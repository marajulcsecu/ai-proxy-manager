/**
 * @fileoverview Sends one minimal, real request to a provider so the user can
 * tell "my key is wrong" apart from "this provider is down" apart from "that
 * model does not exist here".
 *
 * Cost is one token of output at most, and it only runs when explicitly asked.
 */

import http from 'http';
import https from 'https';
import { resolveUpstream } from './upstream.js';
import { buildUpstreamHeaders } from './headers.js';

const DEFAULT_TIMEOUT_MS = 20000;
const MAX_ERROR_TEXT = 400;

/**
 * @param {{protocol:string, hostname:string, port:number, path:string, hostHeader:string, isTls:boolean}} target
 * @param {Object} params
 * @returns {Promise<{statusCode:number, body:string, latencyMs:number}>}
 */
function send(target, { apiKey, spoof, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const headers = buildUpstreamHeaders({
      incoming: { accept: 'application/json', 'content-type': 'application/json' },
      hostHeader: target.hostHeader,
      apiKey,
      spoof
    });
    headers['content-length'] = String(payload.length);

    const transport = target.isTls ? https : http;
    const startedAt = Date.now();

    const req = transport.request(
      { hostname: target.hostname, port: target.port, path: target.path, method: 'POST', headers },
      res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          if (text.length < 8000) text += chunk;
        });
        res.on('end', () => resolve({ statusCode: res.statusCode, body: text, latencyMs: Date.now() - startedAt }));
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(Object.assign(new Error(`No response within ${Math.round(timeoutMs / 1000)}s`), { code: 'ETIMEDOUT' }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/** Pulls a human-readable message out of a provider's error payload. */
function extractMessage(body) {
  if (!body) return '';
  try {
    const parsed = JSON.parse(body);
    const message =
      parsed?.error?.message ||
      parsed?.error?.type ||
      parsed?.message ||
      parsed?.detail ||
      (typeof parsed?.error === 'string' ? parsed.error : '');
    if (message) return String(message).slice(0, MAX_ERROR_TEXT);
  } catch { /* not JSON — fall through to raw text */ }
  return String(body).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_TEXT);
}

/**
 * Maps a status code to a verdict the user can act on.
 * @param {number} statusCode
 * @param {string} message
 */
function interpret(statusCode, message) {
  if (statusCode >= 200 && statusCode < 300) return { ok: true, level: 'ok', summary: 'Key accepted, model responded' };
  if (statusCode === 401) return { ok: false, level: 'error', summary: 'Unauthorized — API key rejected' };
  if (statusCode === 402) return { ok: false, level: 'error', summary: 'Payment required — out of credit' };
  if (statusCode === 403) {
    return {
      ok: false,
      level: 'error',
      summary: /cloudflare|blocked|attention required/i.test(message)
        ? 'Blocked by the provider WAF (Cloudflare)'
        : 'Forbidden — key lacks access'
    };
  }
  if (statusCode === 404) return { ok: false, level: 'error', summary: 'Not found — check the base URL or model name' };
  if (statusCode === 429) return { ok: false, level: 'warn', summary: 'Rate limited — key works, quota exhausted' };
  if (statusCode === 400 || statusCode === 422) {
    return { ok: false, level: 'warn', summary: 'Provider reachable, request rejected (often an unknown model)' };
  }
  if (statusCode >= 500) return { ok: false, level: 'error', summary: `Provider error ${statusCode}` };
  return { ok: false, level: 'warn', summary: `Unexpected status ${statusCode}` };
}

/** Maps a socket-level failure to a verdict. */
function interpretNetworkError(error) {
  const code = error?.code || '';
  const map = {
    ENOTFOUND: 'Host not found — check the base URL',
    ECONNREFUSED: 'Connection refused — nothing is listening there',
    ETIMEDOUT: 'Timed out — provider did not respond',
    ECONNRESET: 'Connection reset by the provider',
    EPROTO: 'TLS handshake failed — is the scheme right (http vs https)?',
    CERT_HAS_EXPIRED: 'Provider TLS certificate has expired',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'Provider uses a self-signed certificate'
  };
  return { ok: false, level: 'error', summary: map[code] || `Network error: ${error?.message || 'unknown'}` };
}

/**
 * Tests one provider end to end.
 * @param {Object} provider - provider record from config
 * @param {Object} [options]
 * @param {string} [options.model] - override the model to probe
 * @param {boolean} [options.spoof=true]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ok:boolean, level:'ok'|'warn'|'error', summary:string, statusCode:number|null,
 *   latencyMs:number|null, endpoint:string|null, model:string|null, detail:string}>}
 */
export async function testProvider(provider, options = {}) {
  const spoof = options.spoof !== false;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const model = options.model || provider?.defaultModel || provider?.models?.[0] || null;

  if (!provider?.apiKey) {
    return {
      ok: false, level: 'error', summary: 'No API key saved for this provider',
      statusCode: null, latencyMs: null, endpoint: null, model, detail: ''
    };
  }
  if (!model) {
    return {
      ok: false, level: 'warn', summary: 'No model configured — add one before testing',
      statusCode: null, latencyMs: null, endpoint: null, model: null, detail: ''
    };
  }

  // Anthropic shape first (this proxy's primary use case), then OpenAI shape.
  const attempts = [
    { path: '/v1/messages', body: { model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] } },
    { path: '/v1/chat/completions', body: { model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] } }
  ];

  let last = null;
  for (const attempt of attempts) {
    let target;
    try {
      target = resolveUpstream(provider.url, attempt.path);
    } catch (error) {
      return {
        ok: false, level: 'error', summary: error.message,
        statusCode: null, latencyMs: null, endpoint: null, model, detail: ''
      };
    }

    try {
      const response = await send(target, { apiKey: provider.apiKey, spoof, body: attempt.body, timeoutMs });
      const detail = extractMessage(response.body);
      const verdict = interpret(response.statusCode, detail);
      last = {
        ...verdict,
        statusCode: response.statusCode,
        latencyMs: response.latencyMs,
        endpoint: target.displayUrl,
        model,
        detail
      };
      // A 404/405 usually just means "wrong API shape" — try the other one.
      if (verdict.ok || ![404, 405].includes(response.statusCode)) return last;
    } catch (error) {
      last = {
        ...interpretNetworkError(error),
        statusCode: null,
        latencyMs: null,
        endpoint: target.displayUrl,
        model,
        detail: error?.message ? String(error.message).slice(0, MAX_ERROR_TEXT) : ''
      };
      // Network failures will not improve on the second endpoint.
      return last;
    }
  }

  return last;
}
