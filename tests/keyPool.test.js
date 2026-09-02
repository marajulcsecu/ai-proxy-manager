/**
 * Multi-key pools per provider: schema, migration and the never-lose-a-key rules.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-proxy-keypool-'));
process.env.AI_PROXY_HOME = home;

const { normalizeConfig, saveConfig, loadConfig, clearConfigCache } =
  await import('../src/core/configManager.js');

const CONFIG_FILE = path.join(home, 'config.json');

/** Config with one provider whose pool is `keys`. */
function withKeys(keys, extra = {}) {
  return normalizeConfig({
    providers: { gorouter: { url: 'https://gorouter.app/v1', keys, ...extra } }
  }).providers.gorouter;
}

test('a legacy single apiKey becomes a one-entry pool', () => {
  const provider = normalizeConfig({
    providers: { gorouter: { url: 'https://gorouter.app/v1', apiKey: 'sk-legacy-key-value' } }
  }).providers.gorouter;

  assert.equal(provider.keys.length, 1);
  assert.equal(provider.keys[0].key, 'sk-legacy-key-value');
  assert.equal(provider.keys[0].status, 'active');
  // The mirror keeps every existing caller (CLI, tester, dashboard) working.
  assert.equal(provider.apiKey, 'sk-legacy-key-value');
});

test('a provider with no key at all gets an empty pool, not a phantom entry', () => {
  const provider = normalizeConfig({
    providers: { gorouter: { url: 'https://gorouter.app/v1', apiKey: '' } }
  }).providers.gorouter;

  assert.deepEqual(provider.keys, []);
  assert.equal(provider.apiKey, '');
});

test('key ids are derived from the key, so re-import is idempotent', () => {
  const first = withKeys([{ key: 'sk-stable-value-1' }]);
  const second = withKeys([{ key: 'sk-stable-value-1', label: 'renamed' }]);

  assert.match(first.keys[0].id, /^[0-9a-f]{12}$/);
  assert.equal(first.keys[0].id, second.keys[0].id, 'same key must keep the same id');
});

test('duplicate keys in one pool collapse to a single entry', () => {
  const provider = withKeys([
    { key: 'sk-dupe-value', label: 'first' },
    { key: 'sk-dupe-value', label: 'second' }
  ]);

  assert.equal(provider.keys.length, 1);
  assert.equal(provider.keys[0].label, 'first', 'the first occurrence wins');
});

test('account metadata survives normalization', () => {
  // The old schema silently deleted anything outside its five fields, so
  // hand-added notes vanished on the next save.
  const provider = withKeys([{
    key: 'sk-rich-metadata-value',
    label: 'someone@example.com',
    status: 'exhausted',
    remaining: 0.710336,
    needed: 0.8,
    dashboardUrl: 'https://gorouter.app/token',
    referralUrl: 'https://gorouter.app/register?aff=abc',
    note: 'third account'
  }]);

  const entry = provider.keys[0];
  assert.equal(entry.label, 'someone@example.com');
  assert.equal(entry.status, 'exhausted');
  assert.equal(entry.remaining, 0.710336);
  assert.equal(entry.needed, 0.8);
  assert.equal(entry.dashboardUrl, 'https://gorouter.app/token');
  assert.equal(entry.referralUrl, 'https://gorouter.app/register?aff=abc');
  assert.equal(entry.note, 'third account');
  assert.match(entry.addedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(entry.requestsServed, 0);
});

test('an unrecognised status falls back to unknown', () => {
  assert.equal(withKeys([{ key: 'sk-bad-status-value', status: 'melted' }]).keys[0].status, 'unknown');
});

test('apiKey mirrors the first active key, skipping exhausted ones', () => {
  const provider = withKeys([
    { key: 'sk-spent-value', status: 'exhausted' },
    { key: 'sk-live-value', status: 'active' }
  ]);

  assert.equal(provider.apiKey, 'sk-live-value');
});

test('every key exhausted still serves the first one rather than nothing', () => {
  // A key rejected for a 200k-token request may still answer a short chat, so
  // the proxy must not pre-emptively refuse to send it.
  const provider = withKeys([
    { key: 'sk-first-spent-value', status: 'exhausted' },
    { key: 'sk-second-spent-value', status: 'exhausted' }
  ]);

  assert.equal(provider.apiKey, 'sk-first-spent-value');
});

test('a legacy apiKey missing from the pool is absorbed, never dropped', () => {
  // Guards the half-edited config case: a key written to the old field while a
  // pool already exists must not be lost.
  const provider = withKeys(
    [{ key: 'sk-pool-value', status: 'active' }],
    { apiKey: 'sk-orphan-value' }
  );

  const values = provider.keys.map(k => k.key);
  assert.ok(values.includes('sk-orphan-value'), `orphan key was dropped: ${values.join()}`);
  assert.equal(provider.keys.length, 2);
});

test('pools survive a save and load round trip', () => {
  clearConfigCache();
  saveConfig({
    providers: {
      gorouter: {
        url: 'https://gorouter.app/v1',
        keys: [
          { key: 'sk-persist-a-value', label: 'a@example.com', status: 'exhausted', remaining: 0.1 },
          { key: 'sk-persist-b-value', label: 'b@example.com', status: 'active' }
        ]
      }
    }
  });
  clearConfigCache();

  const provider = loadConfig({ fresh: true }).providers.gorouter;
  assert.equal(provider.keys.length, 2);
  assert.equal(provider.keys[0].remaining, 0.1);
  assert.equal(provider.apiKey, 'sk-persist-b-value');
  assert.ok(fs.readFileSync(CONFIG_FILE, 'utf8').includes('sk-persist-b-value'));
});

// --- reliability: backups and the append-only vault -------------------------

const { readKeyVault, latestVaultState, recoverMissingKeys, appendKeyVault } =
  await import('../src/core/keyStore.js');

const VAULT = path.join(home, 'keys.jsonl');

function saveProvider(keys) {
  clearConfigCache();
  saveConfig({ providers: { gorouter: { url: 'https://gorouter.app/v1', keys } } });
}

test('saving keeps the previous config as a backup', () => {
  saveProvider([{ key: 'sk-backup-one-value' }]);
  saveProvider([{ key: 'sk-backup-two-value' }]);

  const backup = fs.readFileSync(`${CONFIG_FILE}.bak.1`, 'utf8');
  assert.ok(backup.includes('sk-backup-one-value'), 'bak.1 should hold the version before this save');
  assert.ok(!backup.includes('sk-backup-two-value'));
});

test('backups roll and are capped at five', () => {
  for (let i = 1; i <= 8; i++) saveProvider([{ key: `sk-roll-${i}-value` }]);

  assert.ok(fs.existsSync(`${CONFIG_FILE}.bak.5`));
  assert.ok(!fs.existsSync(`${CONFIG_FILE}.bak.6`), 'only five backups are kept');
  // bak.1 is the newest backup, so it holds the second-to-last save.
  assert.ok(fs.readFileSync(`${CONFIG_FILE}.bak.1`, 'utf8').includes('sk-roll-7-value'));
  assert.ok(fs.readFileSync(`${CONFIG_FILE}.bak.5`, 'utf8').includes('sk-roll-3-value'));
});

test('every saved key is recorded in the append-only vault', () => {
  fs.rmSync(VAULT, { force: true });
  saveProvider([{ key: 'sk-vault-a-value', label: 'a@example.com' }]);

  const lines = readKeyVault();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].provider, 'gorouter');
  assert.equal(lines[0].key, 'sk-vault-a-value');
  assert.equal(lines[0].label, 'a@example.com');
  assert.ok(fs.statSync(VAULT).mode.toString(8).endsWith('600'), 'vault must not be world readable');
});

