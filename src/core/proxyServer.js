/**
 * @fileoverview The HTTP server: dashboard + REST API + smart proxy engine.
 *
 * Routing order for every request:
 *   1. Dashboard assets  ("/", "/style.css", "/app.js", ...)
 *   2. REST API          ("/api/*")
 *   3. Proxy engine      (everything else -> the resolved provider)
 *
 * The proxy re-reads configuration per request (mtime-cached), so switching
 * provider or model in the CLI or dashboard applies to the next request with
 * no restart.
 */

import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { tryLoadConfig, migrateConfig } from './configManager.js';
import { handleApiRequest } from './apiRoutes.js';
import {
  startRequest, finishRequest, markFirstByte, attachBody,
  configureLogger, restorePersistedLogs
} from './requestLogger.js';
import { resolveUpstream, isModelBearingPath } from './upstream.js';
import { INSPECT_STATUS } from './creditSignals.js';
import { noteUpstreamFailure, noteKeyUsed } from './keyMonitor.js';
import { buildUpstreamHeaders, extractClientToken } from './headers.js';
import { writePidFile, removePidFile, findPortOwner } from './daemon.js';
import { setRuntime } from './runtime.js';
import { Logger } from '../utils/logger.js';

const DASHBOARD_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dashboard');

/** Requests larger than this are rejected rather than buffered. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/**
 * Dedicated connection pools.
 *
 * `http.globalAgent` ships with `timeout: 5000`, which lands on the socket
 * before `ClientRequest.setTimeout()` can replace it — and `setTimeout()` is
 * deferred to the socket's `connect` event, so a connect slower than 5s is
 * killed by the agent's timer, not ours. `timeout: 0` removes that hidden
 * deadline; every timeout in `forward()` is an explicit timer we own.
 */
const AGENT_OPTIONS = {
  keepAlive: true,
  keepAliveMsecs: 1000,
  scheduling: 'lifo',
  maxSockets: 64,
  timeout: 0
};
export const HTTP_AGENT = new http.Agent(AGENT_OPTIONS);
export const HTTPS_AGENT = new https.Agent(AGENT_OPTIONS);

/** Dashboard files reachable over HTTP, mapped from request path. */
const STATIC_ROUTES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/style.css': 'style.css',
  '/app.js': 'app.js',
  '/favicon.svg': 'favicon.svg'
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

/** Splits a request target into pathname and query string. */
function splitUrl(target) {
  const raw = target || '/';
  const index = raw.indexOf('?');
  return index === -1
    ? { pathname: raw, search: '' }
    : { pathname: raw.slice(0, index), search: raw.slice(index) };
}

function hostnameOf(value) {
  if (!value) return '';
  const text = String(value).trim().toLowerCase();
  if (text.startsWith('[')) return text.slice(1, text.indexOf(']') === -1 ? undefined : text.indexOf(']'));
  return text.split(':')[0];
}

/**
 * Guards the dashboard and REST API against DNS-rebinding: a remote page can
 * make a browser connect to 127.0.0.1, but it cannot forge a local Host or
 * Origin header. Without this, any website could read the stored API keys.
 * @param {import('http').IncomingMessage} req
 * @returns {boolean}
 */
function isLocalRequest(req) {
  const host = hostnameOf(req.headers.host);
  if (host && !LOCAL_HOSTNAMES.has(host) && !/^127\./.test(host)) return false;

  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    let originHost = '';
    try { originHost = new URL(origin).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { return false; }
    if (!LOCAL_HOSTNAMES.has(originHost) && !/^127\./.test(originHost)) return false;
  }
  return true;
}

/** Sends a JSON error in the shape Anthropic clients already know how to show. */
function sendProxyError(res, statusCode, message, type = 'proxy_error') {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ type: 'error', error: { type, message } }));
}

/**
 * Serves one dashboard asset. Returns false when the path is not a known asset.
 * @param {import('http').ServerResponse} res
 * @param {string} pathname
 * @returns {boolean}
 */
