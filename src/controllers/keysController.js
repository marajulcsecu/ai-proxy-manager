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
import { loadConfig, saveConfig, CONFIG_DIR } from '../core/configManager.js';
import { selectKey, nextKeyId, applyKeyVerdict, maskKey, KEY_ROTATION_MODES } from '../core/keyStore.js';
import { readSpreadsheet, extractKeyRecords, mergeKeyRecords, RE_KEY } from '../core/keyImport.js';
import { checkKeys, DEFAULT_LOW } from '../core/keyCheck.js';
import { Logger } from '../utils/logger.js';
import { UsageError } from '../utils/errors.js';

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
        inUse: entry.id === inUse,
        // Provider-level, repeated per row like `provider` itself: a caller
        // reading one key's row can still tell whether anything moves by hand.
        keyRotation: provider.keyRotation
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

/**
 * Reads or sets who does the switching for one provider.
 *
 * Per provider, and manual by default, because the wording of a refusal differs
 * between relays: `auto` is only safe once `keys check` has shown that this one
 * really does say "out of credit" when it means it. Called with no mode it only
 * reports, so it is also the answer to "what is this provider on?".
 *
 * @param {string} providerName
 * @param {string} [mode] - 'manual' | 'auto'; omit to read
 * @returns {{provider: string, mode: string, previous: string, changed: boolean}}
 */
export function setRotation(providerName, mode) {
  const config = loadConfig();
  const { name, provider } = requireProvider(config, providerName);
  const previous = provider.keyRotation;

  const wanted = String(mode ?? '').trim().toLowerCase();
  if (!wanted) {
    Logger.info(`${name} switches keys ${previous === 'auto' ? 'automatically' : 'when you say so'}.`);
    if (previous !== 'auto') Logger.dim(`  Hand it the pool: ai-proxy keys rotation ${name} auto`);
    return { provider: name, mode: previous, previous, changed: false };
  }
  if (!KEY_ROTATION_MODES.includes(wanted)) {
    throw new UsageError(
      `'${mode}' is not a rotation mode.`,
      `Use one of: ${KEY_ROTATION_MODES.join(', ')}`
    );
  }

  // Saving an unchanged config would rotate the five backups away for nothing,
  // and every one of them is a copy of the key pool.
  if (wanted === previous) {
    Logger.info(`${name} is already on ${previous}.`);
    return { provider: name, mode: previous, previous, changed: false };
  }

  saveConfig({ ...config, providers: { ...config.providers, [name]: { ...provider, keyRotation: wanted } } });

  if (wanted === 'auto') {
    Logger.success(`${name} will now switch to its next account by itself when one runs out.`);
    Logger.dim('  Only on a refusal that quotes a balance — a rate limit or a WAF page still changes nothing.');
  } else {
    Logger.success(`${name} will alert you and keep sending the same key until you switch.`);
  }
  return { provider: name, mode: wanted, previous, changed: true };
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
      + (spent ? `, ${spent} spent` : '') + (dead ? `, ${dead} revoked` : '')
      + (config.providers[name].keyRotation === 'auto' ? ', switches automatically' : ''));

    for (const row of mine) {
      const mark = row.inUse ? '→' : ' ';
      const balance = row.remaining === null ? '' : ` $${row.remaining}`;
      Logger.plain(`  ${mark} ${String(row.position).padStart(3)}. ${row.masked}  ${row.status.padEnd(10)}`
        + `${(row.label || '').padEnd(28)}${balance}`);
    }
    const provider = config.providers[name];
    if (!provider.selectedKeyId) Logger.dim('    (no explicit selection — the first usable key is sent)');
  }
}

/** What each verdict means in one word, for the live line. */
const VERDICT_TEXT = {
  live: 'accepted',
  funded: 'funded',
  spent: 'out of credit',
  invalid: 'revoked',
  'rate-limited': 'rate-limited',
  blocked: 'blocked',
  inconclusive: 'no answer',
  error: 'unreachable'
};

