/**
 * @fileoverview Internal REST API handler for the web dashboard.
 * All endpoints are under /api/* and return JSON responses.
 */

import { loadConfig, saveConfig } from './configManager.js';
import { getLogs, getStatus } from './requestLogger.js';

/**
 * Parses a JSON request body from an incoming HTTP request.
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<Object>}
 */
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
  });
}

/**
 * Sends a JSON response.
 * @param {import('http').ServerResponse} res
 * @param {number} statusCode
 * @param {Object} data
 */
function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data));
}

/**
 * Handles all /api/* requests. Returns true if the request was handled.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @returns {Promise<boolean>}
 */
export async function handleApiRequest(req, res) {
  const url = req.url;
  const method = req.method;

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return true;
  }

  // ----------------------------------------------------------
  // GET /api/status — Server health & uptime
  // ----------------------------------------------------------
  if (url === '/api/status' && method === 'GET') {
    const config = loadConfig();
    const status = getStatus();
    sendJSON(res, 200, {
      ok: true,
      activeProvider: config.active_provider,
      providerCount: Object.keys(config.providers).length,
      ...status
    });
    return true;
  }

  // ----------------------------------------------------------
  // GET /api/logs — Recent request log
  // ----------------------------------------------------------
  if (url === '/api/logs' && method === 'GET') {
    sendJSON(res, 200, { ok: true, logs: getLogs() });
    return true;
  }

  // ----------------------------------------------------------
  // GET /api/providers — List all providers
  // ----------------------------------------------------------
  if (url === '/api/providers' && method === 'GET') {
    const config = loadConfig();
    const providers = Object.entries(config.providers).map(([name, data]) => ({
      name,
      url: data.url,
      defaultModel: data.defaultModel || '',
      hasKey: !!data.apiKey,
      isActive: name === config.active_provider
    }));
    sendJSON(res, 200, { ok: true, providers });
    return true;
  }

  // ----------------------------------------------------------
  // POST /api/providers — Add a new provider
  // Body: { name, url, apiKey?, defaultModel? }
  // ----------------------------------------------------------
  if (url === '/api/providers' && method === 'POST') {
    try {
      const body = await parseBody(req);
      if (!body.name || !body.url) {
        sendJSON(res, 400, { ok: false, error: 'Missing required fields: name, url' });
        return true;
      }

      const config = loadConfig();
      const name = body.name.toLowerCase().replace(/[^a-z0-9_-]/g, '');

      config.providers[name] = {
        url: body.url,
        apiKey: body.apiKey || config.providers[name]?.apiKey || '',
        defaultModel: body.defaultModel || ''
      };

      // Auto-activate if first provider
      if (!config.active_provider) {
        config.active_provider = name;
      }

      saveConfig(config);
      sendJSON(res, 201, { ok: true, message: `Provider '${name}' created.` });
    } catch (e) {
      sendJSON(res, 400, { ok: false, error: e.message });
    }
    return true;
  }

  // ----------------------------------------------------------
  // PUT /api/providers/:name — Update a provider
  // Body: { url?, apiKey?, defaultModel? }
  // ----------------------------------------------------------
  const putMatch = url.match(/^\/api\/providers\/([a-z0-9_-]+)$/);
  if (putMatch && method === 'PUT') {
    try {
      const name = putMatch[1];
      const body = await parseBody(req);
      const config = loadConfig();

      if (!config.providers[name]) {
        sendJSON(res, 404, { ok: false, error: `Provider '${name}' not found.` });
        return true;
      }

      if (body.url !== undefined) config.providers[name].url = body.url;
      if (body.apiKey !== undefined) config.providers[name].apiKey = body.apiKey;
      if (body.defaultModel !== undefined) config.providers[name].defaultModel = body.defaultModel;

      saveConfig(config);
      sendJSON(res, 200, { ok: true, message: `Provider '${name}' updated.` });
    } catch (e) {
      sendJSON(res, 400, { ok: false, error: e.message });
    }
    return true;
  }

  // ----------------------------------------------------------
  // DELETE /api/providers/:name — Remove a provider
  // ----------------------------------------------------------
  const deleteMatch = url.match(/^\/api\/providers\/([a-z0-9_-]+)$/);
  if (deleteMatch && method === 'DELETE') {
    const name = deleteMatch[1];
    const config = loadConfig();

    if (!config.providers[name]) {
      sendJSON(res, 404, { ok: false, error: `Provider '${name}' not found.` });
      return true;
    }

    delete config.providers[name];

    // If we deleted the active provider, clear or reassign
    if (config.active_provider === name) {
      const remaining = Object.keys(config.providers);
      config.active_provider = remaining.length > 0 ? remaining[0] : null;
    }

    saveConfig(config);
    sendJSON(res, 200, { ok: true, message: `Provider '${name}' deleted.` });
    return true;
  }

  // ----------------------------------------------------------
  // POST /api/providers/:name/activate — Switch active provider
  // ----------------------------------------------------------
  const activateMatch = url.match(/^\/api\/providers\/([a-z0-9_-]+)\/activate$/);
  if (activateMatch && method === 'POST') {
    const name = activateMatch[1];
    const config = loadConfig();

    if (!config.providers[name]) {
      sendJSON(res, 404, { ok: false, error: `Provider '${name}' not found.` });
      return true;
    }

    config.active_provider = name;
    saveConfig(config);
    sendJSON(res, 200, { ok: true, message: `Active provider switched to '${name}'.` });
    return true;
  }

  // No matching API route
  return false;
}
