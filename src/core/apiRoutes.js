/**
 * @fileoverview REST API behind /api/*, consumed by the dashboard.
 *
 * Notes:
 *  - Routing is done on the pathname, so query strings no longer fall through
 *    to the proxy engine (GET /api/status?t=1 used to 404).
 *  - Responses never include an API key unless it is explicitly requested via
 *    /api/providers/:name/key, and no CORS wildcard is sent: the server only
 *    answers same-origin, localhost requests (enforced in proxyServer.js).
 */

import {
  loadConfig, saveConfig, tryLoadConfig, normalizeProviderName,
  PROVIDER_NAME_PATTERN, DEFAULT_SETTINGS, CONFIG_FILE
} from './configManager.js';
import { getLogs, getLogById, getStatus, clearLogs, configureLogger } from './requestLogger.js';
import { parseProviderUrl } from './upstream.js';
import { maskKey, selectKey } from './keyStore.js';
import { keyAlerts, dismissKeyAlert } from './keyMonitor.js';
import {
  nextKey, useKey, retireKey, reviveKey, setRotation, addKey, editKey, removeKey, revealKey
} from '../controllers/keysController.js';
import { testProvider } from './providerTester.js';
import { getDaemonStatus } from './daemon.js';
import { getRuntime } from './runtime.js';
import {
  getIntegrationStatus, applyShellSetup, removeShellSetup, syncVsCode
} from '../controllers/integrationController.js';
import { readPackageVersion } from '../utils/version.js';

const MAX_API_BODY_BYTES = 2 * 1024 * 1024;
const NAME = PROVIDER_NAME_PATTERN;

/**
 * Reads and JSON-parses a request body.
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<Object>}
 */
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > MAX_API_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * @param {import('http').ServerResponse} res
 * @param {number} statusCode
 * @param {Object} data
 */
function sendJSON(res, statusCode, data) {
  const payload = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(payload);
}

/**
 * Public shape of a provider (no secrets).
 * @param {string} name
 * @param {Object} data
 * @param {Object} config
 */
function providerView(name, data, config) {
  let host = null;
  let urlValid = true;
  try {
    host = parseProviderUrl(data.url).hostHeader;
  } catch {
    urlValid = false;
  }
  return {
    name,
    url: data.url,
    host,
    urlValid,
    defaultModel: data.defaultModel || '',
    models: data.models || [],
    hasKey: Boolean(data.apiKey),
    keyPreview: maskKey(data.apiKey),
    // Pool summary, so the provider card can show which account is being
    // billed and how many are spent without a request of its own.
    keyCount: (data.keys || []).length,
    keysSpent: (data.keys || []).filter(entry => entry.status === 'exhausted').length,
    keysUnusable: (data.keys || []).filter(entry => entry.status === 'invalid' || entry.status === 'disabled').length,
    keyLabel: selectKey(data.keys, data.selectedKeyId)?.label || '',
    keyRemaining: selectKey(data.keys, data.selectedKeyId)?.remaining ?? null,
    keyRotation: data.keyRotation,
    passThrough: !data.defaultModel,
    isActive: name === config.active_provider
  };
}

const routes = [];

/**
 * @param {string} method
 * @param {RegExp} pattern - matched against the pathname
 * @param {(ctx:Object) => Promise<void>|void} handler
 */
function route(method, pattern, handler) {
  routes.push({ method, pattern, handler });
}

// ---------------------------------------------------------------- meta/status

route('GET', /^\/api\/meta$/, ({ res }) => {
  const daemon = getDaemonStatus();
  const { config } = tryLoadConfig();
  sendJSON(res, 200, {
    ok: true,
    version: readPackageVersion(),
    node: process.version,
    pid: process.pid,
    configPath: CONFIG_FILE,
    port: getRuntime().port ?? config.proxy_port,
    configuredPort: config.proxy_port,
    daemon
  });
});

route('GET', /^\/api\/status$/, ({ res }) => {
  const { ok, config, error } = tryLoadConfig();
  const status = getStatus();
  sendJSON(res, 200, {
    ok,
    configError: ok ? null : error.message,
    activeProvider: config.active_provider,
    providerCount: Object.keys(config.providers).length,
    port: getRuntime().port ?? config.proxy_port,
    configuredPort: config.proxy_port,
    version: readPackageVersion(),
    keyAlerts: keyAlerts(),
    ...status
  });
});

