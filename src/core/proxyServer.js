/**
 * @fileoverview The core HTTP/HTTPS Smart Proxy engine.
 * Routes requests dynamically based on the active config or token prefixes.
 */

import http from 'http';
import https from 'https';
import { loadConfig } from './configManager.js';
import { Logger } from '../utils/logger.js';

const SPOOFED_HEADERS = {
  'user-agent': 'codex_cli_rs/0.101.0',
  'anthropic-version': '2023-06-01',
  'x-stainless-lang': 'js',
  'x-stainless-package-version': '0.24.0',
  'x-stainless-os': 'linux',
  'x-stainless-arch': 'x64',
  'x-stainless-runtime': 'node',
  'x-stainless-runtime-version': 'v20.0.0'
};

export function startProxyServer() {
  const initialConfig = loadConfig();
  const PORT = initialConfig.proxy_port || 8319;

  const server = http.createServer((clientReq, clientRes) => {
    // 1. Dynamically read config on every request (allows instant provider switching!)
    const config = loadConfig();
    let token = null;

    const authHeader = clientReq.headers['authorization'];
    const xApiKeyHeader = clientReq.headers['x-api-key'] || clientReq.headers['api-key'];
    if (authHeader && authHeader.startsWith('Bearer ')) token = authHeader.slice(7).trim();
    else if (authHeader) token = authHeader.trim();
    else if (xApiKeyHeader) token = xApiKeyHeader.trim();

    let targetProviderName = config.active_provider;

    // 2. Smart Routing: Check if client passed a targeted token (e.g., "gorouter:sk-123...")
    if (token && token.includes(':')) {
      const parts = token.split(':');
      if (config.providers[parts[0]]) {
        targetProviderName = parts[0];
        // If they provided an actual key after the colon, use it. Otherwise, use stored key.
        if (parts[1] && parts[1] !== 'dummy') {
          token = parts.slice(1).join(':');
        } else {
          token = 'dummy'; // Force database lookup
        }
      }
    }

    const provider = config.providers[targetProviderName];
    if (!provider) {
      clientRes.writeHead(500);
      return clientRes.end(JSON.stringify({ error: `Provider '${targetProviderName}' is missing or not configured.` }));
    }

    // 3. Resolve API Key (Use client key if valid, otherwise use database key)
    const actualKey = (token && !token.includes('dummy') && token.length > 15) 
      ? token 
      : provider.apiKey;

    // 4. Resolve Target URL
    const targetHost = provider.url.replace(/^https?:\/\//, '').split('/')[0];
    
    // Create outbound headers
    const headers = { ...clientReq.headers, ...SPOOFED_HEADERS, host: targetHost };

    if (actualKey) {
      // Tabitoken and GoRouter require the 'Authorization: Bearer' header,
      // while official Anthropic SDKs expect 'x-api-key'. We supply both to be safe across all providers!
      headers['x-api-key'] = actualKey;
      headers['Authorization'] = `Bearer ${actualKey}`;
    }

    const options = {
      hostname: targetHost,
      port: 443,
      path: clientReq.url,
      method: clientReq.method,
      headers: headers
    };

    Logger.info(`Routing ${clientReq.method} request to [${targetProviderName.toUpperCase()}] -> ${targetHost}`);

    // 5. Forward Request
    if (clientReq.method === 'POST' && clientReq.url.includes('/messages')) {
      let reqBody = '';
      clientReq.on('data', chunk => { reqBody += chunk.toString(); });
      clientReq.on('end', () => {
        try {
          let jsonBody = JSON.parse(reqBody);
          const originalModel = jsonBody.model;
          
          // Inject Default Model if configured
          if (provider.defaultModel && jsonBody.model) {
             jsonBody.model = provider.defaultModel;
             if (originalModel !== provider.defaultModel) {
               console.log(`   🔄 Model Swap: ${originalModel} -> ${provider.defaultModel}`);
             }
          }
          
          const modifiedBody = JSON.stringify(jsonBody);
          options.headers['content-length'] = Buffer.byteLength(modifiedBody);

          const proxyReq = https.request(options, (proxyRes) => {
            console.log(`   ⬅️ Response Status: ${proxyRes.statusCode}`);
            clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(clientRes, { end: true });
          });
          
          proxyReq.on('error', (err) => {
            Logger.error(`Proxy Request Error: ${err.message}`);
            clientRes.writeHead(502); 
            clientRes.end(JSON.stringify({ error: err.message }));
          });
          
          proxyReq.write(modifiedBody); 
          proxyReq.end();
        } catch (e) {
          Logger.error(`Invalid JSON in request body: ${e.message}`);
          clientRes.writeHead(400); 
          clientRes.end('Bad Request');
        }
      });
    } else {
      // Non-POST or Non-Messages routing
      const proxyReq = https.request(options, (proxyRes) => {
        console.log(`   ⬅️ Response Status: ${proxyRes.statusCode}`);
        clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(clientRes, { end: true });
      });
      proxyReq.on('error', (err) => {
        Logger.error(`Proxy Request Error: ${err.message}`);
        clientRes.writeHead(502); 
        clientRes.end(JSON.stringify({ error: err.message }));
      });
      clientReq.pipe(proxyReq, { end: true });
    }
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      Logger.error(`Port ${PORT} is already in use. Is the proxy already running?`);
      Logger.info(`Try running: fuser -k ${PORT}/tcp`);
    } else {
      Logger.error(`Server Error: ${e.message}`);
    }
    process.exit(1);
  });

  server.listen(PORT, '127.0.0.1', () => {
    Logger.header('Smart Proxy Daemon Started');
    Logger.success(`Listening on http://127.0.0.1:${PORT}`);
    Logger.info(`Default Active Provider: \x1b[1m${initialConfig.active_provider}\x1b[0m`);
    console.log('\nWaiting for requests... (Press Ctrl+C to stop)\n');
  });
}
