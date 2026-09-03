/**
 * Turning a rejected upstream response into a marked key.
 *
 * This is the piece that runs on the live request path, so two properties
 * matter more than any feature: it must not write the config for anything that
 * is not a real key verdict (a WAF page and a rate limit are not), and it must
 * never take a working key out of service on its own — the key that failed
 * stays selected until the user switches, so a wrong verdict costs nothing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-proxy-monitor-'));
process.env.AI_PROXY_HOME = home;
process.env.AI_PROXY_QUIET = '1';

const { saveConfig, loadConfig, clearConfigCache, CONFIG_FILE } = await import('../src/core/configManager.js');
const { KEY_VAULT } = await import('../src/core/paths.js');
const { readKeyVault, deriveKeyId } = await import('../src/core/keyStore.js');
const {
  noteUpstreamFailure, noteKeyUsed, keyAlerts, dismissKeyAlert, tierBHits, resetKeyMonitor
} = await import('../src/core/keyMonitor.js');

const KEY_A = 'sk-fake000000000000000000000000000000000000000a';
const KEY_B = 'sk-fake000000000000000000000000000000000000000b';
const ID_A = deriveKeyId(KEY_A);
const ID_B = deriveKeyId(KEY_B);

/** Verbatim from gorouter, 2026-09-02. Fullwidth dollar signs included. */
const EXHAUSTED = '预扣费额度失败, 用户剩余额度: ＄0.710336, 需要预扣费额度: ＄0.800000';
const WAF = '<html><head><title>403 Forbidden</title></head><body>cloudflare</body></html>';

/** A two-key pool, the first one in use. */
function seed() {
  clearConfigCache();
  resetKeyMonitor();
  fs.rmSync(KEY_VAULT, { force: true });
  return saveConfig({
    providers: {
      gorouter: {
        url: 'https://gorouter.app/v1',
        keys: [
          { key: KEY_A, status: 'active', label: 'a@example.com' },
          { key: KEY_B, status: 'unknown', label: 'b@example.com' }
        ]
      }
    }
  });
}

const fresh = () => loadConfig({ fresh: true }).providers.gorouter;
const vaultFor = id => readKeyVault().filter(record => record.id === id);

test('the confirmed 403 marks the key exhausted and keeps the reported balance', () => {
  seed();
  const result = noteUpstreamFailure({ provider: 'gorouter', keyId: ID_A, statusCode: 403, body: EXHAUSTED });

  assert.equal(result.changed, true);
  assert.equal(result.status, 'exhausted');
  assert.equal(result.verdict.tier, 'A');

  const entry = fresh().keys[0];
  assert.equal(entry.status, 'exhausted');
  assert.equal(entry.remaining, 0.710336);
  assert.equal(entry.needed, 0.8);
});

test('the key that failed stays in use until the user switches', () => {
  seed();
  noteUpstreamFailure({ provider: 'gorouter', keyId: ID_A, statusCode: 403, body: EXHAUSTED });

  const provider = fresh();
  assert.equal(provider.selectedKeyId, ID_A, 'marking a key must not rotate by itself');
  assert.equal(provider.apiKey, KEY_A, 'the proxy keeps sending the same key in manual mode');
});

test('a 403 with no balance phrase does not touch the config at all', () => {
  seed();
  const before = fs.readFileSync(CONFIG_FILE, 'utf8');
  const result = noteUpstreamFailure({ provider: 'gorouter', keyId: ID_A, statusCode: 403, body: WAF });

  assert.equal(result.changed, false);
  assert.equal(result.verdict.kind, 'transient');
  assert.equal(fs.readFileSync(CONFIG_FILE, 'utf8'), before, 'a WAF page is not news about the key');
  assert.equal(fresh().keys[0].status, 'active');
});

test('a rate limit is never a key verdict', () => {
  seed();
  const before = fs.readFileSync(CONFIG_FILE, 'utf8');
  const result = noteUpstreamFailure({ provider: 'gorouter', keyId: ID_A, statusCode: 429, body: 'rate limit exceeded' });

  assert.equal(result.verdict.kind, 'rate-limited');
  assert.equal(result.changed, false);
  assert.equal(fs.readFileSync(CONFIG_FILE, 'utf8'), before);
});

