/**
 * Builds a real .xlsx in memory so the reader can be tested against an actual
 * zip rather than a stand-in. Test-only.
 *
 * The CRC is computed bit by bit here on purpose: the reader verifies checksums
 * with a table-driven implementation, so a bug in one cannot cancel out a bug
 * in the other.
 */

import zlib from 'node:zlib';

/** @param {Buffer} buf @returns {number} */
function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/**
 * Minimal zip writer. `store: true` emits an uncompressed entry so both
 * storage methods are exercised.
 * @param {Array<{name: string, data: string|Buffer, store?: boolean}>} files
 * @returns {Buffer}
 */
export function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const raw = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'utf8');
    const body = file.store ? raw : zlib.deflateRawSync(raw);
    const method = file.store ? 0 : 8;
    const sum = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(sum, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);

    offset += 30 + name.length + body.length;
  }

  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, dir, end]);
}

/**
 * Wraps sheets into the parts a reader needs. Sheets are referenced by rId in
 * a deliberately non-sequential order, because the real workbooks number their
 * parts independently of their tab order.
 * @param {Array<{name: string, xml: string}>} sheets
 * @param {Array<string>} [sharedStrings]
 * @returns {Buffer}
 */
export function workbook(sheets, sharedStrings = []) {
  const rels = sheets
    .map((s, i) => `<Relationship Id="rId${i + 5}" Target="worksheets/sheet${i + 1}.xml"/>`)
    .join('');
  const tabs = sheets
    .map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 5}"/>`)
    .join('');

  const files = [
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'xl/workbook.xml', data: `<workbook><sheets>${tabs}</sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<Relationships><Relationship Id="rId3" Target="sharedStrings.xml"/>${rels}</Relationships>` },
    {
      name: 'xl/sharedStrings.xml',
      data: `<sst count="${sharedStrings.length}">${sharedStrings.map(s => `<si><t>${s}</t></si>`).join('')}</sst>`,
      store: true
    }
  ];
  sheets.forEach((sheet, i) => {
    files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: `<worksheet><sheetData>${sheet.xml}</sheetData></worksheet>` });
  });
  return zip(files);
}

/** `<c>` element for a shared-string cell. */
export function sharedCell(ref, index) {
  return `<c r="${ref}" t="s"><v>${index}</v></c>`;
}

/** `<c>` element for a numeric cell. */
export function numberCell(ref, value) {
  return `<c r="${ref}"><v>${value}</v></c>`;
}
