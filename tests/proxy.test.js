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
// The server shares stdout with the test reporter; keep it quiet.
process.env.AI_PROXY_QUIET = '1';

const { saveConfig, clearConfigCache } = await import('../src/core/configManager.js');
const { startProxyServer } = await import('../src/core/proxyServer.js');
const { getLogs, resetLogger } = await import('../src/core/requestLogger.js');

let upstream;
let upstreamPort;
let proxy;
let proxyUrl;

/** Records what the upstream actually received. */
const received = [];

/** Controls how many times the /flaky route fails before answering. */
const flaky = { remaining: 0 };

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
      if (req.url.includes('flaky=1')) {
        // Fails with a Cloudflare-style gateway error until the counter runs
        // out, then answers normally. Lets a test watch a retry succeed.
        if (flaky.remaining > 0) {
          flaky.remaining--;
          res.writeHead(524, { 'content-type': 'text/html' });
          res.end('<html>Error 524: A timeout occurred</html>');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, servedBy: req.headers['x-api-key'] }));
        return;
      }
      if (req.url.includes('fail=524')) {
        res.writeHead(524, { 'content-type': 'text/html' });
        res.end('<html>Error 524: A timeout occurred</html>');
        return;
      }
      if (req.url.includes('/blackhole')) {
        // Accepts the request and never sends response headers either — what a
        // CDN-fronted provider looks like while it is still thinking.
        return;
      }
      if (req.url.includes('/trickle')) {
        // Streams slowly but steadily: the total run exceeds the stall timeout
        // while no single gap does. Must NOT be aborted.
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        let sent = 0;
        const tick = setInterval(() => {
          if (++sent > 4) {
            clearInterval(tick);
            res.end('data: [DONE]\n\n');
            return;
          }
          res.write(`data: {"chunk":${sent}}\n\n`);
        }, 600);
        res.on('close', () => clearInterval(tick));
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
  // The stall tests deliberately leave a response open, and fetch() keeps its
  // sockets alive, so close() alone can wait indefinitely.
  await shutdown(proxy);
  await shutdown(upstream);
  fs.rmSync(home, { recursive: true, force: true });
});

/**
 * Closes a server without waiting on lingering keep-alive or stalled sockets.
 * @param {import('http').Server} server
 * @returns {Promise<void>}
 */
function shutdown(server) {
  return new Promise(resolve => {
    server.close(() => resolve());
    server.closeAllConnections?.();
    setTimeout(resolve, 2000).unref();
  });
}

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

test('the first-byte deadline cuts a provider that never starts answering', async () => {
  clearConfigCache();
  saveConfig({
    providers: {
      slowedge: {
        url: `http://127.0.0.1:${upstreamPort}/v1`,
        apiKey: 'sk-test-slowedge-0123456789',
        defaultModel: ''
      }
    },
    active_provider: 'slowedge',
    settings: { upstreamFirstByteTimeoutMs: 700, upstreamStallTimeoutMs: 5000, upstreamTimeoutMs: 20000 }
  });
  resetLogger();

  const startedAt = Date.now();
  const response = await callProxy('/v1/messages/blackhole', {
    body: JSON.stringify({ model: 'm', messages: [] })
  });
  const elapsed = Date.now() - startedAt;
  const payload = await response.json();

  assert.equal(response.status, 504);
  assert.equal(payload.error.type, 'timeout');
  assert.match(payload.error.message, /no response within/i);
  assert.ok(elapsed < 3000, `cut by the first-byte deadline, not the stall timer (${elapsed}ms)`);
  assert.match(getLogs().at(-1).error, /no response within/i);
});

test('a silent provider is still aborted when the first-byte deadline is off', async () => {
  clearConfigCache();
  saveConfig({
    providers: {
      slowedge: {
        url: `http://127.0.0.1:${upstreamPort}/v1`,
        apiKey: 'sk-test-slowedge-0123456789',
        defaultModel: ''
      }
    },
    active_provider: 'slowedge',
    settings: { upstreamFirstByteTimeoutMs: 0, upstreamStallTimeoutMs: 900, upstreamTimeoutMs: 20000 }
  });
  resetLogger();

  const startedAt = Date.now();
  const response = await callProxy('/v1/messages/blackhole', {
    body: JSON.stringify({ model: 'm', messages: [] })
  });
  const elapsed = Date.now() - startedAt;

  assert.equal(response.status, 504);
  assert.match((await response.json()).error.message, /stalled/i);
  assert.ok(elapsed < 5000, `the stall timer covers pre-header silence too (${elapsed}ms)`);
});

