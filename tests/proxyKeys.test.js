/**
 * What the proxy does with the key it just used, end to end.
 *
 * The relays in use are New-API forks: they pre-authorise an estimated cost and
 * refuse *before billing* when the balance is short, quoting both numbers in a
 * 403 body. So the status code alone is worthless — a 403 is equally a WAF page
 * — and the body has to be read. These tests pin both halves: the confirmed
 * message marks the key, and everything else leaves it alone.
 *
 * The client must never notice. In manual mode the original response is
 * delivered untouched, byte for byte.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-proxy-keys-'));
process.env.AI_PROXY_HOME = home;
process.env.AI_PROXY_QUIET = '1';

const { saveConfig, loadConfig, clearConfigCache } = await import('../src/core/configManager.js');
const { deriveKeyId } = await import('../src/core/keyStore.js');
const { startProxyServer } = await import('../src/core/proxyServer.js');
const { getLogs, resetLogger } = await import('../src/core/requestLogger.js');
const { keyAlerts, resetKeyMonitor } = await import('../src/core/keyMonitor.js');

const KEY_A = 'sk-fake000000000000000000000000000000000000000a';
const KEY_B = 'sk-fake000000000000000000000000000000000000000b';
const ID_A = deriveKeyId(KEY_A);

/** Verbatim from gorouter, in the JSON envelope the relay actually sends. */
const SPENT_BODY = JSON.stringify({
  error: {
    message: '预扣费额度失败, 用户剩余额度: ＄0.710336, 需要预扣费额度: ＄0.800000',
    type: 'one_api_error'
  }
});
const WAF_BODY = '<html><head><title>403 Forbidden</title></head><body>cloudflare</body></html>';
const REVOKED_BODY = JSON.stringify({ error: { message: '令牌无效', type: 'one_api_error' } });
/** Bigger than RETRY_PEEK_BYTES, so the held-back body has to be given up on. */
const HUGE_BODY = SPENT_BODY + ' '.repeat(70 * 1024);

let upstream;
let proxy;
let proxyUrl;

/** Keys the upstream was actually shown, newest last. */
const seen = [];

before(async () => {
  upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push(req.headers['x-api-key'] || req.headers.authorization || '');
      const send = (status, body, type = 'application/json') => {
        res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) });
        res.end(body);
      };
      if (req.url.includes('spent')) return send(403, SPENT_BODY);
      if (req.url.includes('huge')) return send(403, HUGE_BODY);
      if (req.url.includes('waf')) return send(403, WAF_BODY, 'text/html');
      if (req.url.includes('revoked')) return send(401, REVOKED_BODY);
      return send(200, JSON.stringify({ ok: true }));
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));

  seedPool();
  proxy = await startProxyServer({ port: 0, silent: true, managePidFile: false });
  proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
});

after(async () => {
  await new Promise(resolve => {
    proxy.close(() => resolve());
    proxy.closeAllConnections?.();
    setTimeout(resolve, 2000).unref();
  });
  await new Promise(resolve => {
    upstream.close(() => resolve());
    upstream.closeAllConnections?.();
    setTimeout(resolve, 2000).unref();
  });
  fs.rmSync(home, { recursive: true, force: true });
});

/** A fresh two-key pool with the first key in use. */
function seedPool() {
  clearConfigCache();
  resetKeyMonitor();
  resetLogger();
  seen.length = 0;
  saveConfig({
    providers: {
      gorouter: {
        url: `http://127.0.0.1:${upstream.address().port}/v1`,
        keys: [
          { key: KEY_A, status: 'active', label: 'a@example.com' },
          { key: KEY_B, status: 'unknown', label: 'b@example.com' }
        ]
      }
    },
    active_provider: 'gorouter'
  });
}

const pool = () => loadConfig({ fresh: true }).providers.gorouter;

