/**
 * @fileoverview A read-only .xlsx reader built on node:zlib alone.
 *
 * The account inventory this proxy imports from lives in spreadsheets, and the
 * project takes no dependencies, so the format is unpacked by hand. An .xlsx is
 * a zip of XML parts:
 *
 *   xl/workbook.xml            tab names, in tab order, each with an r:id
 *   xl/_rels/workbook.xml.rels r:id -> the part holding that tab
 *   xl/sharedStrings.xml       the string table every text cell points into
 *   xl/worksheets/sheetN.xml   the cells
 *
 * Scope is deliberately small: a flat grid of text. Styles, dates, formulas and
 * merged ranges are not interpreted — a merged cell reads as its top-left value
 * and the rest of the range as empty, which is what the spreadsheets here look
 * like anyway.
 *
 * What is *not* optional is refusing to half-read a damaged file. Every entry's
 * CRC is checked, because a spreadsheet that quietly yields some of its rows
 * would quietly lose API keys.
 */

import zlib from 'zlib';

/** CRC-32 table, built once. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/**
 * @param {Buffer} buf
 * @returns {number} unsigned CRC-32
 */
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/** Thrown for anything that is not a spreadsheet we can read. */
export class SpreadsheetError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'SpreadsheetError';
    this.cause = cause;
  }
}

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;

/**
 * Unpacks a zip into its parts.
 *
 * Sizes and checksums are read from the central directory, never from the local
 * headers: an entry written as a stream carries zeroes there and puts the real
 * values in a trailing data descriptor.
 *
 * @param {Buffer} buf
 * @returns {Map<string, Buffer>} part name -> contents
 * @throws {SpreadsheetError}
 */
