/**
 * End-to-end proxy behaviour against a local fake upstream.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-proxy-proxy-'));
process.env.AI_PROXY_HOME = home;

const { saveConfig, clearConfigCache } = await import('../src/core/configManager.js');
const { startProxyServer } = await import('../src/core/proxyServer.js');
const { getLogs, resetLogger } = await import('../src/core/requestLogger.js');

let upstream;
let upstreamPort;
let proxy;
let proxyUrl;

/** Records what the upstream actually received. */
const received = [];

before(async () => {
  upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      received.push({ url: req.url, method: req.method, headers: req.headers, body });

      if (req.url.includes('/slow-stream')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"type":"message_start"}\n\n');
        setTimeout(() => res.end('data: [DONE]\n\n'), 30);
        return;
      }
      if (req.url.includes('/boom')) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'bad key' } }));
        return;
      }
      if (req.url.includes('/hang')) {
        // Accepts the request and never answers at all.
        res.writeHead(200, { 'content-type': 'application/json' });
        return;
      }
      if (req.url.includes('/half-stream')) {
        // Answers 200, emits an SSE preamble, then goes silent forever —
        // the failure mode that used to hang client tools indefinitely.
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
        return;
      }
      let parsed = null;
      try { parsed = body ? JSON.parse(body) : null; } catch { parsed = { raw: body }; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ echo: { url: req.url, body: parsed } }));
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  upstreamPort = upstream.address().port;

  saveConfig({
    providers: {
      primary: {
        url: `http://127.0.0.1:${upstreamPort}/openai/v1`,
        apiKey: 'sk-primary-key-0123456789',
        defaultModel: 'pinned-model',
        models: ['pinned-model']
      },
      passthrough: {
        url: `http://127.0.0.1:${upstreamPort}/v1`,
        apiKey: 'sk-passthrough-key-0123456',
        defaultModel: '',
        models: []
      },
      keyless: { url: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: '', defaultModel: '', models: [] }
    },
    active_provider: 'primary',
    settings: { upstreamStallTimeoutMs: 1500, upstreamTimeoutMs: 8000 }
  });

  proxy = await startProxyServer({ port: 0, silent: true, managePidFile: false });
  proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
});

after(async () => {
  await new Promise(resolve => proxy.close(resolve));
  await new Promise(resolve => upstream.close(resolve));
  fs.rmSync(home, { recursive: true, force: true });
});

/** Raw request, so forbidden headers such as Host can be set. */
function rawRequest(pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: proxy.address().port, path: pathname, method: 'GET', headers },
      res => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/** Sends a request through the proxy. */
