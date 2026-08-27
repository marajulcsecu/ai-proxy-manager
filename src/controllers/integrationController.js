/**
 * @fileoverview Handles integration logic with third-party tools 
 * (like VS Code chatLanguageModels.json generation).
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadConfig } from '../core/configManager.js';
import { Logger } from '../utils/logger.js';

/**
 * Reads the VS Code config and injects the current AI proxy providers.
 * Path: ~/.config/Code/User/chatLanguageModels.json
 */
export function syncVsCode() {
  const vsCodeConfigPath = path.join(os.homedir(), '.config', 'Code', 'User', 'chatLanguageModels.json');
  
  if (!fs.existsSync(vsCodeConfigPath)) {
    Logger.warn('VS Code chatLanguageModels.json not found. Creating a blank one...');
    fs.mkdirSync(path.dirname(vsCodeConfigPath), { recursive: true });
    fs.writeFileSync(vsCodeConfigPath, '[]', 'utf8');
  }

  try {
    const rawData = fs.readFileSync(vsCodeConfigPath, 'utf8');
    let vsCodeModels = JSON.parse(rawData);

    // Filter out our previously injected providers so we don't duplicate
    vsCodeModels = vsCodeModels.filter(m => m.vendor !== 'customendpoint' || !m.name.startsWith('ai-proxy:'));

    const config = loadConfig();
    let injectedCount = 0;

    for (const [providerName, data] of Object.entries(config.providers)) {
      if (!data.apiKey) continue;

      const providerBlock = {
        name: `ai-proxy:${providerName}`,
        vendor: 'customendpoint',
        apiKey: `${providerName}:${data.apiKey}`, // This is the magic! "provider:apiKey" format routes it
        apiType: 'chat-completions',
        models: [
          {
            id: data.defaultModel,
            name: data.defaultModel,
            url: `http://127.0.0.1:${config.proxy_port || 8319}`,
            toolCalling: true,
            vision: true
          }
        ]
      };

      vsCodeModels.push(providerBlock);
      injectedCount++;
    }

    fs.writeFileSync(vsCodeConfigPath, JSON.stringify(vsCodeModels, null, '\t'), 'utf8');
    Logger.success(`Successfully injected ${injectedCount} provider(s) into VS Code!`);
  } catch (error) {
    Logger.error('Failed to sync with VS Code.');
    Logger.error(error.message);
  }
}

/**
 * Injects the AI Proxy environment variables into the user's ~/.bashrc file.
 */
export function setupTerminal() {
  const bashrcPath = path.join(os.homedir(), '.bashrc');
  const config = loadConfig();
  const PORT = config.proxy_port || 8319;

  const snippet = `\n# --- AI Proxy Manager ---
export ANTHROPIC_BASE_URL="http://127.0.0.1:${PORT}"
export ANTHROPIC_AUTH_TOKEN="dummy-key-managed-by-proxy"
# ------------------------\n`;

  try {
    let bashrc = fs.existsSync(bashrcPath) ? fs.readFileSync(bashrcPath, 'utf8') : '';
    
    if (bashrc.includes('--- AI Proxy Manager ---')) {
      Logger.warn('Terminal is already set up (found AI Proxy Manager block in ~/.bashrc).');
      return;
    }

    fs.appendFileSync(bashrcPath, snippet, 'utf8');
    Logger.success('Successfully configured your terminal!');
    Logger.info('Please run `source ~/.bashrc` or restart your terminal to apply changes.');
  } catch (error) {
    Logger.error('Failed to update ~/.bashrc');
    Logger.error(error.message);
  }
}