test('a revoked key is marked invalid and the selection moves on', () => {
  seed();
  const result = noteUpstreamFailure({ provider: 'gorouter', keyId: ID_A, statusCode: 401, body: '令牌无效' });

  assert.equal(result.status, 'invalid');
  const provider = fresh();
  assert.equal(provider.keys[0].status, 'invalid');
  assert.equal(provider.apiKey, KEY_B, 'a revoked key can never work again, so it is not pinned');
});

test('the vault line says why the key was marked', () => {
  seed();
  noteUpstreamFailure({ provider: 'gorouter', keyId: ID_A, statusCode: 403, body: EXHAUSTED });

  const lines = vaultFor(ID_A);
  const last = lines[lines.length - 1];
  assert.equal(last.event, 'exhausted');
  assert.equal(last.status, 'exhausted');
  assert.equal(last.key, KEY_A, 'the vault holds the key itself, so it survives a lost config');
});

test('the same verdict twice writes one alert and one vault line', () => {
  seed();
  noteUpstreamFailure({ provider: 'gorouter', keyId: ID_A, statusCode: 403, body: EXHAUSTED });
  const before = fs.readFileSync(CONFIG_FILE, 'utf8');
  const second = noteUpstreamFailure({ provider: 'gorouter', keyId: ID_A, statusCode: 403, body: EXHAUSTED });

  assert.equal(second.changed, false, 'already exhausted is not a change');
  assert.equal(fs.readFileSync(CONFIG_FILE, 'utf8'), before, 'no write once the status is already right');
  assert.equal(keyAlerts().length, 1);
  assert.equal(vaultFor(ID_A).filter(r => r.event === 'exhausted').length, 1);
});

test('the alert carries what the user needs to decide', () => {
  seed();
  noteUpstreamFailure({ provider: 'gorouter', keyId: ID_A, statusCode: 403, body: EXHAUSTED });

  const [alert] = keyAlerts();
  assert.equal(alert.provider, 'gorouter');
  assert.equal(alert.keyId, ID_A);
  assert.equal(alert.label, 'a@example.com');
  assert.equal(alert.status, 'exhausted');
  assert.equal(alert.remaining, 0.710336);
  assert.equal(alert.needed, 0.8);
  assert.match(alert.matched, /预扣费额度失败/);
  assert.ok(alert.at, 'timestamped, so the banner can be ordered');
  assert.ok(!JSON.stringify(alert).includes(KEY_A), 'an alert reaches the browser: it never carries the key');
});

test('an unlabelled key is still nameable in the banner', () => {
  // Imported keys carry an account label; a key added by hand has none, and an
  // id like "9f2c1a04" tells the user nothing about which account to top up.
  clearConfigCache();
  resetKeyMonitor();
  saveConfig({
    providers: { gorouter: { url: 'https://gorouter.app/v1', keys: [{ key: KEY_B, status: 'active' }] } }
  });
  noteUpstreamFailure({ provider: 'gorouter', keyId: ID_B, statusCode: 403, body: EXHAUSTED });

  const alert = keyAlerts().find(entry => entry.keyId === ID_B);
  assert.equal(alert.label, '', 'this key has no label, which is the point');
  assert.equal(alert.masked, 'sk-fa…000b');
  assert.ok(!JSON.stringify(alert).includes(KEY_B), 'masking is not the key');
});

test('an alert can be dismissed', () => {
  seed();
  noteUpstreamFailure({ provider: 'gorouter', keyId: ID_A, statusCode: 403, body: EXHAUSTED });
  assert.equal(dismissKeyAlert('gorouter', ID_A), true);
  assert.deepEqual(keyAlerts(), []);
  assert.equal(dismissKeyAlert('gorouter', ID_A), false);
});

test('a key that is not in the pool is reported, not invented', () => {
  seed();
  const before = fs.readFileSync(CONFIG_FILE, 'utf8');
  const result = noteUpstreamFailure({ provider: 'gorouter', keyId: 'nosuchkey', statusCode: 403, body: EXHAUSTED });

  assert.equal(result.changed, false);
  assert.equal(result.verdict.kind, 'exhausted', 'the classifier still reports what it saw');
  assert.equal(fs.readFileSync(CONFIG_FILE, 'utf8'), before);
  assert.deepEqual(keyAlerts(), []);
});

test('an inline client key, which is not in any pool, is classified and nothing more', () => {
  seed();
  const result = noteUpstreamFailure({ provider: 'gorouter', keyId: null, statusCode: 403, body: EXHAUSTED });
  assert.equal(result.changed, false);
  assert.equal(result.entry, null);
});

