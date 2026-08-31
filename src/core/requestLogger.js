/**
 * @fileoverview Request history and metrics for the dashboard.
 *
 * Three layers:
 *  1. A ring buffer of recent requests (size from settings.logBufferSize).
 *  2. Optional JSONL mirror on disk so history survives a restart.
 *     Bodies are deliberately NOT persisted — only metadata.
 *  3. Body previews kept in memory only, for the request inspector.
 */

import fs from 'fs';
import { CONFIG_DIR, REQUEST_LOG, REQUEST_LOG_ROTATED } from './paths.js';

/** Rotate the JSONL file once it passes this size. */
const MAX_LOG_BYTES = 5 * 1024 * 1024;
/** Cap on a stored body preview. */
const BODY_PREVIEW_LIMIT = 4000;

const state = {
  buffer: /** @type {Array<Object>} */ ([]),
  bodies: /** @type {Map<number, {request?:string, response?:string, truncated?:boolean}>} */ (new Map()),
  totalRequests: 0,
  startTime: Date.now(),
  nextId: 1,
  maxEntries: 200,
  persist: true,
  captureBodies: true,
  restored: 0
};

/**
 * Applies user settings and restores persisted history.
 * Safe to call more than once.
 * @param {{logBufferSize?:number, persistLogs?:boolean, captureBodies?:boolean}} [settings]
 */
export function configureLogger(settings = {}) {
  // The sane-range policy lives in normalizeConfig(); honour whatever it passes.
  if (Number.isFinite(settings.logBufferSize)) state.maxEntries = Math.max(1, Math.floor(settings.logBufferSize));
  if (settings.persistLogs !== undefined) state.persist = Boolean(settings.persistLogs);
  if (settings.captureBodies !== undefined) state.captureBodies = Boolean(settings.captureBodies);
  trim();
}

/**
 * Loads the tail of the persisted JSONL history into the ring buffer so the
 * dashboard is not empty right after a restart.
 * @returns {number} number of entries restored
 */
export function restorePersistedLogs() {
  if (!state.persist || state.restored) return 0;
  let text = '';
  try {
    if (!fs.existsSync(REQUEST_LOG)) return 0;
    text = fs.readFileSync(REQUEST_LOG, 'utf8');
  } catch {
    return 0;
  }

  const lines = text.split('\n').filter(Boolean).slice(-state.maxEntries);
  const restored = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry.id === 'number') restored.push({ ...entry, historical: true });
    } catch { /* skip malformed line */ }
  }
  if (!restored.length) return 0;

  state.buffer = restored;
  state.nextId = Math.max(...restored.map(e => e.id)) + 1;
  state.restored = restored.length;
  return restored.length;
}

function trim() {
  while (state.buffer.length > state.maxEntries) {
    const dropped = state.buffer.shift();
    if (dropped) state.bodies.delete(dropped.id);
  }
}

