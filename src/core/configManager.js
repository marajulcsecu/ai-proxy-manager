/**
 * @fileoverview Reads, validates, normalizes and atomically persists the
 * provider database at ~/.config/ai-proxy-manager/config.json.
 *
 * Design notes:
 *  - The proxy reads config on every request, so reads are cached and
 *    invalidated by mtime+size. Editing the file (or the CLI writing it)
 *    still takes effect on the very next request.
 *  - Writes are atomic (tmp file + rename) so a crash or a simultaneous
 *    CLI/dashboard write can never leave a truncated JSON file behind.
 *  - The file holds API keys, so the directory is 0700 and the file 0600.
 *  - A bad/corrupt file throws ConfigError instead of calling process.exit(),
 *    which previously killed the running daemon on any request.
 */

import fs from 'fs';
import { CONFIG_DIR, CONFIG_FILE } from './paths.js';
import { normalizeKeyPool, selectKeyValue, syncKeyVault, KEY_ROTATION_MODES } from './keyStore.js';

/** How many previous versions of config.json to keep beside it. */
const CONFIG_BACKUPS = 5;

/** Thrown for unreadable / unparseable configuration. */
export class ConfigError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'ConfigError';
    this.cause = cause;
  }
}

/** Default settings block. Merged over whatever the user has saved. */
export const DEFAULT_SETTINGS = {
  /** Hard ceiling for a single upstream request (streaming replies are long). */
  upstreamTimeoutMs: 900000,
  /**
   * Give up if the upstream has not produced a single byte in this long.
   * 0 disables it. Useful against CDN-fronted providers that cut the
   * connection at 100-120s (Cloudflare error 524) — set it just below their
   * edge timeout to fail fast with a clear message instead of an HTML page.
   */
  upstreamFirstByteTimeoutMs: 0,
  /** Abort if the upstream sends no bytes for this long after responding. */
  upstreamStallTimeoutMs: 300000,
  /**
   * Re-send a request that failed before a single byte reached the client.
   * Off by default: a retry costs a second call, and the upstream has usually
   * already billed the first one.
   */
  retryEnabled: false,
  /** Total tries per request, the first one included. 1 disables retrying. */
  retryMaxAttempts: 2,
  /**
   * Providers to try, in order, once the resolved one has failed. Names not in
   * `providers` are ignored. Empty means "retry the same provider".
   */
  failoverProviders: [],
  /** Send browser/SDK-lookalike headers upstream (bypasses some WAFs). */
  spoofHeaders: true,
  /** Mirror the request history to ~/.config/ai-proxy-manager/requests.jsonl. */
  persistLogs: true,
  /** How many requests to keep in the in-memory ring buffer. */
  logBufferSize: 200,
  /** Keep request/response body previews in memory for the inspector. */
  captureBodies: true,
  /** Dashboard theme: 'system' | 'light' | 'dark'. */
  theme: 'system'
};

/**
 * Fresh copy of the defaults. Array-valued settings must not be shared with
 * DEFAULT_SETTINGS, or one config could mutate the defaults for the process.
 * @returns {Object}
 */
export function defaultSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const [key, value] of Object.entries(out)) {
    if (Array.isArray(value)) out[key] = [...value];
  }
  return out;
}

export const DEFAULT_CONFIG = {
  providers: {},
  active_provider: null,
  proxy_port: 8319,
  settings: defaultSettings()
};

/** @type {{mtimeMs:number,size:number,config:Object}|null} */
let cache = null;

/**
 * Canonical provider id: lowercase, safe for URLs and shell snippets.
 * @param {string} name
 * @returns {string}
 */
