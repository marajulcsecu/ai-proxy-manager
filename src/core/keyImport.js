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
import { normalizeConfig, normalizeProviderName } from './configManager.js';

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

/**
 * Model names out of a "Top Models" cell.
 *
 * The real column is separated by commas and newlines at once
 * ("gpt-5.6-sol,\nclaude-opus-4-8"), and sometimes by newlines alone. Anything
 * with a space in it is prose, not a model id — the sheet also holds notes like
 * "surprise me" in that column, and a made-up model name in a provider's list
 * would come back as a 404 from the relay much later, far from here.
 * @returns {Array<string>}
 */
function splitModels(text) {
  const out = [];
  for (const piece of String(text ?? '').split(/[,;\r\n]+/)) {
    const name = piece.trim();
    if (!name || name.length > 80) continue;
    if (/\s/.test(name)) continue;
    if (RE_KEY.test(name) || RE_URL.test(name) || RE_NUMBER.test(name) || RE_EMAIL.test(name)) continue;
    if (!/[A-Za-z]/.test(name)) continue;
    // Every model id in the inventory carries a version or a hyphen
    // (claude-opus-5, gpt-5.6-sol, ox-alpha). A bare word does not, and one row
    // writes the note "ALL KINDS OF MODELS" one word per line — four ids that
    // would reach the dashboard's model list and 404 from the relay much later.
    if (!/[\d\-/.:]/.test(name)) continue;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * Index of the models column, or -1.
 *
 * Named by its header rather than found by content: a model id looks like an
 * ordinary hyphenated word, so content detection would happily read a provider
 * name or a note as a model. If the sheet does not label the column, this
 * reports nothing instead of guessing.
 */
function modelsColumn(header) {
  return (header || []).findIndex(value => /model/i.test(cell(value)));
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
    const modelsAt = modelsColumn(header);
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
            // A column header is a name and nothing more: no URL, so no provider
            // can be proposed from it later. Carried through all the same.
            unresolved.push({ key: found[0], hint: column.header, name: column.header, url: '', sheet: sheet.name, row: at });
            continue;
          }
          keep({
            provider: column.provider, key: found[0], label,
            remaining: null, referralUrl: '', dashboardUrl: '', models: [], sheet: sheet.name, row: at
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
      const models = modelsAt >= 0 ? splitModels(cells[modelsAt]) : [];
      for (const keyCell of keyCells) {
        const key = RE_KEY.exec(keyCell)[0];
        if (!provider) {
          unresolved.push({ key, hint, name, url: dashboard || referral, sheet: sheet.name, row: at });
          continue;
        }
        keep({
          provider, key,
          label: emailIn(cells) || sheetLabel,
          remaining: amount === undefined ? null : Number(amount),
          referralUrl: referral,
          dashboardUrl: dashboard,
          models,
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
  let added = 0, updated = 0, unchanged = 0, skipped = 0, modelsAdded = 0;
  /** provider -> models the sheet named, in the order it named them. */
  const wanted = new Map();

  for (const record of records || []) {
    const provider = next.providers[record.provider];
    if (!provider) { skipped++; continue; }

    // The models belong to the row, not to the key, so they are collected even
    // when the key itself turns out to be one the pool already had.
    if (record.models?.length) {
      const list = wanted.get(record.provider) || [];
      for (const model of record.models) if (!list.includes(model)) list.push(model);
      wanted.set(record.provider, list);
    }

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

  // Appended, never replaced: the list may have been curated by hand, and
  // `defaultModel` is the user's choice of what to send — not the sheet's.
  for (const [name, models] of wanted) {
    const provider = next.providers[name];
    provider.models = Array.isArray(provider.models) ? provider.models : [];
    for (const model of models) {
      if (!provider.models.includes(model)) { provider.models.push(model); modelsAdded++; }
    }
  }

  return { config: normalizeConfig(next), added, updated, unchanged, skipped, modelsAdded };
}

/**
 * API base for a relay the sheet only gave a website for.
 *
 * The column is called "URL For API KEY" and holds a dashboard link
 * (https://api.justwoker.icu/), not an endpoint. Every relay in this inventory
 * is a New-API / One-API fork, and all of them serve the OpenAI-shaped API at
 * `/v1` of the same origin, so that is what is proposed — the path is dropped,
 * because a token page is not a base URL. A URL that already names a version
 * keeps it.
 * @returns {string} '' when the URL is unusable
 */
function apiBaseFor(url) {
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    const version = /\/v\d+[a-z]*/i.exec(parsed.pathname);
    return `${parsed.origin}${version ? version[0] : '/v1'}`;
  } catch {
    return '';
  }
}

/**
 * Proposes providers for keys that resolved to none.
 *
 * Read-only and separate from the import on purpose: creating a provider is a
 * decision (it puts a host in the config that the proxy will send keys to), so
 * the importer only acts on this when explicitly asked. A name already in the
 * config is never proposed — overwriting a live provider's URL would take its
 * whole key pool with it.
 *
 * @param {Array<{key: string, name?: string, url?: string, hint?: string}>} unresolved
 * @param {Object} [providers] - the configured providers, which are off limits
 * @returns {{create: Array<{name: string, url: string, keys: Array<string>, from: string}>,
 *            stillUnresolved: Array<Object>}}
 */
export function planProviders(unresolved, providers = {}) {
  const create = new Map();
  const stillUnresolved = [];

  for (const item of unresolved || []) {
    const url = apiBaseFor(item?.url);
    const typed = squash(item?.name);
    const label = hostLabel(item?.url);
    const name = normalizeProviderName(
      PROVIDER_ALIASES[typed] || PROVIDER_ALIASES[label] || label || typed
    );

    // No URL means no provider: the matrix layout names a relay in a column
    // header and nowhere else, and inventing a host for a key is not a repair.
    if (!url || !name || providers[name]) { stillUnresolved.push(item); continue; }

    const plan = create.get(name) || { name, url, keys: [], from: item.hint || item.name || '' };
    if (item.key && !plan.keys.includes(item.key)) plan.keys.push(item.key);
    create.set(name, plan);
  }

  return { create: [...create.values()], stillUnresolved };
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