test('a slow but steady stream outlives the stall timeout', async () => {
  clearConfigCache();
  saveConfig({
    providers: {
      trickler: {
        url: `http://127.0.0.1:${upstreamPort}/v1`,
        apiKey: 'sk-test-trickler-0123456789',
        defaultModel: ''
      }
    },
    active_provider: 'trickler',
    settings: { upstreamFirstByteTimeoutMs: 0, upstreamStallTimeoutMs: 1200, upstreamTimeoutMs: 20000 }
  });
  resetLogger();

  const startedAt = Date.now();
  const response = await callProxy('/v1/messages/trickle', {
    body: JSON.stringify({ model: 'm', stream: true, messages: [] })
  });
  const text = await response.text();
  const elapsed = Date.now() - startedAt;

  assert.equal(response.status, 200);
  assert.ok(elapsed > 1200, `the stream ran longer than one stall window (${elapsed}ms)`);
  assert.match(text, /\[DONE\]/, 'the stream completed instead of being aborted mid-flight');
  assert.equal(getLogs().at(-1).error, null, 'a steady stream is not recorded as a stall');
});

test('the upstream agents carry no hidden socket timeout', async () => {
  const { HTTP_AGENT, HTTPS_AGENT } = await import('../src/core/proxyServer.js');
  for (const agent of [HTTP_AGENT, HTTPS_AGENT]) {
    assert.equal(agent.options.timeout, 0, 'node globalAgent defaults to 5000ms and would fire first');
    assert.equal(agent.keepAlive, true);
  }
});

/** Config with two providers and retry switched on, for the failover tests. */
function saveRetryConfig(overrides = {}) {
  clearConfigCache();
  saveConfig({
    providers: {
      flaky: {
        url: `http://127.0.0.1:${upstreamPort}/v1`,
        apiKey: 'sk-test-flaky-0123456789',
        defaultModel: 'flaky-model',
        models: ['flaky-model']
      },
      backup: {
        url: `http://127.0.0.1:${upstreamPort}/v1`,
        apiKey: 'sk-test-backup-0123456789',
        defaultModel: 'backup-model',
        models: ['backup-model']
      }
    },
    active_provider: 'flaky',
    settings: {
      upstreamFirstByteTimeoutMs: 0,
      upstreamStallTimeoutMs: 5000,
      upstreamTimeoutMs: 20000,
      retryEnabled: true,
      retryMaxAttempts: 2,
      failoverProviders: ['backup'],
      ...overrides
    }
  });
}

test('retrying is off unless it is switched on', async () => {
  clearConfigCache();
  saveConfig({
    providers: { flaky: { url: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'sk-test-flaky-0123456789', defaultModel: '' } },
    active_provider: 'flaky',
    settings: { retryEnabled: false, failoverProviders: ['backup'] }
  });
  resetLogger();
  flaky.remaining = 5;

  const response = await callProxy('/v1/messages?flaky=1', { body: JSON.stringify({ model: 'm', messages: [] }) });

  assert.equal(response.status, 524, 'the gateway error reaches the client untouched');
  assert.equal(getLogs().length, 1, 'exactly one attempt was made');
});

test('a retryable gateway error fails over to the next provider', async () => {
  saveRetryConfig();
  resetLogger();
  received.length = 0;
  flaky.remaining = 1; // first attempt fails, the retry succeeds

  const response = await callProxy('/v1/messages?flaky=1', { body: JSON.stringify({ model: 'm', messages: [] }) });
  const payload = await response.json();

  assert.equal(response.status, 200, 'the client never sees the 524');
  assert.equal(payload.ok, true);
  assert.equal(payload.servedBy, 'sk-test-backup-0123456789', 'the retry used the failover provider key');

  const logs = getLogs();
  assert.equal(logs.length, 2, 'both attempts are recorded');
  assert.deepEqual(logs.map(l => l.provider), ['flaky', 'backup']);
  assert.deepEqual(logs.map(l => l.attempt), [1, 2]);
  assert.equal(logs[0].statusCode, 524);
  assert.equal(logs[1].statusCode, 200);
  assert.match(logs[1].retryReason, /524/, 'the retry records why it happened');
  assert.equal(logs[1].swappedModel, 'backup-model', "the failover provider's own model pin is applied");
});