/**
 * Probes every key (or one provider's) and prints the sorted result.
 *
 * Without `--balance` this is one `GET /v1/models` per key: it separates the
 * accepted keys from the revoked ones and costs nothing at all. With
 * `--balance` each key is also asked for a request it cannot possibly afford,
 * which the relay refuses while quoting the exact figure — the only way to tell
 * a spent key from a working one, and the reason a topped-up account comes back
 * into service by itself.
 *
 * @param {string} [providerName] - omit for every provider
 * @param {{balance?:boolean, concurrency?:number, low?:number, timeoutMs?:number}} [options]
 * @returns {Promise<Object>} the report from checkKeys()
 */
export async function checkKeysCommand(providerName, options = {}) {
  const low = typeof options.low === 'number' && Number.isFinite(options.low) ? options.low : DEFAULT_LOW;
  const total = countKeys(providerName);
  if (total) {
    Logger.info(`Checking ${total} key(s)${providerName ? ` on ${providerName}` : ''}`
      + (options.balance ? `, balance included (spent below $${low})` : ', liveness only'));
    if (!options.balance) Logger.dim('  Add --balance to read each account\'s remaining credit.');
  }

  const report = await checkKeys({
    provider: providerName,
    balance: options.balance,
    concurrency: options.concurrency,
    low,
    timeoutMs: options.timeoutMs,
    onResult: row => Logger.dim(`  ${row.provider} ${row.masked} ${(row.label || '').padEnd(26)}`
      + `${VERDICT_TEXT[row.verdict] || row.verdict}${typeof row.remaining === 'number' ? ` $${row.remaining}` : ''}`)
  });

  reportCheck(report);
  return report;
}

/** How many keys a run will probe, so the user knows what they started. */
function countKeys(providerName) {
  const config = loadConfig();
  const names = providerName ? [requireProvider(config, providerName).name] : Object.keys(config.providers);
  return names.reduce((sum, name) => sum + (config.providers[name].keys || []).length, 0);
}

/** Prints the outcome grouped by what the user has to do about it. */
function reportCheck(report) {
  if (!report.results.length) {
    Logger.info('No keys to check.');
    Logger.dim('  Import them: ai-proxy keys import <file.xlsx>');
    for (const note of report.notes) Logger.dim(`  ${note}`);
    return;
  }

  // Grouped by what came back, not by the status on file: a key that was
  // already active and answered nothing this time belongs under "No verdict",
  // or the run would report it as checked when it was not.
  const groups = [
    ['Usable', ['funded', 'live']],
    ['Out of credit', ['spent']],
    ['Revoked', ['invalid']],
    ['No verdict', ['rate-limited', 'blocked', 'inconclusive', 'error']]
  ];

  for (const [title, verdicts] of groups) {
    const mine = report.results.filter(row => verdicts.includes(row.verdict));
    if (!mine.length) continue;
    Logger.header(`${title} — ${mine.length}`);
    for (const row of mine.sort((a, b) => (b.remaining ?? -1) - (a.remaining ?? -1))) {
      const balance = typeof row.remaining === 'number' ? `$${row.remaining.toFixed(2)}`.padStart(10) : ''.padStart(10);
      Logger.plain(`  ${row.provider.padEnd(12)}${row.masked}  ${(row.label || '').padEnd(26)}${balance}`
        + `  ${VERDICT_TEXT[row.verdict] || row.verdict}${row.changed ? ` → ${row.status}` : ''}`);
      if (row.message && ['invalid', 'error', 'blocked', 'inconclusive'].includes(row.verdict)) {
        Logger.dim(`                ${row.message.slice(0, 100)}`);
      }
    }
  }

  Logger.plain('');
  const totals = report.counts;
  Logger.info(`${report.results.length} checked — ${totals.live} usable, ${totals.spent} out of credit, `
    + `${totals.revoked} revoked, ${totals.inconclusive} without a verdict.`);
  if (report.changed) Logger.success(`${report.changed} key(s) updated${report.revived ? `, ${report.revived} put back in service` : ''}.`);
  else Logger.dim('  Nothing changed, so nothing was written.');
  if (!report.balance && totals.live) Logger.dim('  "Usable" here only means the key is accepted — run with --balance to see the credit.');
  for (const note of report.notes) Logger.warn(note);
}

