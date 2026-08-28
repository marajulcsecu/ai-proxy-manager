/**
 * @fileoverview Logic for handling provider-related CLI commands 
 * (adding, updating keys, listing, etc).
 */

import { loadConfig, saveConfig } from '../core/configManager.js';
import { Logger } from '../utils/logger.js';

/**
 * Adds a new provider to the database.
 * @param {string} name - Name of the provider (e.g., gorouter)
 * @param {string} url - Base URL of the provider
 */
export function addProvider(name, url) {
  if (!name || !url) {
    Logger.error('Usage: ai-proxy add-provider <name> <url>');
    process.exit(1);
  }

  const config = loadConfig();
  
  if (config.providers[name]) {
    Logger.warn(`Provider '${name}' already exists. Updating its URL.`);
  }

  config.providers[name] = {
    url: url,
    apiKey: config.providers[name]?.apiKey || '', // Preserve key if it exists
    defaultModel: 'claude-opus-5-thinking' // Default fallback model
  };

  // If this is the first provider, set it as active
  if (!config.active_provider) {
    config.active_provider = name;
  }

  saveConfig(config);
  Logger.success(`Provider '${name}' configured to use URL: ${url}`);
}

/**
 * Sets the API key for an existing provider.
 * @param {string} name - Name of the provider
 * @param {string} apiKey - The API key
 */
export function setKey(name, apiKey) {
  if (!name || !apiKey) {
    Logger.error('Usage: ai-proxy set-key <name> <api-key>');
    process.exit(1);
  }

  const config = loadConfig();

  if (!config.providers[name]) {
    Logger.error(`Provider '${name}' not found. Add it first using 'ai-proxy add-provider'`);
    process.exit(1);
  }

  config.providers[name].apiKey = apiKey;
  saveConfig(config);
  Logger.success(`API Key updated for provider '${name}'`);
}

/**
 * Sets the default model for a provider.
 * @param {string} name - Name of the provider
 * @param {string} model - The model name
 */
export function setModel(name, model) {
  if (!name || !model) {
    Logger.error('Usage: ai-proxy set-model <provider-name> <model-name>');
    process.exit(1);
  }

  const config = loadConfig();

  if (!config.providers[name]) {
    Logger.error(`Provider '${name}' not found.`);
    process.exit(1);
  }

  config.providers[name].defaultModel = model;
  saveConfig(config);
  Logger.success(`Default model for '${name}' updated to '${model}'`);
}

/**
 * Lists all registered providers.
 */
export function listProviders() {
  const config = loadConfig();
  const providers = config.providers;

  if (Object.keys(providers).length === 0) {
    Logger.info('No providers configured. Use "ai-proxy add-provider" to add one.');
    return;
  }

  Logger.header('Available Providers');
  
  for (const [name, data] of Object.entries(providers)) {
    const isActive = name === config.active_provider ? '👉 ACTIVE ' : '   ';
    const keyStatus = data.apiKey ? '🔑 Key Set' : '❌ No Key';
    
    console.log(`${isActive} | Name:  \x1b[1m${name.padEnd(12)}\x1b[0m`);
    console.log(`         | URL:   ${data.url}`);
    console.log(`         | Model: ${data.defaultModel}`);
    console.log(`         | Auth:  ${keyStatus}`);
    Logger.divider();
  }
}

/**
 * Sets a provider as the globally active default.
 * @param {string} name - Name of the provider
 */
export function setActive(name) {
  if (!name) {
    Logger.error('Usage: ai-proxy use <name>');
    process.exit(1);
  }

  const config = loadConfig();

  if (!config.providers[name]) {
    Logger.error(`Provider '${name}' not found.`);
    process.exit(1);
  }

  config.active_provider = name;
  saveConfig(config);
  Logger.success(`Active provider switched to '${name}'`);
}

/**
 * Adds a model to a provider's available models list.
 * @param {string} name - Name of the provider
 * @param {string} model - The model name to add
 */
export function addModel(name, model) {
  if (!name || !model) {
    Logger.error('Usage: ai-proxy add-model <provider-name> <model-name>');
    process.exit(1);
  }

  const config = loadConfig();

  if (!config.providers[name]) {
    Logger.error(`Provider '${name}' not found.`);
    process.exit(1);
  }

  // Initialize models array if missing
  if (!config.providers[name].models) {
    config.providers[name].models = [];
  }

  if (config.providers[name].models.includes(model)) {
    Logger.warn(`Model '${model}' already exists for provider '${name}'.`);
    return;
  }

  config.providers[name].models.push(model);

  // If no default model is set, make this the default
  if (!config.providers[name].defaultModel) {
    config.providers[name].defaultModel = model;
  }

  saveConfig(config);
  Logger.success(`Model '${model}' added to '${name}' (${config.providers[name].models.length} total)`);
}

/**
 * Removes a model from a provider's available models list.
 * @param {string} name - Name of the provider
 * @param {string} model - The model name to remove
 */
export function removeModel(name, model) {
  if (!name || !model) {
    Logger.error('Usage: ai-proxy remove-model <provider-name> <model-name>');
    process.exit(1);
  }

  const config = loadConfig();

  if (!config.providers[name]) {
    Logger.error(`Provider '${name}' not found.`);
    process.exit(1);
  }

  if (!config.providers[name].models || !config.providers[name].models.includes(model)) {
    Logger.error(`Model '${model}' not found in provider '${name}'.`);
    process.exit(1);
  }

  config.providers[name].models = config.providers[name].models.filter(m => m !== model);

  // If we removed the active model, switch to first available
  if (config.providers[name].defaultModel === model) {
    config.providers[name].defaultModel = config.providers[name].models[0] || '';
    if (config.providers[name].defaultModel) {
      Logger.info(`Default model switched to '${config.providers[name].defaultModel}'`);
    }
  }

  saveConfig(config);
  Logger.success(`Model '${model}' removed from '${name}'`);
}
