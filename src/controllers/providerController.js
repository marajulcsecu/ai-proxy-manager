/**
 * @fileoverview Provider and model CRUD shared by the CLI and (indirectly) the
 * dashboard. Everything here reads and writes the same config.json, so the two
 * interfaces can never drift.
 */

import fs from 'fs';
import path from 'path';
import { loadConfig, saveConfig, normalizeProviderName } from '../core/configManager.js';
import { parseProviderUrl } from '../core/upstream.js';
import { testProvider } from '../core/providerTester.js';
import { Logger } from '../utils/logger.js';
import { UsageError } from '../utils/errors.js';

/**
 * Looks a provider up, with a helpful error when it is missing.
 * @param {Object} config
 * @param {string} rawName
 * @returns {{name:string, provider:Object}}
 */
function requireProvider(config, rawName) {
  const name = normalizeProviderName(rawName);
  const provider = config.providers[name];
  if (!provider) {
    const known = Object.keys(config.providers);
    throw new UsageError(
      `Provider '${rawName}' not found.`,
      known.length ? `Known providers: ${known.join(', ')}` : 'Add one first: ai-proxy add-provider <name> <url>'
    );
  }
  return { name, provider };
}

/** Shows enough of a key to recognise it, never enough to use it. */
function maskKey(key) {
  if (!key) return '';
  return key.length <= 12 ? '••••••' : `${key.slice(0, 5)}…${key.slice(-4)}`;
}

/**
 * Registers a provider, or updates the URL of an existing one.
 * Existing keys, models and the pinned model are preserved.
 * @param {string} rawName
 * @param {string} url
 */
export function addProvider(rawName, url) {
  if (!rawName || !url) throw new UsageError('Usage: ai-proxy add-provider <name> <url>');

  const name = normalizeProviderName(rawName);
  if (!name) throw new UsageError('Provider names may contain letters, digits, dots, underscores and dashes.');

  let parsed;
  try {
    parsed = parseProviderUrl(url);
  } catch (error) {
    throw new UsageError(error.message, 'Example: ai-proxy add-provider gorouter https://gorouter.app/v1');
  }

  const config = loadConfig();
  const existing = config.providers[name];

  config.providers[name] = {
    url: url.trim(),
    // Never clobber a working key/model set just because the URL changed.
    apiKey: existing?.apiKey || '',
    defaultModel: existing?.defaultModel || '',
    models: existing?.models || []
  };
  if (!config.active_provider) config.active_provider = name;

  saveConfig(config);

  if (existing) Logger.success(`Provider '${name}' URL updated to ${url} (key and models kept).`);
  else Logger.success(`Provider '${name}' added → ${parsed.origin}${parsed.basePath}`);

  if (!config.providers[name].apiKey) Logger.info(`Next: ai-proxy set-key ${name} <api-key>`);
  if (!config.providers[name].defaultModel) {
    Logger.dim('  No model pinned — the client\'s requested model is passed through unchanged.');
  }
}

/**
 * Stores the API key for a provider.
 * @param {string} rawName
 * @param {string} apiKey
 */
export function setKey(rawName, apiKey) {
  if (!rawName || !apiKey) throw new UsageError('Usage: ai-proxy set-key <name> <api-key>');

  const config = loadConfig();
  const { name } = requireProvider(config, rawName);
  config.providers[name].apiKey = apiKey.trim();
  saveConfig(config);
  Logger.success(`API key stored for '${name}' (${maskKey(apiKey.trim())}).`);
  Logger.dim(`  Verify it with: ai-proxy test ${name}`);
}

/**
 * Pins the model a provider should use. An empty value restores pass-through.
 * @param {string} rawName
 * @param {string} model
 */
export function setModel(rawName, model) {
  if (!rawName) throw new UsageError('Usage: ai-proxy set-model <name> <model|"">');

  const config = loadConfig();
  const { name, provider } = requireProvider(config, rawName);
  const value = (model || '').trim();

  provider.models = provider.models || [];
  if (value && !provider.models.includes(value)) provider.models.push(value);
  provider.defaultModel = value;

  saveConfig(config);
  if (value) Logger.success(`'${name}' now rewrites every request to '${value}'.`);
  else Logger.success(`'${name}' now passes the client's model through unchanged.`);
}