test('a tier B phrase is counted per provider so auto mode can wait for a second sighting', () => {
  seed();
  assert.equal(tierBHits('gorouter'), 0);
  const first = noteUpstreamFailure({ provider: 'gorouter', keyId: ID_A, statusCode: 403, body: 'insufficient quota' });

  assert.equal(first.verdict.tier, 'B');
  assert.equal(first.priorTierBHits, 0, 'the count as it was when this verdict arrived');
  assert.equal(tierBHits('gorouter'), 1);
  assert.equal(tierBHits('tabitoken'), 0, 'each provider words it differently, so each is counted alone');

  const second = noteUpstreamFailure({ provider: 'gorouter', keyId: ID_B, statusCode: 403, body: 'insufficient quota' });
  assert.equal(second.priorTierBHits, 1);
});

// --- usage, which must cost nothing on the happy path ------------------------

test('serving a request does not write the config', () => {
  seed();
  const before = fs.readFileSync(CONFIG_FILE, 'utf8');
  for (let i = 0; i < 50; i++) noteKeyUsed('gorouter', ID_A);
  assert.equal(fs.readFileSync(CONFIG_FILE, 'utf8'), before, 'per-request config writes would churn the backups');
});

test('counted usage is folded in the next time the key is written anyway', () => {
  seed();
  noteKeyUsed('gorouter', ID_A);
  noteKeyUsed('gorouter', ID_A);
  noteKeyUsed('gorouter', ID_B);
  noteUpstreamFailure({ provider: 'gorouter', keyId: ID_A, statusCode: 403, body: EXHAUSTED });

  const keys = fresh().keys;
  assert.equal(keys[0].requestsServed, 2);
  assert.ok(keys[0].lastUsedAt, 'so the dashboard can say when it was last used');
  assert.equal(keys[1].requestsServed, 1, 'the other key in the pool is folded in on the same write');
});

test('folding usage in twice does not double-count', () => {
  seed();
  noteKeyUsed('gorouter', ID_A);
  noteUpstreamFailure({ provider: 'gorouter', keyId: ID_A, statusCode: 403, body: EXHAUSTED });
  noteUpstreamFailure({ provider: 'gorouter', keyId: ID_B, statusCode: 401, body: '令牌无效' });

  assert.equal(fresh().keys[0].requestsServed, 1);
});

// --- auto mode, per provider -------------------------------------------------
//
// Opt-in, because it acts without asking. Two rules keep it from being a way to
// lose a pool: only a verdict the classifier is confident about may move the
// selection, and a key that is merely rejected — a WAF page, a 401 the relay is
// having a bad day about — never may.

/** The same two-key pool, with the provider switched to auto rotation. */
function seedAuto(keys) {
  clearConfigCache();
  resetKeyMonitor();
  fs.rmSync(KEY_VAULT, { force: true });
  return saveConfig({
    providers: {
      gorouter: {
        url: 'https://gorouter.app/v1',
        keyRotation: 'auto',
        keys: keys || [
          { key: KEY_A, status: 'active', label: 'a@example.com' },
          { key: KEY_B, status: 'unknown', label: 'b@example.com' }
        ]
      }
    }
  });
}

test('an auto provider switches to the next account by itself', () => {
  seedAuto();
  const result = noteUpstreamFailure({ provider: 'gorouter', keyId: ID_A, statusCode: 403, body: EXHAUSTED });

  assert.equal(result.status, 'exhausted');
  assert.deepEqual(result.rotated, { fromKeyId: ID_A, toKeyId: ID_B, toLabel: 'b@example.com' });

  const provider = fresh();
  assert.equal(provider.selectedKeyId, ID_B);
  assert.equal(provider.apiKey, KEY_B, 'the next request goes out on the next account');
});

test('a manual provider reports no rotation, whatever the verdict', () => {
  seed();
  const result = noteUpstreamFailure({ provider: 'gorouter', keyId: ID_A, statusCode: 403, body: EXHAUSTED });

  assert.equal(result.rotated, null);
  assert.equal(fresh().selectedKeyId, ID_A);
});

