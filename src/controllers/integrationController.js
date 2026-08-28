/**
 * @fileoverview Wires the proxy into the tools that consume it: the shell
 * environment Claude Code reads, and VS Code's custom model list.
 *
 * Every write is an idempotent managed block, so re-running after a port
 * change updates in place instead of refusing ("already set up") or appending
 * a second conflicting block.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadConfig } from '../core/configManager.js';
import { Logger } from '../utils/logger.js';

const BLOCK_START = '# --- AI Proxy Manager (managed block) ---';
const BLOCK_END = '# --- end AI Proxy Manager ---';

/** Matches both the current managed block and the older hand-rolled one. */
const BLOCK_PATTERN = /\n*# --- AI Proxy Manager[^\n]*\n[\s\S]*?\n# -{3,}[^\n]*\n?/g;

const VSCODE_CONFIG = path.join(os.homedir(), '.config', 'Code', 'User', 'chatLanguageModels.json');

/**
 * Shell rc files worth managing, in preference order.
 * @returns {Array<{path:string, kind:'posix'|'fish', label:string}>}
 */
function shellTargets() {
  const home = os.homedir();
  const shell = path.basename(process.env.SHELL || '');
  const candidates = [
    { path: path.join(home, '.bashrc'), kind: 'posix', label: 'bash' },
    { path: path.join(home, '.zshrc'), kind: 'posix', label: 'zsh' },
    { path: path.join(home, '.config', 'fish', 'config.fish'), kind: 'fish', label: 'fish' }
  ];

  const existing = candidates.filter(target => fs.existsSync(target.path));
  if (existing.length) return existing;

  // Nothing exists yet: create the rc file for the shell actually in use.
  const preferred = candidates.find(target => target.label === shell);
  return [preferred || candidates[0]];
}

/**
 * Renders the managed block for a shell.
 * @param {'posix'|'fish'} kind
 * @param {number} port
 * @returns {string}
 */
function renderBlock(kind, port) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const body = kind === 'fish'
    ? [`set -gx ANTHROPIC_BASE_URL "${baseUrl}"`, 'set -gx ANTHROPIC_AUTH_TOKEN "dummy-key-managed-by-proxy"']
    : [`export ANTHROPIC_BASE_URL="${baseUrl}"`, 'export ANTHROPIC_AUTH_TOKEN="dummy-key-managed-by-proxy"'];

  return [
    '',
    BLOCK_START,
    '# Managed by `ai-proxy setup-terminal` — edits here are overwritten.',
    ...body,
    BLOCK_END,
    ''
  ].join('\n');
}

/** Reads a file, returning '' when it does not exist. */
function readIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Reports whether each integration is currently applied, and to what port.
 * @returns {Object}
 */
