/**
 * Reading a spreadsheet with nothing but node:zlib.
 *
 * The reader exists because the account inventory lives in .xlsx files and this
 * project takes no dependencies. It only has to be good enough for a flat grid
 * of text, but it does have to be honest about damage: a spreadsheet that
 * silently yields half its rows would quietly lose API keys.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import { zip, workbook, sharedCell, numberCell } from './helpers/xlsxFixture.js';

const { readXlsx, readZipEntries } = await import('../src/core/xlsx.js');

test('a sheet of shared strings comes back as a grid', () => {
  const buf = workbook(
    [{ name: 'Keys', xml: `<row r="1">${sharedCell('A1', 0)}${sharedCell('B1', 1)}</row>` }],
    ['API Key:', 'Remaining Credit']
  );

  const sheets = readXlsx(buf);
  assert.equal(sheets.length, 1);
  assert.equal(sheets[0].name, 'Keys');
  assert.deepEqual(sheets[0].rows, [['API Key:', 'Remaining Credit']]);
});

test('tabs are returned in workbook order, not in part-name order', () => {
  // The real workbook lists sheet1..17 as rId5..rId21, with seventeen drawings
  // stored ahead of them. Trusting the file names would reorder the tabs.
  const buf = workbook(
    [{ name: 'Second', xml: '' }, { name: 'First', xml: '' }],
    []
  );
  assert.deepEqual(readXlsx(buf).map(s => s.name), ['Second', 'First']);
});

test('a gap in the middle of a row becomes an empty cell, not a shift', () => {
  // This is the whole ballgame: in the real sheets the referral URL is often
  // missing, and a shift would file the credit as a referral link.
  const buf = workbook(
    [{ name: 'S', xml: `<row r="2">${sharedCell('A2', 0)}${sharedCell('C2', 1)}${numberCell('F2', 198)}</row>` }],
    ['GoRouter', 'sk-not-a-real-key']
  );

  const sheets = readXlsx(buf);
  // The row declares r="2", so it keeps row 2's position and row 1 stays blank.
  assert.deepEqual(sheets[0].rows[0], []);
  assert.deepEqual(sheets[0].rows[1], ['GoRouter', '', 'sk-not-a-real-key', '', '', '198']);
});

test('a missing row number does not collapse the rows onto each other', () => {
  const buf = workbook([{ name: 'S', xml: `<row>${sharedCell('A1', 0)}</row><row>${sharedCell('A2', 1)}</row>` }], ['one', 'two']);
  assert.deepEqual(readXlsx(buf)[0].rows, [['one'], ['two']]);
});

test('a skipped row is preserved as a blank row so row numbers still line up', () => {
  const buf = workbook([{ name: 'S', xml: `<row r="1">${sharedCell('A1', 0)}</row><row r="3">${sharedCell('A3', 1)}</row>` }], ['head', 'body']);
  assert.deepEqual(readXlsx(buf)[0].rows, [['head'], [], ['body']]);
});

test('numbers, inline strings, formula results and booleans all read as text', () => {
  const xml = `<row r="1">`
    + numberCell('A1', '0.710336')
    + '<c r="B1" t="inlineStr"><is><t>inline</t></is></c>'
    + '<c r="C1" t="str"><v>computed</v></c>'
    + '<c r="D1" t="b"><v>1</v></c>'
    + '<c r="E1"/>'
    + '</row>';

  assert.deepEqual(readXlsx(workbook([{ name: 'S', xml }], []))[0].rows[0],
    ['0.710336', 'inline', 'computed', 'TRUE', '']);
});

test('entities and rich-text runs are decoded', () => {
  const buf = zip([
    { name: 'xl/workbook.xml', data: '<workbook><sheets><sheet name="S" r:id="rId5"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships><Relationship Id="rId3" Target="sharedStrings.xml"/><Relationship Id="rId5" Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: 'xl/sharedStrings.xml', data: '<sst><si><r><t>2FA codes </t></r><r><t>&amp; notes</t></r></si><si><t>a&#10;b</t></si></sst>' },
    { name: 'xl/worksheets/sheet1.xml', data: `<worksheet><sheetData><row r="1">${sharedCell('A1', 0)}${sharedCell('B1', 1)}</row></sheetData></worksheet>` }
  ]);

  assert.deepEqual(readXlsx(buf)[0].rows[0], ['2FA codes & notes', 'a\nb']);
});

test('columns past Z keep their position', () => {
  const buf = workbook([{ name: 'S', xml: `<row r="1">${sharedCell('AA1', 0)}</row>` }], ['far']);
  const row = readXlsx(buf)[0].rows[0];
  assert.equal(row.length, 27);
  assert.equal(row[26], 'far');
});

test('a stored (uncompressed) entry is read as well as a deflated one', () => {
  // The fixture stores sharedStrings.xml uncompressed; if method 0 were
  // mishandled every string cell would come back blank.
  const buf = workbook([{ name: 'S', xml: `<row r="1">${sharedCell('A1', 0)}</row>` }], ['stored']);
  assert.equal(readXlsx(buf)[0].rows[0][0], 'stored');
});

// --- refusing to half-read a damaged file -----------------------------------

test('a corrupted entry is rejected instead of silently truncated', () => {
  const buf = workbook([{ name: 'S', xml: `<row r="1">${sharedCell('A1', 0)}</row>` }], ['intact']);
  // Flip a byte inside the deflated sheet payload.
  const at = buf.indexOf(Buffer.from('xl/worksheets/sheet1.xml', 'utf8')) + 24 + 8;
  buf[at] = buf[at] ^ 0xff;

  assert.throws(() => readXlsx(buf), /sheet1\.xml|checksum|corrupt/i);
});

test('a file that is not a zip is rejected with a usable message', () => {
  assert.throws(() => readXlsx(Buffer.from('email,key\na@b.c,sk-x\n')), /not a .*xlsx|zip/i);
});

test('a zip without a workbook part is rejected', () => {
  assert.throws(() => readXlsx(zip([{ name: 'hello.txt', data: 'hi' }])), /workbook/i);
});

test('readZipEntries exposes the parts by name', () => {
  const entries = readZipEntries(zip([{ name: 'a/b.xml', data: '<x/>' }, { name: 'c.txt', data: 'plain', store: true }]));
  assert.equal(entries.get('a/b.xml').toString('utf8'), '<x/>');
  assert.equal(entries.get('c.txt').toString('utf8'), 'plain');
});

test('a zip with a data descriptor (streamed entry) still reads', () => {
  // Some exporters write zeroes in the local header and put the real sizes
  // after the payload. The central directory is the reliable source.
  const raw = Buffer.from('<sst><si><t>streamed</t></si></sst>', 'utf8');
  const body = zlib.deflateRawSync(raw);
  const base = zip([{ name: 'xl/sharedStrings.xml', data: raw }]);
  const local = base.indexOf(Buffer.from('xl/sharedStrings.xml', 'utf8')) - 30;
  base.writeUInt16LE(0x0808, local + 6);   // flag bit 3: sizes in the descriptor
  base.writeUInt32LE(0, local + 14);       // crc unknown here
  base.writeUInt32LE(0, local + 18);       // compressed size unknown here
  base.writeUInt32LE(0, local + 22);       // uncompressed size unknown here

  assert.equal(readZipEntries(base).get('xl/sharedStrings.xml').length, raw.length);
  assert.ok(body.length > 0);
});