function appendToDisk(entry) {
  if (!state.persist) return;
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    let size = 0;
    try { size = fs.statSync(REQUEST_LOG).size; } catch { /* first write */ }
    if (size > MAX_LOG_BYTES) {
      try { fs.renameSync(REQUEST_LOG, REQUEST_LOG_ROTATED); } catch { /* keep appending */ }
    }
    // Metadata only — prompts and completions never reach disk.
    const { requestBody, responseBody, ...meta } = entry;
    fs.appendFileSync(REQUEST_LOG, `${JSON.stringify(meta)}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch { /* logging must never break the proxy */ }
}

/**
 * Records the start of a proxied request.
 * @param {Object} entry
 * @param {string} entry.method
 * @param {string} entry.path
 * @param {string} [entry.provider]
 * @param {string} [entry.targetHost]
 * @param {string} [entry.targetUrl]
 * @param {string} [entry.originalModel]
 * @param {string} [entry.swappedModel]
 * @param {boolean} [entry.streaming]
 * @param {string} [entry.client] - user agent of the calling tool
 * @param {number} [entry.bytesIn]
 * @param {number} [entry.attempt] - 1 for the first try, 2+ for a retry
 * @param {string} [entry.retryReason] - why the previous attempt was retried
 * @returns {number} request id, to be passed to finishRequest()
 */
export function startRequest(entry) {
  const id = state.nextId++;
  state.totalRequests++;

  const record = {
    id,
    timestamp: new Date().toISOString(),
    method: entry.method || 'GET',
    path: entry.path || '/',
    provider: entry.provider || null,
    targetHost: entry.targetHost || null,
    targetUrl: entry.targetUrl || null,
    originalModel: entry.originalModel || null,
    swappedModel: entry.swappedModel || null,
    streaming: Boolean(entry.streaming),
    client: entry.client || null,
    bytesIn: entry.bytesIn || 0,
    bytesOut: 0,
    statusCode: null,
    durationMs: null,
    ttfbMs: null,
    error: null,
    attempt: entry.attempt || 1,
    retryReason: entry.retryReason || null,
    _startedAt: Date.now()
  };

  state.buffer.push(record);
  trim();
  return id;
}

/** Back-compatible alias for the previous API. */
export const logRequest = startRequest;

/**
 * Attaches request/response body previews (memory only).
 * @param {number} id
 * @param {'request'|'response'} kind
 * @param {string} body
 */
export function attachBody(id, kind, body) {
  if (!state.captureBodies || !body) return;
  const current = state.bodies.get(id) || {};
  const text = String(body);
  current[kind] = text.slice(0, BODY_PREVIEW_LIMIT);
  if (text.length > BODY_PREVIEW_LIMIT) current.truncated = true;
  state.bodies.set(id, current);
}

/**
 * Marks the moment the first upstream byte arrived (useful for spotting
 * providers that answer 200 and then stall).
 * @param {number} id
 */
export function markFirstByte(id) {
  const entry = find(id);
  if (entry && entry.ttfbMs === null) entry.ttfbMs = Date.now() - entry._startedAt;
}

/**
 * Completes a request record and mirrors it to disk.
 * @param {number} id
 * @param {{statusCode?:number|null, bytesOut?:number, error?:string|null, streaming?:boolean}} [result]
 */
export function finishRequest(id, result = {}) {
  const entry = find(id);
  if (!entry) return;
  if (result.statusCode !== undefined) entry.statusCode = result.statusCode;
  if (result.bytesOut !== undefined) entry.bytesOut = result.bytesOut;
  if (result.error !== undefined) entry.error = result.error;
  if (result.streaming !== undefined) entry.streaming = Boolean(result.streaming);
  entry.durationMs = Date.now() - entry._startedAt;
  appendToDisk(entry);
}

/**
 * Back-compatible status-only update.
 * @param {number} id
 * @param {number} statusCode
 */
export function updateRequestStatus(id, statusCode) {
  const entry = find(id);
  if (!entry) return;
  entry.statusCode = statusCode;
}

function find(id) {
  return state.buffer.find(e => e.id === id);
}

function publicView(entry) {
  const { _startedAt, ...rest } = entry;
  return rest;
}

/**
 * Returns recent requests, newest last.
 * @param {{limit?:number, provider?:string, status?:'ok'|'error'|'pending'}} [filter]
 * @returns {Array<Object>}
 */
export function getLogs(filter = {}) {
  let logs = state.buffer.map(publicView);

  if (filter.provider) logs = logs.filter(l => l.provider === filter.provider);
  if (filter.status === 'ok') logs = logs.filter(l => l.statusCode && l.statusCode < 400);
  else if (filter.status === 'error') logs = logs.filter(l => l.error || (l.statusCode && l.statusCode >= 400));
  else if (filter.status === 'pending') logs = logs.filter(l => !l.statusCode && !l.error);

  const limit = Number(filter.limit);
  if (Number.isFinite(limit) && limit > 0) logs = logs.slice(-Math.floor(limit));
  return logs;
}

/**
 * One request plus its captured bodies, for the inspector drawer.
 * @param {number} id
 * @returns {Object|null}
 */
export function getLogById(id) {
  const entry = find(Number(id));
  if (!entry) return null;
  const bodies = state.bodies.get(Number(id)) || {};
  return { ...publicView(entry), bodies };
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

/**
 * Aggregate metrics for the dashboard tiles.
 * @returns {Object}
 */
export function getStatus() {
  const live = state.buffer.filter(e => !e.historical);
  const durations = live.map(e => e.durationMs).filter(d => Number.isFinite(d)).sort((a, b) => a - b);
  const settled = live.filter(e => e.statusCode || e.error);
  const failed = settled.filter(e => e.error || (e.statusCode && e.statusCode >= 400));

  const byProvider = {};
  for (const entry of live) {
    if (!entry.provider) continue;
    const bucket = byProvider[entry.provider] || (byProvider[entry.provider] = { requests: 0, errors: 0 });
    bucket.requests++;
    if (entry.error || (entry.statusCode && entry.statusCode >= 400)) bucket.errors++;
  }

  return {
    totalRequests: state.totalRequests,
    uptimeSeconds: Math.floor((Date.now() - state.startTime) / 1000),
    startedAt: new Date(state.startTime).toISOString(),
    logBufferSize: state.buffer.length,
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    errorRate: settled.length ? Number((failed.length / settled.length).toFixed(3)) : 0,
    errorCount: failed.length,
    byProvider,
    persistLogs: state.persist
  };
}

/** Clears in-memory history and truncates the on-disk mirror. */
export function clearLogs() {
  state.buffer = [];
  state.bodies.clear();
  state.restored = 0;
  try { if (fs.existsSync(REQUEST_LOG)) fs.writeFileSync(REQUEST_LOG, '', 'utf8'); } catch { /* best effort */ }
}

/** Test helper: full reset including counters. */
export function resetLogger() {
  clearLogs();
  state.totalRequests = 0;
  state.nextId = 1;
  state.startTime = Date.now();
}