// --- export: the second copy -------------------------------------------------

/**
 * Columns of the exported CSV, in the order the importer reads a row.
 *
 * The order is not cosmetic. `extractKeyRecords` identifies a row-per-provider
 * row by content: the provider is the first cell that is not a key, a URL, a
 * number or an e-mail, and the balance is the first numeric cell. So the
 * provider must come before `Status`, and no other number may come before
 * `Remaining Credit` — which is why `requestsServed` is not a column here.
 * The names match the account inventory's own headers so rows can be pasted
 * between the two files.
 */
const EXPORT_HEADER = ['Provider', 'Account', 'API Key:', 'Status', 'Remaining Credit', 'URL For API KEY', 'Referral Link'];

/** One CSV field: quoted only when it has to be. */
function csvField(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]|^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Nearest enclosing git working tree, or null.
 *
 * A `.git` entry may be a directory or, in a worktree or submodule, a file.
 * Either one means `git add .` can reach this path.
 * @param {string} dir
 * @returns {string|null}
 */
function gitRootAbove(dir) {
  let at = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(at, '.git'))) return at;
    const up = path.dirname(at);
    if (up === at) return null;
    at = up;
  }
}

/** True when `target` sits inside the tool's own data directory. */
function insideConfigDir(target) {
  const relative = path.relative(CONFIG_DIR, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Writes the whole key inventory to a CSV file.
 *
 * This is the second copy the plan calls for: `config.json` is the source of
 * truth, `keys.jsonl` is the append-only history, and this is the one artefact
 * that leaves the data directory. It is written on request rather than after
 * every mutation, because an automatic write would drop a full plaintext key
 * inventory into a second place every time a key was marked.
 *
 * @param {string} [filePath] - defaults to keys-<date>.csv beside the config
 * @param {{withKeys?: boolean, force?: boolean}} [options]
 * @returns {{file: string, keys: number, providers: number, withKeys: boolean}}
 */
export function exportKeys(filePath, options = {}) {
  const config = loadConfig();
  const withKeys = Boolean(options.withKeys);

  const target = filePath
    ? path.resolve(filePath)
    : path.join(CONFIG_DIR, `keys-${new Date().toISOString().slice(0, 10)}.csv`);

  // A masked file is not a secret, and the data directory already holds these
  // keys in plain text — refusing there would only send the user somewhere worse.
  if (withKeys && !options.force && !insideConfigDir(target)) {
    const repo = gitRootAbove(path.dirname(target));
    if (repo) {
      throw new UsageError(
        `${target} is inside the git repository at ${repo} — a file with real keys does not belong there.`,
        'Write it outside the repository, drop --with-keys for a masked copy, or add --force if you are certain.'
      );
    }
  }

  const lines = [EXPORT_HEADER.map(csvField).join(',')];
  let count = 0;
  for (const [name, provider] of Object.entries(config.providers)) {
    for (const entry of provider.keys || []) {
      lines.push([
        name,
        entry.label,
        withKeys ? entry.key : maskKey(entry.key),
        entry.status,
        entry.remaining === null || entry.remaining === undefined ? '' : entry.remaining,
        entry.dashboardUrl,
        entry.referralUrl
      ].map(csvField).join(','));
      count++;
    }
  }

  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
  // writeFileSync only applies its mode when it creates the file, so a file
  // that already existed keeps whatever permissions it had.
  fs.chmodSync(target, 0o600);

  const result = { file: target, keys: count, providers: Object.keys(config.providers).length, withKeys };
  reportExport(result);
  return result;
}

/** Says what was written and how dangerous it is. */
function reportExport(result) {
  if (!result.keys) {
    Logger.info(`No keys to export — wrote the header alone to ${result.file}`);
    Logger.dim('  Import some first: ai-proxy keys import <file.xlsx>');
    return;
  }
  Logger.success(`Exported ${result.keys} key(s) from ${result.providers} provider(s) to ${result.file}`);
  if (result.withKeys) Logger.warn('This file contains API keys in plain text. Keep it out of git and off shared drives.');
  else Logger.dim('  Keys were masked. Use --with-keys for a copy you could restore from.');
}
