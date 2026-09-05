/**
 * @fileoverview Puts a verdict and, on request, a balance on every key in every
 * pool — without spending anything.
 *
 * Two probes, both free:
 *
 *  1. **Liveness** — `GET /v1/models`. The relay either accepts the key or it
 *     does not. No tokens are generated either way.
 *  2. **Balance** — a `/v1/messages` request with an absurd `max_tokens`. These
 *     relays are New-API forks: they pre-authorise an estimated cost and refuse
 *     *before billing* when the balance is short, quoting the exact figure. The
 *     refusal is the measurement.
 *
 * The subtlety that makes this safe: a refusal here is **not** a verdict. A $200
 * key is refused by this probe exactly as a $0.71 key is, because the estimate
 * is deliberately unpayable. Only the number decides. And when a key is rich
 * enough that the relay *accepts* the request, the probe streams and the socket
 * is destroyed on the first byte — the only point at which this costs money.
 *
 * Liveness alone never overrules "spent": `/v1/models` says nothing about
 * credit. Only a measured balance can put a key back into service.
 */

import http from 'http';
import https from 'https';
import crypto from 'crypto';
import { loadConfig, saveConfig, normalizeProviderName } from './configManager.js';
import { resolveUpstream } from './upstream.js';
import { buildUpstreamHeaders } from './headers.js';
import { classifyUpstreamFailure } from './creditSignals.js';
import { maskKey, appendKeyVault } from './keyStore.js';
import { UsageError } from '../utils/errors.js';

const DEFAULT_TIMEOUT_MS = 20000;
/** Relays rate-limit, and a 429 turns a measurement into a shrug. */
const DEFAULT_CONCURRENCY = 4;
/** Below this many dollars a key cannot pay for a real request any more. */
export const DEFAULT_LOW = 1;
/**
 * Output tokens to ask for. Has to exceed any plausible balance once multiplied
 * by an output price — at $3/M this is $3,000 of pre-authorisation — while
 * staying small enough that a relay does not reject it as malformed.
 */
const PROBE_MAX_TOKENS = 1000000;
const MAX_TEXT = 300;

/** How many bytes of an error body are worth reading. */
const MAX_BODY = 8000;

/**
 * One HTTP round trip against a provider.
 *
 * `cutOnFirstByte` is the money guard: on a successful response the socket is
 * destroyed the moment anything arrives, so an accepted probe is billed for a
 * token or two rather than a million.
 *
 * @param {Object} target - from resolveUpstream()
 * @param {{method?:string, apiKey:string, spoof?:boolean, payload?:Buffer|null,
 *          timeoutMs:number, cutOnFirstByte?:boolean}} options
 * @returns {Promise<{statusCode:number, body:string, latencyMs:number, cut:boolean}>}
 */
