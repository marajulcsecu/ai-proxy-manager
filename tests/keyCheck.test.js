/**
 * `keys check` — putting a verdict and a balance on every key in the pool
 * without spending anything.
 *
 * Two probes, both free. `GET /v1/models` says whether the key is still
 * accepted. A `/v1/messages` request with an absurd `max_tokens` is refused by
 * the relay's pre-authorisation, and the refusal quotes the exact balance — the
 * same message the live path already reads, asked for on purpose this time.
 *
 * The delicate part is that a refusal here is a *measurement*, not a verdict: a
 * $200 key is refused by this probe just as a $0.71 key is. Only the number
 * decides. And if a key is rich enough that the relay accepts the request, the
 * socket is torn down on the first byte, because from that point on it costs
 * real money.
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-proxy-keycheck-'));
process.env.AI_PROXY_HOME = home;
process.env.AI_PROXY_QUIET = '1';

const { saveConfig, loadConfig, clearConfigCache } = await import('../src/core/configManager.js');
const { deriveKeyId, readKeyVault } = await import('../src/core/keyStore.js');
const { probeKey, checkKeys } = await import('../src/core/keyCheck.js');
const { CONFIG_FILE, KEY_VAULT } = await import('../src/core/paths.js');

const RICH = 'sk-fake0000000000000000000000000000000000000rich';
const LOW = 'sk-fake00000000000000000000000000000000000000low';
const ZERO = 'sk-fake0000000000000000000000000000000000000zero';
const DEAD = 'sk-fake0000000000000000000000000000000000000dead';
const BUSY = 'sk-fake0000000000000000000000000000000000000busy';
const WALLED = 'sk-fake000000000000000000000000000000000000walled';
const KNOWN = new Set([RICH, LOW, ZERO, DEAD, BUSY, WALLED]);

/** The pre-authorisation refusal, with the balance the relay quotes. */
const shortOf = remaining => JSON.stringify({
  error: {
    message: `预扣费额度失败, 用户剩余额度: ＄${remaining}, 需要预扣费额度: ＄8000.000000`,
    type: 'one_api_error'
  }
});

let relay;
let relayUrl;

/** Everything the relay was asked, so the tests can prove what was *not* sent. */
let asked = [];
/** Keys whose stream the prober tore down before the relay had finished. */
let aborted = [];
/** Highest number of requests the relay was serving at the same time. */
let peak = 0;
let inFlight = 0;
/** When true, /v1/models answers 200 whatever key it is given. */
let modelsIgnoresKey = false;

before(async () => {
  relay = http.createServer((req, res) => {
    const key = String(req.headers['x-api-key'] || req.headers.authorization || '').replace(/^Bearer /, '');
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    res.on('close', () => { inFlight -= 1; });

    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      asked.push({ method: req.method, url: req.url, key, body });
      const send = (status, payload, type = 'application/json') => {
        res.writeHead(status, { 'content-type': type });
        res.end(payload);
      };

      if (req.method === 'GET') {
        if (modelsIgnoresKey) return send(200, JSON.stringify({ data: [{ id: 'claude-opus-5' }] }));
        if (key === DEAD) return send(401, JSON.stringify({ error: { message: '令牌无效' } }));
        if (key === BUSY) return send(429, JSON.stringify({ error: { message: 'rate limit' } }));
        if (key === WALLED) return send(403, '<html><body>cloudflare Attention Required</body></html>', 'text/html');
        // A relay worth trusting rejects a key it has never issued — which is
        // what makes the control probe meaningful.
        if (!KNOWN.has(key)) return send(401, JSON.stringify({ error: { message: '令牌无效' } }));
        return send(200, JSON.stringify({ data: [{ id: 'claude-opus-5' }] }));
      }

      // The balance probe.
      if (key === LOW) return send(403, shortOf('0.710336'));
      if (key === ZERO) return send(403, shortOf('0.000000'));
      if (key === BUSY) return send(429, JSON.stringify({ error: { message: 'rate limit' } }));

      // Rich enough that the pre-authorisation passes: the relay starts
      // streaming, and from here on the tokens are billed for real.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      const timer = setTimeout(() => res.end('event: done\ndata: {}\n\n'), 1500);
      res.on('close', () => {
        if (!res.writableEnded) aborted.push(key);
        clearTimeout(timer);
      });
    });
  });
  await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve));
  relayUrl = `http://127.0.0.1:${relay.address().port}/v1`;
});

