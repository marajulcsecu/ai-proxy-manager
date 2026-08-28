/**
 * Configuration loading, normalization and persistence.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-proxy-config-'));
process.env.AI_PROXY_HOME = home;

const {
  loadConfig, saveConfig, tryLoadConfig, normalizeConfig, normalizeProviderName,
  migrateConfig, clearConfigCache, DEFAULT_SETTINGS
} = await import('../src/core/configManager.js');

const CONFIG_FILE = path.join(home, 'config.json');

function writeRaw(object) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(object, null, 2));
  clearConfigCache();
}

test('normalizeProviderName lowercases and strips unsafe characters', () => {
  assert.equal(normalizeProviderName('  GoRouter '), 'gorouter');
  assert.equal(normalizeProviderName('my provider!'), 'myprovider');
  assert.equal(normalizeProviderName('open-router.v1_x'), 'open-router.v1_x');
  assert.equal(normalizeProviderName(undefined), '');
});

test('a pinned model missing from its own models list is repaired', () => {
  // This is the exact drift that made the dashboard dropdown show the wrong
  // model as selected.
  const config = normalizeConfig({
    providers: { gorouter: { url: 'https://x/v1', defaultModel: 'opus-5', models: ['sonnet-5'] } }
  });
  assert.deepEqual(config.providers.gorouter.models, ['opus-5', 'sonnet-5']);
});

test('normalization fills defaults and drops junk', () => {
  const config = normalizeConfig({
    providers: {
      'Weird Name': { url: ' https://a/v1 ', models: ['a', 'a', '', null] },
      '': { url: 'https://ignored' }
    },
    active_provider: 'missing-provider',
    proxy_port: '70000',
    settings: { logBufferSize: 999999, theme: 'neon', spoofHeaders: 0 }
  });

  assert.deepEqual(Object.keys(config.providers), ['weirdname']);
  assert.equal(config.providers.weirdname.url, 'https://a/v1');
  assert.deepEqual(config.providers.weirdname.models, ['a']);
  assert.equal(config.providers.weirdname.apiKey, '');
  // active_provider pointed nowhere, so it falls back to the first provider.
  assert.equal(config.active_provider, 'weirdname');
  assert.equal(config.proxy_port, 8319, 'out-of-range port falls back to default');
  assert.equal(config.settings.logBufferSize, 5000, 'buffer size is clamped');
  assert.equal(config.settings.theme, 'system', 'unknown theme falls back');
  assert.equal(config.settings.spoofHeaders, false, 'booleans are coerced');
});

test('saveConfig writes atomically with 0600 permissions', () => {
  saveConfig({ providers: { a: { url: 'https://a/v1', apiKey: 'sk-secret' } } });

  const mode = fs.statSync(CONFIG_FILE).mode & 0o777;
  assert.equal(mode, 0o600, 'a file holding API keys must not be world-readable');
  assert.equal(fs.statSync(home).mode & 0o777, 0o700);
  assert.equal(fs.readdirSync(home).filter(name => name.includes('.tmp')).length, 0, 'no temp file left behind');

  const reloaded = loadConfig({ fresh: true });
  assert.equal(reloaded.providers.a.apiKey, 'sk-secret');
  assert.deepEqual(Object.keys(reloaded.settings).sort(), Object.keys(DEFAULT_SETTINGS).sort());
});

test('loadConfig caches by mtime and picks up external edits', () => {
  saveConfig({ providers: { a: { url: 'https://a/v1' } }, active_provider: 'a' });
  assert.equal(loadConfig().active_provider, 'a');

  writeRaw({ providers: { b: { url: 'https://b/v1' } }, active_provider: 'b' });
  assert.equal(loadConfig().active_provider, 'b', 'an edit made outside the process is seen');
});

test('a corrupt config throws ConfigError but never exits the process', () => {
  fs.writeFileSync(CONFIG_FILE, '{ this is not json');
  clearConfigCache();

  assert.throws(() => loadConfig(), /not valid JSON/);

  const attempt = tryLoadConfig();
  assert.equal(attempt.ok, false);
  assert.match(attempt.error.message, /not valid JSON/);
  assert.deepEqual(attempt.config.providers, {}, 'callers still get a usable object');
});

test('migrateConfig rewrites drifted files exactly once', () => {
  writeRaw({ providers: { A: { url: 'https://a/v1', defaultModel: 'm1', models: [] } } });

  assert.equal(migrateConfig(), true, 'first run repairs the file');
  const repaired = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  assert.deepEqual(Object.keys(repaired.providers), ['a']);
  assert.deepEqual(repaired.providers.a.models, ['m1']);

  clearConfigCache();
  assert.equal(migrateConfig(), false, 'a normalized file is left alone');
});
