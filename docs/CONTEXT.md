# AI Proxy Manager — Developer & Agent Context

> **Read this first** if you are a new developer or AI agent working on this project.
> Last verified against the code on 2026-08-28 (v1.1.0).

---

## 1. What this is

A **local reverse proxy** between AI coding tools (Claude Code, VS Code Copilot, …) and
third-party Anthropic-compatible API providers (Tabitoken, GoRouter, SeekAI, …).

It solves four problems:

| Problem | How this solves it |
|:---|:---|
| Tools hardcode `api.anthropic.com` | They talk to `127.0.0.1:8319` instead; the proxy forwards |
| Juggling keys, URLs and model names | One JSON config, switchable from CLI or dashboard without a restart |
| Some providers block non-SDK traffic | Requests carry first-party SDK headers upstream |
| No visibility into what is happening | Live dashboard with request history, latency and per-provider tests |

**Tech stack:** Node.js ≥18.17, zero npm dependencies, vanilla HTML/CSS/JS dashboard,
tests on the built-in `node:test` runner.

**The rest of the doc set:** [API.md](API.md) (REST reference with examples) ·
[DASHBOARD.md](DASHBOARD.md) (the client, and the rules for editing it) ·
[TROUBLESHOOTING.md](TROUBLESHOOTING.md) · [SETUP_GUIDE.md](SETUP_GUIDE.md) ·
[SRS.md](SRS.md) · [ROADMAP.md](ROADMAP.md) ·
[../CONTRIBUTING.md](../CONTRIBUTING.md) · [../SECURITY.md](../SECURITY.md) ·
[../CHANGELOG.md](../CHANGELOG.md)

> ⚠️ **If you are an agent working in this repo:** the daemon on port 8319 may be routing
> the traffic of the very session you are running in. Never `ai-proxy stop`/`restart` or
> kill that port. Test with `AI_PROXY_HOME=/tmp/whatever ai-proxy start --daemon --port 8321`.

---

## 2. Architecture

```
 Claude Code / VS Code / curl
            │  http://127.0.0.1:8319
            ▼
┌──────────────────────────────────────────────────────────────┐
│                  http.Server (one port)                      │
│                                                              │
│  1. Dashboard   "/", /style.css, /app.js, /favicon.svg       │
│  2. REST API    /api/*                                       │
│  3. Proxy       everything else → upstream provider           │
│                                                              │
│  Layers 1 and 2 are localhost-only (Host/Origin checked).    │
└───────────────────────────┬──────────────────────────────────┘
                            ▼
        provider.url  (http or https, any port, any base path)
```

Routing is decided on the **pathname only**, so `?query=strings` never leak into the
proxy layer.

### Module map

```
src/
├── cli.js                      Argument parsing → controllers. Only place that exits.
├── index.js                    Re-exports for programmatic use.
│
├── core/
│   ├── paths.js                Every on-disk path. Honours $AI_PROXY_HOME.
│   ├── configManager.js        load/save/normalize config. Atomic writes, mtime cache.
│   ├── upstream.js             provider URL + request path → concrete target.
│   ├── headers.js              Header spoofing, hop-by-hop stripping, auth injection.
│   ├── proxyServer.js          The server: 3-layer routing, streaming, timeouts.
│   ├── apiRoutes.js            REST API (table-driven router).
│   ├── requestLogger.js        Ring buffer + metrics + JSONL mirror.
│   ├── providerTester.js       One real request to a provider, mapped to a verdict.
│   ├── daemon.js               PID file, start/stop/status, log tailing.
│   └── runtime.js              Facts about the running process (the bound port).
│
├── controllers/
│   ├── providerController.js   Provider/model CRUD used by the CLI.
│   └── integrationController.js Shell rc + VS Code integration (idempotent blocks).
│
├── utils/
│   ├── logger.js               Console output; colour only on a TTY.
│   ├── version.js              Reads package.json once.
│   └── errors.js               UsageError (CLI exit code 1).
│
└── dashboard/                  index.html · style.css · app.js · favicon.svg
```

---

## 3. Configuration

**Location:** `~/.config/ai-proxy-manager/config.json` — or `$AI_PROXY_HOME/config.json`
when that variable is set (used by the tests so they never touch real data).

