/**
 * Turning the account spreadsheets into key-pool entries.
 *
 * Every quirk asserted here is one the real inventory actually has. The columns
 * do not line up with their own header, the API-key column sometimes holds a
 * bare number, the credit sometimes sits in the referral column, one workbook is
 * a row per provider and the other is a column per provider, and one provider
 * name is misspelled. An importer that assumed a tidy grid would file numbers as
 * API keys and drop real ones.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { extractKeyRecords, mergeKeyRecords, parseCsv, PROVIDER_ALIASES } =
  await import('../src/core/keyImport.js');
const { normalizeConfig } = await import('../src/core/configManager.js');

const KEY_A = 'sk-fake000000000000000000000000000000000000000a';
const KEY_B = 'sk-fake000000000000000000000000000000000000000b';
const KEY_C = 'sk-fake000000000000000000000000000000000000000c';

/** The providers actually configured in the proxy. */
const PROVIDERS = {
  gorouter: { url: 'https://gorouter.app/v1' },
  tabitoken: { url: 'https://tabitoken.com/v1' },
  agentrouter: { url: 'https://agentrouter.org/v1' },
  seekai: { url: 'https://seekai.cc/v1' }
};

const HEADER = ['someone@example.com(github linked)', 'API Provider: ', 'API Key:', 'URL For API KEY', 'Referel Link: ', 'Remaining Credit', 'Top Models'];

/** One tab of the row-per-provider workbook. */
function inventoryTab(rows, header = HEADER) {
  return [{ name: 'someone@example.com(github', rows: [header, ...rows] }];
}

test('a row-per-provider tab yields one record per key', () => {
  const { records } = extractKeyRecords(inventoryTab([
    ['GoRouter', 'https://gorouter.app/', KEY_A, '', 'https://gorouter.app/sign-up?aff=jN2p', '55.34', 'claude-opus-5']
  ]), { providers: PROVIDERS });

  assert.equal(records.length, 1);
  assert.deepEqual(
    { ...records[0], sheet: undefined, row: undefined },
    {
      provider: 'gorouter',
      key: KEY_A,
      label: 'someone@example.com',
      remaining: 55.34,
      referralUrl: 'https://gorouter.app/sign-up?aff=jN2p',
      dashboardUrl: 'https://gorouter.app/',
      sheet: undefined,
      row: undefined
    }
  );
});

test('the account label comes from the header when the rows are providers', () => {
  const { records } = extractKeyRecords(inventoryTab([
    ['GoRouter', 'https://gorouter.app/', KEY_A]
  ], ['tyou5148@gmail.com(github linked)', 'API Provider: ', 'API Key:']), { providers: PROVIDERS });

  assert.equal(records[0].label, 'tyou5148@gmail.com');
});

test('a bare number in the API-key column is not imported as a key', () => {
  // Verbatim from the real sheet: rows with no key carry a credit figure there.
  const { records, warnings } = extractKeyRecords(inventoryTab([
    ['Aegnt Router', 'https://agentrouter.org/', '10'],
    ['GoRouter', 'https://gorouter.app/', KEY_A]
  ]), { providers: PROVIDERS });

  assert.deepEqual(records.map(r => r.key), [KEY_A]);
  assert.ok(warnings.some(w => /no key/i.test(w)), `expected a warning, got: ${warnings.join(' | ')}`);
});

test('a credit that landed in the referral column is still read as a credit', () => {
  const { records } = extractKeyRecords(inventoryTab([
    ['seekai', 'https://seekai.cc/', KEY_A, '', '198.0']
  ]), { providers: PROVIDERS });

  assert.equal(records[0].remaining, 198);
  assert.equal(records[0].referralUrl, '');
});

