/**
 * @fileoverview The `ai-proxy keys …` commands.
 *
 * Importing is deliberately conservative. The spreadsheets are the only record
 * of these accounts, so the rules are: never guess a provider, never overwrite
 * what the proxy measured itself, never move the key that is currently working,
 * and never write at all if a single key in the file went unaccounted for.
 */

import fs from 'fs';
import path from 'path';
import { loadConfig, saveConfig } from '../core/configManager.js';
import { selectKey, nextKeyId, applyKeyVerdict } from '../core/keyStore.js';
import { readSpreadsheet, extractKeyRecords, mergeKeyRecords, RE_KEY } from '../core/keyImport.js';
import { Logger } from '../utils/logger.js';
import { UsageError } from '../utils/errors.js';

/** Shows enough of a key to recognise it, never enough to use it. */
function maskKey(key) {
  if (!key) return '';
  return key.length <= 12 ? '••••••' : `${key.slice(0, 5)}…${key.slice(-4)}`;
}

/**
 * Compares what the file contains with what the extractor made of it.
 *
 * This is the reliability check the first importer lacked: it read two of the
 * spreadsheet's layouts, mishandled the third, and reported a clean run while
 * 70 keys stayed behind. Counting the key-shaped cells independently of the
 * parser is the only way to notice that from the outside.
 *
 * @param {Array<{name: string, rows: Array<Array<string>>}>} sheets
 * @param {{records: Array<{key: string}>, unresolved: Array<{key: string}>}} result
 * @returns {{keys: number, accounted: number, lost: Array<string>}}
 */
export function accountFor(sheets, result) {
  const inFile = new Set();
  for (const sheet of sheets || []) {
    for (const row of sheet.rows || []) {
      for (const value of row || []) {
        const found = RE_KEY.exec(String(value ?? ''));
        if (found) inFile.add(found[0]);
      }
    }
  }
  const seen = new Set([
    ...(result.records || []).map(r => r.key),
    ...(result.unresolved || []).map(u => u.key)
  ]);
  return {
    keys: inFile.size,
    accounted: [...inFile].filter(key => seen.has(key)).length,
    lost: [...inFile].filter(key => !seen.has(key))
  };
}

/**
 * Reads spreadsheets and merges their keys into the config.
 * @param {string[]} files - .xlsx or .csv paths
 * @param {{dryRun?: boolean}} [options]
 * @returns {Object} summary of what happened (or would have)
 */
export function importKeys(files, options = {}) {
  const paths = (files || []).filter(Boolean).map(file => path.resolve(file));
  if (!paths.length) {
    throw new UsageError(
      'Usage: ai-proxy keys import <file.xlsx|file.csv> [more…] [--dry-run]',
      'A spreadsheet of accounts: one row (or one column) per provider, with the API key in a cell of its own.'
    );
  }

  const sheets = [];
  for (const file of paths) {
    if (!fs.existsSync(file)) throw new UsageError(`No such file: ${file}`);
    let parsed;
    try {
      parsed = readSpreadsheet(file);
    } catch (error) {
      throw new UsageError(`Cannot read ${file}: ${error.message}`, 'Supported: .xlsx and .csv');
    }
    for (const sheet of parsed) sheets.push({ ...sheet, name: `${path.basename(file)} › ${sheet.name}` });
  }

  const config = loadConfig();
  const found = extractKeyRecords(sheets, { providers: config.providers });
  const accounting = accountFor(sheets, found);

  if (accounting.lost.length) {
    throw new UsageError(
      `Refusing to import: ${accounting.lost.length} of ${accounting.keys} keys in the file could not be read.`,
      `Nothing was written. First one looks like ${maskKey(accounting.lost[0])} — please report the layout of that tab.`
    );
  }

  const merged = mergeKeyRecords(config, found.records);
  if (!options.dryRun) saveConfig(merged.config);

  const summary = {
    files: paths,
    tabs: sheets.length,
    keys: accounting.keys,
    records: found.records.length,
    added: merged.added,
    updated: merged.updated,
    unchanged: merged.unchanged,
    skipped: merged.skipped,
    unresolved: found.unresolved,
    warnings: found.warnings,
    lost: accounting.lost,
    pools: Object.fromEntries(Object.entries(merged.config.providers).map(([name, p]) => [name, p.keys.length])),
    dryRun: Boolean(options.dryRun)
  };

  reportImport(summary);
  return summary;
}