export function normalizeProviderName(name) {
  return String(name ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
}

/** Pattern used by the REST router to capture a provider name. */
export const PROVIDER_NAME_PATTERN = '[a-z0-9._-]+';

/**
 * Coerces arbitrary JSON into a valid config, repairing common drift:
 * unnormalized names, missing models arrays, a defaultModel that is absent
 * from its own models list, and an active_provider pointing nowhere.
 * @param {any} raw
 * @returns {Object} normalized config (new object; input is not mutated)
 */
export function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {
    providers: {},
    active_provider: null,
    proxy_port: 8319,
    settings: defaultSettings()
  };

  const port = Number(src.proxy_port);
  if (Number.isInteger(port) && port > 0 && port < 65536) out.proxy_port = port;

  if (src.settings && typeof src.settings === 'object') {
    for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS)) {
      const value = src.settings[key];
      if (value === undefined || value === null) continue;
      if (Array.isArray(fallback)) {
        if (!Array.isArray(value)) continue;
        const seen = new Set();
        for (const item of value) {
          const name = normalizeProviderName(item);
          if (name && !seen.has(name)) seen.add(name);
        }
        out.settings[key] = [...seen];
      } else if (typeof fallback === 'boolean') out.settings[key] = Boolean(value);
      else if (typeof fallback === 'number') {
        const n = Number(value);
        if (Number.isFinite(n) && n >= 0) out.settings[key] = Math.floor(n);
      } else out.settings[key] = String(value);
    }
  }
  if (!['system', 'light', 'dark'].includes(out.settings.theme)) out.settings.theme = 'system';
  out.settings.logBufferSize = Math.min(Math.max(out.settings.logBufferSize, 10), 5000);
  out.settings.retryMaxAttempts = Math.min(Math.max(out.settings.retryMaxAttempts, 1), 5);

  const providers = src.providers && typeof src.providers === 'object' ? src.providers : {};
  for (const [rawName, rawData] of Object.entries(providers)) {
    const name = normalizeProviderName(rawName);
    if (!name) continue;
    const data = rawData && typeof rawData === 'object' ? rawData : {};

    const models = [];
    if (Array.isArray(data.models)) {
      for (const m of data.models) {
        const model = String(m ?? '').trim();
        if (model && !models.includes(model)) models.push(model);
      }
    }
    const defaultModel = String(data.defaultModel ?? '').trim();
    // A default model that is not in its own list breaks the dashboard's
    // <select> (the browser silently selects the first option instead).
    if (defaultModel && !models.includes(defaultModel)) models.unshift(defaultModel);

    // `keys` is the source of truth; `apiKey` is a mirror kept for the CLI,
    // the tester, the dashboard and the <provider>:<key> inline token.
    const keys = normalizeKeyPool(data.keys, data.apiKey);

    // A selection pointing at a key that is no longer in the pool would leave
    // the provider with no usable mirror, so it is dropped rather than kept.
    const selectedKeyId = String(data.selectedKeyId ?? '').trim();
    const selected = keys.some(k => k.id === selectedKeyId) ? selectedKeyId : '';

    // Anything but the two known modes is read as `manual`: a mode nobody
    // recognises must not be the one that spends keys on its own.
    const keyRotation = KEY_ROTATION_MODES.includes(data.keyRotation) ? data.keyRotation : 'manual';

    out.providers[name] = {
      url: String(data.url ?? '').trim(),
      apiKey: selectKeyValue(keys, selected),
      keys,
      selectedKeyId: selected,
      keyRotation,
      defaultModel,
      models,
      ...(data.note ? { note: String(data.note) } : {})
    };
  }

  const active = normalizeProviderName(src.active_provider);
  const names = Object.keys(out.providers);
  out.active_provider = active && out.providers[active] ? active : (names[0] ?? null);

  return out;
}

/**
 * Loads (and normalizes) the configuration, caching by file mtime+size.
 * @param {{fresh?: boolean}} [options]
 * @returns {Object} normalized configuration
 * @throws {ConfigError} when the file exists but cannot be read/parsed
 */
