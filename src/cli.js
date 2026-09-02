#!/usr/bin/env node
/**
 * @fileoverview CLI entry point. Parses arguments and delegates to controllers.
 */

import { Logger } from './utils/logger.js';
import { UsageError } from './utils/errors.js';
import { readPackageVersion } from './utils/version.js';
import {
  addProvider, removeProvider, setKey, setModel, addModel, removeModel,
  listProviders, setActive, setPort, testProviderCommand, exportConfig, importConfig
} from './controllers/providerController.js';
import {
  syncVsCode, applyShellSetup, removeShellSetup, getIntegrationStatus
} from './controllers/integrationController.js';
import { importKeys } from './controllers/keysController.js';
import { startProxyServer } from './core/proxyServer.js';
import { loadConfig, CONFIG_FILE } from './core/configManager.js';
import {
  startDetached, stopDaemon, getDaemonStatus, readDaemonLog, followDaemonLog, DAEMON_LOG
} from './core/daemon.js';

/**
 * Splits argv into positional arguments and flags.
 * @param {string[]} argv
 * @returns {{positional:string[], flags:Record<string,string|boolean>}}
 */
function parseArgs(argv) {
  const positional = [];
  const flags = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('-')) {
      positional.push(arg);
      continue;
    }
    const name = arg.replace(/^-+/, '');
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('-') && /^(port|n|lines|model)$/.test(name)) {
      flags[name] = next;
      i++;
    } else {
      flags[name] = true;
    }
  }
  return { positional, flags };
}

function showHelp() {
  const version = readPackageVersion();
  console.log(`
${Logger.value('ai-proxy')} ${version} — local smart router for AI API providers

${Logger.value('Providers')}
  list                                 Show every provider, model and key state
  add-provider <name> <url>            Register a provider (or update its URL)
  remove-provider <name>               Delete a provider
  set-key <name> <api-key>             Store the provider's API key
  use <name>                           Make a provider the active default
  test [name] [--model <id>]           Send one real request and report the result

${Logger.value('Keys')}
  keys import <file…> [--dry-run]      Import accounts from .xlsx/.csv spreadsheets

${Logger.value('Models')}
  set-model <name> <model|"">          Pin a model ("" restores pass-through)
  add-model <name> <model>             Add a model to the provider's list
  remove-model <name> <model>          Remove a model from the list

${Logger.value('Daemon')}
  start [--daemon] [--port <n>]        Start the proxy + dashboard
  stop                                 Stop the running daemon
  restart [--daemon]                   Stop then start again
  status                               Show daemon, provider and traffic state
  logs [-n <lines>] [-f]               Show (or follow) the daemon log
  set-port <n>                         Change the port the daemon binds to

${Logger.value('Integrations')}
  setup-terminal                       Manage the env block in bash/zsh/fish rc
  remove-terminal                      Remove that block again
  sync-vscode                          Inject providers into VS Code's model list

${Logger.value('Config')}
  export <file> [--with-keys]          Write config to a file (keys redacted)
  import <file> [--replace]            Merge or replace config from a file
  help · version                       This text · version number

${Logger.value('Examples')}
  ai-proxy add-provider gorouter https://gorouter.app/v1
  ai-proxy set-key gorouter sk-…
  ai-proxy add-model gorouter claude-opus-5
  ai-proxy use gorouter && ai-proxy start --daemon
  ai-proxy test gorouter
  ai-proxy keys import ~/accounts.xlsx --dry-run

Config file: ${CONFIG_FILE}
`);
}

/** Prints a compact overview of daemon, providers and live traffic. */
async function showStatus() {
  const config = loadConfig();
  const daemon = getDaemonStatus();
  const port = daemon.port || config.proxy_port;

  Logger.header('AI Proxy Status');

  if (daemon.running) {
    const since = daemon.startedAt ? new Date(daemon.startedAt).toLocaleString() : 'unknown';
    Logger.success(`Daemon running — pid ${daemon.pid}, port ${port}, since ${since}`);
    Logger.plain(`  Dashboard   http://127.0.0.1:${port}`);
  } else {
    Logger.warn(daemon.stale
      ? `Daemon not running (stale pid file for ${daemon.pid} cleaned up on next start).`
      : 'Daemon not running.');
    Logger.plain('  Start it    ai-proxy start --daemon');
  }

  const names = Object.keys(config.providers);
  const withKeys = names.filter(name => config.providers[name].apiKey).length;
  const active = config.active_provider;
  Logger.plain(`  Active      ${active ? `${active} → ${config.providers[active]?.defaultModel || 'pass-through'}` : 'none'}`);
  Logger.plain(`  Providers   ${names.length} (${withKeys} with an API key)`);

  if (daemon.running) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(2500) });
      const data = await response.json();
      const p50 = data.p50Ms === null ? 'n/a' : `${data.p50Ms}ms`;
      Logger.plain(`  Traffic     ${data.totalRequests} request(s), p50 ${p50}, ${data.errorCount} error(s)`);
    } catch {
      Logger.plain('  Traffic     (could not reach the API on that port)');
    }
  }

  const integrations = getIntegrationStatus();
  const shellFiles = integrations.shell.files.filter(file => file.applied);
  Logger.plain(`  Shell env   ${shellFiles.length
    ? `${shellFiles.map(file => `${file.label}${file.upToDate ? '' : ` (port ${file.port} ≠ ${port})`}`).join(', ')}`
    : 'not configured — run: ai-proxy setup-terminal'}`);
  Logger.plain(`  VS Code     ${integrations.vscode.applied ? `${integrations.vscode.entries} entry(ies) injected` : 'not synced'}`);
}