after(async () => {
  await new Promise(resolve => relay.close(resolve));
  fs.rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  asked = [];
  aborted = [];
  peak = 0;
  inFlight = 0;
  modelsIgnoresKey = false;
});

/** A pool holding every kind of key, in a known order. */
function seed(keys) {
  clearConfigCache();
  const config = saveConfig({
    providers: {
      gorouter: {
        url: relayUrl,
        defaultModel: 'claude-opus-5',
        keys: keys || [
          { key: RICH, status: 'unknown', label: 'rich@example.com' },
          { key: LOW, status: 'unknown', label: 'low@example.com' },
          { key: ZERO, status: 'unknown', label: 'zero@example.com' },
          { key: DEAD, status: 'active', label: 'dead@example.com' }
        ]
      }
    },
    active_provider: 'gorouter'
  });
  // Zeroed after the seed's own write, so the backups and the vault lines the
  // assertions count are the ones `checkKeys` produced.
  for (let n = 1; n <= 5; n++) fs.rmSync(`${CONFIG_FILE}.bak.${n}`, { force: true });
  fs.rmSync(KEY_VAULT, { force: true });
  return config;
}

/**
 * Waits for something the relay observes, which it learns a tick or two after
 * the prober does. Fails loudly rather than silently passing on a timeout.
 * @param {() => boolean} done
 * @param {string} what
 */
async function until(done, what) {
  for (let n = 0; n < 200 && !done(); n++) await new Promise(r => setTimeout(r, 5));
  assert.ok(done(), `timed out waiting for ${what}`);
}

const poolOf = () => loadConfig({ fresh: true }).providers.gorouter.keys;
const entry = key => poolOf().find(item => item.id === deriveKeyId(key));

// --- one key at a time -------------------------------------------------------

test('a key the relay still accepts comes back live, and costs no tokens', async () => {
  const result = await probeKey(relayUrl, RICH, { model: 'claude-opus-5' });

  assert.equal(result.verdict, 'live');
  assert.equal(result.statusCode, 200);
  assert.deepEqual(asked.map(call => call.method), ['GET'], 'liveness alone must not POST anything');
  assert.match(asked[0].url, /\/v1\/models$/);
});

test('a revoked key is told apart from a spent one', async () => {
  const result = await probeKey(relayUrl, DEAD, { model: 'claude-opus-5' });

  assert.equal(result.verdict, 'invalid');
  assert.equal(result.statusCode, 401);
  assert.match(result.message, /令牌无效/);
});

test('a rate-limited key is inconclusive, never a verdict about the key', async () => {
  const result = await probeKey(relayUrl, BUSY, { model: 'claude-opus-5' });
  assert.equal(result.verdict, 'rate-limited');
});

test('a WAF page is inconclusive too', async () => {
  const result = await probeKey(relayUrl, WALLED, { model: 'claude-opus-5' });
  assert.equal(result.verdict, 'blocked');
});

test('the balance probe reads the exact figure out of the refusal', async () => {
  const result = await probeKey(relayUrl, LOW, { model: 'claude-opus-5', balance: true });

  assert.equal(result.verdict, 'spent');
  assert.equal(result.remaining, 0.710336);
  const probe = asked.find(call => call.method === 'POST');
  const sent = JSON.parse(probe.body);
  assert.ok(sent.max_tokens >= 100000, `the estimate has to exceed any plausible balance, got ${sent.max_tokens}`);
  assert.equal(sent.stream, true, 'streaming is what makes the abort able to stop the billing');
});

