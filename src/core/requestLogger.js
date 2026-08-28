/**
 * @fileoverview In-memory circular buffer for request logging.
 * Stores the last N proxied requests for the dashboard live feed.
 * Logs are NOT persisted to disk — they reset on server restart.
 */

const MAX_LOG_ENTRIES = 50;

/** @type {Array<Object>} */
const logBuffer = [];

/** @type {number} */
let totalRequests = 0;

/** @type {number} */
const startTime = Date.now();

/**
 * Records a new proxied request into the circular buffer.
 * @param {Object} entry
 * @param {string} entry.method - HTTP method (GET, POST, HEAD, etc.)
 * @param {string} entry.provider - Target provider name
 * @param {string} entry.targetHost - Target hostname
 * @param {string} [entry.originalModel] - Model sent by the client
 * @param {string} [entry.swappedModel] - Model after rewrite (if any)
 * @param {number} [entry.statusCode] - HTTP response status code
 * @param {string} entry.path - Request path (e.g., /v1/messages)
 */
export function logRequest(entry) {
  const id = ++totalRequests;
  const record = {
    id,
    timestamp: new Date().toISOString(),
    ...entry,
    statusCode: entry.statusCode || null
  };

  logBuffer.push(record);

  // Trim to max size (circular buffer)
  if (logBuffer.length > MAX_LOG_ENTRIES) {
    logBuffer.shift();
  }

  return id;
}

/**
 * Updates the status code of the most recent log entry matching the given ID.
 * Called asynchronously when the upstream response arrives.
 * @param {number} requestId - The request ID to update
 * @param {number} statusCode - The HTTP status code
 */
export function updateRequestStatus(requestId, statusCode) {
  const entry = logBuffer.find(e => e.id === requestId);
  if (entry) {
    entry.statusCode = statusCode;
  }
}

/**
 * Returns all log entries currently in the buffer.
 * @returns {Array<Object>}
 */
export function getLogs() {
  return [...logBuffer];
}

/**
 * Returns server status info.
 * @returns {Object}
 */
export function getStatus() {
  return {
    totalRequests,
    uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
    startedAt: new Date(startTime).toISOString(),
    logBufferSize: logBuffer.length
  };
}