test('a misspelled or rebranded provider name resolves through the alias table', () => {
  const { records } = extractKeyRecords(inventoryTab([
    ['Aegnt Router', '', KEY_A],
    ['TaBiAI', '', KEY_B]
  ]), { providers: PROVIDERS });

  assert.deepEqual(records.map(r => r.provider), ['agentrouter', 'tabitoken']);
  assert.ok(PROVIDER_ALIASES.aegntrouter, 'the alias table is the auditable record of these fixes');
});

test('the URL wins over the name, because the name is hand-typed', () => {
  const { records } = extractKeyRecords(inventoryTab([
    ['Go Router (old account)', 'https://tabitoken.com/', KEY_A]
  ]), { providers: PROVIDERS });

  assert.equal(records[0].provider, 'tabitoken');
});

test('a provider that is not configured is reported, never guessed', () => {
  const { records, unresolved } = extractKeyRecords(inventoryTab([
    ['Just Do work', 'https://api.justwoker.icu/', KEY_A]
  ]), { providers: PROVIDERS });

  assert.deepEqual(records, []);
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].key, KEY_A);
  assert.match(unresolved[0].hint, /justwoker|just do work/i);
});

test('a column-per-provider tab yields one record per account', () => {
  const sheets = [{
    name: 'Temporary mails github 1',
    rows: [
      ['temp mail and Account No.', 'USERNAME', 'PASSWORD', 'Your two-factor secret', 'Github Recovery Codes', 'Go Router API Key', 'TaBiAI API Key'],
      ['first@example.com', 'tmpm1', 'pw', 'SECRET', 'codes', KEY_A, KEY_B],
      ['2. second@example.com', 'tmpm2', 'pw', 'SECRET', 'codes', KEY_C, '']
    ]
  }];

  const { records } = extractKeyRecords(sheets, { providers: PROVIDERS });

  assert.deepEqual(records.map(r => [r.provider, r.key, r.label]), [
    ['gorouter', KEY_A, 'first@example.com'],
    ['tabitoken', KEY_B, 'first@example.com'],
    ['gorouter', KEY_C, 'second@example.com']
  ]);
});

test('a two-factor secret is never mistaken for a key', () => {
  const sheets = [{
    name: 'T',
    rows: [
      ['temp mail', 'USERNAME', 'PASSWORD', 'Your two-factor secret', 'Go Router API Key'],
      ['a@example.com', 'u', 'eqppue7s5948vvn', 'EWZNRT5VGR4U5P4K', KEY_A]
    ]
  }];

  const { records } = extractKeyRecords(sheets, { providers: PROVIDERS });
  assert.deepEqual(records.map(r => r.key), [KEY_A]);
});

test('the same key on two tabs is imported once', () => {
  const { records } = extractKeyRecords([
    ...inventoryTab([['GoRouter', 'https://gorouter.app/', KEY_A]]),
    ...inventoryTab([['GoRouter', 'https://gorouter.app/', KEY_A]])
  ], { providers: PROVIDERS });

  assert.equal(records.length, 1);
});

test('blank rows and the header itself produce nothing', () => {
  const { records } = extractKeyRecords(inventoryTab([[], ['', '', ''], []]), { providers: PROVIDERS });
  assert.deepEqual(records, []);
});

// --- merging into the config -------------------------------------------------

/** Config with one provider holding one already-working key. */
function baseConfig() {
  return normalizeConfig({
    providers: {
      gorouter: { url: 'https://gorouter.app/v1', keys: [{ key: KEY_A, status: 'active', remaining: 0.71 }] },
      tabitoken: { url: 'https://tabitoken.com/v1', keys: [] }
    }
  });
}

test('a new key is appended as unknown, behind the key already in use', () => {
  const { config, added } = mergeKeyRecords(baseConfig(), [
    { provider: 'gorouter', key: KEY_B, label: 'b@example.com', remaining: 200, referralUrl: '', dashboardUrl: '' }
  ]);

  const pool = config.providers.gorouter.keys;
  assert.equal(added, 1);
  assert.deepEqual(pool.map(k => k.key), [KEY_A, KEY_B]);
  assert.equal(pool[1].status, 'unknown', 'an imported key is untested until it is probed');
  assert.equal(pool[1].remaining, 200);
  // The working key stays at the head, so the proxy keeps sending it.
  assert.equal(config.providers.gorouter.apiKey, KEY_A);
});