```json
{
  "providers": {
    "tabitoken": {
      "url": "https://tabitoken.com/v1",
      "apiKey": "sk-…",
      "defaultModel": "claude-opus-5-thinking",
      "models": ["claude-opus-5-thinking", "claude-sonnet-5"]
    }
  },
  "active_provider": "tabitoken",
  "proxy_port": 8319,
  "settings": {
    "upstreamTimeoutMs": 900000,
    "upstreamStallTimeoutMs": 300000,
    "spoofHeaders": true,
    "persistLogs": true,
    "logBufferSize": 200,
    "captureBodies": true,
    "theme": "system"
  }
}
```

Rules enforced by `normalizeConfig()` on every read (and written back once by
`migrateConfig()` at start-up):

- Provider names are lowercased and stripped to `[a-z0-9._-]`.
- `models` is deduplicated, and `defaultModel` is always present in it.
  *(A `defaultModel` missing from `models` used to make the dashboard dropdown display
  the wrong model as selected.)*
- `active_provider` must exist; otherwise it falls back to the first provider or `null`.
- `proxy_port` must be 1–65535; `logBufferSize` is clamped to 10–5000; `theme` to
  `system|light|dark`.

**An empty `defaultModel` means pass-through** — the client's requested model is forwarded
unchanged.

Other files in the same directory:

| File | Purpose |
|:---|:---|
| `daemon.pid` | JSON `{pid, port, startedAt}`; drives `stop`/`status`/`restart` |
| `daemon.log` | stdout/stderr of a backgrounded daemon; `ai-proxy logs` tails it |
| `requests.jsonl` | Request **metadata** history, rotated at 5 MB. Never contains bodies |

The config file is written atomically (temp file + rename) with mode `0600`, and the
directory with `0700`, because it holds API keys.

---

## 4. How a proxied request flows

`POST http://127.0.0.1:8319/v1/messages`

1. **Split** the URL into pathname + query. Dashboard assets and `/api/*` are handled
   first; everything else is proxied.
2. **Load config** (`tryLoadConfig()` — cached by mtime, never throws on the request path,
   so a corrupt file returns a 500 instead of killing the daemon).
3. **Extract the token** from `Authorization: Bearer …`, `x-api-key` or `api-key`.
4. **Route** (`resolveRoute`): a `provider:key` token targets that provider explicitly;
   anything else uses `active_provider`. A key containing `dummy`, or shorter than 16
   characters, is replaced by the stored key.
5. **Resolve the target** (`resolveUpstream`): scheme, host, port and base path all come
   from `provider.url`, so `http://127.0.0.1:11434/v1` (Ollama) and
   `https://host/openai/v1` (path-prefixed gateway) both work. The API version segment is
   never duplicated.
6. **Build headers** (`buildUpstreamHeaders`): drop hop-by-hop headers and the client's
   auth, apply `SPOOFED_HEADERS` (unless `spoofHeaders` is off), set `Host`, then set
   **both** `Authorization: Bearer <key>` and `x-api-key: <key>`.
7. **Rewrite the model** — only for `POST` to a model-bearing path (`/messages`,
   `/chat/completions`, `/completions`, `/responses`, `/embeddings`,
   `/messages/count_tokens`) and only when `defaultModel` is set. A body that is not JSON
   is forwarded untouched rather than rejected. Other paths stream straight through
   without buffering.
8. **Forward and stream back**, preserving SSE. Two timers protect the client:
   `upstreamTimeoutMs` (hard ceiling) and `upstreamStallTimeoutMs` (socket inactivity →
   the "answers 200 then goes silent forever" failure mode). A client disconnect destroys
   the upstream request.
9. **Log** id, timestamps, provider, model swap, status, duration, TTFB, byte counts,
   streaming flag and any error.

Failures return an Anthropic-shaped envelope so client tools display them:

```json
{ "type": "error", "error": { "type": "upstream_unreachable", "message": "…" } }
```

`type` is one of `proxy_error`, `config_error`, `not_configured`,
`authentication_error`, `upstream_unreachable`, `timeout`, `invalid_request_error`.

---

## 5. REST API

Full reference with request and response examples: **[API.md](API.md)**. Summary:

