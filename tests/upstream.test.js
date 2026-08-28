/**
 * Upstream target resolution — the part that decides which host, port, scheme
 * and path a request is actually sent to.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProviderUrl, joinUpstreamPath, resolveUpstream, isModelBearingPath } from '../src/core/upstream.js';

test('parseProviderUrl handles schemes, ports and bare hosts', () => {
  const https = parseProviderUrl('https://tabitoken.com/v1');
  assert.equal(https.protocol, 'https:');
  assert.equal(https.port, 443);
  assert.equal(https.basePath, '/v1');
  assert.equal(https.hostHeader, 'tabitoken.com', 'default port is omitted from Host');

  const local = parseProviderUrl('http://127.0.0.1:11434/v1');
  assert.equal(local.protocol, 'http:');
  assert.equal(local.port, 11434);
  assert.equal(local.hostHeader, '127.0.0.1:11434', 'a non-default port must appear in Host');

  const bare = parseProviderUrl('api.example.com/v1');
  assert.equal(bare.protocol, 'https:', 'a missing scheme defaults to https');

  const trailing = parseProviderUrl('https://api.example.com/v1/');
  assert.equal(trailing.basePath, '/v1', 'trailing slashes are trimmed');
});

test('parseProviderUrl rejects unusable URLs', () => {
  assert.throws(() => parseProviderUrl(''), /empty/i);
  assert.throws(() => parseProviderUrl('ftp://example.com'), /Unsupported protocol/);
  assert.throws(() => parseProviderUrl('https://'), /not a valid URL|no host/);

  // A schemeless single label is almost always a typo, not a host.
  assert.throws(() => parseProviderUrl('nope'), /not a valid base URL/);
  assert.throws(() => parseProviderUrl('tabitoken'), /not a valid base URL/);

  // …but these schemeless forms are legitimate.
  assert.equal(parseProviderUrl('localhost:11434/v1').port, 11434);
  assert.equal(parseProviderUrl('api.example.com/v1').hostname, 'api.example.com');
  // An explicit scheme means the user meant it, even for an intranet host.
  assert.equal(parseProviderUrl('http://gateway/v1').hostname, 'gateway');
});

test('joinUpstreamPath never duplicates the API version segment', () => {
  // The common case, and the one the previous implementation relied on.
  assert.equal(joinUpstreamPath('/v1', '/v1/messages'), '/v1/messages');
  // Path-prefixed gateways: previously the prefix was silently dropped.
  assert.equal(joinUpstreamPath('/openai/v1', '/v1/messages'), '/openai/v1/messages');
  assert.equal(joinUpstreamPath('/v1', '/messages'), '/v1/messages');
  assert.equal(joinUpstreamPath('', '/v1/messages'), '/v1/messages');
  assert.equal(joinUpstreamPath('/api', '/v1/messages'), '/api/v1/messages');
  assert.equal(joinUpstreamPath('/v1beta', '/v1/models'), '/v1beta/models');
  assert.equal(joinUpstreamPath('/v1', '/v1/messages?beta=true'), '/v1/messages?beta=true');
});

test('resolveUpstream produces complete request options', () => {
  const target = resolveUpstream('http://localhost:1234/openai/v1', '/v1/chat/completions?x=1');
  assert.deepEqual(
    {
      protocol: target.protocol, hostname: target.hostname, port: target.port,
      path: target.path, isTls: target.isTls, hostHeader: target.hostHeader
    },
    {
      protocol: 'http:', hostname: 'localhost', port: 1234,
      path: '/openai/v1/chat/completions?x=1', isTls: false, hostHeader: 'localhost:1234'
    }
  );
});

test('isModelBearingPath covers both API dialects', () => {
  for (const good of ['/v1/messages', '/v1/chat/completions', '/openai/v1/completions',
    '/v1/responses', '/v1/messages/count_tokens', '/v1/messages/']) {
    assert.equal(isModelBearingPath(good), true, `${good} should be rewritten`);
  }
  for (const bad of ['/v1/models', '/health', '/v1/messages/batches/abc']) {
    assert.equal(isModelBearingPath(bad), false, `${bad} should stream through`);
  }
});
