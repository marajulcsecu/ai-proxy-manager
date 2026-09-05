/**
 * Keeping the pool by hand: add, edit, remove, reveal.
 *
 * This is the half of the tool that replaces the spreadsheet. The spreadsheet
 * never lost a row, so the rules here are strict: an add never disturbs the key
 * that is currently working, an edit touches nothing it was not asked to touch,
 * a remove has to be asked for twice, and nothing the user typed is ever the
 * only copy — the vault keeps a line even for a key that has been deleted.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-proxy-keysmanage-'));
process.env.AI_PROXY_HOME = home;
process.env.AI_PROXY_QUIET = '1';

const { addKey, editKey, removeKey, revealKey } = await import('../src/controllers/keysController.js');
const { saveConfig, loadConfig, clearConfigCache } = await import('../src/core/configManager.js');
const { readKeyVault, deriveKeyId } = await import('../src/core/keyStore.js');
const { UsageError } = await import('../src/utils/errors.js');

const CONFIG_FILE = path.join(home, 'config.json');
const LIVE = 'sk-fakelive0000000000000000000000000000000000';
const KEY_B = 'sk-fake000000000000000000000000000000000000000b';
const KEY_C = 'sk-fake000000000000000000000000000000000000000c';

/** Two providers; gorouter is serving traffic on LIVE. */
function seed() {
  clearConfigCache();
  saveConfig({
    providers: {
      gorouter: {
        url: 'https://gorouter.app/v1',
        keys: [{ key: LIVE, label: 'live@example.com', status: 'active', remaining: 12.5 }]
      },
      tabitoken: { url: 'https://tabitoken.com/v1', keys: [] }
    }
  });
  clearConfigCache();
  return loadConfig({ fresh: true });
}

const pool = (config, name = 'gorouter') => config.providers[name].keys;

// --- add ---------------------------------------------------------------------

test('a key added by hand lands at the end of the pool with its account', () => {
  seed();
  const result = addKey('gorouter', KEY_B, { label: 'second@example.com', note: 'topped up today' });

  const config = loadConfig({ fresh: true });
  assert.equal(result.position, 2);
  assert.deepEqual(pool(config).map(k => k.key), [LIVE, KEY_B]);
  assert.equal(pool(config)[1].label, 'second@example.com');
  assert.equal(pool(config)[1].note, 'topped up today');
  assert.equal(pool(config)[1].status, 'unknown', 'a key nobody has tried yet is unknown, not active');
  assert.equal(config.providers.gorouter.apiKey, LIVE, 'the key in use must not move');
});

test('an added key reaches the file and the vault, not just memory', () => {
  seed();
  const before = readKeyVault().length;
  addKey('gorouter', KEY_B, { label: 'second@example.com' });

  assert.ok(fs.readFileSync(CONFIG_FILE, 'utf8').includes(KEY_B), 'the config on disk must hold it');
  const vault = readKeyVault();
  assert.equal(vault.length, before + 1, 'the append-only copy is the whole point of the tool');
  assert.equal(vault.at(-1).key, KEY_B);
  assert.equal(vault.at(-1).label, 'second@example.com');
});

test('--use puts the new key into service straight away', () => {
  seed();
  const result = addKey('gorouter', KEY_B, { label: 'second@example.com', use: true });

  const config = loadConfig({ fresh: true });
  assert.equal(result.inUse, true);
  assert.equal(config.providers.gorouter.selectedKeyId, deriveKeyId(KEY_B));
  assert.equal(config.providers.gorouter.apiKey, KEY_B);
});