/**
 * Adds a model to a provider's list.
 * @param {string} rawName
 * @param {string} model
 */
export function addModel(rawName, model) {
  if (!rawName || !model) throw new UsageError('Usage: ai-proxy add-model <name> <model>');

  const config = loadConfig();
  const { name, provider } = requireProvider(config, rawName);
  const value = model.trim();

  provider.models = provider.models || [];
  if (provider.models.includes(value)) {
    Logger.warn(`'${value}' is already listed for '${name}'.`);
    return;
  }

  provider.models.push(value);
  if (!provider.defaultModel) provider.defaultModel = value;

  saveConfig(config);
  Logger.success(`Added '${value}' to '${name}' (${provider.models.length} model(s) total).`);
}

/**
 * Removes a model from a provider's list.
 * @param {string} rawName
 * @param {string} model
 */
export function removeModel(rawName, model) {
  if (!rawName || !model) throw new UsageError('Usage: ai-proxy remove-model <name> <model>');

  const config = loadConfig();
  const { name, provider } = requireProvider(config, rawName);
  const value = model.trim();

  if (!provider.models?.includes(value)) {
    throw new UsageError(
      `'${value}' is not listed for '${name}'.`,
      provider.models?.length ? `Available: ${provider.models.join(', ')}` : 'This provider has no models yet.'
    );
  }

  provider.models = provider.models.filter(m => m !== value);
  if (provider.defaultModel === value) {
    provider.defaultModel = provider.models[0] || '';
    Logger.info(provider.defaultModel
      ? `Pinned model switched to '${provider.defaultModel}'.`
      : 'No models left — reverted to pass-through mode.');
  }

  saveConfig(config);
  Logger.success(`Removed '${value}' from '${name}'.`);
}

/**
 * Deletes a provider entirely.
 * @param {string} rawName
 */
export function removeProvider(rawName) {
  if (!rawName) throw new UsageError('Usage: ai-proxy remove-provider <name>');

  const config = loadConfig();
  const { name } = requireProvider(config, rawName);
  delete config.providers[name];

  if (config.active_provider === name) {
    config.active_provider = Object.keys(config.providers)[0] ?? null;
    if (config.active_provider) Logger.info(`Active provider switched to '${config.active_provider}'.`);
  }

  saveConfig(config);
  Logger.success(`Provider '${name}' deleted.`);
}

/** Prints every provider with its key/model state. */
export function listProviders() {
  const config = loadConfig();
  const names = Object.keys(config.providers);

  if (!names.length) {
    Logger.info('No providers configured yet.');
    Logger.dim('  ai-proxy add-provider <name> <url>');
    return;
  }

  Logger.header(`Providers (${names.length})`);

  for (const name of names) {
    const data = config.providers[name];
    const active = name === config.active_provider;
    const models = data.models || [];

    let urlNote = '';
    try {
      parseProviderUrl(data.url);
    } catch (error) {
      urlNote = `  ⚠ ${error.message}`;
    }

    console.log(`${active ? '▶' : ' '} ${Logger.value(name)}${active ? '  (active)' : ''}`);
    console.log(`    url    ${data.url}${urlNote}`);
    console.log(`    model  ${data.defaultModel || 'pass-through (client decides)'}`);
    if (models.length) {
      console.log(`    models ${models.map(m => (m === data.defaultModel ? `${m} ←` : m)).join(', ')}`);
    }
    console.log(`    key    ${data.apiKey ? maskKey(data.apiKey) : 'not set'}`);
  }

  Logger.divider();
  Logger.dim(`Active: ${config.active_provider || 'none'}   Port: ${config.proxy_port}`);
}

/**
 * Sets the globally active provider.
 * @param {string} rawName
 */
export function setActive(rawName) {
  if (!rawName) throw new UsageError('Usage: ai-proxy use <name>');

  const config = loadConfig();
  const { name, provider } = requireProvider(config, rawName);
  config.active_provider = name;
  saveConfig(config);

  Logger.success(`Active provider is now '${name}'.`);
  Logger.dim(`  ${provider.defaultModel ? `model: ${provider.defaultModel}` : 'model: pass-through'} · takes effect on the next request`);
  if (!provider.apiKey) Logger.warn(`'${name}' has no API key yet: ai-proxy set-key ${name} <key>`);
}

