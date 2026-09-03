/**
 * `ai-proxy keys export` — the second copy.
 *
 * The locked decision is that the proxy owns the key data and a CSV is kept
 * beside it, so the one property that really matters here is the round trip:
 * whatever this writes has to import back into an empty config and give the
 * pool back. A "backup" that cannot be restored is not a backup.
 *
 * The other property is that the file is dangerous. It is the only artefact of
 * this tool that holds plaintext keys somewhere the user chose, so it is masked
 * unless asked otherwise, it is 0600, and it refuses to be written inside a git
 * working tree — these accounts have been pushed to GitHub by accident once.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-proxy-export-'));
process.env.AI_PROXY_HOME = home;
process.env.AI_PROXY_QUIET = '1';

const { exportKeys } = await import('../src/controllers/keysController.js');
const { saveConfig, loadConfig, clearConfigCache, normalizeConfig } =
  await import('../src/core/configManager.js');
const { parseCsv, extractKeyRecords, mergeKeyRecords } = await import('../src/core/keyImport.js');
const { UsageError } = await import('../src/utils/errors.js');

const A = 'sk-fake000000000000000000000000000000000000000a';
const B = 'sk-fake000000000000000000000000000000000000000b';
const C = 'sk-fake000000000000000000000000000000000000000c';

function seed() {
  clearConfigCache();
  saveConfig({
    providers: {
      gorouter: {
        url: 'https://gorouter.app/v1',
        keys: [
          {
            key: A, label: 'a@example.com', status: 'exhausted', remaining: 0.71,
            dashboardUrl: 'https://gorouter.app/', referralUrl: 'https://gorouter.app/sign-up?aff=jN2p'
          },
          { key: B, label: 'b@example.com', status: 'active', remaining: 55.34 }
        ]
      },
      tabitoken: { url: 'https://tabitoken.com/v1', keys: [{ key: C, label: 'c@example.com' }] }
    }
  });
  clearConfigCache();
}

/** A directory to export into, cleaned up by the OS. */
const outDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ai-proxy-out-'));

test('every key in every pool becomes a row, masked unless asked otherwise', () => {
  seed();
  const file = path.join(outDir(), 'keys.csv');

  const result = exportKeys(file);
  const text = fs.readFileSync(file, 'utf8');
  const rows = parseCsv(text);

  assert.equal(result.keys, 3);
  assert.equal(rows.length, 4, 'a header and one row per key');
  assert.deepEqual(rows.slice(1).map(row => row[0]), ['gorouter', 'gorouter', 'tabitoken']);
  assert.equal(rows[1][3], 'exhausted', 'the status the proxy measured travels with the key');
  for (const key of [A, B, C]) assert.ok(!text.includes(key), 'a masked export must not hold a key');
});

test('--with-keys writes the values, because that is the whole point of a copy', () => {
  seed();
  const file = path.join(outDir(), 'keys.csv');

  exportKeys(file, { withKeys: true });
  const text = fs.readFileSync(file, 'utf8');

  for (const key of [A, B, C]) assert.ok(text.includes(key), 'a key is missing from the copy');
});

test('the export imports back, key for key, into a config that lost everything', () => {
  seed();
  const file = path.join(outDir(), 'keys.csv');
  exportKeys(file, { withKeys: true });

  // What a restore actually looks like: the providers exist, the pools are gone.
  const empty = normalizeConfig({
    providers: {
      gorouter: { url: 'https://gorouter.app/v1' },
      tabitoken: { url: 'https://tabitoken.com/v1' }
    }
  });
  const sheets = [{ name: 'keys.csv', rows: parseCsv(fs.readFileSync(file, 'utf8')) }];
  const { records, unresolved, warnings } = extractKeyRecords(sheets, { providers: empty.providers });
  const { config, added } = mergeKeyRecords(empty, records);

  assert.deepEqual(unresolved, [], 'a key the importer could not place is a key lost');
  assert.deepEqual(warnings, []);
  assert.equal(added, 3);
  assert.deepEqual(config.providers.gorouter.keys.map(k => k.key), [A, B]);
  assert.deepEqual(config.providers.tabitoken.keys.map(k => k.key), [C]);

  const restored = config.providers.gorouter.keys[0];
  assert.equal(restored.label, 'a@example.com');
  assert.equal(restored.remaining, 0.71, 'the balance comes back with it');
  assert.equal(restored.referralUrl, 'https://gorouter.app/sign-up?aff=jN2p');
  assert.equal(restored.dashboardUrl, 'https://gorouter.app/');
});

test('a label holding a comma and a quote survives the round trip', () => {
  clearConfigCache();
  saveConfig({
    providers: {
      gorouter: { url: 'https://gorouter.app/v1', keys: [{ key: A, label: 'a@example.com, "old" account' }] }
    }
  });
  clearConfigCache();
  const file = path.join(outDir(), 'keys.csv');
  exportKeys(file, { withKeys: true });

  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  assert.equal(rows[1][1], 'a@example.com, "old" account');
});

test('a plaintext key is not written inside a git working tree', () => {
  seed();
  const dir = outDir();
  fs.mkdirSync(path.join(dir, '.git'));
  const file = path.join(dir, 'nested', 'keys.csv');
  fs.mkdirSync(path.join(dir, 'nested'));

  assert.throws(() => exportKeys(file, { withKeys: true }), UsageError);
  assert.throws(() => exportKeys(file, { withKeys: true }), error => /git/i.test(error.message + error.hint));
  assert.equal(fs.existsSync(file), false, 'and nothing is left behind');

  // Masked is not a secret, so the same path is fine without the keys.
  exportKeys(file);
  assert.ok(fs.existsSync(file));
});

test('a deliberate export into a repository is still possible, once said out loud', () => {
  seed();
  const dir = outDir();
  fs.mkdirSync(path.join(dir, '.git'));
  const file = path.join(dir, 'keys.csv');

  exportKeys(file, { withKeys: true, force: true });
  assert.ok(fs.readFileSync(file, 'utf8').includes(A));
});

test('the file is readable by nobody else', () => {
  seed();
  const file = path.join(outDir(), 'keys.csv');
  exportKeys(file, { withKeys: true });

  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('with no path given it lands beside the config, dated', () => {
  seed();
  const result = exportKeys();

  assert.equal(path.dirname(result.file), home, 'never the working directory, which may be a repo');
  assert.match(path.basename(result.file), /^keys-\d{4}-\d{2}-\d{2}\.csv$/);
  assert.ok(fs.existsSync(result.file));
});

test('the key store itself is exempt — it already holds the keys in plain text', () => {
  // A home directory that is a dotfiles repository would otherwise make the
  // default path refuse, next to a config.json holding the same keys already.
  seed();
  fs.mkdirSync(path.join(home, '.git'), { recursive: true });
  try {
    const result = exportKeys(undefined, { withKeys: true });
    assert.ok(fs.readFileSync(result.file, 'utf8').includes(A));
  } finally {
    fs.rmSync(path.join(home, '.git'), { recursive: true, force: true });
  }
});

test('a pool that is empty exports a header and says so', () => {
  clearConfigCache();
  saveConfig({ providers: { gorouter: { url: 'https://gorouter.app/v1' } } });
  clearConfigCache();
  const file = path.join(outDir(), 'keys.csv');

  const result = exportKeys(file);

  assert.equal(result.keys, 0);
  assert.deepEqual(parseCsv(fs.readFileSync(file, 'utf8')).length, 1, 'the header alone');
  assert.equal(loadConfig().providers.gorouter.keys.length, 0, 'exporting changes nothing');
});
