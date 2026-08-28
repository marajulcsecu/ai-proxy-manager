/**
 * @fileoverview Turns a provider's configured base URL plus the client's
 * request path into a concrete upstream target.
 *
 * Previously the proxy hardcoded https:// on port 443 and threw away the base
 * URL's path, so `http://localhost:11434/v1` (Ollama, LM Studio, LiteLLM) and
 * `https://host/openai/v1` (path-prefixed gateways) could not work at all.
 */

/** Matches a trailing API version segment, e.g. /v1, /v2, /v1beta. */
const VERSION_TAIL = /\/v\d+[a-z]*\d*$/i;
/** Matches a leading API version segment on the client's path. */
const VERSION_HEAD = /^\/v\d+[a-z]*\d*(?=\/|$)/i;

/**
 * Parses a provider base URL. Accepts a bare host ("api.example.com/v1"),
 * in which case https is assumed.
 * @param {string} baseUrl
 * @returns {{protocol:'http:'|'https:', hostname:string, port:number, basePath:string, hostHeader:string, origin:string}}
 * @throws {Error} when the URL cannot be parsed
 */
export function parseProviderUrl(baseUrl) {
  const raw = String(baseUrl ?? '').trim();
  if (!raw) throw new Error('Provider URL is empty. Set one with: ai-proxy add-provider <name> <url>');

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  const withScheme = hasScheme ? raw : `https://${raw}`;

  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`Provider URL is not a valid URL: ${raw}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported protocol '${url.protocol}' in provider URL: ${raw}`);
  }
  if (!url.hostname) throw new Error(`Provider URL has no host: ${raw}`);

  // Without a scheme we guessed https, so insist the host actually looks like
  // one. Otherwise a typo ("nope", "htp://x") silently becomes a provider
  // pointing at a host that cannot exist.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!hasScheme && !host.includes('.') && !host.includes(':') && host !== 'localhost') {
    throw new Error(`'${raw}' is not a valid base URL. Include the scheme, e.g. https://${raw}/v1`);
  }

  const defaultPort = url.protocol === 'https:' ? 443 : 80;
  const port = url.port ? Number(url.port) : defaultPort;
  const basePath = url.pathname.replace(/\/+$/, '');

  return {
    protocol: url.protocol,
    hostname: url.hostname,
    port,
    basePath,
    // Host header must carry the port whenever it is non-default.
    hostHeader: port === defaultPort ? url.hostname : `${url.hostname}:${port}`,
    origin: `${url.protocol}//${port === defaultPort ? url.hostname : `${url.hostname}:${port}`}`
  };
}

/**
 * Joins a provider base path with the path the client asked for, without
 * duplicating the API version segment.
 *
 *   base '/v1'        + '/v1/messages' -> '/v1/messages'
 *   base '/openai/v1' + '/v1/messages' -> '/openai/v1/messages'
 *   base '/v1'        + '/messages'    -> '/v1/messages'
 *   base ''           + '/v1/messages' -> '/v1/messages'
 *   base '/api'       + '/v1/messages' -> '/api/v1/messages'
 *
 * @param {string} basePath
 * @param {string} requestPath - path plus optional query string
 * @returns {string}
 */
export function joinUpstreamPath(basePath, requestPath) {
  const reqPath = requestPath && requestPath.startsWith('/') ? requestPath : `/${requestPath || ''}`;
  if (!basePath) return reqPath;

  if (VERSION_TAIL.test(basePath) && VERSION_HEAD.test(reqPath)) {
    // Both sides carry a version — the provider's wins.
    return `${basePath}${reqPath.replace(VERSION_HEAD, '')}` || basePath;
  }
  if (reqPath === basePath || reqPath.startsWith(`${basePath}/`) || reqPath.startsWith(`${basePath}?`)) {
    return reqPath;
  }
  return `${basePath}${reqPath === '/' ? '' : reqPath}` || '/';
}

/**
 * Full resolution: provider base URL + client path -> request options.
 * @param {string} baseUrl
 * @param {string} requestPath
 * @returns {{protocol:string, hostname:string, port:number, path:string, hostHeader:string, isTls:boolean, displayUrl:string}}
 */
export function resolveUpstream(baseUrl, requestPath) {
  const parsed = parseProviderUrl(baseUrl);
  const path = joinUpstreamPath(parsed.basePath, requestPath);
  return {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port,
    path,
    hostHeader: parsed.hostHeader,
    isTls: parsed.protocol === 'https:',
    displayUrl: `${parsed.origin}${path}`
  };
}

/** Endpoints whose JSON body carries a `model` field worth rewriting. */
const MODEL_BEARING = [
  '/messages',
  '/messages/count_tokens',
  '/chat/completions',
  '/completions',
  '/responses',
  '/embeddings'
];

/**
 * True when a POST to this path should have its `model` field rewritten.
 * @param {string} pathname
 * @returns {boolean}
 */
export function isModelBearingPath(pathname) {
  const clean = String(pathname || '').split('?')[0].replace(/\/+$/, '');
  return MODEL_BEARING.some(suffix => clean.endsWith(suffix));
}