function serveStatic(res, pathname) {
  const fileName = STATIC_ROUTES[pathname];
  if (!fileName) return false;

  const filePath = path.join(DASHBOARD_DIR, fileName);
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(fileName)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Dashboard asset not found');
  }
  return true;
}

/**
 * Decides which provider a request belongs to.
 *
 * A token of the form "<provider>:<key>" targets that provider explicitly
 * (used by the VS Code integration); anything else uses the active provider.
 * A placeholder key ("dummy...") means "look the real key up in config".
 * @param {Object} config
 * @param {string|null} token
 * @returns {{name:string|null, key:string|null}}
 */
export function resolveRoute(config, token) {
  let name = config.active_provider;
  let clientKey = token;

  if (token && token.includes(':')) {
    const [prefix, ...rest] = token.split(':');
    const candidate = prefix.trim().toLowerCase();
    if (config.providers[candidate]) {
      name = candidate;
      const supplied = rest.join(':').trim();
      clientKey = supplied && !supplied.toLowerCase().includes('dummy') ? supplied : null;
    }
  }

  const provider = name ? config.providers[name] : null;
  const usable = clientKey && !clientKey.toLowerCase().includes('dummy') && clientKey.length > 15;
  return { name, key: usable ? clientKey : (provider?.apiKey || null) };
}

/**
 * Reads a request body with a hard size cap.
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<Buffer>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Rewrites the `model` field when the provider pins one. An unset or empty
 * defaultModel means pass-through: whatever the client asked for is kept.
 * @param {Buffer} body
 * @param {Object} provider
 * @returns {{body:Buffer, originalModel:string|null, swappedModel:string|null, streaming:boolean, json:boolean}}
 */
function applyModelOverride(body, provider) {
  const fallback = { body, originalModel: null, swappedModel: null, streaming: false, json: false };
  if (!body.length) return fallback;

  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    // Not JSON (or malformed): forward it untouched rather than failing the
    // request, which is what the previous implementation did.
    return fallback;
  }
  if (!parsed || typeof parsed !== 'object') return fallback;

  const originalModel = typeof parsed.model === 'string' ? parsed.model : null;
  const streaming = parsed.stream === true;
  const pinned = (provider.defaultModel || '').trim();

  if (!pinned || !originalModel || originalModel === pinned) {
    return { body, originalModel, swappedModel: originalModel, streaming, json: true };
  }

  parsed.model = pinned;
  return {
    body: Buffer.from(JSON.stringify(parsed), 'utf8'),
    originalModel,
    swappedModel: pinned,
    streaming,
    json: true
  };
}

/**
 * Upstream statuses worth a second attempt. These are all "the gateway in
 * front of the model failed", never "your request was wrong": 520-527 are
 * Cloudflare's origin-failure family, 524 being the 120s read timeout.
 * 429 is deliberately absent — rate limits need real backoff, and the calling
 * tool already retries them.
 */
const RETRYABLE_STATUS = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 529]);

/**
 * How much of a retryable error response to hold back while deciding. These
 * pages are tiny (Cloudflare's 524 is ~900 bytes); anything larger is passed
 * through to the client instead of being retried.
 */
const RETRY_PEEK_BYTES = 64 * 1024;

/**
 * Accounts one request may try after the first when a provider is on auto
 * rotation. A pre-authorisation refusal costs nothing, but a relay wording an
 * outage as one would otherwise let a single request walk the entire inventory
 * marking every account spent. Three is enough to get past a genuinely empty
 * account or two; the rest of the pool waits for `ai-proxy keys check`.
 */
const MAX_KEY_WALK = 3;