test('a key already in the pool is refused, and nothing is written', () => {
  seed();
  const before = fs.readFileSync(CONFIG_FILE, 'utf8');

  assert.throws(() => addKey('gorouter', LIVE, { label: 'typed twice' }), err => {
    assert.ok(err instanceof UsageError);
    assert.match(err.message, /already/i);
    assert.match(`${err.message} ${err.hint || ''}`, /live@example\.com|#1/, 'say which entry it already is');
    return true;
  });
  assert.equal(fs.readFileSync(CONFIG_FILE, 'utf8'), before);
});

test('the same key under a second provider is added, but called out', () => {
  seed();
  const result = addKey('tabitoken', LIVE, { label: 'live@example.com' });

  assert.equal(loadConfig({ fresh: true }).providers.tabitoken.keys.length, 1);
  assert.deepEqual(result.alsoIn, ['gorouter'], 'pasting a key under the wrong relay is the likely mistake');
});

test('an empty value or one with spaces in it is not a key', () => {
  seed();
  for (const bad of ['', '   ', 'sk-abc def', 'sk-short']) {
    assert.throws(() => addKey('gorouter', bad, {}), UsageError, `accepted ${JSON.stringify(bad)}`);
  }
  assert.equal(pool(loadConfig({ fresh: true })).length, 1);
});

test('a provider that does not exist is named, never created', () => {
  seed();
  assert.throws(() => addKey('nosuch', KEY_B, {}), err => {
    assert.ok(err instanceof UsageError);
    assert.match(`${err.message} ${err.hint || ''}`, /gorouter/, 'list what is configured');
    return true;
  });
  assert.deepEqual(Object.keys(loadConfig({ fresh: true }).providers), ['gorouter', 'tabitoken']);
});

// --- edit --------------------------------------------------------------------

test('an edit changes the fields it was given and nothing else', () => {
  seed();
  const result = editKey('gorouter', '1', {
    label: 'renamed@example.com',
    note: 'recovery codes in bitwarden',
    dashboardUrl: 'https://gorouter.app/token',
    referralUrl: 'https://gorouter.app/register?aff=x'
  });

  const entry = pool(loadConfig({ fresh: true }))[0];
  assert.deepEqual(result.changed.sort(), ['dashboardUrl', 'label', 'note', 'referralUrl']);
  assert.equal(entry.label, 'renamed@example.com');
  assert.equal(entry.referralUrl, 'https://gorouter.app/register?aff=x');
  assert.equal(entry.key, LIVE, 'the value itself is not editable — remove and add instead');
  assert.equal(entry.status, 'active', 'status has its own verbs');
  assert.equal(entry.remaining, 12.5, 'a measured balance is not overwritten by hand');
});

test('an edit that changes nothing does not rewrite the config', () => {
  seed();
  const before = fs.statSync(CONFIG_FILE).mtimeMs;
  const result = editKey('gorouter', '1', { label: 'live@example.com' });

  assert.deepEqual(result.changed, []);
  assert.equal(fs.statSync(CONFIG_FILE).mtimeMs, before, 'a pointless save rotates a real backup away');
});

test('an empty string clears a field, but an omitted one is left alone', () => {
  seed();
  editKey('gorouter', '1', { note: 'temporary' });
  const result = editKey('gorouter', '1', { note: '' });

  const entry = pool(loadConfig({ fresh: true }))[0];
  assert.deepEqual(result.changed, ['note']);
  assert.equal(entry.note, '');
  assert.equal(entry.label, 'live@example.com', 'untouched because it was not passed');
});

test('status and balance are refused by name, not silently ignored', () => {
  seed();
  for (const fields of [{ status: 'active' }, { remaining: 99 }, { key: KEY_B }]) {
    assert.throws(() => editKey('gorouter', '1', fields), err => {
      assert.ok(err instanceof UsageError);
      assert.match(`${err.message} ${err.hint || ''}`, /retire|revive|check|add/i, 'point at the verb that owns it');
      return true;
    }, `accepted ${Object.keys(fields)[0]}`);
  }
  assert.equal(pool(loadConfig({ fresh: true }))[0].status, 'active');
});

test('an edited referral link is written to the vault as well', () => {
  seed();
  editKey('gorouter', '1', { referralUrl: 'https://gorouter.app/register?aff=x' });

  const lines = readKeyVault().filter(r => r.id === deriveKeyId(LIVE));
  assert.equal(lines.at(-1).referralUrl, 'https://gorouter.app/register?aff=x',
    'the vault is the second copy of the sheet, so it has to hold the sheet\'s columns');
});

test('a key is addressable by its account name, not just its position', () => {
  seed();
  addKey('gorouter', KEY_B, { label: 'second@example.com' });
  editKey('gorouter', 'second@', { note: 'found by label' });

  assert.equal(pool(loadConfig({ fresh: true }))[1].note, 'found by label');
});

test('a key whose id happens to be all digits is still addressable by id', () => {
  // deriveKeyId takes 12 hex characters, so about one id in 200 contains no
  // letters at all. Read as a position, such an id says "out of range" and the
  // key becomes unreachable from the dashboard, which addresses keys by id.
  const DIGITS = 'sk-fakedigits00000000000000000427zz';
  seed();
  addKey('gorouter', DIGITS, { label: 'digits@example.com' });
  assert.equal(deriveKeyId(DIGITS), '109002681363');

  assert.equal(revealKey('gorouter', '109002681363').key, DIGITS);
  assert.equal(editKey('gorouter', '109002681363', { note: 'reachable' }).changed.length, 1);
  assert.equal(revealKey('gorouter', '2').key, DIGITS, 'a real position still wins for a short number');
});

// --- remove ------------------------------------------------------------------

test('removing a key takes an explicit yes', () => {
  seed();
  assert.throws(() => removeKey('gorouter', '1', {}), err => {
    assert.ok(err instanceof UsageError);
    assert.match(`${err.message} ${err.hint || ''}`, /--yes|confirm/i);
    return true;
  });
  assert.equal(pool(loadConfig({ fresh: true })).length, 1);
});

test('a removed key is gone from the config but still in the vault', () => {
  seed();
  addKey('gorouter', KEY_B, { label: 'second@example.com' });
  const result = removeKey('gorouter', 'second@', { confirmed: true });

  const config = loadConfig({ fresh: true });
  assert.equal(result.entry.label, 'second@example.com');
  assert.deepEqual(pool(config).map(k => k.key), [LIVE]);
  assert.ok(
    readKeyVault().some(r => r.key === KEY_B),
    'the vault is append-only so a mistaken delete is recoverable'
  );
});

test('removing the key in use moves the selection to the next one', () => {
  seed();
  addKey('gorouter', KEY_B, { label: 'second@example.com' });
  const result = removeKey('gorouter', '1', { confirmed: true });

  const config = loadConfig({ fresh: true });
  assert.equal(result.movedTo?.key, KEY_B);
  assert.equal(config.providers.gorouter.apiKey, KEY_B, 'the provider must not be left without a key to send');
  assert.equal(config.providers.gorouter.selectedKeyId, deriveKeyId(KEY_B));
});

test('removing the only key leaves the provider configured but keyless', () => {
  seed();
  const result = removeKey('gorouter', '1', { confirmed: true });

  const config = loadConfig({ fresh: true });
  assert.equal(result.movedTo, null);
  assert.deepEqual(pool(config), []);
  assert.equal(config.providers.gorouter.apiKey, '',
    'the mirror must not hand the removed key back to normalization as a legacy one');
  assert.ok(config.providers.gorouter.url, 'the provider itself survives');
});

// --- reveal ------------------------------------------------------------------

test('one key can be read back in full, by account name', () => {
  seed();
  addKey('gorouter', KEY_C, { label: 'third@example.com' });

  assert.equal(revealKey('gorouter', 'third@').key, KEY_C);
  assert.equal(revealKey('gorouter', '1').key, LIVE);
});

test('an ambiguous account name is refused rather than guessed', () => {
  seed();
  addKey('gorouter', KEY_B, { label: 'a@example.com' });
  addKey('gorouter', KEY_C, { label: 'b@example.com' });

  assert.throws(() => revealKey('gorouter', 'example.com'), err => {
    assert.ok(err instanceof UsageError);
    assert.match(err.message, /matches 3 keys/);
    return true;
  });
});