// ------------------------------------------------------------------ providers

route('GET', /^\/api\/providers$/, ({ res }) => {
  const config = loadConfig();
  const providers = Object.entries(config.providers).map(([name, data]) => providerView(name, data, config));
  sendJSON(res, 200, { ok: true, providers, activeProvider: config.active_provider });
});

route('POST', /^\/api\/providers$/, async ({ req, res }) => {
  const body = await parseBody(req);
  const name = normalizeProviderName(body.name);

  if (!name) return sendJSON(res, 400, { ok: false, error: 'A provider name is required (letters, digits, . _ -).' });
  if (!body.url) return sendJSON(res, 400, { ok: false, error: 'A base URL is required.' });

  try {
    parseProviderUrl(body.url);
  } catch (error) {
    return sendJSON(res, 400, { ok: false, error: error.message });
  }

  const config = loadConfig();
  if (config.providers[name]) {
    return sendJSON(res, 409, { ok: false, error: `Provider '${name}' already exists. Edit it instead.` });
  }

  const models = Array.isArray(body.models) ? body.models.map(String) : [];
  config.providers[name] = {
    url: String(body.url).trim(),
    apiKey: body.apiKey ? String(body.apiKey).trim() : '',
    defaultModel: body.defaultModel ? String(body.defaultModel).trim() : '',
    models
  };
  if (!config.active_provider) config.active_provider = name;

  saveConfig(config);
  sendJSON(res, 201, { ok: true, message: `Provider '${name}' created.`, name });
});

route('GET', new RegExp(`^/api/providers/(${NAME})$`), ({ res, params }) => {
  const config = loadConfig();
  const data = config.providers[params[0]];
  if (!data) return sendJSON(res, 404, { ok: false, error: `Provider '${params[0]}' not found.` });
  sendJSON(res, 200, { ok: true, provider: providerView(params[0], data, config) });
});

route('PUT', new RegExp(`^/api/providers/(${NAME})$`), async ({ req, res, params }) => {
  const name = params[0];
  const body = await parseBody(req);
  const config = loadConfig();
  if (!config.providers[name]) return sendJSON(res, 404, { ok: false, error: `Provider '${name}' not found.` });

  if (body.url !== undefined) {
    try {
      parseProviderUrl(body.url);
    } catch (error) {
      return sendJSON(res, 400, { ok: false, error: error.message });
    }
    config.providers[name].url = String(body.url).trim();
  }
  // An empty apiKey means "leave the stored key alone".
  if (body.apiKey) config.providers[name].apiKey = String(body.apiKey).trim();
  if (body.clearKey === true) config.providers[name].apiKey = '';
  if (body.defaultModel !== undefined) config.providers[name].defaultModel = String(body.defaultModel).trim();
  if (Array.isArray(body.models)) config.providers[name].models = body.models.map(String);

  saveConfig(config);
  sendJSON(res, 200, { ok: true, message: `Provider '${name}' updated.` });
});

route('DELETE', new RegExp(`^/api/providers/(${NAME})$`), ({ res, params }) => {
  const name = params[0];
  const config = loadConfig();
  if (!config.providers[name]) return sendJSON(res, 404, { ok: false, error: `Provider '${name}' not found.` });

  delete config.providers[name];
  if (config.active_provider === name) config.active_provider = Object.keys(config.providers)[0] ?? null;

  saveConfig(config);
  sendJSON(res, 200, { ok: true, message: `Provider '${name}' deleted.`, activeProvider: config.active_provider });
});

route('POST', new RegExp(`^/api/providers/(${NAME})/activate$`), ({ res, params }) => {
  const name = params[0];
  const config = loadConfig();
  if (!config.providers[name]) return sendJSON(res, 404, { ok: false, error: `Provider '${name}' not found.` });

  config.active_provider = name;
  saveConfig(config);
  sendJSON(res, 200, { ok: true, message: `Active provider is now '${name}'.` });
});

