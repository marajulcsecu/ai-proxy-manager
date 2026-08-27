/**
 * @fileoverview Manages the reading, writing, and initialization 
 * of the configuration JSON file.
 * 
 * Location: ~/.config/ai-proxy-manager/config.json
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { Logger } from '../utils/logger.js';

// Base directory for our configuration
const CONFIG_DIR = path.join(os.homedir(), '.config', 'ai-proxy-manager');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// Default initial state
const DEFAULT_CONFIG = {
  providers: {},
  active_provider: null,
  proxy_port: 8319
};

/**
 * Loads the configuration from disk. Creates it if it doesn't exist.
 * @returns {Object} The configuration object.
 */
export function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    saveConfig(DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }

  try {
    const data = fs.readFileSync(CONFIG_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    Logger.error(`Failed to read config file at ${CONFIG_FILE}`);
    Logger.error(error.message);
    process.exit(1);
  }
}

/**
 * Saves the configuration object to disk.
 * @param {Object} config - The configuration object to save.
 */
export function saveConfig(config) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  } catch (error) {
    Logger.error(`Failed to save config file to ${CONFIG_FILE}`);
    Logger.error(error.message);
    process.exit(1);
  }
}
