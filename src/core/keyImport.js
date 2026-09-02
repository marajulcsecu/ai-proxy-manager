/**
 * @fileoverview Turns the account spreadsheets into key-pool entries.
 *
 * The inventory is hand-maintained, so this reads it by *content* rather than by
 * column position. Every rule here exists because the real files break the
 * obvious assumption:
 *
 *  - The data rows do not line up with their own header: the header's first cell
 *    is the account's e-mail address, and the rows start one column earlier.
 *  - The API-key column sometimes holds a bare number (a credit figure typed in
 *    the wrong place) for accounts that were never created.
 *  - The credit sometimes sits in the referral-link column instead.
 *  - One workbook is a row per provider; the other is a column per provider,
 *    with the provider named in the header and one account per row.
 *  - One provider's name is misspelled, and another's brand does not match its
 *    domain.
 *
 * So: a key is a cell that looks like a key, a balance is a cell that looks like
 * a number, and a provider is resolved from a URL before a typed name. Anything
 * that cannot be resolved is reported rather than guessed — a key filed under
 * the wrong provider is worse than a key left in the spreadsheet.
 *
 * Pure functions plus one file read. Nothing here writes to the config.
 */

import fs from 'fs';
import path from 'path';
import { readXlsx } from './xlsx.js';
import { normalizeConfig } from './configManager.js';

/**
 * Names in the inventory that cannot be matched to a provider id textually.
 * Kept explicit so the mapping is auditable and correctable by hand.
 */
export const PROVIDER_ALIASES = {
  aegntrouter: 'agentrouter',   // misspelled throughout the inventory
  agentrouter: 'agentrouter',
  tabiai: 'tabitoken',          // brands itself TaBiAI, the domain is tabitoken.com
  tabi: 'tabitoken',
  gorouter: 'gorouter',
  justdowork: 'justwoker',      // api.justwoker.icu, not configured by default
  justwoker: 'justwoker',
  anymodel: 'anymodel',
  aihubmix: 'aihubmix',
  kktoken: 'kktoken',
  seekai: 'seekai',
  bluesminds: 'bluesminds'
};

/** A cell that is an API key. Deliberately strict: numbers must not qualify. */
export const RE_KEY = /\bsk-[A-Za-z0-9_-]{16,}\b/;
const RE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;
const RE_URL = /^https?:\/\/\S+$/i;
const RE_NUMBER = /^-?\d+(?:\.\d+)?$/;
const RE_KEY_HEADER = /api\s*[-_]?\s*key/i;
const RE_REFERRAL = /[?&](?:aff|ref|invite|r)=|\/register|\/sign[-_]?up|\/invite/i;

