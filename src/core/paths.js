/**
 * @fileoverview Single source of truth for every on-disk path the tool uses.
 *
 * Set AI_PROXY_HOME to relocate the whole data directory (used by the test
 * suite so tests never touch a real user's configuration).
 */

import path from 'path';
import os from 'os';

/** Root directory for all persisted state. */
export const CONFIG_DIR = process.env.AI_PROXY_HOME
  ? path.resolve(process.env.AI_PROXY_HOME)
  : path.join(os.homedir(), '.config', 'ai-proxy-manager');

/** Provider database. Contains API keys — written with 0600 permissions. */
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

/** Written by the daemon so `stop`/`status`/`restart` can find the process. */
export const PID_FILE = path.join(CONFIG_DIR, 'daemon.pid');

/** stdout/stderr of a backgrounded daemon. */
export const DAEMON_LOG = path.join(CONFIG_DIR, 'daemon.log');

/** Append-only request history (JSONL). Never contains prompt bodies. */
export const REQUEST_LOG = path.join(CONFIG_DIR, 'requests.jsonl');

/** Rotated copy of REQUEST_LOG. */
export const REQUEST_LOG_ROTATED = path.join(CONFIG_DIR, 'requests.1.jsonl');

/**
 * Append-only record of every key ever saved (JSONL). Grows forever by design:
 * it is the last line of defence against losing an account's key.
 */
export const KEY_VAULT = path.join(CONFIG_DIR, 'keys.jsonl');