/**
 * Forwards one request upstream and streams the response back.
 *
 * Resolves with `{ delivered: true }` once the client has been written to —
 * from that moment the exchange is final. Resolves with `{ delivered: false,
 * reason, statusCode }` when the attempt failed before a single byte reached
 * the client, which is the only situation where retrying is safe. `rotatedTo`
 * on that result names the key the pool switched to while this attempt was in
 * flight: the caller must send the request again on that account.
 *
 * @param {import('http').IncomingMessage} clientReq
 * @param {import('http').ServerResponse} clientRes
 * @param {Object} context - `canRetry` allows holding a gateway error back for
 *   another provider; `canWalk` allows holding a *refusal* back so an auto
 *   provider can answer from its next account.
 * @returns {Promise<{delivered:boolean, reason?:string, statusCode?:number|null, rotatedTo?:string|null}>}
 */
function forward(clientReq, clientRes, context) {
  const { target, headers, body, logId, settings, providerName, canRetry, canWalk, keyId } = context;
  const transport = target.isTls ? https : http;
  let bytesOut = 0;
  let settled = false;
  let upstreamStatus = null;
  let hardDeadline = null;
  let firstByteDeadline = null;
  let stallTimer = null;

  return new Promise(resolve => {
    /** Ends the attempt exactly once; `retry` decides who answers the client. */
    const finish = (result, retry = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardDeadline);
      clearTimeout(firstByteDeadline);
      clearTimeout(stallTimer);
      finishRequest(logId, { bytesOut, ...result });
      resolve(retry
        ? {
          delivered: false,
          reason: retry.reason,
          statusCode: retry.statusCode ?? null,
          // Set only by an auto rotation: the caller must send this request
          // again, on the account the pool has just switched to.
          rotatedTo: retry.rotatedTo ?? null
        }
        : { delivered: true });
    };

    /**
     * Reports a timeout. Retried when nothing has reached the client yet;
     * otherwise the client is told, because the stream is already half-sent.
     */
    const failTimeout = message => {
      Logger.error(`[${providerName}] ${message}`);
      const retryable = canRetry && !clientRes.headersSent;
      finish(
        { error: message, statusCode: upstreamStatus ?? 504 },
        retryable ? { reason: message, statusCode: upstreamStatus } : null
      );
      proxyReq.destroy();
      if (!retryable) sendProxyError(clientRes, 504, message, 'timeout');
    };

    const proxyReq = transport.request({
      hostname: target.hostname,
      port: target.port,
      path: target.path,
      method: clientReq.method,
      headers,
      agent: target.isTls ? HTTPS_AGENT : HTTP_AGENT
    });

    hardDeadline = setTimeout(
      () => failTimeout(`Upstream exceeded the ${Math.round(settings.upstreamTimeoutMs / 1000)}s hard timeout`),
      settings.upstreamTimeoutMs
    );

    // Phase 1 — nothing has come back yet. Providers behind a CDN are commonly
    // cut off by the edge at 100-120s, so failing first (and cleanly) beats
    // waiting for a 500-byte HTML error page.
    if (settings.upstreamFirstByteTimeoutMs > 0) {
      firstByteDeadline = setTimeout(
        () => failTimeout(
          `Upstream sent no response within ${Math.round(settings.upstreamFirstByteTimeoutMs / 1000)}s`
        ),
        settings.upstreamFirstByteTimeoutMs
      );
    }

    // Phase 2 — inactivity guard, armed at dispatch and re-armed on every chunk,
    // so it covers both "never answered" and "answered then went silent".
    // Deliberately NOT proxyReq.setTimeout(): that one is socket-scoped, and the
    // agent's own timeout lands on the socket first (see AGENT_OPTIONS).
    const armStallTimer = () => {
      clearTimeout(stallTimer);
      if (settings.upstreamStallTimeoutMs > 0) {
        stallTimer = setTimeout(
          () => failTimeout(
            `Upstream sent nothing for ${Math.round(settings.upstreamStallTimeoutMs / 1000)}s (stalled)`
          ),
          settings.upstreamStallTimeoutMs
        );
      }
    };
    armStallTimer();

    proxyReq.on('response', proxyRes => {
      upstreamStatus = proxyRes.statusCode;
      clearTimeout(firstByteDeadline);
      armStallTimer();
      const isStream = String(proxyRes.headers['content-type'] || '').includes('text/event-stream');
      const collect = !isStream && settings.captureBodies;
      let preview = '';

      const responseHeaders = { ...proxyRes.headers };
      delete responseHeaders.connection;
      delete responseHeaders['transfer-encoding'];

      // A retryable gateway error is held back rather than forwarded, so a
      // second provider still gets the chance to answer. Only these are
      // buffered — a normal reply is piped with no added latency.
      const peeking = canRetry && RETRYABLE_STATUS.has(proxyRes.statusCode);

      // A rejection that might be about the key (401/402/403/429) is held back
      // too — not to retry it, but because the reason is only in the body: the
      // relays answer "out of credit" with the same 403 a WAF uses. It is
      // classified once the body is complete and then delivered untouched.
      const inspecting = !peeking && !isStream && INSPECT_STATUS.has(proxyRes.statusCode);
      const holding = peeking || inspecting;
      const peeked = [];
      let peekedBytes = 0;

      /** Gives up on retrying and forwards what has been held back so far. */
      const flushAndPipe = () => {
        clientRes.writeHead(proxyRes.statusCode, responseHeaders);
        for (const chunk of peeked) clientRes.write(chunk);
        peeked.length = 0;
        proxyRes.pipe(clientRes, { end: true });
      };

      proxyRes.on('data', chunk => {
        if (bytesOut === 0) markFirstByte(logId);
        bytesOut += chunk.length;
        armStallTimer();
        if (collect && preview.length < 4000) preview += chunk.toString('utf8');
      });

      /**
       * Sends a response that was held back in full. Not flushAndPipe(): the
       * upstream stream has already ended, so piping it would never emit 'end'
       * and the client would wait for a body it already has.
       */
      const deliverHeld = () => {
        clientRes.writeHead(proxyRes.statusCode, responseHeaders);
        for (const chunk of peeked) clientRes.write(chunk);
        peeked.length = 0;
        clientRes.end();
      };

      if (holding) {
        proxyRes.on('data', chunk => {
          if (clientRes.headersSent) return;
          peeked.push(chunk);
          peekedBytes += chunk.length;
          // Too big to be an error page: treat it as a real response.
          if (peekedBytes > RETRY_PEEK_BYTES) flushAndPipe();
        });
      } else {
        clientRes.writeHead(proxyRes.statusCode, responseHeaders);
        proxyRes.pipe(clientRes, { end: true });
      }

      proxyRes.on('end', () => {
        if (preview) attachBody(logId, 'response', preview);
        const level = proxyRes.statusCode >= 400 ? 'warn' : 'info';
        Logger[level](`[${providerName}] ${proxyRes.statusCode} ${clientReq.method} ${target.path} (${bytesOut}B)`);

        if (peeking && !clientRes.headersSent) {
          finish(
            { statusCode: proxyRes.statusCode, streaming: isStream },
            { reason: `upstream returned ${proxyRes.statusCode}`, statusCode: proxyRes.statusCode }
          );
          return;
        }

        if (inspecting && !clientRes.headersSent) {
          const rejection = Buffer.concat(peeked);
          // Classified before the client is answered, because in auto mode the
          // verdict decides whether this response is the one the client gets at
          // all. The body is already complete and the classifier is a handful of
          // regexes, so the wait is a fraction of the round trip just made.
          const noted = noteUpstreamFailure({
            provider: providerName, keyId, statusCode: proxyRes.statusCode, body: rejection
          });
          const outcome = {
            statusCode: proxyRes.statusCode,
            streaming: isStream,
            keyVerdict: noted.status,
            keyRemaining: noted.status ? noted.verdict.remaining : null
          };

          // The pool moved on: nothing was billed for a refusal made before the
          // request ran, so the same request goes out again on the new account
          // and this response is never delivered.
          if (canWalk && noted.rotated) {
            const spent = noted.entry.label || noted.entry.id.slice(0, 8);
            finish(outcome, {
              reason: `key ${spent} is out of credit`,
              statusCode: proxyRes.statusCode,
              rotatedTo: noted.rotated.toKeyId
            });
            return;
          }

          deliverHeld();
          finish(outcome);
          return;
        }

        finish({ statusCode: proxyRes.statusCode, streaming: isStream });
      });
      proxyRes.on('error', error => {
        const retryable = canRetry && !clientRes.headersSent;
        finish(
          { statusCode: proxyRes.statusCode, error: error.message, streaming: isStream },
          retryable ? { reason: error.message, statusCode: proxyRes.statusCode } : null
        );
        if (!retryable) clientRes.destroy();
      });
    });

    proxyReq.on('error', error => {
      if (settled) return;
      const message = `${error.code ? `${error.code}: ` : ''}${error.message}`;
      Logger.error(`[${providerName}] upstream request failed — ${message}`);
      const retryable = canRetry && !clientRes.headersSent;
      finish({ error: message, statusCode: 502 }, retryable ? { reason: message, statusCode: 502 } : null);
      if (!retryable) {
        sendProxyError(clientRes, 502, `Could not reach ${target.hostname}: ${message}`, 'upstream_unreachable');
      }
    });

    // Client (Claude Code, VS Code, ...) gave up: stop paying for the upstream.
    clientRes.on('close', () => {
      if (!settled) {
        finish({ error: 'Client disconnected before the response completed' });
        proxyReq.destroy();
      }
    });

    if (body === null) {
      clientReq.pipe(proxyReq, { end: true });
    } else {
      if (body.length) proxyReq.write(body);
      proxyReq.end();
    }
  });
}

