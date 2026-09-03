/**
 * `ai-proxy keys list|next|use|retire|revive` — the manual switch.
 *
 * These are the commands the user reaches for when the dashboard says an account
 * is out of credit, so they are held to the same rule as everything else here:
 * a key is never removed, never revealed in full, and never moved without being
 * asked.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-proxy-rotatecli-'));
process.env.AI_PROXY_HOME = home;
process.env.AI_PROXY_QUIET = '1';

const { listKeys, nextKey, useKey, retireKey, reviveKey, setRotation } =
  await import('../src/controllers/keysController.js');
const { saveConfig, loadConfig, clearConfigCache } = await import('../src/core/configManager.js');
const { deriveKeyId } = await import('../src/core/keyStore.js');
const { UsageError } = await import('../src/utils/errors.js');

const A = 'sk-fake000000000000000000000000000000000000000a';
const B = 'sk-fake000000000000000000000000000000000000000b';
const C = 'sk-fake000000000000000000000000000000000000000c';

function seed(keys, extra = {}) {
  clearConfigCache();
  saveConfig({ providers: { gorouter: { url: 'https://gorouter.app/v1', keys, ...extra } } });
  clearConfigCache();
}

const reload = () => loadConfig({ fresh: true }).providers.gorouter;

test('list shows every key masked, with the one in use marked', () => {
  seed([{ key: A, label: 'first@example.com', status: 'exhausted', remaining: 0.71 }, { key: B, status: 'active' }]);

  const rows = listKeys('gorouter');

  assert.equal(rows.length, 2);
  assert.equal(rows[0].label, 'first@example.com');
  assert.equal(rows[0].status, 'exhausted');
  assert.equal(rows[0].remaining, 0.71);
  assert.equal(rows[1].inUse, true, 'the active key is the one being sent');
  assert.ok(!JSON.stringify(rows).includes(A), 'a full key must never appear in output');
  assert.match(rows[0].masked, /^sk-fa…000a$/);
});

test('next moves the selection to the following usable key and saves it', () => {
  seed([{ key: A, status: 'active' }, { key: B, status: 'invalid' }, { key: C, status: 'unknown' }]);

  const result = nextKey('gorouter');

  assert.equal(result.to.id, deriveKeyId(C), 'the revoked key in between is skipped');
  assert.equal(reload().selectedKeyId, deriveKeyId(C));
  assert.equal(reload().apiKey, C, 'the mirror follows, so the proxy sends the new key');
});

test('next at the end of the pool refuses instead of looping back', () => {
  seed([{ key: A, status: 'active' }, { key: B, status: 'exhausted' }], { selectedKeyId: deriveKeyId(A) });
  const before = reload();

  assert.throws(() => nextKey('gorouter'), /no .*key|out of/i);
  assert.equal(reload().selectedKeyId, before.selectedKeyId, 'a refused switch changes nothing');
});

test('use pins a key by its position in the pool', () => {
  seed([{ key: A, status: 'active' }, { key: B, status: 'exhausted' }]);

  useKey('gorouter', '2');

  assert.equal(reload().selectedKeyId, deriveKeyId(B), 'a spent key can be re-selected — the user may have topped it up');
  assert.equal(reload().apiKey, B);
});

test('use finds a key by its label as well as its id', () => {
  seed([{ key: A, label: 'first@example.com' }, { key: B, label: 'second@example.com' }]);

  useKey('gorouter', 'second@');
  assert.equal(reload().selectedKeyId, deriveKeyId(B));

  useKey('gorouter', deriveKeyId(A));
  assert.equal(reload().selectedKeyId, deriveKeyId(A));
});

test('use refuses a revoked key, which no amount of credit can fix', () => {
  seed([{ key: A, status: 'active' }, { key: B, status: 'invalid' }]);

  assert.throws(() => useKey('gorouter', '2'), /invalid|revoked/i);
  assert.equal(reload().selectedKeyId, '');
});

test('an ambiguous selector asks rather than guessing', () => {
  seed([{ key: A, label: 'team@example.com' }, { key: B, label: 'team@example.org' }]);

  assert.throws(() => useKey('gorouter', 'team@'), /matches 2|ambiguous/i);
});

test('retire marks the key in use as spent and switches to the next one', () => {
  seed([{ key: A, status: 'active' }, { key: B, status: 'unknown' }]);

  const result = retireKey('gorouter');
  const provider = reload();

  assert.equal(provider.keys[0].status, 'exhausted');
  assert.equal(provider.selectedKeyId, deriveKeyId(B));
  assert.equal(result.to.id, deriveKeyId(B));
  assert.equal(provider.keys.length, 2, 'retiring is marking, never deleting');
});

test('retire with no key left to switch to still marks the key', () => {
  seed([{ key: A, status: 'active' }]);

  const result = retireKey('gorouter');

  assert.equal(reload().keys[0].status, 'exhausted');
  assert.equal(result.to, null);
});

test('revive puts a key back in the pool as untested, not as known-good', () => {
  seed([{ key: A, status: 'exhausted', remaining: 0, lastError: '403 out of credit' }]);

  reviveKey('gorouter', '1');
  const key = reload().keys[0];

  assert.equal(key.status, 'unknown', 'topped up is not the same as verified');
  assert.equal(key.lastError, null);
  assert.equal(key.remaining, null, 'the old balance is stale the moment it is topped up');
});

test('an unknown provider is a usage error listing the ones that exist', () => {
  seed([{ key: A }]);
  assert.throws(() => nextKey('nosuch'), UsageError);
  // The names go in the hint, which is the line the CLI prints under the error.
  assert.throws(() => listKeys('nosuch'), error => /gorouter/.test(error.hint));
});

test('a provider with no keys says so instead of failing', () => {
  seed([]);
  assert.deepEqual(listKeys('gorouter'), []);
  assert.throws(() => nextKey('gorouter'), /no key/i);
});

// --- who does the switching --------------------------------------------------
//
// The mode is per provider on purpose: it is only safe to hand a provider the
// keys to its own pool once `keys check` has shown what its refusals look like.

test('a provider does its switching by hand until it is told otherwise', () => {
  seed([{ key: A }, { key: B }]);

  const result = setRotation('gorouter');

  assert.equal(result.mode, 'manual');
  assert.equal(result.changed, false, 'asking is not setting');
  assert.equal(reload().keyRotation, 'manual');
});

test('auto is stored on the provider that asked for it, and on no other', () => {
  clearConfigCache();
  saveConfig({
    providers: {
      gorouter: { url: 'https://gorouter.app/v1', keys: [{ key: A }] },
      tabitoken: { url: 'https://tabitoken.com/v1', keys: [{ key: B }] }
    }
  });
  clearConfigCache();

  const result = setRotation('gorouter', 'auto');

  assert.deepEqual({ mode: result.mode, previous: result.previous, changed: result.changed },
    { mode: 'auto', previous: 'manual', changed: true });
  const config = loadConfig({ fresh: true });
  assert.equal(config.providers.gorouter.keyRotation, 'auto');
  assert.equal(config.providers.tabitoken.keyRotation, 'manual', 'one provider at a time');
});

test('setting the mode it already has writes nothing', () => {
  seed([{ key: A }], { keyRotation: 'auto' });
  const before = fs.statSync(path.join(home, 'config.json')).mtimeMs;

  const result = setRotation('gorouter', 'auto');

  assert.equal(result.changed, false);
  assert.equal(fs.statSync(path.join(home, 'config.json')).mtimeMs, before,
    'a no-op save would rotate the backups for nothing');
});

test('going back to manual is a change like any other', () => {
  seed([{ key: A }], { keyRotation: 'auto' });

  const result = setRotation('gorouter', 'manual');

  assert.equal(result.changed, true);
  assert.equal(reload().keyRotation, 'manual');
});

test('a mode nobody recognises is refused rather than guessed at', () => {
  seed([{ key: A }], { keyRotation: 'auto' });

  assert.throws(() => setRotation('gorouter', 'automatic'), UsageError);
  assert.throws(() => setRotation('gorouter', 'automatic'), error => /manual|auto/.test(error.hint));
  assert.equal(reload().keyRotation, 'auto', 'a refused change leaves the provider alone');
});

test('the pool listing says which mode the provider is on', () => {
  seed([{ key: A }, { key: B }], { keyRotation: 'auto' });

  const rows = listKeys('gorouter');

  assert.deepEqual(rows.map(row => row.keyRotation), ['auto', 'auto']);
});