test('a balance the probe cannot exhaust is reported as funded, and the stream is cut immediately', async () => {
  const result = await probeKey(relayUrl, RICH, { model: 'claude-opus-5', balance: true });

  assert.equal(result.verdict, 'funded');
  assert.equal(result.remaining, null, 'the relay never quoted a number, so none is invented');
  await until(() => aborted.length > 0, 'the relay to see the socket go');
  assert.deepEqual(aborted, [RICH], 'an accepted probe must be torn down on the first byte');
});

test('a probe against an unreachable relay is an error, not a verdict', async () => {
  const result = await probeKey('http://127.0.0.1:1/v1', RICH, { model: 'claude-opus-5', timeoutMs: 2000 });
  assert.equal(result.verdict, 'error');
  assert.ok(result.message, 'the reason has to reach the user');
});

// --- the whole pool ----------------------------------------------------------

test('every key gets a verdict, and the report never carries a key value', async () => {
  seed();
  const report = await checkKeys({ balance: true, concurrency: 2 });

  assert.equal(report.results.length, 4);
  assert.deepEqual(
    report.results.map(r => [r.label, r.verdict]),
    [['rich@example.com', 'funded'], ['low@example.com', 'spent'], ['zero@example.com', 'spent'], ['dead@example.com', 'invalid']]
  );
  assert.equal(report.results[0].masked, 'sk-fa…rich');
  assert.ok(!JSON.stringify(report).includes(RICH), 'a key value must not leave this function');
});

test('what was measured is written to the pool', async () => {
  seed();
  await checkKeys({ balance: true });

  assert.equal(entry(RICH).status, 'active');
  assert.equal(entry(LOW).status, 'exhausted');
  assert.equal(entry(LOW).remaining, 0.710336);
  assert.equal(entry(ZERO).status, 'exhausted');
  assert.equal(entry(DEAD).status, 'invalid');
});

test('a key that has been topped up since it failed is put back in service', async () => {
  seed([
    { key: ZERO, status: 'exhausted', label: 'zero@example.com', remaining: 0 },
    { key: RICH, status: 'exhausted', label: 'rich@example.com', remaining: 0.4 }
  ]);
  const report = await checkKeys({ balance: true });

  assert.equal(entry(RICH).status, 'active', 'it answers again, so the old verdict is stale');
  assert.equal(entry(ZERO).status, 'exhausted', 'still empty, still spent');
  assert.equal(report.revived, 1);
});

test('liveness alone never overrules a spent key: only a balance can', async () => {
  seed([{ key: RICH, status: 'exhausted', label: 'rich@example.com', remaining: 0.2 }]);
  await checkKeys();

  assert.equal(entry(RICH).status, 'exhausted', '/v1/models says nothing about credit');
  assert.equal(entry(RICH).remaining, 0.2, 'and nothing about the balance either');
});

test('a relay that accepts the probe without quoting a figure keeps the balance it was given', async () => {
  // The imported figure is the only one anyone has: a relay rich enough to let
  // the probe through says the key *has* credit, not how much. Overwriting it
  // with nothing would throw away what the spreadsheet knew.
  seed([{ key: RICH, status: 'unknown', label: 'rich@example.com', remaining: 79.39 }]);
  const report = await checkKeys({ balance: true });

  assert.equal(entry(RICH).status, 'active', 'it answered, so it is live');
  assert.equal(entry(RICH).remaining, 79.39, 'nothing was measured, so nothing replaces the known figure');
  assert.equal(report.results[0].remaining, 79.39, 'and the report quotes it rather than a blank');
});

