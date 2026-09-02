/**
 * Which key the proxy sends, and what an upstream verdict does to it.
 *
 * The rule that shapes all of this: marking a key exhausted must not change the
 * key in use. Rotation is a decision, taken by the user in manual mode, and a
 * classifier that gets it wrong should cost nothing at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-proxy-rotate-'));
process.env.AI_PROXY_HOME = home;
process.env.AI_PROXY_QUIET = '1';

const { selectKey, nextKeyId, applyKeyVerdict, deriveKeyId } = await import('../src/core/keyStore.js');
const { normalizeConfig } = await import('../src/core/configManager.js');

const A = 'sk-fake000000000000000000000000000000000000000a';
const B = 'sk-fake000000000000000000000000000000000000000b';
const C = 'sk-fake000000000000000000000000000000000000000c';
const id = deriveKeyId;

/** A pool of three keys with the given statuses. */
function pool(...statuses) {
  return normalizeConfig({
    providers: {
      gorouter: {
        url: 'https://gorouter.app/v1',
        keys: [A, B, C].map((key, i) => ({ key, status: statuses[i] || 'unknown', label: `acct-${i}` }))
      }
    }
  }).providers.gorouter.keys;
}

test('an explicit selection is used even after the key is marked exhausted', () => {
  // Manual rotation: the user is told, and until they act nothing moves. This
  // also means a wrong verdict cannot take a working key out of service.
  const keys = pool('exhausted', 'active', 'active');
  assert.equal(selectKey(keys, id(A)).key, A);
  assert.equal(selectKey(keys).key, B, 'with no selection the pool order decides');
});

test('a revoked key is never sent, however it was selected', () => {
  const keys = pool('invalid', 'active', 'active');
  assert.equal(selectKey(keys, id(A)).key, B);
  assert.equal(selectKey(pool('disabled', 'active', 'active'), id(A)).key, B);
});

test('a selection naming a key that is gone falls back to the pool order', () => {
  const keys = pool('active', 'active', 'active');
  assert.equal(selectKey(keys, 'deadbeef1234').key, A);
});

test('the selected key survives normalization and drives the apiKey mirror', () => {
  const provider = normalizeConfig({
    providers: {
      gorouter: {
        url: 'https://gorouter.app/v1',
        selectedKeyId: id(C),
        keys: [{ key: A, status: 'active' }, { key: B }, { key: C, status: 'exhausted' }]
      }
    }
  }).providers.gorouter;

  assert.equal(provider.selectedKeyId, id(C));
  assert.equal(provider.apiKey, C, 'the mirror must follow the selection, not the status order');
});

test('a selection that names no key in the pool is dropped rather than kept dangling', () => {
  const provider = normalizeConfig({
    providers: { gorouter: { url: 'https://gorouter.app/v1', selectedKeyId: 'nosuchkey123', keys: [{ key: A }] } }
  }).providers.gorouter;

  assert.equal(provider.selectedKeyId, '');
  assert.equal(provider.apiKey, A);
});

test('nextKeyId walks forward past everything unusable and stops at the end', () => {
  assert.equal(nextKeyId(pool('exhausted', 'invalid', 'unknown'), id(A)), id(C));
  assert.equal(nextKeyId(pool('active', 'exhausted', 'invalid'), id(A)), null);
  assert.equal(nextKeyId(pool('active', 'active', 'active'), null), id(A), 'no current key means start at the top');
});

// --- applying a verdict ------------------------------------------------------

const config = () => normalizeConfig({
  providers: {
    gorouter: {
      url: 'https://gorouter.app/v1',
      keys: [{ key: A, status: 'active', label: 'first@example.com' }, { key: B, status: 'unknown' }]
    }
  }
});

const exhaustion = {
  kind: 'exhausted', tier: 'A', remaining: 0.710336, needed: 0.8,
  matched: '/预扣费额度失败/', status: 403
};

test('a confident exhaustion marks the key and records the balance it reported', () => {
  const { config: next, changed, entry } = applyKeyVerdict(config(), 'gorouter', id(A), exhaustion);
  const key = next.providers.gorouter.keys[0];

  assert.equal(changed, true);
  assert.equal(key.status, 'exhausted');
  assert.equal(key.remaining, 0.710336);
  assert.equal(key.needed, 0.8);
  assert.match(key.lastError, /预扣费额度失败|403/);
  assert.equal(entry.id, id(A));
  assert.equal(next.providers.gorouter.selectedKeyId, id(A), 'the key in use does not move on its own');
  assert.equal(next.providers.gorouter.apiKey, A);
});

test('a revoked key is marked invalid, which is not the same as out of credit', () => {
  const { config: next } = applyKeyVerdict(config(), 'gorouter', id(A), { kind: 'invalid-key', status: 401 });
  assert.equal(next.providers.gorouter.keys[0].status, 'invalid');
});

test('a transient failure records the error but leaves the key active', () => {
  const { config: next, changed } = applyKeyVerdict(config(), 'gorouter', id(A),
    { kind: 'transient', status: 403, matched: '/cloudflare/i' });

  assert.equal(next.providers.gorouter.keys[0].status, 'active');
  assert.match(next.providers.gorouter.keys[0].lastError, /cloudflare/);
  assert.equal(changed, false, 'no status change means nothing to alert about');
});

test('a rate limit never touches the key', () => {
  const { config: next } = applyKeyVerdict(config(), 'gorouter', id(A), { kind: 'rate-limited', status: 429 });
  assert.equal(next.providers.gorouter.keys[0].status, 'active');
});

test('applying a verdict does not mutate the config it was given', () => {
  const before = config();
  const snapshot = JSON.stringify(before);
  applyKeyVerdict(before, 'gorouter', id(A), exhaustion);
  assert.equal(JSON.stringify(before), snapshot);
});

test('a verdict for a key or provider that is gone is a no-op, not a crash', () => {
  assert.equal(applyKeyVerdict(config(), 'gorouter', 'nosuchkey123', exhaustion).changed, false);
  assert.equal(applyKeyVerdict(config(), 'nosuch', id(A), exhaustion).changed, false);
  assert.equal(applyKeyVerdict(config(), 'gorouter', id(A), null).changed, false);
});