/**
 * Layer 3: resolve the provider, build the upstream request, forward it.
 * @param {import('http').IncomingMessage} clientReq
 * @param {import('http').ServerResponse} clientRes
 * @param {string} pathname
 * @param {string} search
 */
async function handleProxy(clientReq, clientRes, pathname, search) {
  // `config` is reassigned when an auto rotation rewrites it mid-request.
  let { ok, config, error } = tryLoadConfig();
  if (!ok) {
    Logger.error(error.message);
    return sendProxyError(clientRes, 500, error.message, 'config_error');
  }

  const settings = config.settings;
  const token = extractClientToken(clientReq.headers);
  const route = resolveRoute(config, token);

  // Fail before reading the body when there is nowhere to send it at all.
  if (!route.name || !config.providers[route.name]) {
    const message = Object.keys(config.providers).length
      ? `No active provider selected. Run: ai-proxy use <name>`
      : `No providers configured yet. Add one: ai-proxy add-provider <name> <url>`;
    const logId = startRequest({ method: clientReq.method, path: pathname + search, provider: route.name });
    finishRequest(logId, { statusCode: 503, error: message });
    return sendProxyError(clientRes, 503, message, 'not_configured');
  }

  const shouldBuffer = clientReq.method === 'POST' && isModelBearingPath(pathname);
  let raw = null;

  if (shouldBuffer) {
    try {
      raw = await readBody(clientReq);
    } catch (bodyError) {
      return sendProxyError(clientRes, bodyError.statusCode || 400, bodyError.message, 'invalid_request_error');
    }
  }

  // A body we did not buffer is streamed straight through, so it is gone once
  // the first attempt has consumed it — such a request can never be retried.
  const replayable = raw !== null || !hasRequestBody(clientReq);
  // A queue, not a fixed list: an auto-rotating provider that switches account
  // while this request is in flight puts the new account at the front of it.
  const queue = replayable
    ? buildAttemptPlan(config, route.name)
    : [{ provider: route.name, keyId: null }];
  const client = String(clientReq.headers['x-client-name'] || clientReq.headers['user-agent'] || '').slice(0, 120);
  let retryReason = null;
  let attempt = 0;
  let walked = 0;

  while (queue.length) {
    const { provider: candidate, keyId: wantedKeyId } = queue.shift();
    attempt++;
    const pool = config.providers[candidate]?.keys || [];
    // Only the first hop may fall back to the caller's own key; a failover
    // provider must use its own, or it would authenticate as the wrong user.
    // A step that names a key is one a rotation put here, so it wins over the
    // mirror — falling back to which is what keeps a vanished key from
    // stranding the request with nothing to send.
    const apiKey = wantedKeyId
      ? (pool.find(entry => entry.id === wantedKeyId)?.key || config.providers[candidate]?.apiKey || null)
      : (attempt === 1 ? route.key : (config.providers[candidate]?.apiKey || null));
    // Which pool entry that key is, if any: a caller-supplied inline key
    // belongs to no pool, and nothing that happens to it may be recorded
    // against one of ours.
    const keyEntry = pool.find(entry => entry.key === apiKey) || null;
    const step = prepareAttempt({ config, candidate, clientReq, pathname, search, raw, settings, apiKey });

    if (!step.ok) {
      // A misconfigured failover target is skipped rather than fatal.
      if (queue.length) {
        Logger.warn(`[${candidate}] skipped — ${step.message}`);
        continue;
      }
      const logId = startRequest({
        method: clientReq.method, path: pathname + search, provider: candidate, attempt, retryReason
      });
      finishRequest(logId, { statusCode: step.statusCode, error: step.message });
      return sendProxyError(clientRes, step.statusCode, step.message, step.type);
    }

    const { target, headers, body, override } = step;
    const logId = startRequest({
      method: clientReq.method,
      path: pathname + search,
      provider: candidate,
      keyId: keyEntry?.id || null,
      keyLabel: keyEntry?.label || null,
      targetHost: target.hostname,
      targetUrl: target.displayUrl,
      originalModel: override.originalModel,
      swappedModel: override.swappedModel,
      streaming: override.streaming,
      client,
      bytesIn: body ? body.length : 0,
      attempt,
      retryReason
    });

    noteKeyUsed(candidate, keyEntry?.id);
    if (body && settings.captureBodies) attachBody(logId, 'request', body.toString('utf8'));
    if (override.originalModel && override.swappedModel && override.originalModel !== override.swappedModel) {
      Logger.info(`[${candidate}] model ${override.originalModel} → ${override.swappedModel}`);
    }

    const result = await forward(clientReq, clientRes, {
      target, headers, body, logId, settings, providerName: candidate,
      canRetry: queue.length > 0,
      // Walking is bounded per request, and a body we could not buffer cannot
      // be sent a second time however sure the verdict is.
      canWalk: replayable && walked < MAX_KEY_WALK,
      keyId: keyEntry?.id || null
    });

    if (result.delivered) return;

    // Nothing reached the client, so another provider may still answer.
    retryReason = result.reason;

    if (result.rotatedTo) {
      // The pool switched account, so this provider gets another turn on the
      // new one. Re-read the config the monitor has just written, or the
      // mirror here would still name the account that is out of credit.
      walked++;
      const reloaded = tryLoadConfig();
      if (reloaded.ok) config = reloaded.config;
      queue.unshift({ provider: candidate, keyId: result.rotatedTo });
    }

    const next = queue[0];
    Logger.warn(`[${candidate}] attempt ${attempt} failed (${result.reason})`
      + (next
        ? ` — retrying with ${next.keyId ? `the next ${candidate} account` : next.provider}`
        : ''));
  }
}

