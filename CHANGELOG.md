# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Requests died after 5 seconds and were reported as a 300-second stall.** The proxy used
  `http.globalAgent`, whose `timeout: 5000` is applied to the socket while it is still
  connecting; `ClientRequest.setTimeout()` defers to the socket's `connect` event, so the
  agent's 5s timer won every race a slow connect started. Six real requests were lost to
  this, each logged as `Upstream sent nothing for 300s (stalled)` after ~5s. The proxy now
  owns dedicated `http`/`https` agents with `timeout: 0` and manages every deadline itself:
  a hard ceiling, an inactivity timer armed at dispatch and re-armed on each chunk, and an
  optional first-byte deadline. A slow-but-steady stream is no longer mistaken for a stall.

### Added

- **Retry with provider failover** (`retryEnabled`, off by default; `retryMaxAttempts`,
  `failoverProviders`). When an attempt fails *before a single byte has reached the client*,
  the request is re-sent — to the next configured provider, or to the same one when no
  failover target is set. Each provider's own model pin and API key are re-applied, so a
  failover is a genuine second route rather than a replay of the first.

  What counts as retryable: connection failures, the first-byte and stall timeouts, and
  gateway statuses `502`, `503`, `504`, `520`-`527`, `529` (Cloudflare's origin-failure
  family, `524` included). Deliberately excluded: `429`, which needs real backoff and is
  already retried by the calling tool, and every 4xx, which would fail identically.

  Three invariants keep it safe. A response that has begun streaming is never retried — once
  `writeHead` has run, the exchange is final. A body that was streamed rather than buffered is
  never retried either, because there is nothing left to re-send. And a retryable error page is
  held back (up to 64 KB) rather than forwarded, so the client sees one clean answer instead of
  an error followed by a success; anything larger is treated as a real response and passed
  through. Every attempt is logged as its own row with `attempt` and `retryReason`, so the
  dashboard shows the 524 and the retry that rescued it.