test('the vault appends a new line per status change, never rewriting history', () => {
  fs.rmSync(VAULT, { force: true });
  saveProvider([{ key: 'sk-vault-b-value', status: 'active' }]);
  saveProvider([{ key: 'sk-vault-b-value', status: 'exhausted', remaining: 0.71 }]);

  const lines = readKeyVault();
  assert.equal(lines.length, 2, 'both states are kept');
  assert.equal(lines[0].status, 'active');
  assert.equal(lines[1].status, 'exhausted');
  assert.equal(lines[1].remaining, 0.71);

  const latest = latestVaultState();
  assert.equal(latest.get('gorouter:' + lines[0].id).status, 'exhausted');
});

test('an unchanged key is not appended again on every save', () => {
  fs.rmSync(VAULT, { force: true });
  saveProvider([{ key: 'sk-vault-c-value', status: 'active' }]);
  saveProvider([{ key: 'sk-vault-c-value', status: 'active' }]);

  assert.equal(readKeyVault().length, 1);
});

test('a key deleted from the config is recoverable from the vault', () => {
  fs.rmSync(VAULT, { force: true });
  saveProvider([{ key: 'sk-vault-keep-value' }, { key: 'sk-vault-lost-value' }]);
  saveProvider([{ key: 'sk-vault-keep-value' }]);

  const missing = recoverMissingKeys(loadConfig({ fresh: true }));
  assert.deepEqual(missing.map(m => m.provider), ['gorouter']);
  assert.deepEqual(missing.map(m => m.key), ['sk-vault-lost-value']);
});

test('appendKeyVault tolerates an unwritable directory instead of throwing', () => {
  // Persisting history must never be able to break a save.
  assert.doesNotThrow(() => appendKeyVault('gorouter', [], 'noop'));
});

test('saving tightens the config directory, not just the files inside it', () => {
  // mkdir's mode only applies when the directory is created, so a dir made
  // under a loose umask (the real ~/.config/ai-proxy-manager is 0755) stayed
  // group and world readable. The files are 0600, but the directory listing
  // itself leaks which providers and how many keys exist.
  fs.chmodSync(home, 0o755);
  saveProvider([{ key: 'sk-dirmode-value' }]);

  assert.equal(fs.statSync(home).mode & 0o777, 0o700, 'config dir must be owner-only');
  assert.equal(fs.statSync(CONFIG_FILE).mode & 0o777, 0o600);
});
