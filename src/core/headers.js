/**
 * @fileoverview Header handling shared by the proxy engine and the connection
 * tester, so a "Test" result reflects exactly what a real request would send.
 */

/**
 * Headers that make the request look like a first-party SDK/CLI call.
 * Some providers (e.g. Tabitoken) sit behind a Cloudflare WAF that rejects
 * anything else. Disable via settings.spoofHeaders when a provider objects.
 */
export const SPOOFED_HEADERS = {
  'user-agent': 'codex_cli_rs/0.101.0',
  'anthropic-version': '2023-06-01',
  'x-stainless-lang': 'js',
  'x-stainless-package-version': '0.24.0',
  'x-stainless-os': 'linux',
  'x-stainless-arch': 'x64',
  'x-stainless-runtime': 'node',
  'x-stainless-runtime-version': 'v20.0.0'
};

/**
 * Connection-scoped headers that must never be forwarded by a proxy.
 * @see https://www.rfc-editor.org/rfc/rfc9110#section-7.6.1
 */
const HOP_BY_HOP = [
  'connection',
  'proxy-connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'http2-settings'
];

/**
 * Builds the outgoing header set for an upstream request.
 * @param {Object} options
 * @param {Record<string,string|string[]>} [options.incoming] - client headers
 * @param {string} options.hostHeader - value for the Host header
 * @param {string} [options.apiKey] - resolved provider key
 * @param {boolean} [options.spoof=true] - apply SPOOFED_HEADERS
 * @returns {Record<string,string|string[]>}
 */
export function buildUpstreamHeaders({ incoming = {}, hostHeader, apiKey, spoof = true }) {
  const headers = {};

  for (const [name, value] of Object.entries(incoming)) {
    const key = name.toLowerCase();
    if (HOP_BY_HOP.includes(key)) continue;
    if (key === 'host' || key === 'content-length') continue;
    // Auth is re-derived below; drop whatever the client sent.
    if (key === 'authorization' || key === 'x-api-key' || key === 'api-key') continue;
    headers[key] = value;
  }

  if (spoof) Object.assign(headers, SPOOFED_HEADERS);
  headers.host = hostHeader;

  if (apiKey) {
    // Anthropic SDKs read x-api-key; most relays expect a Bearer token.
    // Sending both keeps every provider we have seen happy.
    headers['x-api-key'] = apiKey;
    headers.authorization = `Bearer ${apiKey}`;
  }

  return headers;
}

/**
 * Extracts the bearer/api-key token a client supplied.
 * @param {Record<string,string|string[]>} headers
 * @returns {string|null}
 */
export function extractClientToken(headers = {}) {
  const auth = headers.authorization;
  if (typeof auth === 'string' && auth.trim()) {
    return auth.replace(/^Bearer\s+/i, '').trim();
  }
  const apiKey = headers['x-api-key'] || headers['api-key'];
  if (typeof apiKey === 'string' && apiKey.trim()) return apiKey.trim();
  return null;
}
