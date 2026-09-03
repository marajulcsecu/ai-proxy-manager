/**
 * @fileoverview Runtime state for the key pool — the one piece of the pool that
 * runs on the live request path.
 *
 * Two rules shape everything here:
 *
 *  1. **Only real news is written to disk.** A WAF page, a rate limit and a
 *     second 403 from a key already marked exhausted all change nothing, so
 *     they cause no write. Writing per request would rotate the config backups
 *     into uselessness within a minute of traffic.
 *  2. **A verdict never rotates a key by itself, unless it was asked to.** In
 *     the default `manual` mode `applyKeyVerdict` pins the selection to the key
 *     that failed, so the proxy keeps sending it until the user switches
 *     (`ai-proxy keys next`) and a wrong verdict costs an alert rather than a
 *     working key. A provider set to `auto` lets a *confident* verdict move the
 *     pool on instead — Tier A wording, or Tier B wording this provider has
 *     already used once before. Nothing else qualifies: a revoked key is marked
 *     and skipped, never rotated over, because a relay having a bad 401 day
 *     would otherwise walk the whole pool in a minute of traffic.
 */

import { loadConfig, saveConfig } from './configManager.js';
import { applyKeyVerdict, appendKeyVault, maskKey } from './keyStore.js';
import { classifyUpstreamFailure, isConfidentExhaustion } from './creditSignals.js';
import { Logger } from '../utils/logger.js';

/** Un-dismissed alerts, keyed `provider:keyId` so one key alerts once. */
const alerts = new Map();

/**
 * Times a tier B phrase has been seen per provider. Tier B wording has not been
 * confirmed on these relays, so auto mode wants a second sighting before it
 * acts on it — see isConfidentExhaustion().
 */
const tierB = new Map();

/** Requests served per `provider:keyId` since the last config write. */
const usage = new Map();

const at = (provider, keyId) => `${provider}:${keyId}`;

/**
 * Counts one request against the key that served it. In memory only: the
 * counters are folded into the config the next time it is written for another
 * reason, so a busy proxy does no extra I/O at all.
 * @param {string} provider
 * @param {string|null} keyId
 */
export function noteKeyUsed(provider, keyId) {
  if (!provider || !keyId) return;
  const slot = usage.get(at(provider, keyId)) || { provider, keyId, count: 0, lastUsedAt: null };
  slot.count++;
  slot.lastUsedAt = new Date().toISOString();
  usage.set(at(provider, keyId), slot);
}

/**
 * Applies the pending usage counters to a config about to be saved, and clears
 * them. Counters for keys that are no longer in the pool are dropped.
 * @param {Object} config - normalized config; not mutated
 * @returns {Object} config with usage folded in
 */
function foldUsage(config) {
  if (!usage.size) return config;
  const providers = { ...config.providers };
  for (const slot of usage.values()) {
    const provider = providers[slot.provider];
    if (!provider) continue;
    const index = (provider.keys || []).findIndex(entry => entry.id === slot.keyId);
    if (index < 0) continue;
    const keys = [...provider.keys];
    keys[index] = {
      ...keys[index],
      requestsServed: (Number(keys[index].requestsServed) || 0) + slot.count,
      lastUsedAt: slot.lastUsedAt || keys[index].lastUsedAt
    };
    providers[slot.provider] = { ...provider, keys };
  }
  usage.clear();
  return { ...config, providers };
}

/**
 * Reads what the upstream said about the key that was just used, and records it
 * when — and only when — it is news about the key itself.
 *
 * @param {Object} event
 * @param {string} event.provider
 * @param {string|null} event.keyId - null for a caller-supplied inline key,
 *   which belongs to no pool and so can only be classified, never marked
 * @param {number} event.statusCode
 * @param {string|Buffer} event.body - the response body, or its peeked head
 * @returns {{verdict: import('./creditSignals.js').UpstreamVerdict,
 *   priorTierBHits: number, changed: boolean, status: string|null,
 *   entry: Object|null, rotated: {fromKeyId: string, toKeyId: string, toLabel: string}|null}}
 *   `rotated` is set only when this verdict moved an auto provider on to another
 *   key, which is also the caller's signal that the request may be replayed.
 */
