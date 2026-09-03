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
/**
 * Shows enough of a key to recognise it, never enough to use it. Every surface
 * that displays a key — CLI, REST API, dashboard — goes through this.
 * @param {string} key
 * @returns {string}
 */
export function maskKey(key) {
  if (!key) return '';
  const text = String(key);
  return text.length <= 12 ? '••••••' : `${text.slice(0, 5)}…${text.slice(-4)}`;
}

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
export function selectKey(keys, selectedId = '') {
  if (!Array.isArray(keys) || !keys.length) return null;

  // An explicit selection is the user's decision and outranks every status,
  // including `exhausted`: rotation is a click, not a side effect of a verdict.
  // The exception is a key that can never work again, whatever is added to it.
  if (selectedId) {
    const chosen = keys.find(k => k.id === selectedId);
    if (chosen && chosen.status !== 'invalid' && chosen.status !== 'disabled') return chosen;
  }

  return keys.find(k => k.status === 'active')
    || keys.find(k => k.status === 'unknown')
    || keys[0];
}

/**
 * What a provider does when a key of its own turns out to be spent.
 *
 * `manual` alerts and changes nothing, which is the default because a wrong
 * verdict then costs an alert rather than a working key. `auto` lets a
 * *confident* verdict move the pool on by itself — see isConfidentExhaustion().
 */
export const KEY_ROTATION_MODES = ['manual', 'auto'];

/** True for a key worth sending: not spent, not revoked, not switched off. */
const usable = key => key && !['exhausted', 'invalid', 'disabled'].includes(key.status);

/**
 * Id of the next key to try after `currentId`, draining the pool in order.
 *
 * Sequential and deliberately without a wrap-around: reaching the end means the
 * provider is out of accounts, which the caller must be able to see rather than
 * having it loop back onto keys it has already rejected.
 * @param {Array<Object>} keys
 * @param {string|null} currentId - null to start from the top
 * @returns {string|null}
 */
export function nextKeyId(keys, currentId) {
  if (!Array.isArray(keys) || !keys.length) return null;
  const from = currentId ? keys.findIndex(k => k.id === currentId) : -1;
  for (let i = from + 1; i < keys.length; i++) if (usable(keys[i])) return keys[i].id;
  return null;
}

/**
 * Value of the selected key, for the `provider.apiKey` mirror.
 * @param {Array<Object>} keys
 * @returns {string}
 */
export function selectKeyValue(keys, selectedId = '') {
  return selectKey(keys, selectedId)?.key ?? '';
}

/**
 * Records what an upstream failure means for one key.
 *
 * Only a verdict about the key itself changes its status; a Cloudflare page or a
 * rate limit is written to `lastError` and nothing else, because the key is not
 * the problem. The selection only moves when the caller asks for it — see
 * selectKey() and the `rotate` option.
 *
 * @param {Object} config - normalized config; not mutated
 * @param {string} providerName
 * @param {string} keyId
 * @param {import('./creditSignals.js').UpstreamVerdict|null} verdict
 * @param {{rotate?: boolean}} [options] - `rotate` hands the selection to the
 *   next usable key when this verdict says the current one is spent. The
 *   caller owns that decision: it needs the provider's mode and the
 *   classifier's confidence, neither of which is this function's business.
 * @returns {{config: Object, changed: boolean, entry: Object|null,
 *   status: string|null, rotatedTo: string|null}}
 *          `changed` is true only when the key's status moved, i.e. when there
 *          is something to tell the user about. `rotatedTo` is the id of the key
 *          now in use, and only set when the selection really moved.
 */
export function applyKeyVerdict(config, providerName, keyId, verdict, options = {}) {
  const provider = config?.providers?.[providerName];
  const index = provider ? (provider.keys || []).findIndex(k => k.id === keyId) : -1;
  if (!verdict || index < 0) return { config, changed: false, entry: null, status: null, rotatedTo: null };

  const status = verdict.kind === 'exhausted' ? 'exhausted'
    : verdict.kind === 'invalid-key' ? 'invalid'
      : null;

  const before = provider.keys[index];
  const entry = {
    ...before,
    status: status || before.status,
    lastError: [verdict.status || '', verdict.matched || verdict.kind].filter(Boolean).join(' ') || null,
    ...(verdict.remaining === null || verdict.remaining === undefined ? {} : { remaining: verdict.remaining }),
    ...(verdict.needed === null || verdict.needed === undefined ? {} : { needed: verdict.needed })
  };

  const keys = [...provider.keys];
  keys[index] = entry;
  const changed = Boolean(status) && status !== before.status;

  // Out of credit is a judgement, so the key stays in service until the user
  // switches: pin the selection to it, or the mirror would quietly slide to the
  // next key — auto-rotation by accident. A revoked key is a fact, not a
  // judgement, so it is never pinned.
  //
  // Auto mode inverts exactly that pin. `changed` is deliberately not the
  // condition: a key marked spent on an earlier request is still the one being
  // sent, and this is the moment to leave it behind. A target equal to the
  // selection already in place is not a move, so it is not reported as one —
  // otherwise two requests in flight on the same spent key would each write.
  const target = options.rotate && status === 'exhausted' ? nextKeyId(keys, keyId) : null;
  const rotatedTo = target && target !== (provider.selectedKeyId || '') ? target : null;
  const pinned = rotatedTo || (changed && status === 'exhausted' ? keyId : (provider.selectedKeyId || ''));
  const selectedKeyId = keys.some(k => k.id === pinned) ? pinned : '';

  const next = {
    ...config,
    providers: {
      ...config.providers,
      [providerName]: { ...provider, keys, selectedKeyId, apiKey: selectKeyValue(keys, selectedKeyId) }
    }
  };

  return { config: next, changed, entry, status, rotatedTo };
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