- **`upstreamFirstByteTimeoutMs`** setting (default `0`, disabled) — give up when a provider
  has not produced a single byte in that long. Set it just below a CDN-fronted provider's
  edge timeout (Cloudflare's is 100–120s) to fail fast with a readable error instead of
  waiting for an HTML error page.

- **Many keys per provider, with credit detection** — a provider now holds a pool of accounts
  instead of a single key, and the proxy notices when one runs out. Full reference:
  [docs/KEYS.md](docs/KEYS.md).

  *Detection.* New-API / One-API relays pre-authorise a request against the balance and refuse
  it **before** running it, quoting the shortfall: `403` with
  `预扣费额度失败, 用户剩余额度: ＄0.710336, 需要预扣费额度: ＄0.800000`. The status alone is
  worthless — `403` is also a WAF block, a geo block and a revoked key — so `creditSignals.js`
  classifies the body into `exhausted` / `invalid-key` / `rate-limited` / `transient` / `other`
  in two confidence tiers, records which phrase fired, and parses the numbers (fullwidth `＄`
  included). `429`, a bare `403`, `无可用渠道` and `5xx` are explicitly never read as
  exhaustion; mistaking one of them for "spent" would retire a healthy account. Every such
  refusal is therefore a free, exact balance reading, and no billing endpoint is needed.

  *On the request path.* A `401`/`402`/`403`/`429` response is held back (up to 64 KB),
  classified, then delivered. The key is marked, `remaining` is recorded, the request row gains
  `keyId`, `keyLabel`, `keyVerdict` and `keyRemaining`, and the dashboard raises a banner.
  Nothing is written to disk for a WAF `403`, a `429` or a repeat of a verdict already on file.

  *Switching.* Manual by default: you are told, and requests keep going to that key until you
  click *Switch →* or run `ai-proxy keys next <provider>`. `ai-proxy keys rotation <provider>
  auto` lets one provider mark the account spent, move to the next and re-send the refused
  request itself — safe precisely because a pre-authorisation refusal billed nothing. Auto is
  bounded: exhaustion only (never `invalid-key`, or a relay having a bad `401` day would mark
  the whole pool revoked), a verified wording or a second sighting of an unverified one, at
  most three accounts per request, and never for a request whose body was streamed.

  *Importing.* `ai-proxy keys import <file…> [--dry-run]` reads the account spreadsheets
  directly — `.xlsx` is a zip of XML, parsed with `node:zlib`, so this adds no dependency —
  and handles both real layouts (a row per provider, a column per provider). It never guesses
  a provider: an unresolvable key is reported with the header that produced it. It counts the
  key-shaped cells in the file independently of its own parsing and **refuses to write at all**
  if a single one went unaccounted for. Imported keys arrive as `unknown`, behind the key
  already in use, and a balance the proxy measured is never overwritten by one typed into a
  sheet.

  *Checking.* `ai-proxy keys check [name] [--balance] [--concurrency N] [--low N]` probes every
  key: `GET /v1/models` for liveness, and — opt-in — a `max_tokens: 1000000` ping that no
  balance can pre-pay, so the relay refuses it and hands back the number. `stream: true` plus a
  socket destroyed on the first byte is what caps the cost if a key *is* rich enough to be
  accepted. Liveness can promote `unknown` → `active` but never revives a spent key, a control
  probe with an invented key catches relays that accept anything, and `disabled` is a decision
  a measurement does not undo. A figure is written only where the relay quoted one: an accepted
  probe proves a key *has* credit, not how much, so the balance already on the entry stands
  instead of being replaced by a blank — and a key whose status and balance both come back
  unchanged costs no save at all.

  *Adding and correcting by hand.* Not every account arrives in a spreadsheet.
  `ai-proxy keys add <provider> <key> --label me@gmail.com [--note …] [--credit N] [--use]`
  appends one as `unknown` at the end of the pool, so adding a key never changes which account
  is serving traffic unless asked. An exact duplicate inside the same provider is refused —
  two rows for one account would each keep their own idea of the balance — while the same key
  under a *different* provider is allowed and reported, because those entries will empty
  together. `keys edit` corrects only what a person knows (label, note, dashboard and referral
  links): a key value cannot be edited because the id is derived from it, `status` follows what
  a relay answered, and `remaining` is measured by `keys check`; asking to set any of those is
  an error naming the verb that owns it. Editing to what the pool already says writes nothing,
  since a pointless save would rotate a real backup off the end of the five. `keys remove`
  needs `--yes`, moves the selection on as `keys next` would, and still leaves the value in
  `keys.jsonl`.

  *The models column.* An import also fills each provider's model list from a `Top Models`
  column, found by its header rather than its contents. What it accepts is filtered hard —
  anything with a space is prose, and every real id carries a digit or a hyphen — because one
  row writes "ALL KINDS OF MODELS" one word per line, and an invented model reaches the
  dashboard's dropdown and then 404s from the relay far from the import that made it up.
  Models are only added, never pruned. `--create-providers` builds providers the sheet names
  and the config lacks, from the URLs in the sheet, then re-reads the whole file so the same
  resolution rules apply to those keys as to every other one.

  *The Keys view.* The dashboard grew a sixth view: every account the proxy can bill, one table
  per provider, **in the order the keys will be spent** — the key in use is marked where it
  stands rather than lifted to the top, because its position in the queue is the information.
  Four columns, and deliberately only four: status, the account and its note, the masked key
  with a reveal, and *use* / *retire* / *revive* / *edit* / *delete*. The balance, the request
  count, the last-used time and the account's dashboard and referral links stay recorded — the
  CLI and the exported CSV carry them — they are simply not what this view is for. Filter by
  provider, by status or by a search over account, note and masked key; first 25 rows per
  provider with a *Show all N* toggle. Every button carries the key id, never the row number: the table is rebuilt from a
  2-second poll, and a position that shifted between the click and the request would retire
  whichever key had moved into it. The view polls only while it is open — one row per account
  is the largest response the API serves.

  *Not losing keys.* Four copies: `config.json` (atomic, `0600`), its five rotating backups,
  the append-only `keys.jsonl` vault that `config.json` can be rebuilt from, and
  `ai-proxy keys export [file] [--with-keys]` — a CSV in the same column order the importer
  reads, so it is a genuine restore. The export is masked unless asked, `0600`, and refused
  inside a git working tree unless forced. Nothing is deleted unless you say so twice: spent
  and revoked keys stay in the pool, `keys remove` needs `--yes` and the API needs `confirm=1`,
  and the vault line survives either way. Exactly one call returns a key value — the per-key
  reveal — and every listing, alert and response carries a masked key only.

  *Commands and API.*
  `keys import|list|check|add|edit|remove|reveal|next|use|retire|revive|rotation|export`,
  `GET /api/keys`, `POST /api/keys/:name` and `/api/keys/:name/{next,use,retire,revive,rotation}`,
  `PATCH /api/keys/:name/:id`, `DELETE /api/keys/:name/:id?confirm=1`,
  `GET /api/keys/:name/:id/value`, `DELETE /api/keys/:name/alerts/:keyId`, `keyAlerts` on
  `/api/status`, per-provider pool cards with an `auto` toggle, and the Keys view.

## [1.1.0] — 2026-08-28

A hardening release. The proxy engine, configuration layer, REST API and dashboard were
all reworked; every documented command still behaves the same way, and existing
`config.json` files are migrated in place on first start.

### Added

- **Daemon lifecycle** — `ai-proxy start --daemon`, `stop`, `restart`, `status` and
  `logs [-n N] [-f]`, backed by a PID file. `status` reports the daemon, the active route,
  live traffic and whether each integration is applied.
- **Connection testing** — `ai-proxy test [name] [--model <id>]` and a per-provider *Test*
  button send one real 1-token request and translate the result into a cause: key rejected,
  wrong base URL, unknown model, WAF block, rate limit, or a network error.
- **Request inspector** — every forwarded call records duration, time to first byte, byte
  counts, streaming flag and error text. Selecting a row shows the request and response
  bodies.
- **Persistent history** — request *metadata* is mirrored to `requests.jsonl` (rotated at
  5 MB) and restored on start, so history survives a restart. Bodies are kept in memory
  only, capped at 4 KB, and can be disabled with `captureBodies: false`.
- **Metrics** — p50/p95 latency, error rate and per-provider counters on `/api/status`.
- **Config portability** — `ai-proxy export <file> [--with-keys]` and
  `ai-proxy import <file> [--replace]`, plus the same over the API. Keys are redacted by
  default, and importing a redacted file never erases a stored key.
- **New commands** — `remove-provider`, `remove-terminal`, `set-port`, `version`.
- **Settings block** in `config.json`: `upstreamTimeoutMs`, `upstreamStallTimeoutMs`,
  `spoofHeaders`, `persistLogs`, `logBufferSize`, `captureBodies`, `theme`, editable from
  the dashboard.
- **`AI_PROXY_HOME`** relocates every path the tool uses, so a throwaway instance can run
  alongside a real one.
- **Test suite** — 47 tests on `node:test`, covering config repair, URL resolution, the
  REST contract, the full proxy flow (including stalls and SSE) and the logger. Plus a CI
  workflow, a secret-scanning script and issue/PR templates.

### Changed

- **Dashboard v2** — an app shell with five views (Overview, Providers, Requests, Setup,
  Settings), light and dark themes that follow the system by default, a `Ctrl`/`⌘`+`K`
  command palette, focus-trapped and Escape-dismissible dialogs, toasts in place of
  `confirm()`, empty and loading states, and a real mobile layout.
- **Upstream resolution** now honours the scheme, port and base path of `provider.url`, so
  `http://127.0.0.1:11434/v1` (Ollama, LM Studio, LiteLLM) and `https://host/openai/v1`
  (path-prefixed gateways) work. The API version segment is never duplicated.
- **Model rewriting** applies to `/chat/completions`, `/completions`, `/responses`,
  `/embeddings` and `/messages/count_tokens` as well as `/messages`.
- **Timeouts** — a hard ceiling plus a socket-stall timeout, and a client disconnect now
  tears down the upstream request instead of letting it run on.
- **Errors** are returned as an Anthropic-shaped envelope
  (`{"type":"error","error":{"type":…,"message":…}}`) so client tools display them, with
  a message that names the fix.
- **`setup-terminal`** writes a managed block to every shell that exists — bash, zsh and
  fish — and rewrites it in place on re-run instead of refusing.
- **`sync-vscode`** injects every model of every keyed provider, not just the pinned one.
- **Provider names** are normalized (lowercased, restricted to `[a-z0-9._-]`) on both the
  CLI and API paths, so a provider can always be edited and deleted where it was created.
- Colour output is suppressed when stdout is not a TTY, keeping `daemon.log` readable.

### Fixed

- Requests with a query string were routed to the upstream provider: `GET /style.css?v=1`
  was proxied instead of served, and `/api/status?t=1` returned 404. Routing now uses the
  pathname only.
- A `defaultModel` missing from its own `models` array made the dashboard dropdown display
  the wrong model as selected while the proxy used another. The schema is now repaired on
  load and written back once.
- A POST body that was not JSON was rejected with 400; it is now forwarded untouched.
- A corrupt `config.json` called `process.exit(1)` from inside `loadConfig()`, killing the
  running daemon on the next request. It now raises an error that becomes a 500.
- `config.json` — which holds API keys — was written non-atomically with default
  permissions. Writes are now atomic (temp file + rename) at mode `0600` in a `0700`
  directory.
- The REST API sent `Access-Control-Allow-Origin: *` and never checked `Host`, so any web
  page could read stored API keys from `127.0.0.1:8319` through DNS rebinding. The wildcard
  is gone and non-loopback `Host`/`Origin` values are rejected with 403.
- A provider that answered `200` and then stopped sending data hung the client forever.
  It is now aborted with a logged reason.
- `add-provider` on an existing provider wiped its `models` list and reset `defaultModel`
  to a hardcoded value. URL updates now preserve the key and models.
- Hop-by-hop headers (`connection`, `transfer-encoding`, `te`, `upgrade`, …) were forwarded
  upstream.
- `syncVsCode()` threw on any existing entry without a `name` field.
- Model names containing `/` or `:` could not be removed (no URL encoding).
- `POST /api/providers/:name/model` rejected `""`, so pass-through could not be re-enabled
  from the dashboard.
- `POST /api/providers` silently overwrote an existing provider instead of returning 409.
- A schemeless single-label URL such as `nope` was accepted as a hostname.
- The 2-second dashboard poll re-rendered everything, closing an open model dropdown
  mid-selection and discarding focus.
- Browser requests for `/favicon.ico` were proxied upstream as API calls.

### Security

- See [SECURITY.md](SECURITY.md). The DNS-rebinding fix above is the significant one: before
  it, visiting a hostile web page was enough to exfiltrate every provider key.

## [1.0.0] — 2026-08-27

First working version.

### Added

- JSON-backed provider store at `~/.config/ai-proxy-manager/config.json` with
  `add-provider`, `set-key`, `set-model`, `use` and `list`.
- Smart routing: a `provider:key` token targets a specific provider, anything else uses the
  active one, and a placeholder key is replaced with the stored one.
- Proxy engine with SSE streaming, model rewriting on `/messages`, and spoofed SDK headers
  to get past provider WAFs.
- Both `Authorization: Bearer` and `x-api-key` are sent upstream for compatibility.
- Multi-model support per provider (`add-model`, `remove-model`) and pass-through mode when
  no model is pinned.
- Web dashboard MVP on the proxy's own port, with a REST API and a live request log.
- Tool integrations: `setup-terminal` (bash) and `sync-vscode`.
- Documentation set: `README.md`, `docs/SRS.md`, `docs/ROADMAP.md`, `docs/SETUP_GUIDE.md`,
  `docs/DASHBOARD_PLAN.md`, `docs/CONTEXT.md`.

[1.1.0]: https://github.com/marajulcsecu/ai-proxy-manager/compare/e31a2bc...v1.1.0
[1.0.0]: https://github.com/marajulcsecu/ai-proxy-manager/commits/e31a2bc