/**
 * True when the incoming request carries a payload. Used to decide whether an
 * unbuffered body would have to be replayed on a retry (it cannot be).
 * @param {import('http').IncomingMessage} req
 * @returns {boolean}
 */
function hasRequestBody(req) {
  if (req.headers['transfer-encoding']) return true;
  return Number(req.headers['content-length'] || 0) > 0;
}

/**
 * Ordered steps to try for one request: the resolved provider first, then each
 * configured failover target. Returns a single step unless retrying is switched
 * on.
 *
 * A step is `{provider, keyId}`. `keyId` is null here — the plan chooses
 * providers, and which account a provider uses is the pool's business. Auto
 * rotation fills it in at the moment it switches, adding a step for the account
 * it moved to.
 * @param {Object} config
 * @param {string} primary - resolved provider name
 * @returns {Array<{provider: string, keyId: string|null}>}
 */
export function buildAttemptPlan(config, primary) {
  const step = provider => ({ provider, keyId: null });
  const { retryEnabled, retryMaxAttempts, failoverProviders } = config.settings;
  if (!retryEnabled || retryMaxAttempts < 2) return [step(primary)];

  const plan = [step(primary)];
  for (const name of failoverProviders) {
    if (plan.length >= retryMaxAttempts) break;
    if (name !== primary && config.providers[name]) plan.push(step(name));
  }
  // No usable failover target configured: try the same provider again, which
  // still helps against a one-off gateway hiccup.
  while (plan.length < retryMaxAttempts && plan.length < 2) plan.push(step(primary));
  return plan;
}

