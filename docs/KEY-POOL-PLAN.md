# Key pool + rotation — implementation plan

Status: **phases 0–3 done** (branch `feat/key-pool`). Pool schema, vault and backups;
the .xlsx reader and importer; the classifier with tests. Next: phase 4, detection and
manual rotation, which is the first phase to touch the live request path.

## Locked decisions

| Question | Choice |
|---|---|
| When a key looks exhausted | Alert, don't rotate. Manual switch by default. |
| Key selection order | Sequential — drain one account, then the next. |
| Who owns the data | The proxy. Import once, export CSV as a second copy. |
| First import | All 261 keys with `status: unknown`, then one bulk-test pass. |

---

## 1. How exhaustion is actually detected

This was the open problem. It is now solved, because the provider tells us in plain numbers.

**Confirmed signature** (observed on gorouter, 2026-09-02):

```
HTTP 403
预扣费额度失败, 用户剩余额度: ＄0.710336, 需要预扣费额度: ＄0.800000
   pre-deduction failed    remaining: $0.710336   required: $0.800000
```

These relays are New-API / One-API forks. Before running a request they *pre-authorise* an
estimated cost from prompt size + `max_tokens`. If the balance is below that estimate the
request is rejected **before any tokens are billed** — and the rejection contains the exact
remaining balance.

Two consequences, both useful:

1. **The status code alone is worthless.** `403` also means WAF block, geo block and revoked
   key. In the full request history there is exactly **one** `402` in ~1,100 requests, so
   "out of credit" has no dedicated code. Detection must read the body.
2. **Every rejection is a free balance reading.** No billing endpoint needed.

### Classifier (`src/core/creditSignals.js`, new — pure function, no I/O)

```js
classifyUpstreamFailure(statusCode, bodyText) -> {
  kind: 'exhausted' | 'invalid-key' | 'rate-limited' | 'transient' | 'other',
  remaining: number|null,   // parsed from the message
  needed: number|null,
  matched: string|null      // which phrase fired, for the audit log
}
```

**Tier A — confirmed, safe to act on**

- `预扣费额度失败` (pre-deduction failed) — verified above
- `用户剩余额度` / `剩余额度` present with a number
- `402` on any body

**Tier B — same product family, treat as exhausted but log `matched` so we can audit**

`额度不足`, `余额不足`, `用户额度不足`, `令牌额度已用尽`, `insufficient balance`,
`insufficient quota`, `insufficient credit`, `quota exhausted`, `exceeded your current quota`

**Tier C — must NEVER be classified as exhausted** (these are the false positives that
would burn good keys)

| Signal | Real meaning |
|---|---|
| `429` | rate limit — key is fine, back off |
| `401`, `invalid api key`, `令牌无效` | key revoked → `invalid-key`, a *different* status |
| `403` with no balance phrase | Cloudflare / WAF / geo block → `transient` |
| `无可用渠道` (no available channel) | provider-side routing failure, not your balance |
| `502/503/504/524` | upstream trouble, already handled by the existing retry path |

Balance parsing must accept the **fullwidth dollar sign `＄` (U+FF04)** as well as ASCII `$`.
Verified working regex:

```js
/(?:用户)?剩余额度[:：]\s*[$＄]?\s*([0-9]+(?:\.[0-9]+)?)/
/需要预扣费额度[:：]\s*[$＄]?\s*([0-9]+(?:\.[0-9]+)?)/
```

### Where it hooks in — the machinery already exists

`src/core/proxyServer.js:486` already holds back a retryable error response instead of
forwarding it (`peeking`, `RETRY_PEEK_BYTES = 64KB`, `flushAndPipe()`), so a second provider
can still answer. That is exactly the hook needed. Changes:

- Extend the peek trigger from "status is in `RETRYABLE_STATUS`" to "status is retryable
  **or** in `INSPECT_STATUS` (`401, 402, 403`)".
- In `proxyRes.on('end')` (line 397), run the classifier over the held-back buffer.
  - `exhausted` / `invalid-key` → mark the key, then either alert (manual) or rotate (auto).
  - anything else → `flushAndPipe()`, client sees the original response untouched.
- Peeking a 403 costs nothing measurable: these bodies are ~200 bytes and non-streaming.

**Note on the `Please run /login` message you saw:** that is Claude Code guessing from the
bare `403`. Once the proxy classifies the body it can replace the message with
`gorouter key "marajul.cu.cse" is out of credit ($0.71 left, $0.80 needed) — ai-proxy keys next gorouter`.
Status stays `403` so no client changes behaviour. Optional, but it turns a misleading prompt
into the actual instruction.

---

## 2. Reliability rules (non-negotiable — "don't lose my keys")

**Existing bug to fix first:** `normalizeConfig()` in `src/core/configManager.js:161` rebuilds
every provider from exactly five fields, so *any* extra data added to `config.json` by hand is
silently deleted on the next save. The schema must grow properly; hand-editing is not an option.

1. **Append-only vault** `~/.config/ai-proxy-manager/keys.jsonl`. Every key ever seen gets a
   line. Status changes append new lines, never rewrite old ones. `config.json` is rebuildable
   from it. Mode `0600`.
2. **Rolling backups** — 5 timestamped copies of `config.json` on each write. Writes are
   already atomic (tmp + rename); this covers "bad data written successfully".