/** Prints an import summary. Kept apart so the numbers can be tested quietly. */
function reportImport(summary) {
  Logger.header(summary.dryRun ? 'Key import (dry run — nothing written)' : 'Key import');
  Logger.plain(`  Read        ${summary.keys} keys from ${summary.tabs} tab(s)`);
  Logger.success(`Added ${summary.added}, updated ${summary.updated}, unchanged ${summary.unchanged}`
    + (summary.skipped ? `, skipped ${summary.skipped}` : ''));

  const pools = Object.entries(summary.pools).map(([name, count]) => `${name} ${count}`).join(' · ');
  if (pools) Logger.plain(`  Pools       ${pools}`);

  if (summary.unresolved.length) {
    const byHint = new Map();
    for (const item of summary.unresolved) {
      const hint = item.hint || '(nothing in the row identified a provider)';
      byHint.set(hint, (byHint.get(hint) || 0) + 1);
    }
    Logger.warn(`${summary.unresolved.length} key(s) belong to no configured provider and were left out:`);
    for (const [hint, count] of byHint) Logger.dim(`    ${count} × ${hint}`);
    Logger.dim('    Add the provider (ai-proxy add-provider <name> <url>) and import again.');
  }

  if (summary.warnings.length) {
    Logger.info(`${summary.warnings.length} row(s) had no usable key:`);
    for (const warning of summary.warnings.slice(0, 8)) Logger.dim(`    ${warning}`);
    if (summary.warnings.length > 8) Logger.dim(`    …and ${summary.warnings.length - 8} more`);
  }

  Logger.dim('  Balances from a spreadsheet are only as fresh as the sheet — run a check to measure them.');
  if (summary.dryRun) Logger.info('Dry run: config.json was not touched. Re-run without --dry-run to apply.');
}

// --- the manual switch -------------------------------------------------------

/** Looks a provider up, with a helpful error when it is missing. */
function requireProvider(config, name) {
  const provider = config.providers[String(name ?? '').trim().toLowerCase()];
  if (!provider) {
    const known = Object.keys(config.providers);
    throw new UsageError(
      `Provider '${name}' not found.`,
      known.length ? `Known providers: ${known.join(', ')}` : 'Add one first: ai-proxy add-provider <name> <url>'
    );
  }
  return { name: String(name).trim().toLowerCase(), provider };
}

/**
 * Finds one key from a human-typed selector: its position in the pool (1-based),
 * its id (or the start of it), or part of its label. Ambiguity is an error —
 * picking the wrong account is worse than asking again.
 * @returns {{entry: Object, index: number}}
 */
function requireKey(provider, selector) {
  const keys = provider.keys || [];
  const wanted = String(selector ?? '').trim();
  if (!wanted) throw new UsageError('Which key? Give its number from `ai-proxy keys list`, its id, or its label.');

  if (/^\d+$/.test(wanted)) {
    const index = Number(wanted) - 1;
    if (index < 0 || index >= keys.length) {
      throw new UsageError(`This pool has ${keys.length} key(s), so ${wanted} is out of range.`);
    }
    return { entry: keys[index], index };
  }

  const lower = wanted.toLowerCase();
  const matches = keys
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.id.startsWith(lower) || (entry.label || '').toLowerCase().includes(lower));

  if (!matches.length) throw new UsageError(`No key in this pool matches '${wanted}'.`);
  if (matches.length > 1) {
    throw new UsageError(
      `'${wanted}' matches ${matches.length} keys.`,
      matches.map(({ entry, index }) => `  ${index + 1}. ${entry.label || maskKey(entry.key)}`).join('\n')
    );
  }
  return matches[0];
}

/**
 * One row per key, safe to print or serve: the key itself is masked.
 * @param {string} [providerName] - omit for every provider
 * @returns {Array<Object>}
 */
export function listKeys(providerName) {
  const config = loadConfig();
  const names = providerName ? [requireProvider(config, providerName).name] : Object.keys(config.providers);

  const rows = [];
  for (const name of names) {
    const provider = config.providers[name];
    const inUse = selectKey(provider.keys, provider.selectedKeyId)?.id ?? null;
    (provider.keys || []).forEach((entry, index) => {
      rows.push({
        provider: name,
        position: index + 1,
        id: entry.id,
        masked: maskKey(entry.key),
        label: entry.label,
        status: entry.status,
        remaining: entry.remaining,
        needed: entry.needed,
        requestsServed: entry.requestsServed,
        lastUsedAt: entry.lastUsedAt,
        lastError: entry.lastError,
        inUse: entry.id === inUse
      });
    });
  }

  reportKeys(rows, names, config);
  return rows;
}

/** Pins `entry` as the key to send and saves. */
function pin(config, name, provider, entry) {
  const next = {
    ...config,
    providers: { ...config.providers, [name]: { ...provider, selectedKeyId: entry?.id ?? '' } }
  };
  saveConfig(next);
  return entry;
}

/**
 * Switches to the next usable key in the pool.
 * @returns {{provider: string, from: Object|null, to: Object}}
 */