Localhost only: a request whose `Host` or `Origin` is not a loopback name gets `403`.
There is no CORS wildcard — that combination is what stops any website you visit from
reading your API keys out of `127.0.0.1:8319` via DNS rebinding.

| Method | Endpoint | Notes |
|:---|:---|:---|
| `GET` | `/api/meta` | version, node, pid, config path, bound port, daemon state |
| `GET` | `/api/status` | active provider, counts, p50/p95, error rate, uptime |
| `GET` | `/api/providers` | list; keys are masked (`keyPreview`), never returned raw |
| `POST` | `/api/providers` | `{name, url, apiKey?, defaultModel?, models?}` → 409 if it exists |
| `GET`·`PUT`·`DELETE` | `/api/providers/:name` | PUT with no `apiKey` keeps the stored key; `clearKey:true` erases it |
| `POST` | `/api/providers/:name/activate` | |
| `GET` | `/api/providers/:name/key` | the one endpoint that returns a key in clear |
| `POST` | `/api/providers/:name/test` | one real upstream request; `{model?}` |
| `POST` | `/api/providers/:name/model` | `{model}`; `""` restores pass-through |
| `POST` | `/api/providers/:name/models` | add (`/models/add` kept as an alias) |
| `DELETE` | `/api/providers/:name/models/:model` | URL-encode the model; `POST /models/remove` also works |
| `GET` | `/api/logs` | `?limit=&provider=&status=ok\|error\|pending` |
| `GET` | `/api/logs/:id` | one request plus in-memory body previews |
| `DELETE` | `/api/logs` | clear history and truncate the JSONL file |
| `GET`·`PUT` | `/api/settings` | PUT reports `restartRequired` when the port changed |
| `GET` | `/api/config/export` | `?redact=0` to include keys |
| `POST` | `/api/config/import` | `{config, mode:'merge'\|'replace'}`; an empty key never overwrites a stored one |
| `GET` | `/api/integrations` | whether the shell block and VS Code list are applied |
| `POST`·`DELETE` | `/api/integrations/shell` | write / remove the managed rc block |
| `POST` | `/api/integrations/vscode` | sync the model list |

Every response is `{ok: boolean, …}`. Unknown routes return `404`; a known path with the
wrong method returns `405` plus the allowed methods.

---

## 6. CLI

```
Providers     list · add-provider <name> <url> · remove-provider <name> · set-key <name> <key>
              use <name> · test [name] [--model <id>]
Models        set-model <name> <model|""> · add-model <name> <model> · remove-model <name> <model>
Daemon        start [--daemon] [--port n] · stop · restart · status · logs [-n N] [-f] · set-port <n>
Integrations  setup-terminal · remove-terminal · sync-vscode
Config        export <file> [--with-keys] · import <file> [--replace] · help · version
```

- `start` runs in the foreground; `--daemon` detaches and writes `daemon.pid`.
  Either way `ai-proxy stop` finds it.
- `status` prints daemon state, active route, provider counts, live traffic (fetched from
  `/api/status`) and whether each integration is applied.
- Commands throw `UsageError`; `cli.js` is the only place that sets the exit code.

---

## 7. Dashboard

`http://127.0.0.1:8319` — five views (Overview, Providers, Requests, Setup, Settings) in
one page, no build step, no framework. Screenshots and a per-view tour:
**[DASHBOARD.md](DASHBOARD.md)**.

Conventions to preserve when editing `dashboard/app.js`:

- **No inline `onclick`.** Everything is delegated from `document` via `data-action`
  attributes mapped in the `ACTIONS` table. Two historical bugs came from quoting values
  into inline handlers.
- **Renders are signature-guarded.** Each render function compares a JSON signature of
  its inputs and returns early when nothing changed, so the 2-second poll cannot steal
  focus. The provider grid additionally refuses to redraw while a dialog is open or an
  open `<select>` has focus, and restores focus by `data-focus-key`.
- **Polling pauses** when `document.hidden`.
- **Dialogs** go through `showOverlay`/`hideOverlay`: focus trap, Escape, focus restore.
  `confirmDialog()` replaces `window.confirm`; dismissing it resolves `false` via the
  `overlay:close` event.
