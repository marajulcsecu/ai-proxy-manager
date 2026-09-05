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

// --- a relay the config has never heard of ------------------------------------
//
// Four real keys sat unimported for one reason: the sheet knows a provider the
// proxy does not. The sheet also holds its URL, so it can be created — but that
// puts a new host in the config, so it happens only when asked for.

/** The row-per-provider layout, which is the one that carries a URL. */
function inventoryFile(name, rows) {
  return sheetFile(name, [
    'a@example.com(github linked)', 'API Provider: ', 'API Key:',
    'URL For API KEY', 'Referel Link: ', 'Remaining Credit', 'Top Models'
  ], rows);
}

test('a key for an unconfigured provider stays out unless creating one is asked for', () => {
  seed();
  const file = inventoryFile('new-relay.xlsx', [
    ['Just Do work', 'https://api.justwoker.icu/', KEY_B, '', '', '10', 'claude-opus-5']
  ]);

  const summary = importKeys([file]);

  assert.equal(summary.added, 0);
  assert.equal(summary.unresolved.length, 1);
  assert.deepEqual(summary.created, []);
  assert.deepEqual(Object.keys(loadConfig({ fresh: true }).providers), ['gorouter', 'tabitoken']);
});

test('--create-providers builds the provider from the sheet and files the key in it', () => {
  seed();
  const file = inventoryFile('created.xlsx', [
    ['Just Do work', 'https://api.justwoker.icu/', KEY_B, '', '', '10', 'claude-opus-5,\nclaude-opus-4-8']
  ]);

  const summary = importKeys([file], { createProviders: true });

  assert.deepEqual(summary.created.map(p => [p.name, p.url]), [['justwoker', 'https://api.justwoker.icu/v1']]);
  assert.equal(summary.added, 1);
  assert.deepEqual(summary.unresolved, [], 'a created provider leaves nothing unresolved');

  const provider = loadConfig({ fresh: true }).providers.justwoker;
  assert.equal(provider.url, 'https://api.justwoker.icu/v1');
  assert.deepEqual(provider.keys.map(k => [k.key, k.status, k.remaining]), [[KEY_B, 'unknown', 10]]);
  assert.deepEqual(provider.models, ['claude-opus-5', 'claude-opus-4-8']);
  assert.equal(provider.defaultModel, '', 'which model to send stays the user\'s decision');
});

test('the models column reaches a provider that already exists', () => {
  seed();
  const file = inventoryFile('models.xlsx', [
    ['GoRouter', 'https://gorouter.app/', KEY_A, '', '', '5', 'claude-opus-5-thinking,\nclaude-opus-5']
  ]);

  const summary = importKeys([file]);

  assert.equal(summary.modelsAdded, 2);
  assert.deepEqual(loadConfig({ fresh: true }).providers.gorouter.models, ['claude-opus-5-thinking', 'claude-opus-5']);
});

test('a dry run that would create a provider still writes nothing', () => {
  seed();
  const file = inventoryFile('dry-create.xlsx', [
    ['Just Do work', 'https://api.justwoker.icu/', KEY_B]
  ]);
  const before = fs.readFileSync(CONFIG_FILE, 'utf8');

  const summary = importKeys([file], { createProviders: true, dryRun: true });

  assert.equal(summary.created.length, 1);
  assert.equal(summary.added, 1, 'the numbers are what the run would do');
  assert.equal(fs.readFileSync(CONFIG_FILE, 'utf8'), before);
});

test('a key with no URL to point a provider at is still reported, never invented', () => {
  seed();
  const file = sheetFile('headerless.xlsx', ['mail', 'GoRouter', 'Some New Relay'], [
    ['a@example.com', KEY_A, KEY_B]
  ]);

  const summary = importKeys([file], { createProviders: true });

  assert.deepEqual(summary.created, []);
  assert.equal(summary.unresolved.length, 1);
  assert.equal(summary.unresolved[0].key, KEY_B);
  assert.deepEqual(Object.keys(loadConfig({ fresh: true }).providers), ['gorouter', 'tabitoken']);
});

test('a dry run leaves no phantom provider behind in memory', () => {
  // loadConfig() hands out a cached object that the proxy reads on every
  // request. Building the new provider into it directly would route traffic to
  // a host that is not in the file — and after a dry run, never will be.
  seed();
  const file = inventoryFile('phantom.xlsx', [
    ['Just Do work', 'https://api.justwoker.icu/', KEY_B]
  ]);

  importKeys([file], { createProviders: true, dryRun: true });

  assert.equal(loadConfig().providers.justwoker, undefined);
});
