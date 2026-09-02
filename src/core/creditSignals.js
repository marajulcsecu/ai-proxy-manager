/**
 * @fileoverview Decides what an upstream failure actually means — above all,
 * whether an account has run out of credit.
 *
 * Why this needs its own module: the relays this proxy fronts (New-API /
 * One-API forks) pre-authorise a request before running it. They estimate the
 * cost from the prompt plus max_tokens and refuse *before billing* when the
 * balance is lower, quoting both numbers in the error body:
 *
 *   403 预扣费额度失败, 用户剩余额度: ＄0.710336, 需要预扣费额度: ＄0.800000
 *
 * Two consequences shape everything here:
 *  - The status code cannot be trusted on its own. 403 is also a WAF block, a
 *    geo block and a revoked token; a real 402 showed up once in ~1,100
 *    requests. So the body decides, and the status only breaks ties.
 *  - Every rejection is a free balance reading. No billing API is needed.
 *
 * The cost of a mistake is asymmetric, so the default is always "not credit":
 * a false positive retires a working account, a false negative only shows the
 * user a worse error message.
 *
 * Pure functions only — no I/O, no config, no state.
 */

/**
 * Statuses whose body is worth holding back and reading. Anything outside this
 * set is streamed straight through untouched.
 */
export const INSPECT_STATUS = new Set([401, 402, 403, 429]);

/** Errors the existing retry path already owns; never a credit verdict. */
const TRANSIENT_STATUS = new Set([408, 425, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 527, 530]);

/**
 * Only the head of the body is scanned. Real error payloads are a few hundred
 * bytes; anything huge is an HTML challenge page, and scanning all of it with
 * a dozen regexes on the request path would be wasteful.
 */
const MAX_SCAN = 16 * 1024;

/**
 * Tier A — confirmed verbatim from this user's own providers. A match here is
 * strong enough to retire a key automatically.
 */
const TIER_A = [
  /预扣费额度失败/,
  /预扣费额度不足/
];

/**
 * Tier B — the same One-API/New-API family and the OpenAI-compatible wording.
 * Almost certainly exhaustion, but not yet observed on these exact relays, so
 * auto-rotation requires seeing it twice (see the plan).
 */
const TIER_B = [
  /额度不足/,
  /余额不足/,
  /额度已用尽/,
  /额度已耗尽/,
  /配额不足/,
  /请充值/,
  /insufficient\s+balance/i,
  /insufficient\s+(?:user\s+)?quota/i,
  /exceeded\s+your\s+current\s+quota/i,
  /credit\s+balance\s+is\s+too\s+low/i,
  /quota\s+exceeded/i,
  /out\s+of\s+credits?/i,
  /balance\s+is\s+(?:too\s+low|insufficient)/i
];

/** A key that will never work again, however much credit is added. */
const INVALID_KEY = [
  /令牌无效/,
  /无效的令牌/,
  /令牌已过期/,
  /令牌验证失败/,
  /未提供令牌/,
  /认证失败/,
  /invalid[\s_-]*api[\s_-]*key/i,
  /incorrect\s+api\s+key/i,
  /api\s+key\s+not\s+(?:found|valid)/i,
  /no\s+auth\s+credentials/i,
  /invalid\s+authentication/i
];

/**
 * The provider's own problem. Kept explicit because these arrive with 403 as
 * often as with 503, and a 403 must never be read as an empty wallet.
 */
const PROVIDER_FAULT = [
  /无可用渠道/,
  /no\s+available\s+channel/i,
  /当前分组/,
  /上游负载已饱和/,
  /服务器繁忙/
];

/** An interstitial from a CDN, not an answer from the relay. */
const CHALLENGE = [
  /cloudflare/i,
  /attention\s+required/i,
  /just\s+a\s+moment/i,
  /<!doctype\s+html/i,
  /<html[\s>]/i
];

const RE_REMAINING = /(?:用户)?剩余额度\s*[:：]\s*[$＄]?\s*(-?[0-9]+(?:\.[0-9]+)?)/;
const RE_NEEDED = /需要(?:预扣费)?额度\s*[:：]\s*[$＄]?\s*(-?[0-9]+(?:\.[0-9]+)?)/;

/**
 * Body as scannable text. Accepts a Buffer (what the proxy actually holds), a
 * string, or nothing at all.
 * @param {any} body
 * @returns {string}
 */
function asText(body) {
  if (body === undefined || body === null) return '';
  if (Buffer.isBuffer(body)) return body.subarray(0, MAX_SCAN).toString('utf8');
  return String(body).slice(0, MAX_SCAN);
}

