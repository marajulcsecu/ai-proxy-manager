/**
 * Request history: ring buffer, metrics and on-disk persistence.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-proxy-logger-'));
process.env.AI_PROXY_HOME = home;

const logger = await import('../src/core/requestLogger.js');
const REQUEST_LOG = path.join(home, 'requests.jsonl');

beforeEach(() => {
  logger.resetLogger();
  logger.configureLogger({ logBufferSize: 5, persistLogs: true, captureBodies: true });
});

test('the buffer is a ring: oldest entries drop out', () => {
  for (let index = 0; index < 8; index++) {
    const id = logger.startRequest({ method: 'POST', path: `/v1/${index}`, provider: 'p' });
    logger.finishRequest(id, { statusCode: 200, bytesOut: 10 });
  }

  const logs = logger.getLogs();
  assert.equal(logs.length, 5, 'the configured cap is respected');
  assert.deepEqual(logs.map(log => log.id), [4, 5, 6, 7, 8]);
  assert.equal(logger.getStatus().totalRequests, 8, 'the counter keeps the true total');
});

test('an in-flight request has no status until it finishes', () => {
  const id = logger.startRequest({ method: 'POST', path: '/v1/messages', provider: 'p' });
  assert.equal(logger.getLogs().at(-1).statusCode, null);
  assert.equal(logger.getLogs().at(-1).durationMs, null);

  logger.markFirstByte(id);
  logger.finishRequest(id, { statusCode: 200, bytesOut: 5 });

  const entry = logger.getLogs().at(-1);
  assert.equal(entry.statusCode, 200);
  assert.ok(entry.durationMs !== null && entry.ttfbMs !== null);
});

test('metrics report percentiles and an error rate over settled requests', () => {
  for (const status of [200, 200, 200, 500]) {
    const id = logger.startRequest({ method: 'POST', path: '/v1/messages', provider: 'p' });
    logger.finishRequest(id, { statusCode: status });
  }
  logger.startRequest({ method: 'POST', path: '/v1/messages', provider: 'p' }); // still in flight

  const status = logger.getStatus();
  assert.equal(status.errorCount, 1);
  assert.equal(status.errorRate, 0.25, 'the in-flight request is excluded');
  assert.ok(status.p50Ms !== null && status.p95Ms !== null);
  assert.equal(status.byProvider.p.requests, 5);
  assert.equal(status.byProvider.p.errors, 1);
});

test('filters narrow the history by provider and outcome', () => {
  const first = logger.startRequest({ method: 'POST', path: '/a', provider: 'alpha' });
  logger.finishRequest(first, { statusCode: 200 });
  const second = logger.startRequest({ method: 'POST', path: '/b', provider: 'beta' });
  logger.finishRequest(second, { statusCode: 503, error: 'upstream down' });
  logger.startRequest({ method: 'POST', path: '/c', provider: 'alpha' });

  assert.equal(logger.getLogs({ provider: 'alpha' }).length, 2);
  assert.equal(logger.getLogs({ status: 'error' }).length, 1);
  assert.equal(logger.getLogs({ status: 'pending' }).length, 1);
  assert.equal(logger.getLogs({ status: 'ok' }).length, 1);
  assert.equal(logger.getLogs({ limit: 1 })[0].path, '/c', 'limit keeps the newest');
});

test('bodies are inspectable in memory but never written to disk', () => {
  const id = logger.startRequest({ method: 'POST', path: '/v1/messages', provider: 'p' });
  logger.attachBody(id, 'request', JSON.stringify({ messages: [{ content: 'a private prompt' }] }));
  logger.attachBody(id, 'response', 'x'.repeat(9000));
  logger.finishRequest(id, { statusCode: 200 });

  const detail = logger.getLogById(id);
  assert.match(detail.bodies.request, /a private prompt/);
  assert.equal(detail.bodies.response.length, 4000, 'previews are capped');
  assert.equal(detail.bodies.truncated, true);

  const persisted = fs.readFileSync(REQUEST_LOG, 'utf8');
  assert.ok(!persisted.includes('a private prompt'), 'prompt text must stay out of the log file');
  assert.match(persisted, /"statusCode":200/);
});

test('history is restored from disk after a restart', () => {
  const id = logger.startRequest({ method: 'POST', path: '/v1/messages', provider: 'p' });
  logger.finishRequest(id, { statusCode: 201 });

  logger.resetLogger();
  assert.equal(logger.getLogs().length, 0);

  // Simulate a fresh process reading the JSONL mirror.
  fs.appendFileSync(REQUEST_LOG, `${JSON.stringify({ id: 99, method: 'GET', path: '/v1/models', statusCode: 200 })}\n`);
  fs.appendFileSync(REQUEST_LOG, 'this line is corrupt\n');

  const restored = logger.restorePersistedLogs();
  assert.ok(restored >= 1, 'valid lines are restored');
  assert.ok(logger.getLogs().every(log => log.historical), 'restored rows are marked historical');
  assert.equal(logger.getStatus().p50Ms, null, 'restored rows do not pollute live latency metrics');
});

test('clearLogs empties memory and truncates the file', () => {
  const id = logger.startRequest({ method: 'POST', path: '/v1/messages', provider: 'p' });
  logger.finishRequest(id, { statusCode: 200 });

  logger.clearLogs();
  assert.equal(logger.getLogs().length, 0);
  assert.equal(fs.readFileSync(REQUEST_LOG, 'utf8'), '');
});