export function readZipEntries(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) {
    throw new SpreadsheetError('Not a readable .xlsx: the file is too small to be a zip.');
  }

  // The end-of-central-directory record is last, possibly behind a comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) {
    throw new SpreadsheetError('Not a readable .xlsx: no zip end-of-directory record found.');
  }

  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries = new Map();

  for (let n = 0; n < count; n++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== SIG_CENTRAL) {
      throw new SpreadsheetError(`Corrupt .xlsx: central directory entry ${n + 1} of ${count} is unreadable.`);
    }
    const method = buf.readUInt16LE(offset + 10);
    const expectedCrc = buf.readUInt32LE(offset + 16);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLength);

    if (!name.endsWith('/')) {
      entries.set(name, inflateEntry(buf, name, localOffset, method, compressedSize, expectedCrc));
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/**
 * Decompresses one entry and verifies its checksum.
 * @returns {Buffer}
 */
function inflateEntry(buf, name, localOffset, method, compressedSize, expectedCrc) {
  const localNameLength = buf.readUInt16LE(localOffset + 26);
  const localExtraLength = buf.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + localNameLength + localExtraLength;
  const payload = buf.subarray(start, start + compressedSize);

  let data;
  try {
    if (method === 0) data = Buffer.from(payload);
    else if (method === 8) data = zlib.inflateRawSync(payload);
    else throw new Error(`unsupported compression method ${method}`);
  } catch (error) {
    throw new SpreadsheetError(`Corrupt .xlsx: cannot decompress ${name} (${error.message}).`, error);
  }

  if (crc32(data) !== expectedCrc) {
    throw new SpreadsheetError(`Corrupt .xlsx: checksum mismatch in ${name}. The file is damaged — re-download it rather than importing a partial copy.`);
  }
  return data;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/**
 * Decodes XML text, including numeric character references.
 * @param {string} text
 * @returns {string}
 */
function decodeXml(text) {
  if (!text || !text.includes('&')) return text || '';
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

/** Value of one attribute on an element's attribute string. */
function attr(source, name) {
  const found = new RegExp(`(?:^|\\s)${name.replace(':', '\\:')}\\s*=\\s*"([^"]*)"`).exec(source);
  return found ? decodeXml(found[1]) : null;
}

/** Zero-based column index for a cell reference: A -> 0, Z -> 25, AA -> 26. */
function columnIndex(ref) {
  let index = 0;
  for (const char of ref) {
    const code = char.charCodeAt(0);
    if (code < 65 || code > 90) break;
    index = index * 26 + (code - 64);
  }
  return index - 1;
}

/**
 * The shared string table. Rich text is stored as runs, so every <t> inside one
 * <si> is concatenated.
 * @param {string} xml
 * @returns {Array<string>}
 */
function parseSharedStrings(xml) {
  const out = [];
  if (!xml) return out;
  for (const item of xml.matchAll(/<si\b[^>]*(?:\/>|>([\s\S]*?)<\/si>)/g)) {
    const body = item[1] ?? '';
    let text = '';
    for (const part of body.matchAll(/<t\b[^>]*(?:\/>|>([\s\S]*?)<\/t>)/g)) text += decodeXml(part[1] ?? '');
    out.push(text);
  }
  return out;
}

/**
 * One worksheet as an array of rows, each an array of cell strings.
 *
 * Positions are preserved: a row runs to its last declared cell, and a missing
 * cell in the middle is an empty string rather than a shift. The sheets this
 * reads have holes all over them, and a shift would file a credit balance as a
 * referral link.
 *
 * @param {string} xml
 * @param {Array<string>} shared
 * @returns {Array<Array<string>>}
 */
function parseSheet(xml, shared) {
  const rows = [];
  if (!xml) return rows;
  let cursor = 0;

  for (const rowMatch of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const number = Number(attr(rowMatch[1], 'r'));
    const index = Number.isInteger(number) && number > 0 ? number - 1 : cursor;
    cursor = index + 1;

    const cells = [];
    for (const cellMatch of (rowMatch[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const meta = cellMatch[1];
      const body = cellMatch[2] ?? '';
      const ref = attr(meta, 'r');
      const at = ref ? columnIndex(ref) : cells.length;
      const type = attr(meta, 't') || 'n';

      let value = '';
      if (type === 'inlineStr') {
        for (const part of body.matchAll(/<t\b[^>]*(?:\/>|>([\s\S]*?)<\/t>)/g)) value += decodeXml(part[1] ?? '');
      } else {
        const raw = decodeXml(/<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
        if (type === 's') value = shared[Number(raw)] ?? '';
        else if (type === 'b') value = raw === '1' ? 'TRUE' : raw === '0' ? 'FALSE' : raw;
        else value = raw;
      }

      if (at >= 0) {
        while (cells.length < at) cells.push('');
        cells[at] = value;
      }
    }

    while (rows.length < index) rows.push([]);
    rows[index] = cells;
  }

  return rows;
}

/** Resolves a workbook-relative relationship target to a part name. */
function resolveTarget(target) {
  const clean = String(target || '').replace(/^\.\//, '');
  if (!clean) return '';
  if (clean.startsWith('/')) return clean.slice(1);
  return clean.startsWith('xl/') ? clean : `xl/${clean}`;
}

/**
 * Reads a workbook into tabs, in the order the tabs appear in the application.
 *
 * Part file names cannot be trusted for order: the inventory workbook stores
 * seventeen drawings ahead of its sheets and numbers sheet1..17 as rId5..rId21.
 *
 * @param {Buffer} buf - the whole .xlsx file
 * @returns {Array<{name: string, rows: Array<Array<string>>}>}
 * @throws {SpreadsheetError}
 */
export function readXlsx(buf) {
  const entries = readZipEntries(buf);
  const workbookXml = entries.get('xl/workbook.xml')?.toString('utf8');
  if (!workbookXml) {
    throw new SpreadsheetError('Not a readable .xlsx: xl/workbook.xml is missing.');
  }

  const relsXml = entries.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  const targets = new Map();
  for (const rel of relsXml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = attr(rel[1], 'Id');
    if (id) targets.set(id, resolveTarget(attr(rel[1], 'Target')));
  }

  const shared = parseSharedStrings(entries.get('xl/sharedStrings.xml')?.toString('utf8') ?? '');
  const sheets = [];
  let fallback = 0;

  for (const tab of workbookXml.matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    const meta = tab[1];
    const name = attr(meta, 'name') ?? `Sheet${sheets.length + 1}`;
    const id = attr(meta, 'r:id') ?? attr(meta, 'id');
    const part = (id && targets.get(id)) || `xl/worksheets/sheet${++fallback}.xml`;
    sheets.push({ name, rows: parseSheet(entries.get(part)?.toString('utf8') ?? '', shared) });
  }

  return sheets;
}