/**
 * Adds the string leaves of a parsed JSON body to the haystack. Upstreams wrap
 * the message in `{error:{message}}`, and some escape non-ASCII as \uXXXX —
 * parsing turns those back into the characters the patterns look for.
 * @param {string} text
 * @returns {string} the original text, plus decoded strings when it was JSON
 */
function expand(text) {
  const head = text.trimStart();
  if (!head.startsWith('{') && !head.startsWith('[')) return text;
  if (!/\\u[0-9a-fA-F]{4}/.test(text) && !/"/.test(text)) return text;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text; // truncated peek, or not JSON after all
  }

  const found = [];
  const walk = (value, depth) => {
    if (depth > 6 || found.length > 64) return;
    if (typeof value === 'string') found.push(value);
    else if (Array.isArray(value)) for (const item of value) walk(item, depth + 1);
    else if (value && typeof value === 'object') for (const item of Object.values(value)) walk(item, depth + 1);
  };
  walk(parsed, 0);
  return found.length ? `${text}\n${found.join('\n')}` : text;
}

/** First pattern in `list` that matches, as its source string. */
function firstMatch(list, text) {
  for (const pattern of list) if (pattern.test(text)) return String(pattern);
  return null;
}

/** Number captured by `pattern`, or null when absent. Zero stays zero. */
function amount(pattern, text) {
  const found = pattern.exec(text);
  if (!found) return null;
  const value = Number(found[1]);
  return Number.isFinite(value) ? value : null;
}

/**
 * @typedef {Object} UpstreamVerdict
 * @property {'none'|'exhausted'|'invalid-key'|'rate-limited'|'transient'|'other'} kind
 * @property {'A'|'B'|null} tier   - confidence of an `exhausted` verdict
 * @property {number|null} remaining - balance the upstream reported, in dollars
 * @property {number|null} needed    - what this request would have cost
 * @property {string|null} matched   - the pattern that fired, for auditing
 * @property {number} status
 */

/**
 * Classifies one upstream failure.
 * @param {number} statusCode
 * @param {string|Buffer|undefined} body - response body, or the peeked head of it
 * @returns {UpstreamVerdict}
 */
export function classifyUpstreamFailure(statusCode, body) {
  const status = Number(statusCode) || 0;
  const text = expand(asText(body));
  const remaining = amount(RE_REMAINING, text);
  const needed = amount(RE_NEEDED, text);

  const verdict = (kind, tier = null, matched = null) =>
    ({ kind, tier, remaining, needed, matched, status });

  // A 2xx/3xx is an answer, not a failure, whatever words it contains.
  if (status < 400) return verdict('none');

  // The body is authoritative, so it is read before the status is considered.
  const tierA = firstMatch(TIER_A, text);
  if (tierA) return verdict('exhausted', 'A', tierA);

  const tierB = firstMatch(TIER_B, text);
  if (tierB) return verdict('exhausted', 'B', tierB);

  // Below here nothing can be exhaustion, so the balance fields would be
  // misleading if they had somehow parsed.
  const fault = firstMatch(PROVIDER_FAULT, text);
  if (fault) return { kind: 'transient', tier: null, remaining: null, needed: null, matched: fault, status };

  const challenge = firstMatch(CHALLENGE, text);
  if (challenge) return { kind: 'transient', tier: null, remaining: null, needed: null, matched: challenge, status };

  const bad = firstMatch(INVALID_KEY, text);
  if (bad) return { kind: 'invalid-key', tier: null, remaining: null, needed: null, matched: bad, status };

  // Payment Required needs no body: it is what the code is for. Rare in
  // practice, which is exactly why the phrases above come first.
  if (status === 402) return verdict('exhausted', 'A', 'status 402');

  // An empty 401 is the one case where the status alone identifies the key.
  if (status === 401) return verdict('invalid-key');

  if (status === 429) return verdict('rate-limited');
  if (status === 403) return verdict('transient'); // WAF, geo block, or unknown
  if (TRANSIENT_STATUS.has(status) || status >= 500) return verdict('transient');

  return verdict('other');
}

/**
 * Whether a verdict is confident enough to retire a key without asking.
 * Tier B needs corroboration because it has not been seen on these relays yet.
 * @param {UpstreamVerdict} verdict
 * @param {number} [priorTierBHits] - times tier B already fired for this provider
 * @returns {boolean}
 */
export function isConfidentExhaustion(verdict, priorTierBHits = 0) {
  if (!verdict || verdict.kind !== 'exhausted') return false;
  return verdict.tier === 'A' || priorTierBHits >= 1;
}
