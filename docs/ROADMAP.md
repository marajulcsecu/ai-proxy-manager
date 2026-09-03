# Roadmap

Phases 1–6 are shipped (v1.1.0); phase 7, the key pool, is on `feat/key-pool` and unreleased.
What comes after them is listed at the bottom, roughly in order of how much it would improve
day-to-day use.

### Phase 1: Project Setup & Storage Engine (Completed)
- [x] Initialize Node.js project (`package.json`, Git).
- [x] Write SDLC documentation (`README.md`, `SRS.md`, `ROADMAP.md`).
- [x] Create the core configuration/JSON storage engine module.

### Phase 2: CLI Interface Development (Completed)
- [x] Implement `ai-proxy add-provider <name> <url>` to register new providers.
- [x] Implement `ai-proxy set-key <name> <key>` to update API keys securely.
- [x] Implement `ai-proxy list` to view a formatted table of all configurations.
- [x] Implement `ai-proxy use <name>` to set the system-wide default provider.

### Phase 3: The Smart Proxy Server Engine (Completed)
- [x] Develop the core Node.js `http/https` proxy module.
- [x] Implement request interception (swapping base URLs, spoofing headers).
- [x] Implement robust model overriding in request bodies.
- [x] Add streaming event support (SSE) to ensure UI tools don't time out during "thinking" phases.

### Phase 4: Integration Scripts (Completed)
- [x] Create dynamic bash alias generators for multi-terminal support (e.g. Claude Code session management).
- [x] Provide comprehensive instructions for Opencode GUI setup.
- [x] Build automated integration hooks for VS Code `chatLanguageModels.json`.

### Phase 5: Polish & Deployment (Completed)
- [x] Ensure all commands work flawlessly through the global `npm` alias.
- [x] Complete final testing of simultaneous routing (Provider A vs Provider B).
- [x] Push to GitHub Repository.

### Phase 6: Hardening & Dashboard v2 (Completed — v1.1.0)
- [x] Upstream resolution rewritten: any scheme, port and base path (local Ollama/LM Studio,
      path-prefixed gateways). Previously https:443 only, with the base path discarded.
- [x] Route on pathname, so `?query=strings` no longer leak into the proxy layer.
- [x] Hard + stall timeouts, client-disconnect teardown, and Anthropic-shaped error envelopes.
- [x] Atomic config writes with 0600 permissions, schema repair and mtime caching;
      a corrupt file no longer kills the daemon.
- [x] Localhost-only dashboard/API (Host + Origin checks, no CORS wildcard) — closes a
      DNS-rebinding path to the stored API keys.
- [x] Daemon lifecycle: `start --daemon`, `stop`, `restart`, `status`, `logs`.
- [x] Per-provider connection test, request inspector, latency metrics, persistent history.
- [x] Dashboard v2: app shell, light/dark themes, command palette, accessible dialogs,
      focus-preserving re-render.
- [x] Test suite on `node:test` (47 tests) covering config, URL resolution, the REST
      contract, the proxy flow and the logger.

### Phase 7: Many keys per provider (Completed — unreleased)
- [x] A pool of accounts per provider, each with its own status, balance and dashboard/referral
      URL, plus an append-only vault and five rolling config backups — four independent copies,
      so no schema change can lose a key.
- [x] `.xlsx` reader written on `node:zlib` alone (a spreadsheet is a zip of XML), and an
      importer that accounts for every key-shaped cell in the file or refuses to write.
- [x] Credit detection from the refusal body, not the status code: these relays pre-authorise
      against the balance and quote the exact shortfall, so a refusal is a free balance reading.
- [x] Manual switching by default (a dashboard banner and `keys next`), `auto` per provider for
      those whose refusal wording has been confirmed. Replaying is safe only because a
      pre-authorisation refusal billed nothing.
- [x] `keys check [--balance]`, which verdicts and prices a whole pool without spending credit,
      and `keys export`, the CSV second copy.
- [x] Test suite at 263 tests.

---

## Next

Nothing below is committed work — it is the shortlist, and none of it may add an npm
dependency (see [CONTRIBUTING.md](../CONTRIBUTING.md)).

### Likely next

- ~~**Automatic failover.**~~ Shipped, unreleased: `retryEnabled` + `failoverProviders`, and
  the key pool walks accounts within a provider before moving to the next one. It is off by
  default, because a retry can cost a second call — the exception is a pre-authorisation
  refusal, which billed nothing and is the one failure the proxy replays on its own.
- **Live log streaming.** Replace the dashboard's 2-second poll with SSE from the daemon, so
  in-flight requests appear as they start. The renderers are already diff-guarded, so this is
  a transport change.
- **Per-provider header overrides.** A `headers` object per provider, for gateways that need
  something other than the built-in spoofed set — currently editing `core/headers.js` is the
  only way.
- **Model aliasing.** Map a requested model to a per-provider name (`sonnet → claude-sonnet-5`)
  instead of the all-or-nothing pin, so one alias works across providers.
- **`ai-proxy doctor`.** One command that checks the daemon, every provider, the shell block,
  the VS Code list and file permissions, and prints what to fix.

### Considered

- **Usage and cost accounting.** Token counts are already in most responses; summing them per
  provider per day would make the Overview genuinely useful for spend. Needs per-provider
  pricing data, which goes stale.
- **Windows support.** Paths and the shell integration assume POSIX. `%APPDATA%` plus a
  PowerShell profile block would cover it.
- **Request replay.** Re-send a logged request against a different provider from the
  inspector, to compare answers. Requires bodies to be retained longer than the current 4 KB
  in-memory preview.
- **Config profiles.** Named sets of providers (`work`, `personal`) switched in one command.

### Explicitly not planned

- Any authentication scheme for the dashboard. It is loopback-only by design; adding auth
  invites exposing the port, which is the wrong direction.
- Translating between the Anthropic and OpenAI request shapes. Providers that need it should
  be addressed with their own endpoint.
- A frontend framework or a build step.
