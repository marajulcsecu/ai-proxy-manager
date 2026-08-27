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
  listProviders, 
  setActive 
} from './controllers/providerController.js';

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
  ai-proxy use <name>                           - Set a provider as the active default
  
Examples:
  ai-proxy add-provider gorouter https://gorouter.app/v1
  ai-proxy set-key gorouter sk-12345...
  ai-proxy use gorouter
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

  case 'use':
    setActive(args[1]);
    break;

  case 'start':
    // Phase 3 placeholder!
    Logger.warn('Proxy Daemon (Phase 3) is not yet implemented!');
    console.log('For now, you can manage your database. Check out docs/ROADMAP.md.');
    break;

  default:
    Logger.error(`Unknown command: '${command}'`);
    showHelp();
    break;
}
