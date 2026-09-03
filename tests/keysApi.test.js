/**
 * The key pool over HTTP — what the dashboard banner is built on.
 *
 * The rule that matters here: this is the one surface a browser talks to, so a
 * key value must never appear in a response. Everything is addressed by id.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-proxy-keys-api-'));
process.env.AI_PROXY_HOME = home;
process.env.AI_PROXY_QUIET = '1';

const { saveConfig, loadConfig, clearConfigCache } = await import('../src/core/configManager.js');
const { deriveKeyId } = await import('../src/core/keyStore.js');
const { startProxyServer } = await import('../src/core/proxyServer.js');
const { noteUpstreamFailure, keyAlerts, resetKeyMonitor } = await import('../src/core/keyMonitor.js');

const KEY_A = 'sk-fake000000000000000000000000000000000000000a';
const KEY_B = 'sk-fake000000000000000000000000000000000000000b';
const KEY_C = 'sk-fake000000000000000000000000000000000000000c';
const ID_A = deriveKeyId(KEY_A);
const ID_B = deriveKeyId(KEY_B);
const ID_C = deriveKeyId(KEY_C);

const SPENT = '预扣费额度失败, 用户剩余额度: ＄0.710336, 需要预扣费额度: ＄0.800000';

let server;
let base;

before(async () => {
  seed();
  server = await startProxyServer({ port: 0, silent: true, managePidFile: false });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise(resolve => {
    server.close(() => resolve());
    server.closeAllConnections?.();
    setTimeout(resolve, 2000).unref();
  });
  fs.rmSync(home, { recursive: true, force: true });
});

function seed(extra = {}) {
  clearConfigCache();
  resetKeyMonitor();
  saveConfig({
    providers: {
      gorouter: {
        url: 'https://gorouter.app/v1',
        ...extra,
        keys: [
          { key: KEY_A, status: 'active', label: 'a@example.com', remaining: 55.34 },
          { key: KEY_B, status: 'unknown', label: 'b@example.com' },
          { key: KEY_C, status: 'invalid', label: 'c@example.com' }
        ]
      }
    },
    active_provider: 'gorouter'
  });
}

async function call(endpoint, options = {}) {
  const response = await fetch(`${base}${endpoint}`, {
    method: options.method || 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  return { status: response.status, data: await response.json() };
}

const pool = () => loadConfig({ fresh: true }).providers.gorouter;

test('GET /api/keys lists the pool without ever sending a key', async () => {
  seed();
  const response = await fetch(`${base}/api/keys`);
  const text = await response.text();
  const data = JSON.parse(text);

  assert.equal(response.status, 200);
  assert.equal(data.ok, true);
  const [provider] = data.providers;
  assert.equal(provider.name, 'gorouter');
  assert.equal(provider.total, 3);
  assert.equal(provider.spent, 0);
  assert.equal(provider.unusable, 1, 'the revoked key is counted apart');
  assert.deepEqual(provider.keys.map(k => k.id), [ID_A, ID_B, ID_C]);
  assert.deepEqual(provider.keys.map(k => k.inUse), [true, false, false]);
  assert.equal(provider.keys[0].masked, 'sk-fa…000a');
  assert.equal(provider.keys[0].remaining, 55.34);

  for (const key of [KEY_A, KEY_B, KEY_C]) {
    assert.ok(!text.includes(key), 'a key value must never reach the browser');
  }
});

test('an out-of-credit key shows up as an alert on the pool and on the status poll', async () => {
  seed();
  noteUpstreamFailure({ provider: 'gorouter', keyId: ID_A, statusCode: 403, body: SPENT });

  const keys = await call('/api/keys');
  assert.equal(keys.data.alerts.length, 1);
  assert.equal(keys.data.alerts[0].keyId, ID_A);
  assert.equal(keys.data.alerts[0].remaining, 0.710336);
  assert.equal(keys.data.providers[0].spent, 1);

  // The dashboard already polls /api/status, so the banner needs no second call.
  const status = await call('/api/status');
  assert.equal(status.data.keyAlerts.length, 1);
  assert.equal(status.data.keyAlerts[0].provider, 'gorouter');
});

test('POST next switches to the following key and clears the alert', async () => {
  seed();
  noteUpstreamFailure({ provider: 'gorouter', keyId: ID_A, statusCode: 403, body: SPENT });

  const response = await call('/api/keys/gorouter/next', { method: 'POST' });
  assert.equal(response.status, 200);
  assert.equal(response.data.to.id, ID_B);
  assert.equal(response.data.from.id, ID_A);
  assert.ok(!JSON.stringify(response.data).includes(KEY_B));

  assert.equal(pool().apiKey, KEY_B);
  assert.deepEqual(keyAlerts(), [], 'switching is the answer to the alert, so it goes away');
});

test('POST use pins the key it is given', async () => {
  seed();
  const response = await call('/api/keys/gorouter/use', { method: 'POST', body: { keyId: ID_B } });

  assert.equal(response.status, 200);
  assert.equal(response.data.to.id, ID_B);
  assert.equal(pool().selectedKeyId, ID_B);
});

test('POST use refuses a revoked key and says why', async () => {
  seed();
  const response = await call('/api/keys/gorouter/use', { method: 'POST', body: { keyId: ID_C } });

  assert.equal(response.status, 400);
  assert.match(response.data.error, /invalid/i);
  assert.ok(response.data.hint, 'the CLI hint is worth just as much in the browser');
  assert.equal(pool().selectedKeyId, '', 'a refused switch changes nothing');
});

test('POST retire marks the key in use as spent and moves on', async () => {
  seed();
  const response = await call('/api/keys/gorouter/retire', { method: 'POST' });

  assert.equal(response.status, 200);
  const provider = pool();
  assert.equal(provider.keys[0].status, 'exhausted');
  assert.equal(provider.apiKey, KEY_B);
});

test('an alert can be dismissed without switching', async () => {
  seed();
  noteUpstreamFailure({ provider: 'gorouter', keyId: ID_A, statusCode: 403, body: SPENT });

  const response = await call(`/api/keys/gorouter/alerts/${ID_A}`, { method: 'DELETE' });
  assert.equal(response.status, 200);
  assert.deepEqual(keyAlerts(), []);
  assert.equal(pool().apiKey, KEY_A, 'dismissing is not switching');
});

test('an unknown provider is a 400 that names the ones that exist', async () => {
  seed();
  const response = await call('/api/keys/nosuch/next', { method: 'POST' });

  assert.equal(response.status, 400);
  assert.match(response.data.error, /nosuch/);
  assert.match(response.data.hint, /gorouter/);
});

test('a pool with nothing left to switch to says so', async () => {
  seed();
  await call('/api/keys/gorouter/use', { method: 'POST', body: { keyId: ID_B } });
  const response = await call('/api/keys/gorouter/next', { method: 'POST' });

  assert.equal(response.status, 400);
  assert.match(response.data.error, /no usable key left/i);
  assert.equal(pool().selectedKeyId, ID_B, 'and leaves the pool as it was');
});

test('POST revive puts a topped-up account back in the pool as untested', async () => {
  seed();
  await call('/api/keys/gorouter/retire', { method: 'POST' });
  const response = await call('/api/keys/gorouter/revive', { method: 'POST', body: { keyId: ID_A } });

  assert.equal(response.status, 200);
  assert.equal(response.data.entry.status, 'unknown');
  const entry = pool().keys[0];
  assert.equal(entry.status, 'unknown');
  assert.equal(entry.remaining, null, 'the balance the proxy measured no longer holds');
});

// --- what the provider card reads -------------------------------------------
//
// The card is drawn from /api/providers, which the dashboard already polls. A
// pool summary rides along on it so the card can say "1 of 3 spent" without a
// second request every two seconds.

test('a provider carries a pool summary, still without a key value', async () => {
  seed();
  const response = await fetch(`${base}/api/providers`);
  const text = await response.text();
  const provider = JSON.parse(text).providers.find(entry => entry.name === 'gorouter');

  assert.equal(provider.keyCount, 3);
  assert.equal(provider.keysSpent, 0);
  assert.equal(provider.keysUnusable, 1, 'the invalid key cannot be switched to');
  assert.equal(provider.keyLabel, 'a@example.com', 'whose account is being billed right now');
  assert.equal(provider.keyRemaining, 55.34);
  assert.ok(!text.includes(KEY_A) && !text.includes(KEY_B), 'a key value reached the browser');
});

test('the summary counts a spent key once it is marked', async () => {
  seed();
  noteUpstreamFailure({ provider: 'gorouter', keyId: ID_A, statusCode: 403, body: SPENT });

  const { data } = await call('/api/providers');
  const provider = data.providers.find(entry => entry.name === 'gorouter');
  assert.equal(provider.keysSpent, 1);
  assert.equal(provider.keyLabel, 'a@example.com', 'manual mode: the spent key is still the one in use');
});

test('a provider with a single legacy key reports a pool of one', async () => {
  clearConfigCache();
  resetKeyMonitor();
  saveConfig({ providers: { solo: { url: 'https://solo.example/v1', apiKey: KEY_A } }, active_provider: 'solo' });

  const { data } = await call('/api/providers');
  const provider = data.providers.find(entry => entry.name === 'solo');
  assert.equal(provider.keyCount, 1);
  assert.equal(provider.keysSpent, 0);
  assert.equal(provider.keyLabel, '');
  seed();
});

// --- who does the switching --------------------------------------------------

test('the pool says whether the provider switches by itself', async () => {
  seed();
  const response = await call('/api/keys');
  assert.equal(response.data.providers[0].rotation, 'manual');
});

test('POST rotation hands a provider its own pool, and takes it back', async () => {
  seed();

  const on = await call('/api/keys/gorouter/rotation', { method: 'POST', body: { mode: 'auto' } });
  assert.equal(on.status, 200);
  assert.deepEqual({ mode: on.data.mode, changed: on.data.changed }, { mode: 'auto', changed: true });
  assert.equal(pool().keyRotation, 'auto');

  const off = await call('/api/keys/gorouter/rotation', { method: 'POST', body: { mode: 'manual' } });
  assert.equal(off.data.mode, 'manual');
  assert.equal(pool().keyRotation, 'manual');
});

test('a mode the proxy does not know is a 400, not a silent manual', async () => {
  seed({ keyRotation: 'auto' });

  const response = await call('/api/keys/gorouter/rotation', { method: 'POST', body: { mode: 'sometimes' } });

  assert.equal(response.status, 400);
  assert.match(response.data.hint, /manual|auto/);
  assert.equal(pool().keyRotation, 'auto', 'and the provider keeps the mode it had');
});

test('a switch the proxy made itself reaches the browser as news, not as a request', async () => {
  seed({ keyRotation: 'auto' });
  noteUpstreamFailure({ provider: 'gorouter', keyId: ID_A, statusCode: 403, body: SPENT });

  const response = await call('/api/keys');
  const [alert] = response.data.alerts;

  assert.equal(alert.keyId, ID_A);
  assert.equal(alert.switchedTo, 'b@example.com', 'the banner names the account now serving');
  assert.equal(response.data.providers[0].keys[1].inUse, true);
  assert.equal(pool().apiKey, KEY_B);
});

test('the provider card is told the mode, so it can say who will switch', async () => {
  seed({ keyRotation: 'auto' });

  const { data } = await call('/api/providers');
  const provider = data.providers.find(entry => entry.name === 'gorouter');

  assert.equal(provider.keyRotation, 'auto');
});