export function loadConfig(options = {}) {
  let stat = null;
  try {
    stat = fs.statSync(CONFIG_FILE);
  } catch {
    // First run: materialize defaults so the CLI and dashboard agree.
    const fresh = { ...DEFAULT_CONFIG, settings: defaultSettings() };
    try { saveConfig(fresh); } catch { /* read-only home: still usable in memory */ }
    return fresh;
  }

  if (!options.fresh && cache && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
    return cache.config;
  }

  let text;
  try {
    text = fs.readFileSync(CONFIG_FILE, 'utf8');
  } catch (error) {
    throw new ConfigError(`Cannot read ${CONFIG_FILE}: ${error.message}`, error);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(
      `${CONFIG_FILE} is not valid JSON (${error.message}). Fix or delete the file to start fresh.`,
      error
    );
  }

  const config = normalizeConfig(parsed);
  cache = { mtimeMs: stat.mtimeMs, size: stat.size, config };
  return config;
}

/**
 * Like loadConfig() but never throws — for request paths that must stay alive.
 * @returns {{ok: boolean, config: Object, error: Error|null}}
 */
export function tryLoadConfig() {
  try {
    return { ok: true, config: loadConfig(), error: null };
  } catch (error) {
    return { ok: false, config: { ...DEFAULT_CONFIG, settings: defaultSettings() }, error };
  }
}

/**
 * Copies the current config aside as `.bak.1`, shifting older backups down and
 * dropping the oldest. Atomic writes protect against a truncated file; this
 * protects against valid-but-wrong content (a bad edit, a mistaken delete).
 * Never throws — a save must not fail because a backup could not be made.
 */
function rotateBackups() {
  const at = n => `${CONFIG_FILE}.bak.${n}`;
  try {
    if (!fs.existsSync(CONFIG_FILE)) return;
    fs.rmSync(at(CONFIG_BACKUPS), { force: true });
    for (let n = CONFIG_BACKUPS - 1; n >= 1; n--) {
      if (fs.existsSync(at(n))) fs.renameSync(at(n), at(n + 1));
    }
    fs.copyFileSync(CONFIG_FILE, at(1));
    fs.chmodSync(at(1), 0o600);
  } catch { /* best effort */ }
}

/**
 * Atomically writes the configuration to disk with restrictive permissions.
 * @param {Object} config
 * @returns {Object} the normalized config that was written
 */
export function saveConfig(config) {
  const normalized = normalizeConfig(config);
  const tmpFile = `${CONFIG_FILE}.${process.pid}.tmp`;

  rotateBackups();

  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    // mkdir's mode only applies when it creates the directory, so a dir made
    // by an older version (or under a loose umask) stays world-readable. The
    // files are 0600, but the listing alone reveals the provider inventory.
    try { fs.chmodSync(CONFIG_DIR, 0o700); } catch { /* not ours to chmod */ }
    fs.writeFileSync(tmpFile, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpFile, CONFIG_FILE);
    fs.chmodSync(CONFIG_FILE, 0o600);
  } catch (error) {
    try { fs.unlinkSync(tmpFile); } catch { /* nothing to clean up */ }
    throw new ConfigError(`Cannot write ${CONFIG_FILE}: ${error.message}`, error);
  }

  try {
    const stat = fs.statSync(CONFIG_FILE);
    cache = { mtimeMs: stat.mtimeMs, size: stat.size, config: normalized };
  } catch {
    cache = null;
  }

  // Append-only history, so a key can be recovered even if this very save
  // dropped it. Deliberately after the write: the config is the primary.
  syncKeyVault(normalized);
  return normalized;
}

/**
 * Rewrites the config file if normalization changed anything (schema repair).
 * Called once at CLI/daemon start so drift is fixed instead of re-detected.
 * @returns {boolean} true when the file was rewritten
 */
export function migrateConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return false;
  const before = fs.readFileSync(CONFIG_FILE, 'utf8');
  let parsed;
  try { parsed = JSON.parse(before); } catch { return false; }
  const after = `${JSON.stringify(normalizeConfig(parsed), null, 2)}\n`;
  if (before === after) return false;
  saveConfig(parsed);
  return true;
}

/** Resets the in-process cache. Exposed for tests. */
export function clearConfigCache() {
  cache = null;
}

export { CONFIG_FILE, CONFIG_DIR };