test('an unquotable balance on an unchanged key writes nothing at all', async () => {
  seed([{ key: RICH, status: 'active', label: 'rich@example.com', remaining: 79.39 }]);
  const before = fs.readFileSync(CONFIG_FILE, 'utf8');
  await checkKeys({ balance: true });

  assert.equal(fs.readFileSync(CONFIG_FILE, 'utf8'), before, 'no verdict and no number is nothing learned');
  assert.ok(!fs.existsSync(`${CONFIG_FILE}.bak.1`), 'a pointless save rotates a real backup off the end');
});

test('an untested key that answers is marked active without a balance probe', async () => {
  seed([{ key: RICH, status: 'unknown', label: 'rich@example.com' }]);
  await checkKeys();
  assert.equal(entry(RICH).status, 'active');
});

test('a rate limit and a WAF page leave the pool exactly as it was', async () => {
  seed([
    { key: BUSY, status: 'active', label: 'busy@example.com' },
    { key: WALLED, status: 'active', label: 'walled@example.com' }
  ]);
  const before = fs.readFileSync(CONFIG_FILE, 'utf8');
  const report = await checkKeys({ balance: true });

  assert.equal(fs.readFileSync(CONFIG_FILE, 'utf8'), before, 'nothing was learned, so nothing is written');
  assert.equal(report.changed, 0);
  assert.equal(report.counts.inconclusive, 2);
});

test('a relay that hands out /v1/models to anyone is called out instead of trusted', async () => {
  modelsIgnoresKey = true;
  seed([{ key: DEAD, status: 'unknown', label: 'dead@example.com' }]);
  const report = await checkKeys();

  assert.equal(entry(DEAD).status, 'unknown', 'a 200 that means nothing must not promote a key');
  assert.ok(
    report.notes.some(note => /does not check|any key|--balance/i.test(note)),
    `expected a warning about the relay, got: ${report.notes.join(' | ')}`
  );
});

test('the whole pool costs one config write, not one per key', async () => {
  seed();
  await checkKeys({ balance: true });

  assert.ok(fs.existsSync(`${CONFIG_FILE}.bak.1`));
  assert.ok(!fs.existsSync(`${CONFIG_FILE}.bak.2`), 'a write per key would churn through the backups');
});

test('the vault records the check itself, once per key it changed', async () => {
  seed();
  await checkKeys({ balance: true });

  const lines = readKeyVault().filter(line => line.event === 'check');
  assert.deepEqual(lines.map(line => line.status).sort(), ['active', 'exhausted', 'exhausted', 'invalid']);
  assert.ok(lines.every(line => line.key), 'the vault is the recovery copy: it does keep the key');
});

test('a key the user disabled by hand stays disabled, however well it probes', async () => {
  // `disabled` is a decision, not a measurement: an account kept for later, or
  // one that must not be billed. A funded probe is not permission to use it.
  seed([{ key: RICH, status: 'disabled', label: 'shelved@example.com' }]);
  const report = await checkKeys({ balance: true });

  assert.equal(entry(RICH).status, 'disabled');
  assert.equal(report.changed, 0);
  assert.equal(report.results[0].verdict, 'funded', 'it was still probed and still reported');
});

test('the concurrency cap is respected, because these relays rate-limit', async () => {
  seed();
  await checkKeys({ balance: true, concurrency: 2 });
  assert.ok(peak <= 2, `expected at most 2 requests in flight, saw ${peak}`);
});

test('one provider can be checked on its own', async () => {
  clearConfigCache();
  saveConfig({
    providers: {
      gorouter: { url: relayUrl, keys: [{ key: RICH, status: 'unknown' }] },
      tabitoken: { url: 'https://tabitoken.example/v1', keys: [{ key: LOW, status: 'unknown' }] }
    }
  });
  const report = await checkKeys({ provider: 'gorouter' });

  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].provider, 'gorouter');
  assert.ok(asked.some(call => call.key === RICH));
  assert.ok(asked.every(call => call.key !== LOW), 'the other provider was left alone');
});

test('an unknown provider is refused by name', async () => {
  seed();
  await assert.rejects(() => checkKeys({ provider: 'nosuch' }), /nosuch|gorouter/i);
});