test('the last attempt delivers its error instead of swallowing it', async () => {
  saveRetryConfig();
  resetLogger();
  flaky.remaining = 0;

  const response = await callProxy('/v1/messages?fail=524', { body: JSON.stringify({ model: 'm', messages: [] }) });
  const text = await response.text();

  assert.equal(response.status, 524, 'when every provider fails the client is told');
  assert.match(text, /524/);
  assert.equal(getLogs().length, 2, 'both providers were tried');
});

test('a response already being streamed is never retried', async () => {
  saveRetryConfig({ upstreamStallTimeoutMs: 900 });
  resetLogger();

  const response = await callProxy('/v1/messages/half-stream', {
    body: JSON.stringify({ model: 'm', stream: true, messages: [] })
  });
  await response.text().catch(() => '');

  assert.equal(response.status, 200, 'the headers had already gone out');
  assert.equal(getLogs().length, 1, 'a half-sent stream must not be re-sent to another provider');
});

test('an unreachable provider fails over too', async () => {
  clearConfigCache();
  saveConfig({
    providers: {
      dead: { url: 'http://127.0.0.1:1/v1', apiKey: 'sk-test-dead-0123456789', defaultModel: '' },
      backup: { url: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'sk-test-backup-0123456789', defaultModel: '' }
    },
    active_provider: 'dead',
    settings: { retryEnabled: true, retryMaxAttempts: 2, failoverProviders: ['backup'] }
  });
  resetLogger();

  const response = await callProxy('/v1/messages', { body: JSON.stringify({ model: 'm', messages: [] }) });

  assert.equal(response.status, 200);
  const logs = getLogs();
  assert.equal(logs.length, 2);
  assert.match(logs[0].error, /ECONNREFUSED/);
  assert.match(logs[1].retryReason, /ECONNREFUSED/);
});

test('buildAttemptPlan honours the attempt cap and skips unknown providers', async () => {
  const { buildAttemptPlan } = await import('../src/core/proxyServer.js');
  const config = name => ({
    providers: { a: {}, b: {}, c: {} },
    settings: {
      retryEnabled: true, retryMaxAttempts: 3,
      failoverProviders: ['b', 'nope', 'c'], ...name
    }
  });

  assert.deepEqual(buildAttemptPlan(config(), 'a'), ['a', 'b', 'c']);
  assert.deepEqual(buildAttemptPlan(config({ retryMaxAttempts: 2 }), 'a'), ['a', 'b']);
  assert.deepEqual(buildAttemptPlan(config({ retryEnabled: false }), 'a'), ['a'], 'off means one attempt');
  assert.deepEqual(
    buildAttemptPlan(config({ failoverProviders: [] }), 'a'), ['a', 'a'],
    'with no failover target the same provider is retried once'
  );
  assert.deepEqual(buildAttemptPlan(config({ failoverProviders: ['a'] }), 'a'), ['a', 'a'], 'self is not a failover');
});

test('a streamed body is never retried, because it cannot be replayed', async () => {
  saveRetryConfig();
  resetLogger();
  received.length = 0;

  // /v1/files is not a model-bearing path, so the proxy pipes the body straight
  // through instead of buffering it — there is nothing left to re-send.
  const response = await callProxy('/v1/files?fail=524', { body: JSON.stringify({ payload: 'x'.repeat(200) }) });

  assert.equal(response.status, 524, 'the error is delivered rather than retried blindly');
  assert.equal(getLogs().length, 1, 'exactly one attempt');
  assert.equal(received.length, 1, 'the upstream was called once');
  assert.equal(received[0].body.length, JSON.stringify({ payload: 'x'.repeat(200) }).length, 'the streamed body arrived intact');
});