/** One request through the proxy. */
function call(pathname, headers = {}) {
  return fetch(`${proxyUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 100, messages: [] })
  });
}

test('the confirmed 403 marks the key and parses the balance', async () => {
  seedPool();
  const response = await call('/v1/messages?route=spent');

  assert.equal(response.status, 403, 'the client sees the upstream status, unchanged');
  assert.equal(await response.text(), SPENT_BODY, 'and the body it would have got without the proxy');

  const provider = pool();
  assert.equal(provider.keys[0].status, 'exhausted');
  assert.equal(provider.keys[0].remaining, 0.710336);
  assert.equal(provider.keys[0].needed, 0.8);
});

test('in manual mode the spent key stays in use until the user switches', async () => {
  seedPool();
  await call('/v1/messages?route=spent');
  await call('/v1/messages?route=spent');

  assert.equal(pool().apiKey, KEY_A, 'no silent rotation: the user decides');
  assert.deepEqual(seen, [KEY_A, KEY_A]);
});

test('the user is alerted once, with the numbers needed to decide', async () => {
  seedPool();
  await call('/v1/messages?route=spent');
  await call('/v1/messages?route=spent');

  const alerts = keyAlerts();
  assert.equal(alerts.length, 1, 'one alert per key, not one per rejected request');
  assert.equal(alerts[0].keyId, ID_A);
  assert.equal(alerts[0].label, 'a@example.com');
  assert.equal(alerts[0].remaining, 0.710336);
});

test('the request row records which key was used and what happened to it', async () => {
  seedPool();
  await call('/v1/messages?route=spent');

  const row = getLogs()[0];
  assert.equal(row.statusCode, 403);
  assert.equal(row.keyId, ID_A);
  assert.equal(row.keyLabel, 'a@example.com');
  assert.equal(row.keyVerdict, 'exhausted');
  assert.equal(row.keyRemaining, 0.710336);
  assert.ok(!JSON.stringify(row).includes(KEY_A), 'the log never carries a key value');
});

test('a 403 that is not about the balance leaves the key alone', async () => {
  seedPool();
  const response = await call('/v1/messages?route=waf');

  assert.equal(response.status, 403);
  assert.equal(await response.text(), WAF_BODY);
  assert.equal(pool().keys[0].status, 'active', 'a WAF page must never retire a working key');
  assert.deepEqual(keyAlerts(), []);
  assert.equal(getLogs()[0].keyVerdict, null);
});

test('a revoked key is marked invalid and the client still gets its 401', async () => {
  seedPool();
  const response = await call('/v1/messages?route=revoked');

  assert.equal(response.status, 401);
  assert.equal(await response.text(), REVOKED_BODY);
  const provider = pool();
  assert.equal(provider.keys[0].status, 'invalid');
  assert.equal(provider.apiKey, KEY_B, 'a revoked key can never work again, so the pool moves on');
});

test('a successful request is not held back and does not touch the pool', async () => {
  seedPool();
  const response = await call('/v1/messages');

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(pool().keys[0].status, 'active');
  assert.equal(getLogs()[0].keyId, ID_A, 'the key is still recorded, so usage can be attributed');
});

test('an error page too big to hold back is still delivered whole', async () => {
  seedPool();
  const response = await call('/v1/messages?route=huge');
  const body = await response.text();

  assert.equal(response.status, 403);
  assert.equal(body.length, HUGE_BODY.length, 'nothing may be lost when the peek buffer overflows');
  assert.equal(body, HUGE_BODY);
});

test('a caller who supplies their own key is not charged against the pool', async () => {
  seedPool();
  const response = await call('/v1/messages?route=spent', { 'x-api-key': `gorouter:${'sk-caller-supplied-00000000000'}` });

  assert.equal(response.status, 403);
  assert.equal(pool().keys[0].status, 'active', 'the key that failed was not one of ours');
  assert.equal(getLogs()[0].keyId, null);
  assert.deepEqual(keyAlerts(), []);
});
