/**
 * @fileoverview Multi-key pools: one provider, many accounts.
 *
 * Each provider owns an ordered list of keys. Position is priority — the pool
 * is drained sequentially, so one account's credit is spent before the next is
 * touched. Nothing here performs I/O; these are pure functions over the config
 * so they can be unit-tested and reused by the CLI, the API and the proxy.
 *
 * Two rules exist to avoid ever losing a key:
 *  - `provider.apiKey` is only ever a *mirror* of the chosen pool entry, so
 *    older callers keep working, and a key written to that field by hand is
 *    absorbed into the pool rather than overwritten.
 *  - a key is marked, never deleted. Removal is an explicit, separate action.
 */

import crypto from 'crypto';
import fs from 'fs';
import { CONFIG_DIR, KEY_VAULT } from './paths.js';

/** Lifecycle of one key. Position in the pool decides order, not status. */
export const KEY_STATUSES = ['active', 'exhausted', 'invalid', 'unknown', 'disabled'];

/**
 * Stable id for a key value. Derived from the key itself so importing the same
 * spreadsheet twice cannot produce duplicates, and so an id never reveals the
 * key it points at.
 * @param {string} key
 * @returns {string} 12 hex characters
 */
export function deriveKeyId(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 12);
}

/** Trimmed string, or '' for anything absent. */
function str(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

/** Finite number, or null. Used for balances, which are legitimately absent. */
function num(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Coerces one raw entry into a full key record.
 * @param {any} raw - object, or a bare key string
 * @returns {Object|null} null when there is no key value to store
 */
export function normalizeKeyEntry(raw) {
  const src = raw && typeof raw === 'object' ? raw : { key: raw };
  const key = str(src.key);
  if (!key) return null;

  const status = KEY_STATUSES.includes(src.status) ? src.status : 'unknown';
  const served = Number(src.requestsServed);

  return {
    id: deriveKeyId(key),
    key,
    label: str(src.label),
    status,
    remaining: num(src.remaining),
    needed: num(src.needed),
    dashboardUrl: str(src.dashboardUrl),
    referralUrl: str(src.referralUrl),
    note: str(src.note),
    addedAt: str(src.addedAt) || new Date().toISOString(),
    lastUsedAt: str(src.lastUsedAt) || null,
    requestsServed: Number.isFinite(served) && served > 0 ? Math.floor(served) : 0,
    lastError: str(src.lastError) || null
  };
}

/**
 * Builds a provider's pool, absorbing a legacy single `apiKey`.
 * @param {any} rawKeys - existing pool, if any
 * @param {string} [legacyApiKey] - value of the old single-key field
 * @returns {Array<Object>} deduplicated, order preserved
 */
export function normalizeKeyPool(rawKeys, legacyApiKey = '') {
  const pool = [];
  const seen = new Set();

  const push = (raw, fallbackStatus) => {
    const entry = normalizeKeyEntry(raw);
    if (!entry || seen.has(entry.id)) return;
    if (fallbackStatus && (!raw || typeof raw !== 'object' || !raw.status)) entry.status = fallbackStatus;
    seen.add(entry.id);
    pool.push(entry);
  };

  if (Array.isArray(rawKeys)) for (const raw of rawKeys) push(raw);

  // A key sitting in the old field is either the only key (fresh migration) or
  // a hand-edit that predates the pool. Either way it must not disappear.
  const legacy = str(legacyApiKey);
  if (legacy) push({ key: legacy }, 'active');

  return pool;
}

/**
 * The key the proxy should send. Prefers an explicitly active entry, then an
 * untested one, and otherwise falls back to the head of the pool: a key that
 * was rejected for a huge request can still answer a small one, so the proxy
 * must not refuse to try.
 * @param {Array<Object>} keys
 * @returns {Object|null}
 */
export function selectKey(keys) {
  if (!Array.isArray(keys) || !keys.length) return null;
  return keys.find(k => k.status === 'active')
    || keys.find(k => k.status === 'unknown')
    || keys[0];
}

/**
 * Value of the selected key, for the `provider.apiKey` mirror.
 * @param {Array<Object>} keys
 * @returns {string}
 */
export function selectKeyValue(keys) {
  return selectKey(keys)?.key ?? '';
}

// --- the vault --------------------------------------------------------------
//
// config.json can be corrupted, hand-edited or overwritten. keys.jsonl only
// ever grows: one line each time a key is first seen or its state changes, so
// a key can always be recovered even if it is gone from the config entirely.

/** Fields worth preserving for recovery. The key itself is the important one. */
function vaultRecord(provider, entry, event, ts) {
  return {
    ts, event, provider,
    id: entry.id,
    key: entry.key,
    label: entry.label,
    status: entry.status,
    remaining: entry.remaining,
    needed: entry.needed,
    dashboardUrl: entry.dashboardUrl,
    referralUrl: entry.referralUrl,
    note: entry.note
  };
}

/**
 * Appends key states to the vault. Never throws: losing history is bad, but
 * failing a config save because of it would be worse.
 * @param {string} provider
 * @param {Array<Object>} entries
 * @param {string} [event] - why the line was written ('save', 'exhausted', ...)
 * @returns {number} lines written
 */
export function appendKeyVault(provider, entries, event = 'save') {
  if (!Array.isArray(entries) || !entries.length) return 0;
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    const ts = new Date().toISOString();
    const body = entries
      .map(entry => JSON.stringify(vaultRecord(provider, entry, event, ts)))
      .join('\n');
    fs.appendFileSync(KEY_VAULT, `${body}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(KEY_VAULT, 0o600);
    return entries.length;
  } catch {
    return 0;
  }
}

/**
 * Every vault line, oldest first. Malformed lines are skipped.
 * @returns {Array<Object>}
 */
export function readKeyVault() {
  let text = '';
  try {
    text = fs.readFileSync(KEY_VAULT, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const record = JSON.parse(line);
      if (record && record.id && record.provider) out.push(record);
    } catch { /* a truncated line must not hide the rest of the file */ }
  }
  return out;
}

/**
 * Most recent state of each key, keyed `<provider>:<id>`.
 * @returns {Map<string, Object>}
 */
export function latestVaultState() {
  const latest = new Map();
  for (const record of readKeyVault()) latest.set(`${record.provider}:${record.id}`, record);
  return latest;
}

/** True when a key's recorded state differs from what the vault last saw. */
function changed(previous, entry) {
  if (!previous) return true;
  return previous.status !== entry.status
    || previous.label !== entry.label
    || previous.remaining !== entry.remaining
    || previous.note !== entry.note;
}

/**
 * Records any new or changed key from a whole config. Called on every save so
 * no caller has to remember to do it.
 * @param {Object} config - normalized config
 * @param {string} [event]
 * @returns {number} lines written
 */
export function syncKeyVault(config, event = 'save') {
  const latest = latestVaultState();
  let written = 0;
  for (const [provider, data] of Object.entries(config?.providers || {})) {
    const pending = (data.keys || []).filter(entry => changed(latest.get(`${provider}:${entry.id}`), entry));
    written += appendKeyVault(provider, pending, event);
  }
  return written;
}

/**
 * Keys the vault knows about that are no longer in the config — i.e. keys that
 * a bad edit, a failed merge or a mistaken delete would otherwise have lost.
 * @param {Object} config - normalized config
 * @returns {Array<Object>} vault records, one per missing key
 */
export function recoverMissingKeys(config) {
  const missing = [];
  for (const record of latestVaultState().values()) {
    const pool = config?.providers?.[record.provider]?.keys || [];
    if (!pool.some(entry => entry.id === record.id)) missing.push(record);
  }
  return missing;
}