export function getIntegrationStatus() {
  const config = loadConfig();
  const port = config.proxy_port || 8319;

  const files = shellTargets().map(target => {
    const content = readIfExists(target.path);
    const match = content.match(/ANTHROPIC_BASE_URL[="\s]+http:\/\/127\.0\.0\.1:(\d+)/);
    const applied = BLOCK_PATTERN.test(content);
    BLOCK_PATTERN.lastIndex = 0;
    return {
      path: target.path,
      label: target.label,
      exists: fs.existsSync(target.path),
      applied,
      port: match ? Number(match[1]) : null,
      upToDate: applied && match ? Number(match[1]) === port : false
    };
  });

  let vscodeEntries = 0;
  let vscodeReadable = false;
  const vscodeRaw = readIfExists(VSCODE_CONFIG);
  if (vscodeRaw) {
    try {
      const parsed = JSON.parse(vscodeRaw);
      if (Array.isArray(parsed)) {
        vscodeEntries = parsed.filter(entry => String(entry?.name || '').startsWith('ai-proxy:')).length;
        vscodeReadable = true;
      }
    } catch { /* malformed file: reported as unreadable */ }
  }

  return {
    expectedPort: port,
    shell: {
      applied: files.some(file => file.applied),
      upToDate: files.length > 0 && files.every(file => !file.applied || file.upToDate),
      files
    },
    vscode: {
      path: VSCODE_CONFIG,
      exists: fs.existsSync(VSCODE_CONFIG),
      readable: vscodeReadable || !vscodeRaw,
      applied: vscodeEntries > 0,
      entries: vscodeEntries
    }
  };
}

/**
 * Writes (or refreshes) the managed shell block.
 * @param {{quiet?:boolean}} [options]
 * @returns {{ok:boolean, message:string, files:Array<Object>, changed:boolean}}
 */
export function applyShellSetup(options = {}) {
  const config = loadConfig();
  const port = config.proxy_port || 8319;
  const results = [];
  let changed = false;

  for (const target of shellTargets()) {
    try {
      fs.mkdirSync(path.dirname(target.path), { recursive: true });
      const before = readIfExists(target.path);
      const stripped = before.replace(BLOCK_PATTERN, '\n').replace(/\n{3,}$/, '\n');
      const after = `${stripped.replace(/\s*$/, '')}\n${renderBlock(target.kind, port)}`;

      if (before !== after) {
        fs.writeFileSync(target.path, after, 'utf8');
        changed = true;
      }
      results.push({ path: target.path, label: target.label, updated: before !== after });
    } catch (error) {
      results.push({ path: target.path, label: target.label, error: error.message });
    }
  }

  const failed = results.filter(result => result.error);
  const message = failed.length
    ? `Updated ${results.length - failed.length} file(s); failed on ${failed.map(f => f.path).join(', ')}`
    : changed
      ? `Shell environment configured for port ${port} in ${results.map(r => r.label).join(', ')}.`
      : `Shell environment was already up to date (port ${port}).`;

  if (!options.quiet) {
    if (failed.length) Logger.error(message); else Logger.success(message);
    for (const result of results) {
      if (result.error) Logger.error(`  ${result.path}: ${result.error}`);
      else Logger.dim(`  ${result.updated ? 'updated' : 'unchanged'}  ${result.path}`);
    }
    if (changed) Logger.info('Run `source` on your shell rc (or open a new terminal) to pick it up.');
  }

  return { ok: failed.length === 0, message, files: results, changed };
}

/**
 * Removes the managed shell block.
 * @param {{quiet?:boolean}} [options]
 * @returns {{ok:boolean, message:string, files:Array<Object>}}
 */
export function removeShellSetup(options = {}) {
  const results = [];
  let removed = 0;

  for (const target of shellTargets()) {
    const before = readIfExists(target.path);
    if (!before) continue;
    const after = before.replace(BLOCK_PATTERN, '\n').replace(/\n{3,}/g, '\n\n');
    if (before === after) {
      results.push({ path: target.path, label: target.label, removed: false });
      continue;
    }
    try {
      fs.writeFileSync(target.path, after, 'utf8');
      removed++;
      results.push({ path: target.path, label: target.label, removed: true });
    } catch (error) {
      results.push({ path: target.path, label: target.label, error: error.message });
    }
  }

  const message = removed
    ? `Removed the AI Proxy block from ${removed} shell file(s). Open a new terminal to drop the variables.`
    : 'No AI Proxy block found in your shell files.';
  if (!options.quiet) Logger.success(message);

  return { ok: true, message, files: results };
}

/** Kept for CLI compatibility: `ai-proxy setup-terminal`. */
export function setupTerminal(options = {}) {
  return applyShellSetup(options);
}

/**
 * Injects every configured provider (and all of its models) into VS Code's
 * custom chat model list.
 * @param {{quiet?:boolean}} [options]
 * @returns {{ok:boolean, message:string, injected:number, models:number}}
 */
export function syncVsCode(options = {}) {
  const config = loadConfig();
  const port = config.proxy_port || 8319;

  let entries = [];
  if (fs.existsSync(VSCODE_CONFIG)) {
    const raw = readIfExists(VSCODE_CONFIG);
    if (raw.trim()) {
      try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) throw new Error('expected a JSON array');
        entries = parsed;
      } catch (error) {
        const message = `${VSCODE_CONFIG} is not a valid JSON array (${error.message}). Fix or delete it, then retry.`;
        if (!options.quiet) Logger.error(message);
        return { ok: false, message, injected: 0, models: 0 };
      }
    }
  }

  // Drop previously injected blocks. Guard against entries without a name,
  // which used to throw here.
  entries = entries.filter(entry => !String(entry?.name || '').startsWith('ai-proxy:'));

  let injected = 0;
  let modelCount = 0;

  for (const [name, data] of Object.entries(config.providers)) {
    if (!data.apiKey) continue;

    const models = (data.models && data.models.length)
      ? data.models
      : (data.defaultModel ? [data.defaultModel] : []);
    if (!models.length) continue;

    entries.push({
      name: `ai-proxy:${name}`,
      vendor: 'customendpoint',
      // "<provider>:<key>" is what the proxy's smart router reads to pick a
      // provider regardless of which one is globally active.
      apiKey: `${name}:${data.apiKey}`,
      apiType: 'chat-completions',
      models: models.map(model => ({
        id: model,
        name: `${name} · ${model}`,
        url: `http://127.0.0.1:${port}`,
        toolCalling: true,
        vision: true
      }))
    });
    injected++;
    modelCount += models.length;
  }

  try {
    fs.mkdirSync(path.dirname(VSCODE_CONFIG), { recursive: true });
    fs.writeFileSync(VSCODE_CONFIG, `${JSON.stringify(entries, null, '\t')}\n`, 'utf8');
  } catch (error) {
    const message = `Could not write ${VSCODE_CONFIG}: ${error.message}`;
    if (!options.quiet) Logger.error(message);
    return { ok: false, message, injected: 0, models: 0 };
  }

  const skipped = Object.values(config.providers).filter(p => !p.apiKey).length;
  const message = injected
    ? `Injected ${injected} provider(s) / ${modelCount} model(s) into VS Code.${skipped ? ` Skipped ${skipped} without a key.` : ''}`
    : 'No providers with an API key and at least one model — nothing to inject.';

  if (!options.quiet) {
    Logger.success(message);
    Logger.dim(`  ${VSCODE_CONFIG}`);
    Logger.info('Reload VS Code to see the entries in the model picker.');
  }

  return { ok: true, message, injected, models: modelCount };
}

export { VSCODE_CONFIG };
