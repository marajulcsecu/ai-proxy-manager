/**
 * @fileoverview Daemon lifecycle: PID file bookkeeping so `ai-proxy stop`,
 * `status`, `restart` and `logs` work without the user hunting for a process.
 */

import fs from 'fs';
import path from 'path';
import { spawn, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { CONFIG_DIR, PID_FILE, DAEMON_LOG } from './paths.js';

const CLI_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');

/**
 * True when a process with this pid exists and we may signal it.
 * @param {number} pid
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to another user.
    return error.code === 'EPERM';
  }
}

/**
 * Reads the PID file, if any.
 * @returns {{pid:number, port:number|null, startedAt:string|null}|null}
 */
export function readPidFile() {
  try {
    const raw = fs.readFileSync(PID_FILE, 'utf8').trim();
    if (!raw) return null;
    if (raw.startsWith('{')) {
      const parsed = JSON.parse(raw);
      return { pid: Number(parsed.pid), port: parsed.port ?? null, startedAt: parsed.startedAt ?? null };
    }
    return { pid: Number(raw), port: null, startedAt: null };
  } catch {
    return null;
  }
}

/**
 * Records the current process as the running daemon.
 * @param {number} port
 */
export function writePidFile(port) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    const payload = { pid: process.pid, port, startedAt: new Date().toISOString() };
    fs.writeFileSync(PID_FILE, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch { /* a missing pid file only degrades stop/status */ }
}

/** Removes the PID file if it belongs to this process (or is stale). */
export function removePidFile() {
  const info = readPidFile();
  if (info && info.pid !== process.pid && isProcessAlive(info.pid)) return;
  try { fs.unlinkSync(PID_FILE); } catch { /* already gone */ }
}

/**
 * Current daemon state, with stale PID files reported as not running.
 * @returns {{running:boolean, pid:number|null, port:number|null, startedAt:string|null, stale:boolean}}
 */
export function getDaemonStatus() {
  const info = readPidFile();
  if (!info) return { running: false, pid: null, port: null, startedAt: null, stale: false };
  const running = isProcessAlive(info.pid);
  return { running, pid: info.pid, port: info.port, startedAt: info.startedAt, stale: !running };
}

/**
 * Best-effort lookup of which pid holds a TCP port. Used to make the
 * "port already in use" message actionable.
 * @param {number} port
 * @returns {{pid:number|null, command:string|null}}
 */
export function findPortOwner(port) {
  const probes = [
    { cmd: 'ss', args: ['-ltnpH', `sport = :${port}`], parse: out => out.match(/pid=(\d+)/) },
    { cmd: 'lsof', args: ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], parse: out => out.match(/(\d+)/) }
  ];
  for (const probe of probes) {
    try {
      const out = execFileSync(probe.cmd, probe.args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const match = probe.parse(out);
      if (match) {
        const pid = Number(match[1]);
        let command = null;
        try {
          command = execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' }).trim();
        } catch { /* command name is optional */ }
        return { pid, command };
      }
    } catch { /* probe not installed — try the next one */ }
  }
  return { pid: null, command: null };
}

/**
 * Launches the proxy in the background, detached from this terminal, with
 * stdout/stderr appended to the daemon log.
 * @param {{port?:number}} [options]
 * @returns {{pid:number, logFile:string}}
 */
export function startDetached(options = {}) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const out = fs.openSync(DAEMON_LOG, 'a', 0o600);

  const args = [CLI_PATH, 'start', '--foreground'];
  if (options.port) args.push('--port', String(options.port));

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, AI_PROXY_DAEMONIZED: '1' }
  });
  child.unref();
  fs.closeSync(out);

  return { pid: child.pid, logFile: DAEMON_LOG };
}

/**
 * Stops the running daemon: SIGTERM, then SIGKILL if it will not exit.
 * @param {{timeoutMs?:number}} [options]
 * @returns {Promise<{stopped:boolean, pid:number|null, forced:boolean, reason?:string}>}
 */
export async function stopDaemon(options = {}) {
  const timeoutMs = options.timeoutMs ?? 8000;
  const status = getDaemonStatus();

  if (!status.pid) return { stopped: false, pid: null, forced: false, reason: 'no-pid-file' };
  if (!status.running) {
    removePidFile();
    return { stopped: false, pid: status.pid, forced: false, reason: 'stale-pid-file' };
  }

  try {
    process.kill(status.pid, 'SIGTERM');
  } catch (error) {
    return { stopped: false, pid: status.pid, forced: false, reason: error.message };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(status.pid)) {
      removePidFile();
      return { stopped: true, pid: status.pid, forced: false };
    }
    await new Promise(resolve => setTimeout(resolve, 120));
  }

  try { process.kill(status.pid, 'SIGKILL'); } catch { /* it may have just exited */ }
  await new Promise(resolve => setTimeout(resolve, 250));
  removePidFile();
  return { stopped: !isProcessAlive(status.pid), pid: status.pid, forced: true };
}

/**
 * Reads the last N lines of the daemon log.
 * @param {number} [lines=40]
 * @returns {{text:string, size:number, exists:boolean}}
 */
export function readDaemonLog(lines = 40) {
  try {
    const size = fs.statSync(DAEMON_LOG).size;
    const text = fs.readFileSync(DAEMON_LOG, 'utf8');
    const tail = text.split('\n').slice(-lines).join('\n');
    return { text: tail, size, exists: true };
  } catch {
    return { text: '', size: 0, exists: false };
  }
}

/**
 * Streams new daemon log output to stdout until the process is interrupted.
 * @param {number} [fromOffset]
 * @returns {() => void} stop function
 */
export function followDaemonLog(fromOffset = 0) {
  let offset = fromOffset;
  const tick = () => {
    try {
      const { size } = fs.statSync(DAEMON_LOG);
      if (size < offset) offset = 0; // rotated/truncated
      if (size > offset) {
        const fd = fs.openSync(DAEMON_LOG, 'r');
        const buffer = Buffer.alloc(size - offset);
        fs.readSync(fd, buffer, 0, buffer.length, offset);
        fs.closeSync(fd);
        offset = size;
        process.stdout.write(buffer.toString('utf8'));
      }
    } catch { /* log may not exist yet */ }
  };
  const timer = setInterval(tick, 400);
  return () => clearInterval(timer);
}

export { DAEMON_LOG, PID_FILE };
