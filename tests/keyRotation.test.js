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

// --- auto mode: the same verdict, this time allowed to move the selection -----
//
// Auto is per provider and opt-in. Whether to rotate is the caller's decision —
// the monitor takes it from the provider's mode and the classifier's confidence
// — so this layer only has to be honest about what rotating means: the spent key
// is left behind instead of pinned, and when there is nothing to move to, the
// pinning behaviour is what remains.

test('keyRotation is manual unless the provider asked for auto', () => {
  const providers = normalizeConfig({
    providers: {
      one: { url: 'https://one.example/v1', keys: [{ key: A }] },
      two: { url: 'https://two.example/v1', keys: [{ key: B }], keyRotation: 'auto' },
      three: { url: 'https://three.example/v1', keys: [{ key: C }], keyRotation: 'whenever' }
    }
  }).providers;

  assert.equal(providers.one.keyRotation, 'manual');
  assert.equal(providers.two.keyRotation, 'auto', 'the mode must survive a save, or it is off again on the next write');
  assert.equal(providers.three.keyRotation, 'manual', 'an unreadable mode falls back to the cautious one');
});

test('rotating hands the selection to the next key instead of pinning the spent one', () => {
  const { config: next, rotatedTo } = applyKeyVerdict(config(), 'gorouter', id(A), exhaustion, { rotate: true });
  const provider = next.providers.gorouter;

  assert.equal(provider.keys[0].status, 'exhausted');
  assert.equal(rotatedTo, id(B));
  assert.equal(provider.selectedKeyId, id(B));
  assert.equal(provider.apiKey, B, 'the mirror is what the next request goes out on');
});

test('rotating with nothing left to switch to keeps the spent key pinned', () => {
  // The last account in the pool. Pinning is what manual mode does, and it is
  // right here too: this is the account the user may top up.
  const only = normalizeConfig({
    providers: { gorouter: { url: 'https://gorouter.app/v1', keys: [{ key: A, status: 'active' }] } }
  });
  const { config: next, rotatedTo } = applyKeyVerdict(only, 'gorouter', id(A), exhaustion, { rotate: true });

  assert.equal(rotatedTo, null);
  assert.equal(next.providers.gorouter.selectedKeyId, id(A));
  assert.equal(next.providers.gorouter.apiKey, A);
});

test('a key already marked spent is still handed over, because it is still the one in use', () => {
  // How the first sighting of an unconfirmed phrase resolves: it pinned the key,
  // and the second sighting is the one that gets to move the pool on. Without
  // this the pin would outlast the reason for it.
  const pinned = normalizeConfig({
    providers: {
      gorouter: {
        url: 'https://gorouter.app/v1',
        selectedKeyId: id(A),
        keys: [{ key: A, status: 'exhausted' }, { key: B, status: 'unknown' }]
      }
    }
  });
  const { config: next, changed, rotatedTo } = applyKeyVerdict(pinned, 'gorouter', id(A), exhaustion, { rotate: true });

  assert.equal(changed, false, 'the status was already right');
  assert.equal(rotatedTo, id(B));
  assert.equal(next.providers.gorouter.apiKey, B);
});

test('a rotation is only reported when the selection actually moved', () => {
  // Two requests in flight on the same spent key: the first moves the pool, and
  // the second must not report a move it did not make, or the proxy would write
  // the config once per request for as long as the client keeps trying.
  const moved = normalizeConfig({
    providers: {
      gorouter: {
        url: 'https://gorouter.app/v1',
        selectedKeyId: id(B),
        keys: [{ key: A, status: 'exhausted' }, { key: B, status: 'active' }]
      }
    }
  });
  const { changed, rotatedTo } = applyKeyVerdict(moved, 'gorouter', id(A), exhaustion, { rotate: true });

  assert.equal(rotatedTo, null);
  assert.equal(changed, false, 'nothing to write and nothing to say');
});

test('a rotation asked for on a verdict about something else moves nothing', () => {
  // Auto mode with a Cloudflare page in front of the relay: not the key's fault,
  // so not the key's turn to be replaced.
  const { config: next, rotatedTo } = applyKeyVerdict(config(), 'gorouter', id(A),
    { kind: 'transient', status: 403, matched: '/cloudflare/i' }, { rotate: true });

  assert.equal(rotatedTo, null);
  assert.equal(next.providers.gorouter.apiKey, A);
});