3. **Exhausted means marked, never removed.** Deletion is a separate explicit command with a
   confirmation prompt, and still leaves the vault line intact.
4. **CSV export** after every mutation, so the spreadsheet stays a live second copy.
5. **Masking** — dashboard and API return `sk-…a1b2` only. Keys never enter `requests.jsonl`.
6. **No encryption at rest.** `0600` plus out-of-git is the right level; a passphrase would
   block unattended daemon start.

---

## 3. Phases

### Phase 0 — safety (do first, 10 min)
- `.gitignore` rule for `04_Github and API Keys/` — **done**, verified with `git check-ignore`.
- **Move that folder out of the repo.** `My githubs Links.xlsx` holds GitHub passwords, 2FA
  secrets and recovery codes for ~59 accounts. A gitignore line is one `git add -f` from
  useless. Suggested home: `~/keys/` (mode `0700`).

### Phase 1 — data model + vault (no behaviour change)
Files: `src/core/keyStore.js` (new), `src/core/configManager.js`

```js
providers.gorouter.keys = [{
  id, label: "marajul.cu.cse@gmail.com", key, status: "active",
  remaining: 0.71, needed: null, dashboardUrl, referralUrl,
  addedAt, lastUsedAt, requestsServed, lastError, note
}]
```
`status` ∈ `active | exhausted | invalid | unknown | disabled`.
`apiKey` is kept as a **mirror** of the active key, so `cli.js`, `providerController.js`,
`providerTester.js`, the dashboard and the `<provider>:<key>` inline token all keep working
with no changes. Normalization must preserve the new fields and migrate an existing single
`apiKey` into a one-entry pool.

Tests: round-trip through `normalizeConfig`, migration of a legacy config, vault append and
rebuild, backup rotation.

### Phase 2 — import
Files: `src/core/keyImport.js` (new), `src/cli.js` (`keys import`)

xlsx is a zip + XML — parse it with `zlib` alone, **no new dependency**. Maps the sheet columns
already in use: account email → `label`, `API Key:` → `key`, `Remaining Credit` → `remaining`,
`Referel Link:` → `referralUrl`, `URL For API KEY` → `dashboardUrl`. Also accepts CSV.
Dedupes by key value across all 17 tabs. Idempotent: re-running never duplicates or downgrades
a known-good status.

### Phase 3 — classifier
Files: `src/core/creditSignals.js` (new)
Pure function, unit-tested against the real strings in §1 including every Tier C case. This
phase ships with tests only — nothing calls it yet.

### Phase 4 — detection + manual rotation
Files: `src/core/proxyServer.js`, `src/core/requestLogger.js`, `src/dashboard/app.js`,
`src/core/apiRoutes.js`

- Peek + classify as described in §1.
- Mark the key, record `remaining`, append to the vault, log `keyId` + `keyLabel` on the
  request row.
- Dashboard banner: *"gorouter key marajul.cu.cse is out of credit ($0.71 left). Switch →"*.
- CLI: `ai-proxy keys list|next|use|retire|revive <provider>`.
- Attempt plan becomes a list of `{provider, keyId}` instead of provider names;
  `buildAttemptPlan` extends to walk keys within a provider *before* moving to another
  provider. Existing retry/failover behaviour and its tests stay green.

Tests: fake upstream route returning the exact Chinese 403 body → asserts the key is marked,
the balance is parsed, the client still receives the 403 in manual mode, and a 403 *without* a
balance phrase leaves the key untouched.

### Phase 5 — bulk health check + balance probe
Files: `src/core/providerTester.js`, `src/cli.js` (`keys check`)

Two calls per key, both effectively free:

1. **Liveness** — `GET /v1/models` with the key. `200` = valid, `401/403` = dead. No tokens.
2. **Balance** — the same `/v1/messages` ping `testProvider` already sends, but with a large
   `max_tokens` so the pre-authorisation estimate exceeds any plausible balance. The relay
   rejects it and *hands back the exact balance*. Nothing is billed because nothing ran.
   Safety: if a key is rich enough that the probe is **accepted**, abort the socket on the
   first byte — cost is negligible but non-zero, so this probe is opt-in (`--balance`) and
   concurrency-limited.

Output: all 261 keys sorted into live / no-credit / revoked, with balances. This replaces
logging into dozens of dashboards by hand.

### Phase 6 — auto mode, per provider
Settings: `keyRotation: 'manual' | 'auto'` per provider, default `manual`.
Auto requires: a Tier A match, or a Tier B match that has been seen at least twice on that
provider. On trigger: mark exhausted → next key → replay the request (the existing
`replayable` guard at `proxyServer.js:491` already prevents replaying a streamed body).
Enable per provider only after Phase 5 has confirmed its real message.

### Phase 7 — export + docs
CSV export (`keys export`), `docs/KEYS.md`, README section, CHANGELOG entry.

---

## 4. Risks

| Risk | Mitigation |
|---|---|
| Classifier retires a healthy key | Tier C deny-list; manual default; every decision logged with `matched` |
| Balance probe accidentally spends credit | Abort on first byte; opt-in flag; concurrency cap |
| Schema change loses existing keys | Migration test from a legacy config; append-only vault; backups |
| 261 keys make the dashboard unusable | Group by provider, collapse exhausted, search by label |
| Keys leak into logs or git | Masking at the API boundary; `.gitignore`; `npm run verify` runs `check-secrets.sh` |