function send(target, options) {
  const { method = 'GET', apiKey, spoof = true, payload = null, timeoutMs, cutOnFirstByte = false } = options;

  return new Promise((resolve, reject) => {
    const incoming = { accept: payload ? 'application/json' : 'application/json' };
    if (payload) incoming['content-type'] = 'application/json';
    const headers = buildUpstreamHeaders({ incoming, hostHeader: target.hostHeader, apiKey, spoof });
    if (payload) headers['content-length'] = String(payload.length);

    const startedAt = Date.now();
    const req = (target.isTls ? https : http).request(
      { hostname: target.hostname, port: target.port, path: target.path, method, headers },
      res => {
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        let text = '';
        res.setEncoding('utf8');

        if (ok && cutOnFirstByte) {
          // Accepted: the relay is generating tokens we are paying for. Stop it.
          // The result is reported only once the socket has actually gone, so
          // "cut" is never claimed ahead of the fact.
          const done = () => resolve({ statusCode: res.statusCode, body: '', latencyMs: Date.now() - startedAt, cut: true });
          res.once('close', done);
          res.once('data', () => { req.destroy(); res.destroy(); });
          // An empty 200 (no body at all) still counts as accepted.
          res.once('end', () => { req.destroy(); });
          return;
        }

        res.on('data', chunk => { if (text.length < MAX_BODY) text += chunk; });
        res.on('end', () => resolve({ statusCode: res.statusCode, body: text, latencyMs: Date.now() - startedAt, cut: false }));
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(Object.assign(new Error(`no response within ${Math.round(timeoutMs / 1000)}s`), { code: 'ETIMEDOUT' }));
    });
    req.on('error', error => {
      // A socket torn down on purpose is a success, not a failure.
      if (req.destroyed && error?.code === 'ECONNRESET') return;
      reject(error);
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/** Readable one-liner out of a provider's error payload. */
function messageOf(body) {
  if (!body) return '';
  try {
    const parsed = JSON.parse(body);
    const text = parsed?.error?.message || parsed?.message || parsed?.detail
      || (typeof parsed?.error === 'string' ? parsed.error : '');
    if (text) return String(text).slice(0, MAX_TEXT);
  } catch { /* not JSON */ }
  return String(body).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}

/** A verdict shell, so every return from probeKey has the same shape. */
function verdictOf(verdict, extra = {}) {
  return {
    verdict,
    statusCode: null,
    remaining: null,
    needed: null,
    matched: null,
    message: '',
    latencyMs: null,
    ...extra
  };
}

/**
 * Reads a rejection body for a key verdict, shared by both probes.
 * @param {number} statusCode
 * @param {string} body
 * @param {number} low - dollars below which a key is treated as spent
 * @returns {Object|null} verdict, or null when the body says nothing about the key
 */
function fromRejection(statusCode, body, low) {
  const signal = classifyUpstreamFailure(statusCode, body);
  const message = messageOf(body);
  const base = { statusCode, message, matched: signal.matched };

  if (signal.kind === 'invalid-key') return verdictOf('invalid', base);
  if (signal.kind === 'rate-limited') return verdictOf('rate-limited', base);
  if (signal.kind === 'exhausted') {
    // The number, not the refusal, is the verdict: this probe is unpayable by
    // design, so a rich key is refused too.
    const remaining = signal.remaining;
    const funded = typeof remaining === 'number' && remaining > low;
    return verdictOf(funded ? 'funded' : 'spent', { ...base, remaining, needed: signal.needed });
  }
  return null;
}

/**
 * Probes one key. Never throws: a failure to measure is a result.
 * @param {string} url - provider base URL
 * @param {string} apiKey
 * @param {{model?:string, balance?:boolean, low?:number, timeoutMs?:number, spoof?:boolean}} [options]
 * @returns {Promise<{verdict:'live'|'funded'|'spent'|'invalid'|'rate-limited'|'blocked'|'inconclusive'|'error',
 *   statusCode:number|null, remaining:number|null, needed:number|null, matched:string|null,
 *   message:string, latencyMs:number|null}>}
 */
export async function probeKey(url, apiKey, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const low = typeof options.low === 'number' ? options.low : DEFAULT_LOW;
  const spoof = options.spoof !== false;

  let models;
  try {
    models = resolveUpstream(url, '/v1/models');
  } catch (error) {
    return verdictOf('error', { message: error.message });
  }

  let live;
  try {
    const response = await send(models, { method: 'GET', apiKey, spoof, timeoutMs });
    const rejection = response.statusCode < 200 || response.statusCode >= 300
      ? fromRejection(response.statusCode, response.body, low)
      : null;

    if (rejection && rejection.verdict !== 'funded' && rejection.verdict !== 'spent') {
      // A revoked or rate-limited key is settled here; no point asking for a
      // balance it will not quote.
      return { ...rejection, latencyMs: response.latencyMs };
    }
    if (rejection) live = { ...rejection, latencyMs: response.latencyMs };
    else if (response.statusCode >= 200 && response.statusCode < 300) {
      live = verdictOf('live', { statusCode: response.statusCode, latencyMs: response.latencyMs });
    } else if ([404, 405].includes(response.statusCode)) {
      live = verdictOf('inconclusive', {
        statusCode: response.statusCode,
        message: 'this relay has no /v1/models endpoint',
        latencyMs: response.latencyMs
      });
    } else if (response.statusCode === 403) {
      live = verdictOf('blocked', {
        statusCode: response.statusCode,
        message: messageOf(response.body),
        latencyMs: response.latencyMs
      });
    } else {
      live = verdictOf(response.statusCode >= 500 ? 'error' : 'inconclusive', {
        statusCode: response.statusCode,
        message: messageOf(response.body),
        latencyMs: response.latencyMs
      });
    }
  } catch (error) {
    return verdictOf('error', { message: String(error?.message || 'network error').slice(0, MAX_TEXT) });
  }

  if (!options.balance || live.verdict === 'blocked' || live.verdict === 'error') return live;

  const model = options.model;
  if (!model) {
    return { ...live, message: live.message || 'no model configured, so no balance could be asked for' };
  }

  // The balance probe. Streaming, so that an accepted request can be cut off
  // after a token or two instead of a million.
  const payload = Buffer.from(JSON.stringify({
    model,
    max_tokens: PROBE_MAX_TOKENS,
    stream: true,
    messages: [{ role: 'user', content: '.' }]
  }), 'utf8');

  for (const path of ['/v1/messages', '/v1/chat/completions']) {
    let target;
    try {
      target = resolveUpstream(url, path);
    } catch (error) {
      return { ...live, message: error.message };
    }

    let response;
    try {
      response = await send(target, { method: 'POST', apiKey, spoof, payload, timeoutMs, cutOnFirstByte: true });
    } catch (error) {
      return { ...live, message: String(error?.message || 'network error').slice(0, MAX_TEXT) };
    }

    if (response.statusCode >= 200 && response.statusCode < 300) {
      return verdictOf('funded', {
        statusCode: response.statusCode,
        latencyMs: response.latencyMs,
        message: 'the relay accepted an unpayable request, so the balance is well above it (cut off immediately)'
      });
    }

    const rejection = fromRejection(response.statusCode, response.body, low);
    if (rejection) return { ...rejection, latencyMs: response.latencyMs };
    // Wrong API dialect — ask the other one before giving up.
    if (![404, 405].includes(response.statusCode)) {
      return { ...live, statusCode: response.statusCode, message: messageOf(response.body) };
    }
  }

  return { ...live, message: live.message || 'neither API dialect answered the balance probe' };
}

/**
 * Runs `worker` over `items`, at most `limit` at a time, results in order.
 * @template T, R
 * @param {Array<T>} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<Array<R>>}
 */
async function mapLimited(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return out;
}

/** A key nobody was ever issued, used to ask whether a relay checks at all. */
function bogusKey() {
  return `sk-aiproxycheck${crypto.randomBytes(16).toString('hex')}`;
}

/** Which status a measurement implies. Returns the current one when it proves nothing. */
function statusFrom(entry, result, livenessTrusted) {
  // `disabled` is a decision the user made, not a measurement: an account kept
  // for later, or one that must not be billed. Probing it well is not
  // permission to start sending it traffic again.
  if (entry.status === 'disabled') return 'disabled';

  switch (result.verdict) {
    case 'invalid': return 'invalid';
    case 'spent': return 'exhausted';
    case 'funded': return 'active';
    // `/v1/models` proves the key is accepted, and nothing about its credit — so
    // it can promote an untested key but never revive a spent one.
    case 'live': return livenessTrusted && entry.status === 'unknown' ? 'active' : entry.status;
    default: return entry.status;
  }
}

const COUNTS = {
  live: 'live', funded: 'live', spent: 'spent', invalid: 'revoked'
};

/**
 * Checks every key of every provider (or one provider) and records what came
 * back. One config write for the whole run, and none at all when nothing was
 * learned — the rolling backups would otherwise churn.
 *
 * @param {{provider?:string, balance?:boolean, concurrency?:number, low?:number,
 *          timeoutMs?:number, model?:string, onResult?:function}} [options]
 * @returns {Promise<Object>} report; carries masked keys only
 */
export async function checkKeys(options = {}) {
  const config = loadConfig({ fresh: true });
  const low = typeof options.low === 'number' ? options.low : DEFAULT_LOW;
  const concurrency = Math.max(1, Math.min(options.concurrency || DEFAULT_CONCURRENCY, 16));
  const names = Object.keys(config.providers);

  let targets = names;
  if (options.provider) {
    const wanted = normalizeProviderName(options.provider);
    if (!config.providers[wanted]) {
      throw new UsageError(
        `Unknown provider "${options.provider}"`,
        names.length ? `Configured: ${names.join(', ')}` : 'Add one with: ai-proxy add <name> <url> <key>'
      );
    }
    targets = [wanted];
  }

  const report = {
    balance: Boolean(options.balance),
    low,
    results: [],
    notes: [],
    counts: { live: 0, spent: 0, revoked: 0, inconclusive: 0 },
    changed: 0,
    revived: 0
  };

  const pools = new Map();

  for (const name of targets) {
    const provider = config.providers[name];
    const pool = provider.keys || [];
    if (!pool.length) {
      report.notes.push(`${name}: no keys in the pool`);
      continue;
    }
    const model = options.model || provider.defaultModel || provider.models?.[0] || null;
    if (options.balance && !model) {
      report.notes.push(`${name}: no model configured, so no balance can be measured — add one with "ai-proxy model ${name} <model>"`);
    }

    // Does this relay even look at the key? A made-up one should be refused.
    const control = await probeKey(provider.url, bogusKey(), { timeoutMs: options.timeoutMs, low });
    const livenessTrusted = control.verdict !== 'live';
    if (!livenessTrusted) {
      report.notes.push(
        `${name}: /v1/models answered a made-up key, so it does not check the key — liveness alone proves nothing here, run with --balance`
      );
    }

    const results = await mapLimited(pool, concurrency, key => probeKey(provider.url, key.key, {
      model, balance: options.balance, low, timeoutMs: options.timeoutMs
    }));

    const keys = [...pool];
    let touched = false;

    results.forEach((result, index) => {
      const before = pool[index];
      const status = statusFrom(before, result, livenessTrusted);
      const measured = result.verdict === 'spent' || result.verdict === 'funded';
      const changed = status !== before.status;

      // Only what the relay actually quoted. A relay rich enough to let the
      // probe through has said the key *has* credit, not how much — so there is
      // no figure to write, and the one already on the entry (from the import,
      // or from the last relay that did quote one) is the only one anyone has.
      // Same rule as `applyKeyVerdict` on the live path: a balance is written
      // when a number was given and left alone when one was not.
      const quoted = {};
      if (measured && result.remaining !== null && result.remaining !== undefined) {
        quoted.remaining = result.remaining;
      }
      if (measured && result.needed !== null && result.needed !== undefined) {
        quoted.needed = result.needed;
      }

      if (changed || quoted.remaining !== undefined || quoted.needed !== undefined) {
        keys[index] = {
          ...before,
          status,
          ...quoted,
          lastError: status === 'invalid' || status === 'exhausted' ? (result.message || null) : before.lastError
        };
        touched = true;
      }

      if (changed) report.changed += 1;
      if (changed && status === 'active' && before.status === 'exhausted') report.revived += 1;
      report.counts[COUNTS[result.verdict] || 'inconclusive'] += 1;

      const row = {
        provider: name,
        keyId: before.id,
        masked: maskKey(before.key),
        label: before.label,
        verdict: result.verdict,
        statusCode: result.statusCode,
        remaining: quoted.remaining ?? before.remaining ?? null,
        needed: quoted.needed ?? before.needed ?? null,
        was: before.status,
        status,
        changed,
        message: result.message || ''
      };
      report.results.push(row);
      options.onResult?.(row);
    });

    if (touched) pools.set(name, keys);
  }

  if (pools.size) {
    const next = { ...config, providers: { ...config.providers } };
    for (const [name, keys] of pools) {
      next.providers[name] = { ...next.providers[name], keys };
      // Tagged before the save, so the history says a check moved the key and
      // saveConfig's own vault sync finds nothing left to record.
      appendKeyVault(name, keys.filter((key, index) => key !== config.providers[name].keys[index]), 'check');
    }
    saveConfig(next);
  }

  return report;
}
