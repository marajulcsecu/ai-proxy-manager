#!/usr/bin/env node
/**
 * @fileoverview Main entry point for the AI Proxy Manager CLI.
 * Parses command-line arguments and routes them to the correct controller.
 */

import { Logger } from './utils/logger.js';
import { 
  addProvider, 
  setKey,
  setModel,
  addModel,
  removeModel,
  listProviders, 
  setActive 
} from './controllers/providerController.js';

import { startProxyServer } from './core/proxyServer.js';
import { syncVsCode, setupTerminal } from './controllers/integrationController.js';

// Get command line arguments, skipping 'node' and the script name
const args = process.argv.slice(2);
const command = args[0];

// Print help text if no valid command is provided
function showHelp() {
  Logger.header('AI Proxy Manager CLI');
  console.log(`
Usage:
  ai-proxy list                                 - Show all registered providers
  ai-proxy add-provider <name> <url>            - Register a new AI provider
  ai-proxy set-key <name> <api-key>             - Set the API key for a provider
  ai-proxy set-model <name> <model-name>        - Set the default model for a provider
  ai-proxy add-model <name> <model-name>        - Add a model to a provider's list
  ai-proxy remove-model <name> <model-name>     - Remove a model from a provider's list
  ai-proxy use <name>                           - Set a provider as the active default
  ai-proxy start                                - Start the Smart Proxy Server + Dashboard
  ai-proxy sync-vscode                          - Inject your providers into VS Code GUI
  ai-proxy setup-terminal                       - Configure your ~/.bashrc for Claude Code
  
Examples:
  ai-proxy add-provider gorouter https://gorouter.app/v1
  ai-proxy set-key gorouter sk-12345...
  ai-proxy add-model gorouter claude-opus-5
  ai-proxy add-model gorouter claude-sonnet-5
  ai-proxy start
  `);
}

if (!command || command === 'help') {
  showHelp();
  process.exit(0);
}

// Router
switch (command) {
  case 'list':
    listProviders();
    break;

  case 'add-provider':
    addProvider(args[1], args[2]);
    break;

  case 'set-key':
    setKey(args[1], args[2]);
    break;

  case 'set-model':
    setModel(args[1], args[2]);
    break;

  case 'add-model':
    addModel(args[1], args[2]);
    break;

  case 'remove-model':
    removeModel(args[1], args[2]);
    break;

  case 'use':
    setActive(args[1]);
    break;

  case 'start':
    startProxyServer();
    break;

  case 'sync-vscode':
    syncVsCode();
    break;

  case 'setup-terminal':
    setupTerminal();
    break;

  default:
    Logger.error(`Unknown command: '${command}'`);
    showHelp();
    break;
}