route('GET', new RegExp(`^/api/providers/(${NAME})/key$`), ({ res, params }) => {
  const config = loadConfig();
  const data = config.providers[params[0]];
  if (!data) return sendJSON(res, 404, { ok: false, error: `Provider '${params[0]}' not found.` });
  sendJSON(res, 200, { ok: true, apiKey: data.apiKey || '' });
});

route('POST', new RegExp(`^/api/providers/(${NAME})/test$`), async ({ req, res, params }) => {
  const body = await parseBody(req).catch(() => ({}));
  const config = loadConfig();
  const provider = config.providers[params[0]];
  if (!provider) return sendJSON(res, 404, { ok: false, error: `Provider '${params[0]}' not found.` });

  const result = await testProvider(provider, {
    model: body.model,
    spoof: config.settings.spoofHeaders !== false
  });
  sendJSON(res, 200, { ok: true, provider: params[0], result });
});

// --------------------------------------------------------------------- models

route('POST', new RegExp(`^/api/providers/(${NAME})/model$`), async ({ req, res, params }) => {
  const name = params[0];
  const body = await parseBody(req);
  const config = loadConfig();
  if (!config.providers[name]) return sendJSON(res, 404, { ok: false, error: `Provider '${name}' not found.` });
  if (body.model === undefined) return sendJSON(res, 400, { ok: false, error: 'Missing field: model' });

  const model = String(body.model).trim();
  const provider = config.providers[name];
  provider.models = provider.models || [];
  // An empty model is meaningful: it re-enables pass-through mode.
  if (model && !provider.models.includes(model)) provider.models.push(model);
  provider.defaultModel = model;

  saveConfig(config);
  sendJSON(res, 200, {
    ok: true,
    message: model ? `'${name}' now uses '${model}'.` : `'${name}' now passes the client's model through.`
  });
});

async function addModelHandler({ req, res, params }) {
  const name = params[0];
  const body = await parseBody(req);
  const config = loadConfig();
  if (!config.providers[name]) return sendJSON(res, 404, { ok: false, error: `Provider '${name}' not found.` });

  const model = String(body.model ?? '').trim();
  if (!model) return sendJSON(res, 400, { ok: false, error: 'Missing field: model' });

  const provider = config.providers[name];
  provider.models = provider.models || [];
  if (provider.models.includes(model)) {
    return sendJSON(res, 409, { ok: false, error: `'${model}' is already in the list.` });
  }
  provider.models.push(model);
  if (!provider.defaultModel) provider.defaultModel = model;

  saveConfig(config);
  sendJSON(res, 201, { ok: true, message: `Added '${model}' to '${name}'.` });
}

async function removeModelHandler({ res, params, name: providerName, model: modelName, req }) {
  const name = providerName ?? params[0];
  const model = modelName ?? String((await parseBody(req)).model ?? '').trim();
  const config = loadConfig();
  if (!config.providers[name]) return sendJSON(res, 404, { ok: false, error: `Provider '${name}' not found.` });
  if (!model) return sendJSON(res, 400, { ok: false, error: 'Missing field: model' });

  const provider = config.providers[name];
  provider.models = (provider.models || []).filter(m => m !== model);
  if (provider.defaultModel === model) provider.defaultModel = provider.models[0] || '';

  saveConfig(config);
  sendJSON(res, 200, {
    ok: true,
    message: `Removed '${model}' from '${name}'.`,
    defaultModel: provider.defaultModel
  });
}

route('POST', new RegExp(`^/api/providers/(${NAME})/models$`), addModelHandler);
route('POST', new RegExp(`^/api/providers/(${NAME})/models/add$`), addModelHandler);
route('POST', new RegExp(`^/api/providers/(${NAME})/models/remove$`), removeModelHandler);
route('DELETE', new RegExp(`^/api/providers/(${NAME})/models/(.+)$`), ctx =>
  removeModelHandler({ ...ctx, name: ctx.params[0], model: decodeURIComponent(ctx.params[1]) })
);

// ------------------------------------------------------------------- key pool

