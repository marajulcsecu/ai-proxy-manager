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