- **Theme** is `data-theme` on `<html>`, cycled `system → light → dark`, stored in
  `localStorage` and mirrored into `config.json` so the CLI and other browsers agree.
- `Ctrl/Cmd+K` opens a command palette built from the current provider list.

---

## 8. Integrations

### Shell (Claude Code)

`setup-terminal` writes a **managed block** to every shell rc file that exists
(`~/.bashrc`, `~/.zshrc`, `~/.config/fish/config.fish` — fish gets `set -gx` syntax):

```bash
# --- AI Proxy Manager (managed block) ---
export ANTHROPIC_BASE_URL="http://127.0.0.1:8319"
export ANTHROPIC_AUTH_TOKEN="dummy-key-managed-by-proxy"
# --- end AI Proxy Manager ---
```

Re-running rewrites the block in place (so a port change is picked up) instead of
refusing or appending a second copy. The regex also matches the older hand-written block
format, so upgrades are clean. `remove-terminal` strips it.

### VS Code

`sync-vscode` rewrites `~/.config/Code/User/chatLanguageModels.json`, replacing any
entry whose `name` starts with `ai-proxy:` and injecting one entry per provider that has
a key, listing **all** of its models. The `apiKey` is `"<provider>:<real key>"`, which the
proxy's router uses to target that provider regardless of which one is active.

---

## 9. Development

```bash
npm link                 # exposes `ai-proxy` globally, no install step
npm test                 # node:test, 47 tests, no network access needed
npm run verify           # syntax check + tests + credential scan (what CI runs)
AI_PROXY_HOME=/tmp/x ai-proxy start --daemon --port 8321   # isolated instance
```

`scripts/check-secrets.sh` is the credential scanner; install it as a pre-commit hook with
`ln -sf ../../scripts/check-secrets.sh .git/hooks/pre-commit`. Pass `--all` to sweep every
commit in history.

**Tests** (`tests/`) each set `AI_PROXY_HOME` to a fresh temp directory *before*
dynamically importing the modules under test, so they never read or write real config.

| File | Covers |
|:---|:---|
| `config.test.js` | normalization/repair, atomic writes, 0600 mode, cache, corrupt files |
| `upstream.test.js` | URL parsing, version-segment joining, model-bearing paths |
| `proxy.test.js` | full request flow against a local fake upstream, incl. stalls and SSE |
| `api.test.js` | REST contract, validation, export/import, rebinding guard |
| `requestLogger.test.js` | ring buffer, metrics, persistence, body handling |

When touching the proxy engine, the load-bearing invariants are: config is re-read per
request; bodies are only buffered for model-bearing POSTs; both auth headers are always
sent; and every code path either finishes or errors its log entry.

---

## 10. Security notes

- `config.json` is `0600` inside a `0700` directory. Never commit it (`.gitignore` covers it).
- The dashboard and API only answer loopback `Host`/`Origin` values; no CORS wildcard.
- `GET /api/providers` masks keys. Only `/api/providers/:name/key` returns one, for the
  dashboard's "reveal" button.
- Request/response **body previews live in memory only** and are capped at 4 KB. Prompt
  text is never written to `requests.jsonl`. Turn capture off entirely with
  `captureBodies: false`.
- `export` redacts keys unless `--with-keys` / `?redact=0` is passed.
- A real API key was committed to `docs/SETUP_GUIDE.md` in an early commit and is still in
  git history. It was revoked.

---

## 11. Known constraints

- **Config is read on every request** (mtime-cached, so usually no disk I/O). This is what
  makes instant switching work; it is not tuned for high throughput.
- **A provider that answers 200 and then streams nothing** (observed with SeekAI) is now
  aborted after `upstreamStallTimeoutMs` with a logged reason instead of hanging forever.
  It is still a provider-side fault.
- **Cloudflare-fronted providers** depend on `SPOOFED_HEADERS` in `core/headers.js`. If a
  provider starts returning 403, that list is what needs updating.
- **No auth on the dashboard.** It is loopback-only by design; adding a listen address
  beyond `127.0.0.1` would require real authentication first.
- **History is metadata-only across restarts** — bodies are gone after a restart by design.
- **POSIX only.** Paths (`~/.config/…`) and the shell integration assume Linux or macOS;
  Windows would need `%APPDATA%` handling and a PowerShell profile block.