/**
 * One provider's key pool, masked and counted. Addressed by id throughout: no
 * response from this API ever carries a key value.
 * @param {string} name
 * @param {Object} data - normalized provider
 * @returns {Object}
 */
function keyPoolView(name, data) {
  const inUse = selectKey(data.keys, data.selectedKeyId)?.id ?? null;
  const keys = (data.keys || []).map((entry, index) => ({
    position: index + 1,
    id: entry.id,
    masked: maskKey(entry.key),
    label: entry.label,
    // Typed by the user and recorded nowhere else, so an editor that could not
    // read it back would blank it on the next save.
    note: entry.note,
    status: entry.status,
    remaining: entry.remaining,
    needed: entry.needed,
    requestsServed: entry.requestsServed,
    lastUsedAt: entry.lastUsedAt,
    lastError: entry.lastError,
    dashboardUrl: entry.dashboardUrl,
    referralUrl: entry.referralUrl,
    inUse: entry.id === inUse
  }));

  return {
    name,
    total: keys.length,
    spent: keys.filter(key => key.status === 'exhausted').length,
    unusable: keys.filter(key => key.status === 'invalid' || key.status === 'disabled').length,
    selectedKeyId: data.selectedKeyId || '',
    // Whether a spent key waits for the user or is left behind on the spot.
    // The banner reads differently in each case.
    rotation: data.keyRotation,
    inUse,
    keys
  };
}

/** The little a caller needs to name a key back to the user. */
function keyRef(entry) {
  if (!entry) return null;
  return {
    id: entry.id,
    label: entry.label || '',
    masked: maskKey(entry.key),
    status: entry.status,
    remaining: entry.remaining ?? null
  };
}

route('GET', /^\/api\/keys$/, ({ res }) => {
  const config = loadConfig();
  sendJSON(res, 200, {
    ok: true,
    providers: Object.entries(config.providers).map(([name, data]) => keyPoolView(name, data)),
    alerts: keyAlerts()
  });
});

route('POST', new RegExp(`^/api/keys/(${NAME})/next$`), ({ res, params }) => {
  const { from, to } = nextKey(params[0]);
  sendJSON(res, 200, { ok: true, provider: params[0], from: keyRef(from), to: keyRef(to) });
});

route('POST', new RegExp(`^/api/keys/(${NAME})/use$`), async ({ req, res, params }) => {
  const body = await parseBody(req);
  const { to } = useKey(params[0], body.keyId ?? body.key ?? body.selector);
  sendJSON(res, 200, { ok: true, provider: params[0], to: keyRef(to) });
});

route('POST', new RegExp(`^/api/keys/(${NAME})/retire$`), async ({ req, res, params }) => {
  const body = await parseBody(req).catch(() => ({}));
  const { from, to } = retireKey(params[0], body.keyId ?? body.selector ?? '');
  sendJSON(res, 200, { ok: true, provider: params[0], from: keyRef(from), to: keyRef(to) });
});

route('POST', new RegExp(`^/api/keys/(${NAME})/revive$`), async ({ req, res, params }) => {
  const body = await parseBody(req);
  const { entry } = reviveKey(params[0], body.keyId ?? body.selector);
  sendJSON(res, 200, { ok: true, provider: params[0], entry: keyRef(entry) });
});

route('POST', new RegExp(`^/api/keys/(${NAME})/rotation$`), async ({ req, res, params }) => {
  const body = await parseBody(req).catch(() => ({}));
  const { mode, previous, changed } = setRotation(params[0], body.mode ?? body.rotation);
  sendJSON(res, 200, { ok: true, provider: params[0], mode, previous, changed });
});

route('DELETE', new RegExp(`^/api/keys/(${NAME})/alerts/([a-f0-9]+)$`), ({ res, params }) => {
  sendJSON(res, 200, { ok: true, dismissed: dismissKeyAlert(params[0], params[1]) });
});

// Managing the pool by hand. `POST /api/keys/:name` takes a key value in, and
// `GET …/value` is the one route that gives one back — deliberately separate
// from every listing, so no bulk response can ever grow a key field by accident.