test('auto mode waits for a second sighting of a phrase this relay has never used', () => {
  // Tier B wording is plausible but unconfirmed on these relays. The first
  // sighting marks the key, which is reversible; moving the pool on the word of
  // a phrase that has never been proven here is not what it is allowed to do.
  seedAuto();
  const first = noteUpstreamFailure({ provider: 'gorouter', keyId: ID_A, statusCode: 403, body: 'insufficient quota' });

  assert.equal(first.verdict.tier, 'B');
  assert.equal(first.rotated, null);
  assert.equal(fresh().apiKey, KEY_A, 'still pinned, exactly as manual mode would leave it');

  // Second sighting, same provider: now the phrase is this relay's own wording.
  const second = noteUpstreamFailure({ provider: 'gorouter', keyId: ID_A, statusCode: 403, body: 'insufficient quota' });
  assert.equal(second.priorTierBHits, 1);
  assert.deepEqual(second.rotated, { fromKeyId: ID_A, toKeyId: ID_B, toLabel: 'b@example.com' });
  assert.equal(fresh().apiKey, KEY_B);
});

test('a revoked key is marked but never rotated over, however the provider is set', () => {
  // A relay having a bad 401 day would otherwise mark every account in the pool
  // invalid, one per request, inside a minute of traffic. The selection still
  // moves — a revoked key is never sent — but that is selectKey() skipping it,
  // not a replay walking the pool.
  seedAuto();
  const result = noteUpstreamFailure({ provider: 'gorouter', keyId: ID_A, statusCode: 401, body: '令牌无效' });

  assert.equal(result.status, 'invalid');
  assert.equal(result.rotated, null);
  assert.equal(fresh().apiKey, KEY_B);
});

test('auto mode with nothing left to switch to keeps the last key in use', () => {
  seedAuto([{ key: KEY_A, status: 'active', label: 'only@example.com' }]);
  const result = noteUpstreamFailure({ provider: 'gorouter', keyId: ID_A, statusCode: 403, body: EXHAUSTED });

  assert.equal(result.rotated, null, 'nowhere to go: the user has to top this account up');
  assert.equal(fresh().apiKey, KEY_A);
  assert.equal(keyAlerts().length, 1, 'and the alert is the only thing that can help');
});

test('an automatic switch is still reported, and keeps being reported until dismissed', () => {
  // In manual mode the alert is a request, so it clears itself once the user has
  // switched. In auto mode it is news about something already done: pruning it
  // against the selection would delete it before anyone had seen it.
  seedAuto();
  noteUpstreamFailure({ provider: 'gorouter', keyId: ID_A, statusCode: 403, body: EXHAUSTED });

  const [alert] = keyAlerts();
  assert.equal(alert.keyId, ID_A);
  assert.equal(alert.status, 'exhausted');
  assert.equal(alert.switchedTo, 'b@example.com', 'the banner says which account is serving now');
  assert.ok(!JSON.stringify(alert).includes(KEY_B), 'the account that took over is named, not revealed');

  assert.deepEqual(keyAlerts().map(entry => entry.keyId), [ID_A], 'the pool moved on: that is the news, not the answer');
  assert.equal(dismissKeyAlert('gorouter', ID_A), true);
  assert.deepEqual(keyAlerts(), []);
});

test('a manual alert still clears itself when the user switches in the CLI', () => {
  // The other half of that rule, which must not regress: a request that has been
  // answered elsewhere stops being shown.
  seed();
  noteUpstreamFailure({ provider: 'gorouter', keyId: ID_A, statusCode: 403, body: EXHAUSTED });
  assert.equal(keyAlerts().length, 1);

  clearConfigCache();
  saveConfig({ ...loadConfig(), providers: { gorouter: { ...fresh(), selectedKeyId: ID_B } } });
  assert.deepEqual(keyAlerts(), [], 'switched by hand, so the alert has been dealt with');
});

test('a switch on its own appends no vault line, because nothing about the key changed', () => {
  // The vault records what a key *is*, so it can be recovered: which one is
  // selected is not a fact about the key, and a line per rotation would bury the
  // ones that matter.
  seedAuto();
  noteUpstreamFailure({ provider: 'gorouter', keyId: ID_A, statusCode: 403, body: 'insufficient quota' });
  const before = vaultFor(ID_A).length;

  const second = noteUpstreamFailure({ provider: 'gorouter', keyId: ID_A, statusCode: 403, body: 'insufficient quota' });
  assert.ok(second.rotated, 'this is the sighting that moves the pool');
  assert.equal(vaultFor(ID_A).length, before);
});