export function noteUpstreamFailure({ provider, keyId, statusCode, body }) {
  const verdict = classifyUpstreamFailure(statusCode, body);
  const priorTierBHits = tierB.get(provider) || 0;
  if (verdict.kind === 'exhausted' && verdict.tier === 'B') tierB.set(provider, priorTierBHits + 1);

  const quiet = { verdict, priorTierBHits, changed: false, status: null, entry: null, rotated: null };
  const actionable = verdict.kind === 'exhausted' || verdict.kind === 'invalid-key';
  if (!actionable || !provider || !keyId) return quiet;

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    Logger.warn(`could not record the key verdict — ${error.message}`);
    return quiet;
  }

  // Auto mode acts on its own, so it only acts on wording that has been
  // confirmed on this provider. Exhaustion only: see the note at the top.
  const auto = config.providers[provider]?.keyRotation === 'auto';
  const rotate = auto && verdict.kind === 'exhausted' && isConfidentExhaustion(verdict, priorTierBHits);

  const applied = applyKeyVerdict(config, provider, keyId, verdict, { rotate });
  // Not in the pool, or already in that state: nothing to write, and nothing
  // new to tell the user. `lastError` and the balance are deliberately not
  // persisted on a repeat, so a hammering client cannot cause a write per call.
  // A rotation is news even when the status is not: the key was already marked,
  // and it is the selection that has just moved off it.
  if (!applied.entry || (!applied.changed && !applied.rotatedTo)) {
    return { verdict, priorTierBHits, changed: false, status: applied.status, entry: applied.entry, rotated: null };
  }

  const moved = applied.rotatedTo
    ? (applied.config.providers[provider].keys.find(key => key.id === applied.rotatedTo) || null)
    : null;
  const rotated = moved ? { fromKeyId: keyId, toKeyId: moved.id, toLabel: moved.label || '' } : null;

  // Tagged first, so the history says *why* the status moved; saveConfig's own
  // vault sync then sees the state already recorded and adds no second line.
  // Only on a real status change: a rotation is not a new fact about the key, and
  // saveConfig's sync will find nothing to record either.
  if (applied.changed) appendKeyVault(provider, [applied.entry], applied.status);
  try {
    saveConfig(foldUsage(applied.config));
  } catch (error) {
    Logger.error(`key marked ${applied.status} but the config could not be saved — ${error.message}`);
    // Nothing was persisted, so the selection has not moved either: reporting a
    // rotation here would have the proxy replay onto a key it never switched to.
    return { verdict, priorTierBHits, changed: false, status: applied.status, entry: applied.entry, rotated: null };
  }

  alerts.set(at(provider, keyId), {
    provider,
    keyId,
    label: applied.entry.label || '',
    // A key added by hand has no label, and a bare id names no account.
    masked: maskKey(applied.entry.key),
    status: applied.status,
    remaining: verdict.remaining,
    needed: verdict.needed,
    matched: verdict.matched,
    statusCode: verdict.status,
    // Names the account now serving, so the banner reads as news rather than as
    // a request. Its presence is also what stops keyAlerts() pruning it.
    switchedTo: rotated ? (rotated.toLabel || maskKey(moved.key)) : null,
    at: new Date().toISOString()
  });

  const balance = verdict.remaining === null ? '' : ` ($${verdict.remaining} left`
    + `${verdict.needed === null ? '' : `, $${verdict.needed} needed`})`;
  const named = applied.entry.label || applied.entry.id.slice(0, 8);
  Logger.warn(
    `[${provider}] key ${named} is ${applied.status}${balance}`
    + (rotated
      ? ` — switched to ${rotated.toLabel || rotated.toKeyId.slice(0, 8)}`
      : ` — switch with: ai-proxy keys next ${provider}`)
  );

  return {
    verdict, priorTierBHits, changed: applied.changed, status: applied.status, entry: applied.entry, rotated
  };
}

/**
 * Alerts the user has not dismissed, oldest first. Safe to hand to the browser:
 * an alert names the key by label and id, never by value.
 * @returns {Array<Object>}
 */
export function keyAlerts() {
  let config = null;
  try {
    config = loadConfig();
  } catch { /* unreadable config: better a stale alert than none */ }

  // Pruned against the config rather than only on dismissal, because the user
  // may well have answered the alert in the CLI — a different process, which
  // cannot reach into this one's memory. The condition an alert stands for is
  // "this key is spent and still the one being sent", so once that stops being
  // true the alert has been dealt with, whoever did it.
  if (config) {
    for (const [id, alert] of alerts) {
      const provider = config.providers[alert.provider];
      const entry = (provider?.keys || []).find(key => key.id === alert.keyId);
      // An alert about a switch already made is not a request, so the selection
      // says nothing about whether it has been read: only dismissal clears it.
      const answered = !entry
        || entry.status !== alert.status
        || (alert.status === 'exhausted' && !alert.switchedTo && provider.selectedKeyId !== alert.keyId);
      if (answered) alerts.delete(id);
    }
  }
  return [...alerts.values()];
}

/**
 * @param {string} provider
 * @param {string} keyId
 * @returns {boolean} true when an alert was actually removed
 */
export function dismissKeyAlert(provider, keyId) {
  return alerts.delete(at(provider, keyId));
}

/**
 * @param {string} provider
 * @returns {number} tier B sightings so far for that provider
 */
export function tierBHits(provider) {
  return tierB.get(provider) || 0;
}

/** Drops all runtime state. Used by the daemon on start and by the tests. */
export function resetKeyMonitor() {
  alerts.clear();
  tierB.clear();
  usage.clear();
}