/** Lowercased alphanumerics only, for comparing hand-typed names. */
function squash(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

const cell = value => String(value ?? '').trim();

/** Comparable form of a URL's host, with the usual prefixes dropped. */
function hostKey(url) {
  try {
    const host = new URL(String(url)).hostname.replace(/^(?:www|api)\./i, '');
    return squash(host);
  } catch {
    return '';
  }
}

/** Leading label of a host: gorouter.app -> gorouter. */
function hostLabel(url) {
  try {
    return squash(new URL(String(url)).hostname.replace(/^(?:www|api)\./i, '').split('.')[0]);
  } catch {
    return '';
  }
}

/**
 * Resolves a provider id from whatever the row offers.
 * @param {{name?: string, url?: string}} hint
 * @param {Object} providers - the configured providers
 * @returns {string|null}
 */
export function resolveProvider(hint, providers) {
  const names = Object.keys(providers || {});
  if (!names.length) return null;

  // The URL is machine-generated, so it beats a hand-typed name.
  const host = hostKey(hint.url);
  if (host) {
    for (const name of names) if (hostKey(providers[name]?.url) === host) return name;
    const label = hostLabel(hint.url);
    if (label) {
      if (providers[label]) return label;
      for (const name of names) if (hostLabel(providers[name]?.url) === label) return name;
      const aliased = PROVIDER_ALIASES[label];
      if (aliased && providers[aliased]) return aliased;
    }
  }

  const typed = squash(hint.name);
  if (typed) {
    if (providers[typed]) return typed;
    for (const name of names) if (hostLabel(providers[name]?.url) === typed) return name;
    const aliased = PROVIDER_ALIASES[typed];
    if (aliased && providers[aliased]) return aliased;
  }

  return null;
}

/** First cell holding an e-mail address. */
function emailIn(cells) {
  for (const value of cells) {
    const found = RE_EMAIL.exec(cell(value));
    if (found) return found[0];
  }
  return '';
}

/**
 * Columns that actually contain keys, by index. Detection is by content because
 * two tabs label their key columns with nothing but a provider name, so looking
 * for the words "API Key" found no header at all and lost 70 keys in silence.
 * @returns {Array<number>}
 */
function keyColumnIndexes(rows) {
  const found = new Set();
  for (const row of rows || []) {
    (row || []).forEach((value, index) => {
      if (RE_KEY.test(cell(value))) found.add(index);
    });
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * Index of the header row: the row above the first key, or failing that the
 * first row that names a key column. A tab with no keys still has a header, so
 * the "no key for X" warnings keep working.
 */
function findHeader(rows) {
  const limit = Math.min((rows || []).length, 5);
  for (let i = 0; i < limit; i++) {
    if ((rows[i] || []).some(value => RE_KEY_HEADER.test(cell(value)))) return i;
  }
  const firstKey = (rows || []).findIndex(row => (row || []).some(value => RE_KEY.test(cell(value))));
  return firstKey > 0 ? firstKey - 1 : -1;
}

/**
 * Provider named by a column header. The real headers range from "Go Router API
 * Key" to a bare "TabiToken" to "seekai. (default) , surprise me", so the whole
 * label is tried first and then its individual words.
 * @returns {string|null}
 */
function resolveColumnProvider(text, providers) {
  const stripped = text.replace(RE_KEY_HEADER, ' ');
  for (const candidate of [stripped, text, ...stripped.split(/[^A-Za-z0-9]+/)]) {
    if (!squash(candidate)) continue;
    const provider = resolveProvider({ name: candidate }, providers);
    if (provider) return provider;
  }
  return null;
}

/**
 * Key-bearing columns of a matrix tab, one provider per column.
 *
 * A column whose header cannot be resolved is still returned, with a null
 * provider, so its keys are reported as unresolved instead of dropped. A column
 * whose header *does* name a provider is returned even when it holds no key at
 * all, so a "Disabled" cell can be reported rather than passed over.
 *
 * The shape is only treated as a matrix when at least one column names a
 * provider: in the row-per-provider workbook the key column is headed
 * "API Key:", and a key that drifted into a neighbouring column must not turn
 * that tab into a matrix.
 * @returns {Array<{index: number, provider: string|null, header: string}>}
 */
function providerColumns(header, rows, providers) {
  const indexes = new Set(keyColumnIndexes(rows));
  const named = new Map();
  (header || []).forEach((value, index) => {
    const text = cell(value);
    const provider = text ? resolveColumnProvider(text, providers) : null;
    if (provider) named.set(index, provider);
  });
  if (![...indexes].some(index => named.has(index))) return [];

  for (const index of named.keys()) indexes.add(index);
  return [...indexes].sort((a, b) => a - b).map(index => ({
    index,
    header: cell((header || [])[index]),
    provider: named.get(index) ?? null
  }));
}

/**
 * Reads key records out of parsed sheets.
 * @param {Array<{name: string, rows: Array<Array<string>>}>} sheets
 * @param {{providers: Object}} options
 * @returns {{records: Array<Object>, unresolved: Array<Object>, warnings: Array<string>}}
 */
export function extractKeyRecords(sheets, options = {}) {
  const providers = options.providers || {};
  const records = [];
  const unresolved = [];
  const warnings = [];
  const seen = new Set();

  const keep = (record) => {
    if (seen.has(record.key)) return;
    seen.add(record.key);
    records.push(record);
  };

  for (const sheet of sheets || []) {
    const rows = sheet.rows || [];
    const headerAt = findHeader(rows);
    const header = headerAt >= 0 ? rows[headerAt] : [];
    const body = rows.slice(headerAt + 1);
    const columns = providerColumns(header, body, providers);
    // Row-per-provider tabs name the account once, in the header (or, when the
    // header was overwritten, in the tab name itself).
    const sheetLabel = emailIn(header) || emailIn([sheet.name]);

    body.forEach((row, offset) => {
      const cells = (row || []).map(cell);
      const at = `${sheet.name} row ${headerAt + offset + 2}`;
      if (!cells.some(Boolean)) return;

      if (columns.length) {
        // One account per row; each provider column may hold that account's key.
        const label = emailIn(cells) || sheetLabel;
        for (const column of columns) {
          const text = cells[column.index] || '';
          const found = RE_KEY.exec(text);
          if (!found) {
            // "Disabled" where a key belongs means the account was retired.
            // Worth saying out loud: a blank cell and a revoked one differ.
            if (text) warnings.push(`"${text.slice(0, 40)}" is not a key, in the ${column.header || `column ${column.index + 1}`} column (${at})`);
            continue;
          }
          if (!column.provider) {
            unresolved.push({ key: found[0], hint: column.header, sheet: sheet.name, row: at });
            continue;
          }
          keep({
            provider: column.provider, key: found[0], label,
            remaining: null, referralUrl: '', dashboardUrl: '', sheet: sheet.name, row: at
          });
        }
        return;
      }

      // One provider per row: everything is identified by what it looks like.
      // Every key in the row is taken, not just the first — a second key in a
      // row is exactly the kind of thing that used to vanish.
      const keyCells = cells.filter(value => RE_KEY.test(value));
      const urls = cells.filter(value => RE_URL.test(value));
      const referral = urls.find(url => RE_REFERRAL.test(url)) || '';
      const dashboard = urls.find(url => url !== referral) || '';
      const amount = cells.find(value => RE_NUMBER.test(value));
      const name = cells.find(value =>
        value && !RE_KEY.test(value) && !RE_URL.test(value) && !RE_NUMBER.test(value) && !RE_EMAIL.test(value)) || '';

      if (!keyCells.length) {
        if (name || urls.length) warnings.push(`no key for ${name || urls[0]} (${at})`);
        return;
      }

      const provider = resolveProvider({ name, url: dashboard || referral }, providers);
      const hint = [name, dashboard || referral].filter(Boolean).join(' ');
      for (const keyCell of keyCells) {
        const key = RE_KEY.exec(keyCell)[0];
        if (!provider) {
          unresolved.push({ key, hint, sheet: sheet.name, row: at });
          continue;
        }
        keep({
          provider, key,
          label: emailIn(cells) || sheetLabel,
          remaining: amount === undefined ? null : Number(amount),
          referralUrl: referral,
          dashboardUrl: dashboard,
          sheet: sheet.name,
          row: at
        });
      }
    });
  }

  return { records, unresolved, warnings };
}

/**
 * Merges records into a config without ever losing or downgrading anything.
 *
 * A key already in a pool keeps its status and its position, so the account the
 * proxy is currently using stays at the head and stays selected. Blank fields
 * are filled in from the sheet; fields that already hold a value are left
 * alone, because a figure typed into a spreadsheet is worth less than one the
 * proxy measured from a rejection.
 *
 * @param {Object} config - normalized config; not mutated
 * @param {Array<Object>} records
 * @returns {{config: Object, added: number, updated: number, unchanged: number, skipped: number}}
 */
export function mergeKeyRecords(config, records) {
  const next = JSON.parse(JSON.stringify(config || {}));
  next.providers = next.providers || {};
  let added = 0, updated = 0, unchanged = 0, skipped = 0;

  for (const record of records || []) {
    const provider = next.providers[record.provider];
    if (!provider) { skipped++; continue; }

    provider.keys = Array.isArray(provider.keys) ? provider.keys : [];
    const existing = provider.keys.find(entry => entry.key === record.key);

    if (!existing) {
      provider.keys.push({
        key: record.key,
        label: record.label || '',
        status: 'unknown',              // untested until something probes it
        remaining: record.remaining ?? null,
        dashboardUrl: record.dashboardUrl || '',
        referralUrl: record.referralUrl || '',
        note: record.note || ''
      });
      added++;
      continue;
    }

    let touched = false;
    for (const field of ['label', 'dashboardUrl', 'referralUrl', 'note']) {
      if (!existing[field] && record[field]) { existing[field] = record[field]; touched = true; }
    }
    if (existing.remaining === null || existing.remaining === undefined) {
      if (record.remaining !== null && record.remaining !== undefined) {
        existing.remaining = record.remaining;
        touched = true;
      }
    }
    if (touched) updated++; else unchanged++;
  }

  return { config: normalizeConfig(next), added, updated, unchanged, skipped };
}

/**
 * Parses CSV, for anything exported straight out of a spreadsheet.
 * Handles quoted fields, escaped quotes, embedded newlines and CRLF.
 * @param {string} text
 * @returns {Array<Array<string>>}
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const source = String(text ?? '');

  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char !== '"') { field += char; continue; }
      if (source[i + 1] === '"') { field += '"'; i++; continue; }
      quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === ',') { row.push(field); field = ''; continue; }
    if (char === '\r') continue;
    if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }

  return rows;
}

/**
 * Reads one spreadsheet from disk into the shape extractKeyRecords wants.
 * @param {string} file - .xlsx or .csv
 * @returns {Array<{name: string, rows: Array<Array<string>>}>}
 */
export function readSpreadsheet(file) {
  const buf = fs.readFileSync(file);
  if (/\.csv$/i.test(file)) {
    return [{ name: path.basename(file), rows: parseCsv(buf.toString('utf8')) }];
  }
  return readXlsx(buf);
}
