/**
 * `ai-proxy keys import <file>` end to end: a real .xlsx on disk, through the
 * zip reader and the importer, into a real config.json.
 *
 * The point of testing the whole chain rather than the pieces is that the pieces
 * were already green when the importer was quietly dropping a quarter of the
 * keys. What matters to the user is the number that lands in the file.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { workbook, sharedCell } from './helpers/xlsxFixture.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-proxy-keyscli-'));
process.env.AI_PROXY_HOME = home;
process.env.AI_PROXY_QUIET = '1';

const { importKeys, accountFor } = await import('../src/controllers/keysController.js');
const { saveConfig, loadConfig, clearConfigCache } = await import('../src/core/configManager.js');
const { UsageError } = await import('../src/utils/errors.js');

const CONFIG_FILE = path.join(home, 'config.json');
const KEY_A = 'sk-fake000000000000000000000000000000000000000a';
const KEY_B = 'sk-fake000000000000000000000000000000000000000b';
const KEY_C = 'sk-fake000000000000000000000000000000000000000c';

/** A one-tab .xlsx on disk, matrix layout, written to the temp home. */
function sheetFile(name, header, rows) {
  const strings = [...header];
  const cells = rows.map((row, r) => row.map((value, c) => {
    if (!value) return '';
    let index = strings.indexOf(value);
    if (index < 0) { strings.push(value); index = strings.length - 1; }
    return sharedCell(`${String.fromCharCode(65 + c)}${r + 2}`, index);
  }).join(''));

  const xml = `<row r="1">${header.map((h, c) => sharedCell(`${String.fromCharCode(65 + c)}1`, strings.indexOf(h))).join('')}</row>`
    + cells.map((row, r) => `<row r="${r + 2}">${row}</row>`).join('');

  const file = path.join(home, name);
  fs.writeFileSync(file, workbook([{ name: 'Accounts', xml }], strings));
  return file;
}

/** Two configured providers and one live key, as the real config has. */
function seed() {
  clearConfigCache();
  saveConfig({
    providers: {
      gorouter: { url: 'https://gorouter.app/v1', keys: [{ key: 'sk-fakelive000000000000000000000000000000000', status: 'active' }] },
      tabitoken: { url: 'https://tabitoken.com/v1', keys: [] }
    }
  });
  clearConfigCache();
}

test('importing a spreadsheet puts every key in the config on disk', () => {
  seed();
  const file = sheetFile('one.xlsx', ['mail', 'GoRouter', 'TabiToken'], [
    ['first@example.com', KEY_A, KEY_B]
  ]);

  const summary = importKeys([file]);

  assert.equal(summary.added, 2);
  assert.equal(summary.lost.length, 0);
  const saved = fs.readFileSync(CONFIG_FILE, 'utf8');
  assert.ok(saved.includes(KEY_A) && saved.includes(KEY_B), 'both keys must reach the file');

  const config = loadConfig({ fresh: true });
  assert.deepEqual(config.providers.gorouter.keys.map(k => k.key), ['sk-fakelive000000000000000000000000000000000', KEY_A]);
  assert.equal(config.providers.gorouter.keys[0].status, 'active', 'the key in use stays at the head, still active');
  assert.equal(config.providers.gorouter.keys[1].status, 'unknown');
  assert.equal(config.providers.gorouter.keys[1].label, 'first@example.com');
});

test('a dry run reports the same numbers but writes nothing', () => {
  seed();
  const file = sheetFile('dry.xlsx', ['mail', 'GoRouter'], [['a@example.com', KEY_C]]);
  const before = fs.readFileSync(CONFIG_FILE, 'utf8');

  const summary = importKeys([file], { dryRun: true });

  assert.equal(summary.added, 1);
  assert.equal(summary.dryRun, true);
  assert.equal(fs.readFileSync(CONFIG_FILE, 'utf8'), before, 'a dry run must not touch config.json');
});

test('importing the same file twice changes nothing the second time', () => {
  seed();
  const file = sheetFile('twice.xlsx', ['mail', 'GoRouter'], [['a@example.com', KEY_A]]);

  assert.equal(importKeys([file]).added, 1);
  const after = fs.readFileSync(CONFIG_FILE, 'utf8');
  const second = importKeys([file]);

  assert.equal(second.added, 0);
  assert.equal(second.unchanged, 1);
  assert.equal(fs.readFileSync(CONFIG_FILE, 'utf8'), after, 'a re-import must be a no-op');
});

test('a key whose provider is not configured is reported, not filed under a guess', () => {
  seed();
  const file = sheetFile('unknown.xlsx', ['mail', 'GoRouter', 'Some New Relay'], [
    ['a@example.com', KEY_A, KEY_B]
  ]);

  const summary = importKeys([file]);

  assert.equal(summary.added, 1);
  assert.equal(summary.unresolved.length, 1);
  assert.equal(summary.unresolved[0].key, KEY_B);
  assert.match(summary.unresolved[0].hint, /Some New Relay/);
  assert.ok(!fs.readFileSync(CONFIG_FILE, 'utf8').includes(KEY_B), 'an unresolved key must not be filed anywhere');
});

test('a key the extractor did not see is counted as lost, so the run can refuse', () => {
  // The guard for the bug this whole file exists to prevent: if a future layout
  // defeats the reader, the import must fail loudly rather than write a subset.
  const sheets = [{ name: 'T', rows: [['mail', 'GoRouter'], ['a@example.com', KEY_A]] }];

  assert.deepEqual(accountFor(sheets, { records: [], unresolved: [] }).lost, [KEY_A]);
  assert.deepEqual(accountFor(sheets, { records: [{ key: KEY_A }], unresolved: [] }).lost, []);
  assert.deepEqual(accountFor(sheets, { records: [], unresolved: [{ key: KEY_A }] }).lost, []);
  assert.equal(accountFor(sheets, { records: [], unresolved: [] }).keys, 1);
});

test('no file argument is a usage error, not a stack trace', () => {
  assert.throws(() => importKeys([]), UsageError);
});

test('a file that is not a spreadsheet is refused before anything is written', () => {
  seed();
  const junk = path.join(home, 'notes.txt');
  fs.writeFileSync(junk, 'nothing to see');
  const before = fs.readFileSync(CONFIG_FILE, 'utf8');

  assert.throws(() => importKeys([junk]), UsageError);
  assert.equal(fs.readFileSync(CONFIG_FILE, 'utf8'), before);
});