/**
 * Builds everything one attempt needs. The model override and the auth header
 * are per-provider, so this runs again for every candidate.
 * @param {Object} args
 * @returns {{ok:boolean, message?:string, statusCode?:number, type?:string,
 *   target?:Object, headers?:Object, body?:Buffer|null, override?:Object}}
 */
function prepareAttempt({ config, candidate, clientReq, pathname, search, raw, settings, apiKey }) {
  const provider = candidate ? config.providers[candidate] : null;
  if (!provider) {
    return {
      ok: false, statusCode: 503, type: 'not_configured',
      message: Object.keys(config.providers).length
        ? 'No active provider selected. Run: ai-proxy use <name>'
        : 'No providers configured yet. Add one: ai-proxy add-provider <name> <url>'
    };
  }

  let target;
  try {
    target = resolveUpstream(provider.url, pathname + search);
  } catch (urlError) {
    return {
      ok: false, statusCode: 500, type: 'config_error',
      message: `Provider '${candidate}' has an invalid URL: ${urlError.message}`
    };
  }

  if (!apiKey) {
    return {
      ok: false, statusCode: 401, type: 'authentication_error',
      message: `Provider '${candidate}' has no API key. Run: ai-proxy set-key ${candidate} <key>`
    };
  }

  const override = raw === null
    ? { body: null, originalModel: null, swappedModel: null, streaming: false }
    : applyModelOverride(raw, provider);
  const body = raw === null ? null : override.body;

  const headers = buildUpstreamHeaders({
    incoming: clientReq.headers,
    hostHeader: target.hostHeader,
    apiKey,
    spoof: settings.spoofHeaders !== false
  });
  if (body !== null) {
    headers['content-length'] = String(body.length);
  } else if (clientReq.headers['content-length']) {
    // Preserve the original framing; some upstreams reject chunked uploads.
    headers['content-length'] = clientReq.headers['content-length'];
  }

  return { ok: true, target, headers, body, override };
}

