/**
 * REST API contract used by the dashboard.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-proxy-api-'));
process.env.AI_PROXY_HOME = home;
// The server shares stdout with the test reporter; keep it quiet.
process.env.AI_PROXY_QUIET = '1';

const { saveConfig, loadConfig } = await import('../src/core/configManager.js');
const { startProxyServer } = await import('../src/core/proxyServer.js');

let server;
let base;

before(async () => {
  saveConfig({ providers: {}, active_provider: null });
  server = await startProxyServer({ port: 0, silent: true, managePidFile: false });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  // fetch() holds keep-alive sockets open, which server.close() waits for.
  await new Promise(resolve => {
    server.close(() => resolve());
    server.closeAllConnections?.();
    setTimeout(resolve, 2000).unref();
  });
  fs.rmSync(home, { recursive: true, force: true });
});

/**
 * @param {string} endpoint
 * @param {{method?:string, body?:Object}} [options]
 * @returns {Promise<{status:number, data:Object}>}
 */
async function call(endpoint, options = {}) {
  const response = await fetch(`${base}${endpoint}`, {
    method: options.method || 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  return { status: response.status, data: await response.json() };
}

test('POST /api/providers validates its input', async () => {
  const noName = await call('/api/providers', { method: 'POST', body: { url: 'https://x/v1' } });
  assert.equal(noName.status, 400);
  assert.match(noName.data.error, /name is required/i);

  const badUrl = await call('/api/providers', { method: 'POST', body: { name: 'x', url: 'not a url at all' } });
  assert.equal(badUrl.status, 400);

  const badProtocol = await call('/api/providers', { method: 'POST', body: { name: 'x', url: 'ftp://x/v1' } });
  assert.equal(badProtocol.status, 400);
  assert.match(badProtocol.data.error, /Unsupported protocol/);
});

test('a provider is created, auto-activated and listed without its key', async () => {
  const created = await call('/api/providers', {
    method: 'POST',
    body: { name: 'Acme Router', url: 'https://acme.test/v1', apiKey: 'sk-acme-key-0123456789', defaultModel: 'opus' }
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.name, 'acmerouter', 'the name is normalized');

  const list = await call('/api/providers');
  const provider = list.data.providers[0];
  assert.equal(provider.name, 'acmerouter');
  assert.equal(provider.isActive, true, 'the first provider becomes active automatically');
  assert.equal(provider.hasKey, true);
  assert.equal(provider.urlValid, true);
  assert.equal(provider.host, 'acme.test');
  assert.deepEqual(provider.models, ['opus'], 'the pinned model is added to the list');
  assert.equal(provider.apiKey, undefined, 'the list endpoint must never leak keys');
  assert.match(provider.keyPreview, /^sk-ac…6789$/);
});

test('creating the same provider twice is a conflict, not a silent overwrite', async () => {
  const again = await call('/api/providers', {
    method: 'POST', body: { name: 'acmerouter', url: 'https://other.test/v1' }
  });
  assert.equal(again.status, 409);
  assert.equal(loadConfig({ fresh: true }).providers.acmerouter.url, 'https://acme.test/v1');
});

test('PUT keeps the stored key when none is supplied', async () => {
  const updated = await call('/api/providers/acmerouter', {
    method: 'PUT', body: { url: 'https://acme.test/openai/v1' }
  });
  assert.equal(updated.status, 200);

  const config = loadConfig({ fresh: true });
  assert.equal(config.providers.acmerouter.url, 'https://acme.test/openai/v1');
  assert.equal(config.providers.acmerouter.apiKey, 'sk-acme-key-0123456789', 'the key survives an edit');
});

test('the key can be revealed explicitly', async () => {
  const revealed = await call('/api/providers/acmerouter/key');
  assert.equal(revealed.data.apiKey, 'sk-acme-key-0123456789');

  const missing = await call('/api/providers/nope/key');
  assert.equal(missing.status, 404);
});

test('models can be added, switched, set to pass-through and removed', async () => {
  await call('/api/providers/acmerouter/models', { method: 'POST', body: { model: 'sonnet' } });

  const duplicate = await call('/api/providers/acmerouter/models', { method: 'POST', body: { model: 'sonnet' } });
  assert.equal(duplicate.status, 409);

  await call('/api/providers/acmerouter/model', { method: 'POST', body: { model: 'sonnet' } });
  assert.equal(loadConfig({ fresh: true }).providers.acmerouter.defaultModel, 'sonnet');

  // An empty model is a valid instruction: stop rewriting.
  const passThrough = await call('/api/providers/acmerouter/model', { method: 'POST', body: { model: '' } });
  assert.equal(passThrough.status, 200);
  assert.match(passThrough.data.message, /passes the client/);
  assert.equal(loadConfig({ fresh: true }).providers.acmerouter.defaultModel, '');

  const removed = await call('/api/providers/acmerouter/models/sonnet', { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.deepEqual(loadConfig({ fresh: true }).providers.acmerouter.models, ['opus']);
});

test('a model name needing URL encoding round-trips', async () => {
  await call('/api/providers/acmerouter/models', { method: 'POST', body: { model: 'vendor/model:v2' } });
  assert.ok(loadConfig({ fresh: true }).providers.acmerouter.models.includes('vendor/model:v2'));

  const removed = await call(`/api/providers/acmerouter/models/${encodeURIComponent('vendor/model:v2')}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.ok(!loadConfig({ fresh: true }).providers.acmerouter.models.includes('vendor/model:v2'));
});

test('deleting the active provider reassigns activation', async () => {
  await call('/api/providers', { method: 'POST', body: { name: 'second', url: 'https://second.test/v1' } });
  await call('/api/providers/second/activate', { method: 'POST' });
  assert.equal(loadConfig({ fresh: true }).active_provider, 'second');

  const deleted = await call('/api/providers/second', { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.data.activeProvider, 'acmerouter');

  assert.equal((await call('/api/providers/second/activate', { method: 'POST' })).status, 404);
});

test('settings round-trip and flag a port change as needing a restart', async () => {
  const before = await call('/api/settings');
  assert.equal(before.data.settings.spoofHeaders, true);

  const saved = await call('/api/settings', {
    method: 'PUT', body: { spoofHeaders: false, logBufferSize: 42, proxy_port: 8400 }
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.restartRequired, true);
  assert.equal(saved.data.settings.spoofHeaders, false);
  assert.equal(saved.data.settings.logBufferSize, 42);

  const rejected = await call('/api/settings', { method: 'PUT', body: { proxy_port: 99999 } });
  assert.equal(rejected.status, 400);

  await call('/api/settings', { method: 'PUT', body: { spoofHeaders: true, proxy_port: 8319 } });
});

test('export redacts keys by default and import never wipes an existing one', async () => {
  const redacted = await call('/api/config/export');
  assert.equal(redacted.data.redacted, true);
  assert.equal(redacted.data.config.providers.acmerouter.apiKey, '');

  const full = await call('/api/config/export?redact=0');
  assert.equal(full.data.config.providers.acmerouter.apiKey, 'sk-acme-key-0123456789');

  // Re-importing the redacted copy must not destroy the live key.
  const imported = await call('/api/config/import', { method: 'POST', body: { config: redacted.data.config } });
  assert.equal(imported.status, 200);
  assert.equal(loadConfig({ fresh: true }).providers.acmerouter.apiKey, 'sk-acme-key-0123456789');

  const merged = await call('/api/config/import', {
    method: 'POST',
    body: { config: { providers: { fresh: { url: 'https://fresh.test/v1', apiKey: 'sk-fresh-0123456789012' } } } }
  });
  assert.equal(merged.data.imported, 1);
  const names = Object.keys(loadConfig({ fresh: true }).providers);
  assert.ok(names.includes('acmerouter') && names.includes('fresh'), 'merge keeps existing providers');

  const replaced = await call('/api/config/import', {
    method: 'POST',
    body: { mode: 'replace', config: { providers: { only: { url: 'https://only.test/v1' } } } }
  });
  assert.equal(replaced.status, 200);
  assert.deepEqual(Object.keys(loadConfig({ fresh: true }).providers), ['only']);

  const rubbish = await call('/api/config/import', { method: 'POST', body: { config: { nope: true } } });
  assert.equal(rubbish.status, 400);
});

test('unknown routes and wrong methods answer with JSON, not a proxy attempt', async () => {
  const unknown = await call('/api/does-not-exist');
  assert.equal(unknown.status, 404);
  assert.match(unknown.data.error, /Unknown API route/);

  const wrongMethod = await call('/api/status', { method: 'DELETE' });
  assert.equal(wrongMethod.status, 405);
  assert.deepEqual(wrongMethod.data.allowed, ['GET']);

  const malformed = await fetch(`${base}/api/providers`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{ broken'
  });
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json()).error, /Invalid JSON/);
});

test('logs can be listed, inspected and cleared', async () => {
  const empty = await call('/api/logs');
  assert.equal(empty.data.ok, true);
  assert.ok(Array.isArray(empty.data.logs));

  const missing = await call('/api/logs/999999');
  assert.equal(missing.status, 404);

  const cleared = await call('/api/logs', { method: 'DELETE' });
  assert.equal(cleared.status, 200);
  assert.equal((await call('/api/logs')).data.logs.length, 0);
});

test('/api/meta reports the port actually bound, not just the configured one', async () => {
  const meta = await call('/api/meta');
  assert.equal(meta.data.ok, true);
  assert.equal(meta.data.port, server.address().port);
  assert.equal(meta.data.configuredPort, 8319);
  assert.match(meta.data.version, /^\d+\.\d+\.\d+$/);
  assert.equal(meta.data.configPath, path.join(home, 'config.json'));
});