export function nextKey(providerName) {
  const config = loadConfig();
  const { name, provider } = requireProvider(config, providerName);
  const keys = provider.keys || [];
  if (!keys.length) throw new UsageError(`${name} has no key at all.`, 'Import some: ai-proxy keys import <file.xlsx>');

  const from = selectKey(keys, provider.selectedKeyId);
  const toId = nextKeyId(keys, from?.id ?? null);
  if (!toId) {
    throw new UsageError(
      `${name} has no usable key left after ${from ? (from.label || maskKey(from.key)) : 'the current one'}.`,
      'Top an account up and revive it (ai-proxy keys revive ' + name + ' <n>), or import more keys.'
    );
  }

  const to = keys.find(k => k.id === toId);
  pin(config, name, provider, to);
  Logger.success(`${name} now uses ${to.label || maskKey(to.key)} (${to.status}).`);
  return { provider: name, from, to };
}

/** Pins a specific key, chosen by number, id or label. */
export function useKey(providerName, selector) {
  const config = loadConfig();
  const { name, provider } = requireProvider(config, providerName);
  const { entry } = requireKey(provider, selector);

  if (entry.status === 'invalid' || entry.status === 'disabled') {
    throw new UsageError(
      `That key is marked ${entry.status}, so it would never be sent.`,
      entry.status === 'invalid'
        ? 'A revoked key cannot be revived — replace it, or `ai-proxy keys revive` if it was marked in error.'
        : `Enable it first: ai-proxy keys revive ${name} ${selector}`
    );
  }

  pin(config, name, provider, entry);
  Logger.success(`${name} now uses ${entry.label || maskKey(entry.key)} (${entry.status}).`);
  return { provider: name, to: entry };
}

/** Marks a key spent and moves on. Defaults to the key currently in use. */
export function retireKey(providerName, selector) {
  const config = loadConfig();
  const { name, provider } = requireProvider(config, providerName);
  const target = selector
    ? requireKey(provider, selector).entry
    : selectKey(provider.keys, provider.selectedKeyId);
  if (!target) throw new UsageError(`${name} has no key to retire.`);

  const marked = applyKeyVerdict(config, name, target.id, { kind: 'exhausted', tier: 'manual', status: 0, matched: 'retired by hand' });
  const provider2 = marked.config.providers[name];
  const toId = nextKeyId(provider2.keys, target.id);
  const to = toId ? provider2.keys.find(k => k.id === toId) : null;

  saveConfig({
    ...marked.config,
    providers: { ...marked.config.providers, [name]: { ...provider2, selectedKeyId: to?.id ?? target.id } }
  });

  Logger.success(`Marked ${target.label || maskKey(target.key)} exhausted (it stays in the pool).`);
  if (to) Logger.plain(`  ${name} now uses ${to.label || maskKey(to.key)} (${to.status}).`);
  else Logger.warn(`${name} has no usable key left — top an account up, then: ai-proxy keys revive ${name} <n>`);

  return { provider: name, from: target, to };
}

/** Puts a key back in service as untested. */
export function reviveKey(providerName, selector) {
  const config = loadConfig();
  const { name, provider } = requireProvider(config, providerName);
  const { entry, index } = requireKey(provider, selector);

  const keys = [...provider.keys];
  // Untested, not known-good: a topped-up account has not answered yet, and the
  // balance the proxy last measured describes a state that no longer holds.
  keys[index] = { ...entry, status: 'unknown', lastError: null, remaining: null, needed: null };
  saveConfig({ ...config, providers: { ...config.providers, [name]: { ...provider, keys } } });

  Logger.success(`${entry.label || maskKey(entry.key)} is back in ${name}'s pool as untested.`);
  Logger.dim(`  Send it a request to confirm: ai-proxy keys use ${name} ${index + 1} && ai-proxy test ${name}`);
  return { provider: name, entry: keys[index] };
}

/** Prints the pools grouped by provider. */
function reportKeys(rows, names, config) {
  if (!rows.length) {
    Logger.info(names.length === 1 ? `${names[0]} has no keys yet.` : 'No keys stored yet.');
    Logger.dim('  Import them: ai-proxy keys import <file.xlsx>');
    return;
  }

  for (const name of names) {
    const mine = rows.filter(row => row.provider === name);
    if (!mine.length) continue;
    const spent = mine.filter(row => row.status === 'exhausted').length;
    const dead = mine.filter(row => row.status === 'invalid').length;

    Logger.header(`${name} — ${mine.length} key(s)`
      + (spent ? `, ${spent} spent` : '') + (dead ? `, ${dead} revoked` : ''));

    for (const row of mine) {
      const mark = row.inUse ? '→' : ' ';
      const balance = row.remaining === null ? '' : ` $${row.remaining}`;
      Logger.plain(`  ${mark} ${String(row.position).padStart(3)}. ${row.masked}  ${row.status.padEnd(9)}`
        + `${(row.label || '').padEnd(28)}${balance}`);
    }
    const provider = config.providers[name];
    if (!provider.selectedKeyId) Logger.dim('    (no explicit selection — the first usable key is sent)');
  }
}