route('POST', new RegExp(`^/api/keys/(${NAME})$`), async ({ req, res, params }) => {
  const body = await parseBody(req);
  const credit = Number(body.remaining ?? body.credit);
  const { entry, position, inUse, alsoIn } = addKey(params[0], body.key ?? body.apiKey, {
    label: body.label ?? body.account,
    note: body.note,
    dashboardUrl: body.dashboardUrl,
    referralUrl: body.referralUrl,
    remaining: Number.isFinite(credit) ? credit : undefined,
    use: Boolean(body.use)
  });
  sendJSON(res, 200, { ok: true, provider: params[0], entry: keyRef(entry), position, inUse, alsoIn });
});

route('PATCH', new RegExp(`^/api/keys/(${NAME})/([a-f0-9]+)$`), async ({ req, res, params }) => {
  // The body is forwarded as it arrived: a field the pool does not let anyone
  // type — a status, a balance — has to come back as an error naming the verb
  // that owns it, not be dropped in silence here.
  const body = await parseBody(req);
  const { entry, changed } = editKey(params[0], params[1], body);
  sendJSON(res, 200, { ok: true, provider: params[0], entry: keyRef(entry), changed });
});

route('DELETE', new RegExp(`^/api/keys/(${NAME})/([a-f0-9]+)$`), ({ res, params, query }) => {
  const confirm = String(query.get('confirm') ?? '').toLowerCase();
  const { entry, movedTo, poolSize } = removeKey(params[0], params[1], {
    confirmed: ['1', 'true', 'yes'].includes(confirm)
  });
  sendJSON(res, 200, {
    ok: true, provider: params[0], entry: keyRef(entry), movedTo: keyRef(movedTo), poolSize
  });
});

route('GET', new RegExp(`^/api/keys/(${NAME})/([a-f0-9]+)/value$`), ({ res, params }) => {
  const { entry, key } = revealKey(params[0], params[1]);
  sendJSON(res, 200, {
    ok: true, provider: params[0], id: entry.id, label: entry.label, status: entry.status, apiKey: key
  });
});

// ----------------------------------------------------------------------- logs

route('GET', /^\/api\/logs$/, ({ res, query }) => {
  const logs = getLogs({
    limit: query.get('limit') ?? undefined,
    provider: query.get('provider') ?? undefined,
    status: query.get('status') ?? undefined
  });
  sendJSON(res, 200, { ok: true, logs });
});

route('GET', /^\/api\/logs\/(\d+)$/, ({ res, params }) => {
  const entry = getLogById(Number(params[0]));
  if (!entry) return sendJSON(res, 404, { ok: false, error: `No request with id ${params[0]}.` });
  sendJSON(res, 200, { ok: true, log: entry });
});

route('DELETE', /^\/api\/logs$/, ({ res }) => {
  clearLogs();
  sendJSON(res, 200, { ok: true, message: 'Request history cleared.' });
});

// ------------------------------------------------------------------- settings

route('GET', /^\/api\/settings$/, ({ res }) => {
  const config = loadConfig();
  sendJSON(res, 200, { ok: true, settings: config.settings, proxyPort: config.proxy_port, defaults: DEFAULT_SETTINGS });
});

route('PUT', /^\/api\/settings$/, async ({ req, res }) => {
  const body = await parseBody(req);
  const config = loadConfig();
  let restartRequired = false;

  if (body.proxy_port !== undefined) {
    const port = Number(body.proxy_port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return sendJSON(res, 400, { ok: false, error: 'proxy_port must be an integer between 1 and 65535.' });
    }
    if (port !== config.proxy_port) restartRequired = true;
    config.proxy_port = port;
  }

  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (body[key] !== undefined) config.settings[key] = body[key];
  }

  const saved = saveConfig(config);
  configureLogger(saved.settings);
  sendJSON(res, 200, {
    ok: true,
    message: restartRequired ? 'Saved. Restart the proxy to bind the new port.' : 'Settings saved.',
    settings: saved.settings,
    restartRequired
  });
});

// --------------------------------------------------------------- config io

route('GET', /^\/api\/config\/export$/, ({ res, query }) => {
  const config = loadConfig();
  const redact = query.get('redact') !== '0';
  const exported = JSON.parse(JSON.stringify(config));
  if (redact) {
    for (const provider of Object.values(exported.providers)) provider.apiKey = '';
  }
  sendJSON(res, 200, {
    ok: true,
    redacted: redact,
    exportedAt: new Date().toISOString(),
    config: exported
  });
});

