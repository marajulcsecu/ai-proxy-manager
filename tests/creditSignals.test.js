/**
 * Reading "you are out of credit" out of an upstream failure.
 *
 * The strings below are real responses from the relays this proxy talks to.
 * Getting this wrong in either direction is expensive: a false positive
 * retires a working account, a false negative leaves the user staring at a
 * misleading "Please run /login".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { classifyUpstreamFailure, INSPECT_STATUS } =
  await import('../src/core/creditSignals.js');

/** The exact body observed from gorouter on 2026-09-02. Note the fullwidth ＄. */
const GOROUTER_403 =
  '预扣费额度失败, 用户剩余额度: ＄0.710336, 需要预扣费额度: ＄0.800000 (request id: 2026090213463112928)';

test('the confirmed pre-charge rejection is read as exhaustion, with both amounts', () => {
  const verdict = classifyUpstreamFailure(403, GOROUTER_403);

  assert.equal(verdict.kind, 'exhausted');
  assert.equal(verdict.remaining, 0.710336);
  assert.equal(verdict.needed, 0.8);
  assert.equal(verdict.tier, 'A');
  assert.ok(verdict.matched, 'the phrase that fired must be recorded for auditing');
});

test('an ASCII dollar sign parses the same as the fullwidth one', () => {
  const verdict = classifyUpstreamFailure(403, '预扣费额度失败, 用户剩余额度: $1.25, 需要预扣费额度: $2.50');
  assert.equal(verdict.remaining, 1.25);
  assert.equal(verdict.needed, 2.5);
});

test('a JSON-wrapped message is read just as well as a bare one', () => {
  const body = JSON.stringify({ error: { message: GOROUTER_403, type: 'invalid_request_error' } });
  assert.equal(classifyUpstreamFailure(403, body).kind, 'exhausted');
  assert.equal(classifyUpstreamFailure(403, body).remaining, 0.710336);
});

test('402 Payment Required is exhaustion even with an empty body', () => {
  const verdict = classifyUpstreamFailure(402, '');
  assert.equal(verdict.kind, 'exhausted');
  assert.equal(verdict.tier, 'A');
  assert.equal(verdict.remaining, null);
});

test('the wider One-API family of quota messages is caught as tier B', () => {
  for (const body of ['额度不足', '余额不足，请充值', '该令牌额度已用尽', '用户额度不足']) {
    const verdict = classifyUpstreamFailure(403, body);
    assert.equal(verdict.kind, 'exhausted', `missed: ${body}`);
    assert.equal(verdict.tier, 'B', `wrong tier for: ${body}`);
  }
});

test('English quota wording is caught too', () => {
  for (const body of [
    'Insufficient balance',
    'insufficient quota for this request',
    'You exceeded your current quota, please check your plan',
    'Your credit balance is too low'
  ]) {
    assert.equal(classifyUpstreamFailure(403, body).kind, 'exhausted', `missed: ${body}`);
  }
});

// --- the false positives that would burn a healthy key ----------------------

test('a rate limit is never exhaustion', () => {
  const verdict = classifyUpstreamFailure(429, 'Rate limit exceeded, please slow down');
  assert.equal(verdict.kind, 'rate-limited');
});

test('a quota message still wins over a 429 status', () => {
  // OpenAI-compatible upstreams report real exhaustion with 429, so the body
  // has to decide, not the status.
  assert.equal(
    classifyUpstreamFailure(429, 'You exceeded your current quota').kind,
    'exhausted'
  );
});

test('a Cloudflare block is transient, not exhaustion', () => {
  const html = '<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head></html>';
  const verdict = classifyUpstreamFailure(403, html);
  assert.equal(verdict.kind, 'transient');
  assert.equal(verdict.remaining, null);
});

test('"no available channel" is the provider\'s problem, not the balance', () => {
  assert.equal(classifyUpstreamFailure(503, '无可用渠道').kind, 'transient');
  assert.equal(classifyUpstreamFailure(403, '当前分组下对于模型无可用渠道').kind, 'transient');
});

test('a revoked or wrong key is reported separately from an empty one', () => {
  for (const [status, body] of [[401, ''], [403, '令牌无效'], [401, 'invalid api key provided']]) {
    assert.equal(classifyUpstreamFailure(status, body).kind, 'invalid-key', `missed: ${status} ${body}`);
  }
});

test('a gateway error stays transient so the existing retry path owns it', () => {
  for (const status of [502, 503, 504, 524]) {
    assert.equal(classifyUpstreamFailure(status, 'origin timeout').kind, 'transient');
  }
});

test('a successful response is never classified', () => {
  assert.equal(classifyUpstreamFailure(200, '额度不足').kind, 'none');
});

test('an unrecognised client error is left alone', () => {
  assert.equal(classifyUpstreamFailure(400, 'messages: at least one message is required').kind, 'other');
});

test('a missing or oversized body does not throw', () => {
  assert.equal(classifyUpstreamFailure(403, undefined).kind, 'transient');
  assert.equal(classifyUpstreamFailure(403, Buffer.from(GOROUTER_403)).kind, 'exhausted');
  assert.doesNotThrow(() => classifyUpstreamFailure(403, 'x'.repeat(200000)));
});

test('a balance of exactly zero is still a number, not a missing value', () => {
  const verdict = classifyUpstreamFailure(403, '预扣费额度失败, 用户剩余额度: ＄0.000000, 需要预扣费额度: ＄0.8');
  assert.equal(verdict.remaining, 0);
  assert.equal(verdict.kind, 'exhausted');
});

test('the statuses worth inspecting include the credit ones and exclude success', () => {
  for (const status of [401, 402, 403, 429]) assert.ok(INSPECT_STATUS.has(status), `missing ${status}`);
  assert.ok(!INSPECT_STATUS.has(200));
});