test('importing never downgrades a key that is already known good', () => {
  const { config, updated, unchanged } = mergeKeyRecords(baseConfig(), [
    { provider: 'gorouter', key: KEY_A, label: '', remaining: 999, referralUrl: '', dashboardUrl: '' }
  ]);

  const entry = config.providers.gorouter.keys[0];
  assert.equal(entry.status, 'active');
  assert.equal(entry.remaining, 0.71, 'a figure typed in a spreadsheet must not overwrite a measured one');
  assert.equal(updated, 0);
  assert.equal(unchanged, 1);
});

test('metadata the config is missing is filled in from the sheet', () => {
  const { config, updated } = mergeKeyRecords(baseConfig(), [
    {
      provider: 'gorouter', key: KEY_A, label: 'a@example.com', remaining: null,
      referralUrl: 'https://gorouter.app/sign-up?aff=jN2p', dashboardUrl: 'https://gorouter.app/'
    }
  ]);

  const entry = config.providers.gorouter.keys[0];
  assert.equal(updated, 1);
  assert.equal(entry.label, 'a@example.com');
  assert.equal(entry.referralUrl, 'https://gorouter.app/sign-up?aff=jN2p');
  assert.equal(entry.status, 'active', 'filling a blank field is not a status change');
});

test('a record for an unconfigured provider is skipped, leaving the config alone', () => {
  const before = baseConfig();
  const { config, skipped } = mergeKeyRecords(before, [
    { provider: 'justwoker', key: KEY_C, label: '', remaining: null, referralUrl: '', dashboardUrl: '' }
  ]);

  assert.equal(skipped, 1);
  assert.deepEqual(Object.keys(config.providers), Object.keys(before.providers));
});

test('importing twice is a no-op the second time', () => {
  const records = [{ provider: 'tabitoken', key: KEY_C, label: 'c@example.com', remaining: 120, referralUrl: '', dashboardUrl: '' }];
  const first = mergeKeyRecords(baseConfig(), records);
  const second = mergeKeyRecords(first.config, records);

  assert.equal(first.added, 1);
  assert.equal(second.added, 0);
  assert.equal(second.updated, 0);
  assert.deepEqual(second.config.providers.tabitoken.keys, first.config.providers.tabitoken.keys);
});

test('the input config is not mutated', () => {
  const before = baseConfig();
  mergeKeyRecords(before, [{ provider: 'gorouter', key: KEY_B, label: '', remaining: null, referralUrl: '', dashboardUrl: '' }]);
  assert.equal(before.providers.gorouter.keys.length, 1);
});

// --- csv, for anything exported straight out of a sheet ----------------------

test('csv with quotes, commas and newlines inside fields parses', () => {
  const rows = parseCsv('email,key,note\r\n"a@b.c",' + KEY_A + ',"says ""hi"", ok"\n"multi\nline",x,y\n');
  assert.deepEqual(rows, [
    ['email', 'key', 'note'],
    ['a@b.c', KEY_A, 'says "hi", ok'],
    ['multi\nline', 'x', 'y']
  ]);
});

test('a csv exported from the inventory imports like the xlsx tab', () => {
  const csv = 'someone@example.com(github linked),API Provider: ,API Key:,URL For API KEY,Referel Link: ,Remaining Credit\n'
    + 'GoRouter,https://gorouter.app/,' + KEY_A + ',,https://gorouter.app/sign-up?aff=jN2p,55.34\n';

  const { records } = extractKeyRecords([{ name: 'export.csv', rows: parseCsv(csv) }], { providers: PROVIDERS });
  assert.equal(records[0].provider, 'gorouter');
  assert.equal(records[0].remaining, 55.34);
});