/**
 * Changes the port the daemon binds to.
 * @param {string|number} rawPort
 */
export function setPort(rawPort) {
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UsageError('Usage: ai-proxy set-port <1-65535>');
  }

  const config = loadConfig();
  config.proxy_port = port;
  saveConfig(config);

  Logger.success(`Proxy port set to ${port}.`);
  Logger.info('Restart the daemon and re-run `ai-proxy setup-terminal` so clients use the new port.');
}

/**
 * Sends one real request to a provider and prints the verdict.
 * @param {string} [rawName] - defaults to the active provider
 * @param {string} [model]
 */
export async function testProviderCommand(rawName, model) {
  const config = loadConfig();
  const target = rawName || config.active_provider;
  if (!target) throw new UsageError('No provider to test.', 'Add one: ai-proxy add-provider <name> <url>');

  const { name, provider } = requireProvider(config, target);
  Logger.info(`Testing '${name}'${model ? ` with model '${model}'` : ''}…`);

  const result = await testProvider(provider, { model, spoof: config.settings.spoofHeaders !== false });
  const line = `${result.summary}${result.latencyMs !== null ? ` (${result.latencyMs}ms)` : ''}`;

  if (result.ok) Logger.success(line);
  else if (result.level === 'warn') Logger.warn(line);
  else Logger.error(line);

  if (result.endpoint) Logger.dim(`  endpoint  ${result.endpoint}`);
  if (result.model) Logger.dim(`  model     ${result.model}`);
  if (result.statusCode) Logger.dim(`  status    ${result.statusCode}`);
  if (result.detail) Logger.dim(`  detail    ${result.detail}`);

  return result;
}

/**
 * Writes the configuration to a file.
 * @param {string} filePath
 * @param {{includeKeys?:boolean}} [options]
 */
export function exportConfig(filePath, options = {}) {
  if (!filePath) throw new UsageError('Usage: ai-proxy export <file.json> [--with-keys]');

  const config = JSON.parse(JSON.stringify(loadConfig()));
  if (!options.includeKeys) {
    for (const provider of Object.values(config.providers)) provider.apiKey = '';
  }

  const target = path.resolve(filePath);
  fs.writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });

  Logger.success(`Exported ${Object.keys(config.providers).length} provider(s) to ${target}`);
  if (options.includeKeys) Logger.warn('This file contains API keys in plain text. Do not commit it.');
  else Logger.dim('  API keys were redacted. Use --with-keys to include them.');
}

/**
 * Merges (or replaces) configuration from a file.
 * @param {string} filePath
 * @param {{replace?:boolean}} [options]
 */
export function importConfig(filePath, options = {}) {
  if (!filePath) throw new UsageError('Usage: ai-proxy import <file.json> [--replace]');

  const target = path.resolve(filePath);
  let incoming;
  try {
    incoming = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (error) {
    throw new UsageError(`Cannot read ${target}: ${error.message}`);
  }
  if (!incoming?.providers || typeof incoming.providers !== 'object') {
    throw new UsageError('That file has no "providers" object — is it an ai-proxy export?');
  }

  const current = loadConfig();
  const next = options.replace
    ? { ...current, providers: {} }
    : { ...current, providers: { ...current.providers } };

  let imported = 0;
  let keptKeys = 0;
  for (const [rawName, data] of Object.entries(incoming.providers)) {
    const name = normalizeProviderName(rawName);
    if (!name || !data || typeof data !== 'object') continue;
    const existing = current.providers[name];
    if (!data.apiKey && existing?.apiKey) keptKeys++;
    next.providers[name] = {
      url: String(data.url ?? existing?.url ?? ''),
      apiKey: data.apiKey ? String(data.apiKey) : (existing?.apiKey ?? ''),
      defaultModel: String(data.defaultModel ?? existing?.defaultModel ?? ''),
      models: Array.isArray(data.models) ? data.models.map(String) : (existing?.models ?? [])
    };
    imported++;
  }
  if (incoming.active_provider) next.active_provider = normalizeProviderName(incoming.active_provider);

  saveConfig(next);
  Logger.success(`Imported ${imported} provider(s) from ${target} (${options.replace ? 'replace' : 'merge'}).`);
  if (keptKeys) Logger.dim(`  Kept ${keptKeys} existing API key(s) where the file had none.`);
}
