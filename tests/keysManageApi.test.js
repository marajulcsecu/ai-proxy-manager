/**
 * Managing the pool from the dashboard: add, correct, delete, reveal.
 *
 * Two rules are load-bearing here. A list response never carries a key value,
 * so everything is addressed by id — and exactly one route hands a key back,
 * because "which key is on which account" is a question the user has to be able
 * to answer without opening config.json.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-proxy-keysmanage-api-'));
process.env.AI_PROXY_HOME = home;
process.env.AI_PROXY_QUIET = '1';

const { saveConfig, loadConfig, clearConfigCache } = await import('../src/core/configManager.js');
const { deriveKeyId, readKeyVault } = await import('../src/core/keyStore.js');
const { startProxyServer } = await import('../src/core/proxyServer.js');

const KEY_A = 'sk-fake000000000000000000000000000000000000000a';
const KEY_B = 'sk-fake000000000000000000000000000000000000000b';
const NEW = 'sk-fakenew00000000000000000000000000000000000n';
const ID_A = deriveKeyId(KEY_A);
const ID_B = deriveKeyId(KEY_B);
const ID_NEW = deriveKeyId(NEW);

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

function seed() {
  clearConfigCache();
  saveConfig({
    providers: {
      gorouter: {
        url: 'https://gorouter.app/v1',
        keys: [
          { key: KEY_A, status: 'active', label: 'a@example.com', remaining: 55.34 },
          { key: KEY_B, status: 'unknown', label: 'b@example.com' }
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
  const text = await response.text();
  return { status: response.status, text, data: JSON.parse(text) };
}

const pool = () => loadConfig({ fresh: true }).providers.gorouter;

// --- add ---------------------------------------------------------------------

test('POST /api/keys/:name adds a key and says nothing about its value', async () => {
  seed();
  const response = await call('/api/keys/gorouter', {
    method: 'POST',
    body: { key: NEW, label: 'new@example.com', note: 'added from the browser' }
  });

  assert.equal(response.status, 200);
  assert.equal(response.data.entry.id, ID_NEW);
  assert.equal(response.data.entry.label, 'new@example.com');
  assert.equal(response.data.position, 3);
  assert.ok(!response.text.includes(NEW), 'the value the browser just sent must not come back');

  const keys = pool().keys;
  assert.deepEqual(keys.map(k => k.key), [KEY_A, KEY_B, NEW]);
  assert.equal(keys[2].status, 'unknown');
  assert.equal(keys[2].note, 'added from the browser');
  assert.equal(pool().apiKey, KEY_A, 'adding must not move the key in use');
});

test('POST with use:true starts sending the new key at once', async () => {
  seed();
  const response = await call('/api/keys/gorouter', {
    method: 'POST',
    body: { key: NEW, label: 'new@example.com', use: true }
  });

  assert.equal(response.data.inUse, true);
  assert.equal(pool().selectedKeyId, ID_NEW);
  assert.equal(pool().apiKey, NEW);
});

test('POST refuses a key the pool already has, and changes nothing', async () => {
  seed();
  const response = await call('/api/keys/gorouter', { method: 'POST', body: { key: KEY_A } });

  assert.equal(response.status, 400);
  assert.match(response.data.error, /already/i);
  assert.equal(pool().keys.length, 2);
});

test('POST without a key is a 400, not an empty entry', async () => {
  seed();
  const response = await call('/api/keys/gorouter', { method: 'POST', body: { label: 'oops@example.com' } });

  assert.equal(response.status, 400);
  assert.equal(pool().keys.length, 2);
});

test('POST to a provider that does not exist is a 400 naming the real ones', async () => {
  seed();
  const response = await call('/api/keys/nosuch', { method: 'POST', body: { key: NEW } });

  assert.equal(response.status, 400);
  assert.match(`${response.data.error} ${response.data.hint || ''}`, /gorouter/);
});

// --- edit --------------------------------------------------------------------

test('PATCH corrects the account a key belongs to', async () => {
  seed();
  const response = await call(`/api/keys/gorouter/${ID_B}`, {
    method: 'PATCH',
    body: { label: 'renamed@example.com', referralUrl: 'https://gorouter.app/register?aff=x' }
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.data.changed.sort(), ['label', 'referralUrl']);
  assert.equal(response.data.entry.label, 'renamed@example.com');
  assert.ok(!response.text.includes(KEY_B));

  const entry = pool().keys[1];
  assert.equal(entry.label, 'renamed@example.com');
  assert.equal(entry.status, 'unknown', 'an edit changes metadata, never state');
});

test('PATCH reports an unchanged edit instead of writing', async () => {
  seed();
  const response = await call(`/api/keys/gorouter/${ID_B}`, { method: 'PATCH', body: { label: 'b@example.com' } });

  assert.equal(response.status, 200);
  assert.deepEqual(response.data.changed, []);
});

test('PATCH will not set a status or a balance', async () => {
  seed();
  const response = await call(`/api/keys/gorouter/${ID_B}`, { method: 'PATCH', body: { status: 'active' } });

  assert.equal(response.status, 400);
  assert.match(`${response.data.error} ${response.data.hint || ''}`, /retire|revive/i);
  assert.equal(pool().keys[1].status, 'unknown');
});

test('PATCH on an id that is not in the pool is a 400', async () => {
  seed();
  const response = await call('/api/keys/gorouter/deadbeefdead', { method: 'PATCH', body: { label: 'x' } });
  assert.equal(response.status, 400);
});

// --- delete ------------------------------------------------------------------

test('DELETE without confirmation leaves the key alone', async () => {
  seed();
  const response = await call(`/api/keys/gorouter/${ID_B}`, { method: 'DELETE' });

  assert.equal(response.status, 400);
  assert.match(`${response.data.error} ${response.data.hint || ''}`, /confirm/i);
  assert.equal(pool().keys.length, 2);
});

test('DELETE ?confirm=1 removes the key but the vault keeps it', async () => {
  seed();
  const response = await call(`/api/keys/gorouter/${ID_B}?confirm=1`, { method: 'DELETE' });

  assert.equal(response.status, 200);
  assert.equal(response.data.entry.id, ID_B);
  assert.deepEqual(pool().keys.map(k => k.id), [ID_A]);
  assert.ok(readKeyVault().some(r => r.key === KEY_B), 'a deleted key is still recoverable');
});

test('deleting the key in use moves the selection on and reports where', async () => {
  seed();
  const response = await call(`/api/keys/gorouter/${ID_A}?confirm=1`, { method: 'DELETE' });

  assert.equal(response.data.movedTo.id, ID_B);
  assert.equal(pool().apiKey, KEY_B);
  assert.ok(!response.text.includes(KEY_A) && !response.text.includes(KEY_B));
});

// --- reveal ------------------------------------------------------------------

test('GET one key value is the single route that returns a key', async () => {
  seed();
  const response = await call(`/api/keys/gorouter/${ID_A}/value`);

  assert.equal(response.status, 200);
  assert.equal(response.data.apiKey, KEY_A);
  assert.equal(response.data.label, 'a@example.com');
  assert.equal(response.data.id, ID_A);
});

test('a key value is never in the list, even when one has just been revealed', async () => {
  seed();
  await call(`/api/keys/gorouter/${ID_A}/value`);
  const listed = await call('/api/keys');

  for (const key of [KEY_A, KEY_B]) {
    assert.ok(!listed.text.includes(key), 'the pool listing must stay masked');
  }
});

test('asking for the value of a key that is not there is a 400', async () => {
  seed();
  const response = await call('/api/keys/gorouter/deadbeefdead/value');
  assert.equal(response.status, 400);
});