// --- nothing may be dropped in silence ---------------------------------------
//
// The first version of this importer lost 70 of 272 real keys: two tabs name
// their columns with bare provider names and no "API Key" wording, so no header
// was found, the tab was read as one-provider-per-row, and every row kept only
// its first key. Silently. These tests exist so that cannot recur.

/** The layout of "Temporary mails github 2": no "API Key" text anywhere. */
const BARE_MATRIX = [{
  name: 'Temporary mails github 2',
  rows: [
    ['mail', 'GoRouter', 'TabiToken', 'seekai', 'bluesminds'],
    ['first@example.com', KEY_A, KEY_B, KEY_C, '']
  ]
}];

test('a matrix tab whose header is just provider names is still a matrix', () => {
  const { records, unresolved } = extractKeyRecords(BARE_MATRIX, { providers: PROVIDERS });

  assert.deepEqual(records.map(r => [r.provider, r.key]), [
    ['gorouter', KEY_A],
    ['tabitoken', KEY_B],
    ['seekai', KEY_C]
  ]);
  assert.deepEqual(unresolved, []);
});

test('a header carrying prose after the provider name still resolves', () => {
  const { records } = extractKeyRecords([{
    name: 'T',
    rows: [['mail', 'seekai. (default) , surprise me'], ['a@example.com', KEY_A]]
  }], { providers: PROVIDERS });

  assert.deepEqual(records.map(r => r.provider), ['seekai']);
});

test('a key column that cannot be mapped is reported with its header, not dropped', () => {
  const { records, unresolved } = extractKeyRecords([{
    name: 'T',
    rows: [['mail', 'GoRouter', 'Some New Relay'], ['a@example.com', KEY_A, KEY_B]]
  }], { providers: PROVIDERS });

  assert.deepEqual(records.map(r => r.key), [KEY_A]);
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].key, KEY_B);
  assert.match(unresolved[0].hint, /Some New Relay/);
});

test('a row holding two keys produces two records', () => {
  const { records } = extractKeyRecords(inventoryTab([
    ['GoRouter', 'https://gorouter.app/', KEY_A, KEY_B]
  ]), { providers: PROVIDERS });

  assert.deepEqual(records.map(r => r.key).sort(), [KEY_A, KEY_B].sort());
});

test('a retired account marked "Disabled" is called out rather than ignored', () => {
  const { records, warnings } = extractKeyRecords([{
    name: 'T',
    rows: [['mail', 'GoRouter', 'TabiToken'], ['a@example.com', 'Disabled', KEY_B]]
  }], { providers: PROVIDERS });

  assert.deepEqual(records.map(r => r.key), [KEY_B]);
  assert.ok(warnings.some(w => /disabled/i.test(w)), `expected a Disabled warning, got: ${warnings.join(' | ')}`);
});

test('every key-shaped cell is accounted for, in records or in unresolved', () => {
  // The invariant the original bug broke. Both shapes, in one pass.
  const sheets = [
    ...inventoryTab([
      ['GoRouter', 'https://gorouter.app/', KEY_A, '', 'https://gorouter.app/sign-up?aff=x', '55.34'],
      ['Just Do work', 'https://api.justwoker.icu/', KEY_B]
    ]),
    ...BARE_MATRIX
  ];

  const { records, unresolved } = extractKeyRecords(sheets, { providers: PROVIDERS });
  const seen = new Set([...records.map(r => r.key), ...unresolved.map(u => u.key)]);
  const inSheets = new Set();
  for (const sheet of sheets) {
    for (const row of sheet.rows) {
      for (const value of row) {
        const found = /\bsk-[A-Za-z0-9_-]{16,}\b/.exec(String(value));
        if (found) inSheets.add(found[0]);
      }
    }
  }

  assert.deepEqual([...inSheets].filter(key => !seen.has(key)), [], 'these keys were silently dropped');
  assert.equal(seen.size, inSheets.size);
});