function callProxy(pathname, options = {}) {
  return fetch(`${proxyUrl}${pathname}`, {
    method: options.method || 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${options.token ?? 'dummy-key-managed-by-proxy'}`,
      ...options.headers
    },
    body: options.body
  });
}

test('POST /v1/messages joins the base path and rewrites the model', async () => {
  received.length = 0;
  const response = await callProxy('/v1/messages', {
    body: JSON.stringify({ model: 'whatever-the-client-asked-for', messages: [] })
  });

  assert.equal(response.status, 200);
  const seen = received.at(-1);
  assert.equal(seen.url, '/openai/v1/messages', 'the provider path prefix is preserved');
  assert.equal(JSON.parse(seen.body).model, 'pinned-model');
});

test('both auth header styles are sent, with the stored key substituted', async () => {
  received.length = 0;
  await callProxy('/v1/messages', { body: JSON.stringify({ model: 'x', messages: [] }) });

  const seen = received.at(-1);
  assert.equal(seen.headers.authorization, 'Bearer sk-primary-key-0123456789');
  assert.equal(seen.headers['x-api-key'], 'sk-primary-key-0123456789');
  assert.equal(seen.headers.host, `127.0.0.1:${upstreamPort}`, 'Host carries the non-default port');
  assert.equal(seen.headers['user-agent'], 'codex_cli_rs/0.101.0', 'spoofed headers are applied');
});

test('an empty pinned model means pass-through', async () => {
  received.length = 0;
  const response = await callProxy('/v1/messages', {
    token: 'passthrough:dummy',
    body: JSON.stringify({ model: 'client-choice', messages: [] })
  });

  assert.equal(response.status, 200);
  const seen = received.at(-1);
  assert.equal(JSON.parse(seen.body).model, 'client-choice', 'the client model is untouched');
  assert.equal(seen.headers.authorization, 'Bearer sk-passthrough-key-0123456');
});

test('a provider:key token routes to that provider using the supplied key', async () => {
  received.length = 0;
  await callProxy('/v1/messages', {
    token: 'passthrough:sk-caller-supplied-key-999',
    body: JSON.stringify({ model: 'm', messages: [] })
  });

  const seen = received.at(-1);
  assert.equal(seen.url, '/v1/messages', 'routed to the passthrough provider');
  assert.equal(seen.headers.authorization, 'Bearer sk-caller-supplied-key-999');
});

test('a provider without a key fails fast with a usable error envelope', async () => {
  const response = await callProxy('/v1/messages', {
    token: 'keyless:dummy',
    body: JSON.stringify({ model: 'm', messages: [] })
  });

  assert.equal(response.status, 401);
  const data = await response.json();
  assert.equal(data.type, 'error');
  assert.match(data.error.message, /no API key/i);
  assert.match(data.error.message, /ai-proxy set-key keyless/);
});

test('a non-JSON body is forwarded untouched instead of being rejected', async () => {
  received.length = 0;
  const response = await callProxy('/v1/messages', {
    headers: { 'content-type': 'text/plain' },
    body: 'this is not json at all'
  });

  assert.equal(response.status, 200, 'the previous implementation answered 400 here');
  assert.equal(received.at(-1).body, 'this is not json at all');
});

test('non-model endpoints are streamed through without buffering', async () => {
  received.length = 0;
  const response = await callProxy('/v1/models', { method: 'GET', body: undefined });

  assert.equal(response.status, 200);
  assert.equal(received.at(-1).url, '/openai/v1/models');
});

test('server-sent events reach the client intact', async () => {
  const response = await callProxy('/v1/messages/slow-stream', {
    body: JSON.stringify({ model: 'm', stream: true, messages: [] })
  });

  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const text = await response.text();
  assert.match(text, /message_start/);
  assert.match(text, /\[DONE\]/);
});

test('dashboard assets and API routes ignore query strings', async () => {
  received.length = 0;
  const css = await fetch(`${proxyUrl}/style.css?v=2`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);

  const status = await fetch(`${proxyUrl}/api/status?t=1`);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).ok, true);

  assert.equal(received.length, 0, 'neither request may leak to the upstream provider');
});

test('the dashboard and API refuse non-local Host or Origin headers', async () => {
  // A rebound DNS name resolving to 127.0.0.1 still carries the attacker's Host.
  const rebound = await rawRequest('/api/providers', { host: 'attacker.example' });
  assert.equal(rebound.status, 403, 'stored API keys must not be readable via DNS rebinding');

  const dashboard = await rawRequest('/', { host: 'attacker.example' });
  assert.equal(dashboard.status, 403);

  const crossOrigin = await fetch(`${proxyUrl}/api/providers`, { headers: { origin: 'https://attacker.example' } });
  assert.equal(crossOrigin.status, 403);

  const sameOrigin = await fetch(`${proxyUrl}/api/providers`, { headers: { origin: proxyUrl } });
  assert.equal(sameOrigin.status, 200, 'the dashboard itself must still work');
});

test('requests are logged with provider, model swap, status and timings', async () => {
  resetLogger();
  await callProxy('/v1/messages', { body: JSON.stringify({ model: 'from-client', messages: [] }) });
  await callProxy('/v1/messages/boom', { body: JSON.stringify({ model: 'from-client', messages: [] }) });

  const logs = getLogs();
  assert.equal(logs.length, 2);

  const [first, second] = logs;
  assert.equal(first.provider, 'primary');
  assert.equal(first.originalModel, 'from-client');
  assert.equal(first.swappedModel, 'pinned-model');
  assert.equal(first.statusCode, 200);
  assert.ok(first.durationMs >= 0 && first.ttfbMs !== null, 'timings are captured');
  assert.ok(first.bytesOut > 0);

  assert.equal(second.statusCode, 401, 'upstream failures are recorded, not hidden');
});

test('an upstream that answers then goes silent is aborted, not left hanging', async () => {
  resetLogger();
  const startedAt = Date.now();
  const response = await callProxy('/v1/messages/hang', {
    body: JSON.stringify({ model: 'm', messages: [] })
  });
  const payload = await response.json();
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed < 4000, `the request must not hang; it finished in ${elapsed}ms`);
  assert.equal(response.status, 504);
  assert.equal(payload.error.type, 'timeout');
  assert.match(payload.error.message, /stalled/i);
  assert.match(getLogs().at(-1).error, /stalled/i, 'the reason is recorded for the dashboard');
});

test('a stream that dies mid-flight is closed instead of hanging the client', async () => {
  resetLogger();
  const startedAt = Date.now();
  const response = await callProxy('/v1/messages/half-stream', {
    body: JSON.stringify({ model: 'm', stream: true, messages: [] })
  });

  assert.equal(response.status, 200, 'the upstream had already sent its headers');
  // Reading drains until the proxy gives up; a truncated body may throw.
  const text = await response.text().catch(() => 'aborted');
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed < 4000, `the stream must be cut off; it ended after ${elapsed}ms`);
  assert.ok(text.includes('message_start') || text === 'aborted');
  assert.match(getLogs().at(-1).error, /stalled/i);
});

test('an unreachable upstream is reported as 502 and logged', async () => {
  clearConfigCache();
  saveConfig({
    providers: { dead: { url: 'http://127.0.0.1:1/v1', apiKey: 'sk-dead-key-0123456789', defaultModel: '' } },
    active_provider: 'dead'
  });
  resetLogger();

  const response = await callProxy('/v1/messages', { body: JSON.stringify({ model: 'm', messages: [] }) });
  assert.equal(response.status, 502);

  const data = await response.json();
  assert.equal(data.error.type, 'upstream_unreachable');

  const log = getLogs().at(-1);
  assert.equal(log.statusCode, 502);
  assert.match(log.error, /ECONNREFUSED/);
});

test('an empty provider set produces an actionable 503', async () => {
  clearConfigCache();
  saveConfig({ providers: {}, active_provider: null });

  const response = await callProxy('/v1/messages', { body: JSON.stringify({ model: 'm' }) });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error.message, /add-provider/);
});