route('POST', /^\/api\/config\/import$/, async ({ req, res }) => {
  const body = await parseBody(req);
  const incoming = body.config ?? body;
  if (!incoming || typeof incoming !== 'object' || typeof incoming.providers !== 'object') {
    return sendJSON(res, 400, { ok: false, error: 'Expected an object with a "providers" map.' });
  }

  const mode = body.mode === 'replace' ? 'replace' : 'merge';
  const current = loadConfig();
  const next = mode === 'replace'
    ? { ...incoming, providers: {} }
    : { ...current, providers: { ...current.providers } };

  let imported = 0;
  for (const [rawName, rawData] of Object.entries(incoming.providers)) {
    const name = normalizeProviderName(rawName);
    if (!name || !rawData || typeof rawData !== 'object') continue;
    const existing = current.providers[name];
    next.providers[name] = {
      url: String(rawData.url ?? existing?.url ?? ''),
      // A redacted export carries no key — never wipe a working one.
      apiKey: rawData.apiKey ? String(rawData.apiKey) : (existing?.apiKey ?? ''),
      defaultModel: String(rawData.defaultModel ?? existing?.defaultModel ?? ''),
      models: Array.isArray(rawData.models) ? rawData.models.map(String) : (existing?.models ?? [])
    };
    imported++;
  }

  if (incoming.active_provider) next.active_provider = normalizeProviderName(incoming.active_provider);
  if (incoming.proxy_port) next.proxy_port = Number(incoming.proxy_port);

  const saved = saveConfig(next);
  sendJSON(res, 200, {
    ok: true,
    message: `Imported ${imported} provider(s) (${mode}).`,
    imported,
    providers: Object.keys(saved.providers)
  });
});

// --------------------------------------------------------------- integrations

route('GET', /^\/api\/integrations$/, ({ res }) => {
  sendJSON(res, 200, { ok: true, integrations: getIntegrationStatus() });
});

route('POST', /^\/api\/integrations\/shell$/, ({ res }) => {
  const result = applyShellSetup({ quiet: true });
  sendJSON(res, result.ok ? 200 : 500, { ...result, integrations: getIntegrationStatus() });
});

route('DELETE', /^\/api\/integrations\/shell$/, ({ res }) => {
  const result = removeShellSetup({ quiet: true });
  sendJSON(res, result.ok ? 200 : 500, { ...result, integrations: getIntegrationStatus() });
});

route('POST', /^\/api\/integrations\/vscode$/, ({ res }) => {
  const result = syncVsCode({ quiet: true });
  sendJSON(res, result.ok ? 200 : 500, { ...result, integrations: getIntegrationStatus() });
});

/**
 * Dispatches an /api/* request.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} [pathname] - pre-split pathname (query string removed)
 * @returns {Promise<boolean>} true when a route handled the request
 */
export async function handleApiRequest(req, res, pathname) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const routePath = pathname || url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { Allow: 'GET, POST, PUT, PATCH, DELETE, OPTIONS' });
    res.end();
    return true;
  }

  const matchesPath = routes.filter(entry => entry.pattern.test(routePath));

  for (const entry of matchesPath) {
    if (entry.method !== req.method) continue;
    const match = routePath.match(entry.pattern);
    try {
      await entry.handler({ req, res, params: match.slice(1), query: url.searchParams, pathname: routePath });
    } catch (error) {
      if (!res.headersSent) {
        sendJSON(res, 400, {
          ok: false,
          error: error.message,
          ...(error.hint ? { hint: error.hint } : {})
        });
      }
    }
    return true;
  }

  if (matchesPath.length) {
    sendJSON(res, 405, {
      ok: false,
      error: `${req.method} is not allowed on ${routePath}.`,
      allowed: [...new Set(matchesPath.map(entry => entry.method))]
    });
    return true;
  }

  sendJSON(res, 404, { ok: false, error: `Unknown API route: ${routePath}` });
  return true;
}