/** `ai-proxy start` — foreground unless --daemon/-d. */
async function runStart(flags) {
  const port = flags.port ? Number(flags.port) : undefined;

  if (flags.daemon || flags.d) {
    const existing = getDaemonStatus();
    if (existing.running) {
      throw new UsageError(
        `A daemon is already running (pid ${existing.pid}, port ${existing.port}).`,
        'Use `ai-proxy restart --daemon` to reload it.'
      );
    }
    const { pid, logFile } = startDetached({ port });
    // Give it a moment so a bind failure surfaces here rather than silently.
    await new Promise(resolve => setTimeout(resolve, 600));
    const status = getDaemonStatus();
    if (!status.running) {
      Logger.error('The daemon exited immediately. Last lines of its log:');
      console.log(readDaemonLog(15).text);
      process.exitCode = 1;
      return;
    }
    Logger.success(`Daemon started in the background (pid ${pid}).`);
    Logger.plain(`  Dashboard   http://127.0.0.1:${status.port || port || loadConfig().proxy_port}`);
    Logger.plain(`  Log file    ${logFile}`);
    Logger.plain('  Stop it     ai-proxy stop');
    return;
  }

  await startProxyServer({ port });
}

async function runLogs(flags) {
  const lines = Number(flags.n || flags.lines || 40);
  const { text, size, exists } = readDaemonLog(Number.isFinite(lines) ? lines : 40);

  if (!exists) {
    Logger.info('No daemon log yet — it is written when you run `ai-proxy start --daemon`.');
    Logger.dim(`  Expected at ${DAEMON_LOG}`);
    return;
  }

  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);

  if (flags.f || flags.follow) {
    Logger.dim(`── following ${DAEMON_LOG} (Ctrl+C to stop) ──`);
    const stop = followDaemonLog(size);
    process.on('SIGINT', () => {
      stop();
      process.exit(0);
    });
    await new Promise(() => {});
  }
}

/**
 * `keys` sub-commands. Only `import` exists so far; rotation lands with the
 * detection work, and each one is listed here so an unknown verb says what is
 * actually available rather than printing the whole CLI help.
 */
function runKeys(args, flags) {
  const [action, ...rest] = args;
  switch (action) {
    case 'import':
      importKeys(rest, { dryRun: Boolean(flags['dry-run'] || flags.dry) });
      break;
    default:
      throw new UsageError(
        action ? `Unknown keys command: '${action}'` : 'Usage: ai-proxy keys import <file.xlsx|file.csv> [--dry-run]',
        'Available: import'
      );
  }
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0];

  if (!command || command === 'help' || flags.help || flags.h) {
    showHelp();
    return;
  }
  if (command === 'version' || flags.version || flags.v) {
    console.log(readPackageVersion());
    return;
  }

  switch (command) {
    case 'list':
    case 'ls':
      listProviders();
      break;

    case 'add-provider':
      addProvider(positional[1], positional[2]);
      break;

    case 'remove-provider':
    case 'delete-provider':
      removeProvider(positional[1]);
      break;

    case 'set-key':
      setKey(positional[1], positional[2]);
      break;

    case 'set-model':
      setModel(positional[1], positional[2] ?? '');
      break;

    case 'add-model':
      addModel(positional[1], positional[2]);
      break;

    case 'remove-model':
      removeModel(positional[1], positional[2]);
      break;

    case 'use':
      setActive(positional[1]);
      break;

    case 'keys':
      runKeys(positional.slice(1), flags);
      break;

    case 'test':
      await testProviderCommand(positional[1], typeof flags.model === 'string' ? flags.model : positional[2]);
      break;

    case 'start':
      await runStart(flags);
      break;

    case 'stop': {
      const result = await stopDaemon();
      if (result.stopped) Logger.success(`Daemon stopped (pid ${result.pid}${result.forced ? ', forced' : ''}).`);
      else if (result.reason === 'no-pid-file') Logger.info('No daemon is running.');
      else if (result.reason === 'stale-pid-file') Logger.info(`No daemon is running (cleaned up a stale pid file for ${result.pid}).`);
      else Logger.error(`Could not stop pid ${result.pid}: ${result.reason}`);
      break;
    }

    case 'restart': {
      const result = await stopDaemon();
      if (result.stopped) Logger.info(`Stopped pid ${result.pid}.`);
      await runStart({ ...flags, daemon: true });
      break;
    }

    case 'status':
      await showStatus();
      break;

    case 'logs':
      await runLogs(flags);
      break;

    case 'set-port':
      setPort(positional[1]);
      break;

    case 'sync-vscode':
      syncVsCode();
      break;

    case 'setup-terminal':
      applyShellSetup();
      break;

    case 'remove-terminal':
      removeShellSetup();
      break;

    case 'export':
      exportConfig(positional[1], { includeKeys: Boolean(flags['with-keys']) });
      break;

    case 'import':
      importConfig(positional[1], { replace: Boolean(flags.replace) });
      break;

    default:
      Logger.error(`Unknown command: '${command}'`);
      Logger.dim('  Run `ai-proxy help` to see the available commands.');
      process.exitCode = 1;
  }
}

main().catch(error => {
  if (error instanceof UsageError) {
    Logger.error(error.message);
    if (error.hint) Logger.dim(`  ${error.hint}`);
  } else if (error?.name === 'ConfigError') {
    Logger.error(error.message);
    Logger.dim(`  Config file: ${CONFIG_FILE}`);
  } else if (error?.code === 'EADDRINUSE') {
    // startProxyServer already explained this one.
  } else {
    Logger.error(error?.stack || String(error));
  }
  process.exitCode = 1;
});