/**
 * Boots the server.
 * @param {{port?:number, host?:string, silent?:boolean, managePidFile?:boolean}} [options]
 * @returns {Promise<import('http').Server>} resolves once listening
 */
export function startProxyServer(options = {}) {
  try { migrateConfig(); } catch { /* a broken file is reported per request */ }

  const { config } = tryLoadConfig();
  // Port 0 is meaningful (bind any free port), so do not treat it as unset.
  const port = options.port === undefined || options.port === null
    ? (config.proxy_port || 8319)
    : Number(options.port);
  const host = options.host || '127.0.0.1';
  const managePidFile = options.managePidFile !== false;

  configureLogger(config.settings);
  if (config.settings.persistLogs) restorePersistedLogs();

  const server = http.createServer((clientReq, clientRes) => {
    const { pathname, search } = splitUrl(clientReq.url);

    // Browsers ask for this on every page load; answer locally instead of
    // proxying it upstream as a bogus API call.
    if (pathname === '/favicon.ico' || pathname === '/robots.txt') {
      clientRes.writeHead(204);
      return clientRes.end();
    }

    if (STATIC_ROUTES[pathname] || pathname.startsWith('/api/')) {
      if (!isLocalRequest(clientReq)) {
        clientRes.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        return clientRes.end(JSON.stringify({
          ok: false,
          error: 'Forbidden: the dashboard and API only accept requests from localhost.'
        }));
      }
    }

    if (serveStatic(clientRes, pathname)) return;

    if (pathname.startsWith('/api/')) {
      return handleApiRequest(clientReq, clientRes, pathname).catch(apiError => {
        Logger.error(`API error on ${pathname}: ${apiError.message}`);
        if (!clientRes.headersSent) {
          clientRes.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          clientRes.end(JSON.stringify({ ok: false, error: apiError.message }));
        }
      });
    }

    handleProxy(clientReq, clientRes, pathname, search).catch(proxyError => {
      Logger.error(`Proxy error on ${pathname}: ${proxyError.message}`);
      sendProxyError(clientRes, 500, proxyError.message);
    });
  });

  // Long-lived streaming responses must not be cut off by the default 5s
  // headers timeout or any request timeout.
  server.keepAliveTimeout = 76000;
  server.headersTimeout = 80000;
  server.requestTimeout = 0;

  return new Promise((resolve, reject) => {
    server.on('error', serverError => {
      if (serverError.code === 'EADDRINUSE') {
        const owner = findPortOwner(port);
        Logger.error(`Port ${port} is already in use.`);
        if (owner.pid) {
          Logger.info(`Held by PID ${owner.pid}${owner.command ? ` (${owner.command})` : ''}`);
          Logger.info(`Stop it with: ai-proxy stop   (or: kill ${owner.pid})`);
        } else {
          Logger.info(`Free it with: ai-proxy stop`);
        }
      } else {
        Logger.error(`Server error: ${serverError.message}`);
      }
      reject(serverError);
    });

    server.listen(port, host, () => {
      // With port 0 the kernel picks the port, so report what was really bound.
      const boundPort = server.address()?.port ?? port;
      setRuntime({ port: boundPort, host });
      if (managePidFile) writePidFile(boundPort);

      const shutdown = signal => {
        Logger.info(`Received ${signal} — shutting down.`);
        server.close(() => {
          if (managePidFile) removePidFile();
          process.exit(0);
        });
        // Client tools hold keep-alive sockets open; releasing the idle ones
        // lets the port be rebound in milliseconds instead of seconds.
        server.closeIdleConnections?.();
        // An in-flight streaming response can still hold the server open.
        setTimeout(() => {
          if (managePidFile) removePidFile();
          process.exit(0);
        }, 3000).unref();
      };
      if (managePidFile) {
        process.once('SIGINT', () => shutdown('SIGINT'));
        process.once('SIGTERM', () => shutdown('SIGTERM'));
      }

      if (!options.silent) {
        Logger.header('Smart Proxy Daemon Started');
        Logger.success(`Listening on http://${host}:${boundPort}`);
        Logger.info(`Dashboard:       http://${host}:${boundPort}`);
        Logger.info(`Active provider: ${config.active_provider || 'none (run: ai-proxy use <name>)'}`);
        Logger.info(`Providers:       ${Object.keys(config.providers).length}`);
        console.log('\nWaiting for requests… (Ctrl+C to stop)\n');
      }
      resolve(server);
    });
  });
}
