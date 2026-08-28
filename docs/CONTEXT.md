# AI Proxy Manager — Developer & Agent Context

> **Read this first** if you are a new developer or AI agent working on this project.
> This document contains everything you need to understand, modify, and extend the tool.

---

## Table of Contents

1. [What Is This?](#what-is-this)
2. [Architecture Overview](#architecture-overview)
3. [File Structure](#file-structure)
4. [Configuration](#configuration)
5. [How The Proxy Works](#how-the-proxy-works)
6. [REST API Reference](#rest-api-reference)
7. [CLI Commands](#cli-commands)
8. [Web Dashboard](#web-dashboard)
9. [Integration Points](#integration-points)
10. [Known Issues & Constraints](#known-issues--constraints)
11. [Development Guide](#development-guide)
12. [Security Notes](#security-notes)
13. [Commit History & Design Decisions](#commit-history--design-decisions)

---

## What Is This?

AI Proxy Manager is a **local reverse proxy** that sits between AI coding tools (Claude Code, VS Code Copilot, etc.) and third-party AI API providers (Tabitoken, GoRouter, SeekAI, etc.).

**The problem it solves:**
- AI tools like Claude Code hardcode their API base URL to `api.anthropic.com`
- Users who use third-party providers need a way to redirect traffic
- Managing multiple providers, API keys, and models is tedious
- Some providers (e.g., Tabitoken) block direct `curl` requests via Cloudflare WAF

**What it does:**
- Runs a local HTTP server on `http://127.0.0.1:8319`
- Intercepts API requests and forwards them to the configured upstream provider
- Rewrites API keys, model names, and headers transparently
- Spoofs request headers to bypass Cloudflare WAF blocks
- Provides a web dashboard for visual management
- Supports multiple providers with instant switching
- Supports multiple models per provider

**Tech stack:** Pure Node.js (zero npm dependencies), vanilla HTML/CSS/JS dashboard.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                  Claude Code / VS Code                  │
│            sends requests to 127.0.0.1:8319             │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│              Node.js HTTP Server (:8319)                 │
│                                                         │
│  Layer 1: Dashboard    │  GET /              → HTML     │
│                        │  GET /style.css     → CSS      │
│                        │  GET /app.js        → JS       │
│  ──────────────────────┼──────────────────────────────  │
│  Layer 2: REST API     │  /api/providers     → CRUD     │
│                        │  /api/status        → Health   │
│                        │  /api/logs          → Logs     │
│  ──────────────────────┼──────────────────────────────  │
│  Layer 3: Proxy Engine │  /v1/messages       → Forward  │
│                        │  /v1/chat/*         → Forward  │
│                        │  HEAD /             → Forward  │
└────────────────────────┼────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│         Upstream Provider (e.g., tabitoken.com)          │
│         HTTPS :443 with spoofed headers                  │
└─────────────────────────────────────────────────────────┘
```

Request routing priority:
1. `/` or `/index.html` or static files → **Dashboard** (serve HTML/CSS/JS)
2. `/api/*` → **REST API** (provider management, status, logs)
3. Everything else → **Proxy Engine** (forward to upstream provider)

---

## File Structure

```
ai-proxy-manager/
├── package.json                          # type:module, bin:"ai-proxy", zero deps
├── README.md                             # User-facing tutorial
│
├── docs/
│   ├── CONTEXT.md                        # ← THIS FILE (developer/agent reference)
│   ├── SRS.md                            # System Requirements Specification
│   ├── ROADMAP.md                        # Phase-based development roadmap
│   ├── SETUP_GUIDE.md                    # Step-by-step provider setup guide
│   └── DASHBOARD_PLAN.md                 # Dashboard implementation plan
│
└── src/
    ├── cli.js                            # CLI entry point (#!/usr/bin/env node)
    ├── index.js                          # Module re-exports
    │
    ├── core/
    │   ├── configManager.js              # loadConfig() / saveConfig() → config.json
    │   ├── proxyServer.js                # HTTP server with 3-layer routing
    │   ├── apiRoutes.js                  # REST API handler (/api/*)
    │   └── requestLogger.js              # In-memory circular buffer (50 entries)
    │
    ├── controllers/
    │   ├── providerController.js         # addProvider, setKey, setModel, addModel, etc.
    │   └── integrationController.js      # syncVsCode(), setupTerminal()
    │
    ├── dashboard/
    │   ├── index.html                    # Single-page dashboard
    │   ├── style.css                     # Dark theme (GitHub-inspired)
    │   └── app.js                        # Client-side polling & rendering
    │
    └── utils/
        └── logger.js                     # Color-coded console output utility
```

---

## Configuration

**Config file location:** `~/.config/ai-proxy-manager/config.json`

**Schema:**

```json
{
  "providers": {
    "<provider-name>": {
      "url": "string",           // Base URL (e.g., "https://tabitoken.com/v1")
      "apiKey": "string",        // API key (e.g., "sk-...")
      "defaultModel": "string",  // Currently active model (e.g., "claude-opus-5-thinking")
      "models": ["string"]       // Optional. List of available models for this provider
    }
  },
  "active_provider": "string",   // Name of the currently active provider
  "proxy_port": 8319             // Port the proxy listens on
}
```

**Important notes:**
- Config is read from disk on EVERY incoming request (no caching). This allows instant provider/model switching without restarting the server.
- The `models` array is optional for backward compatibility. Older providers that were created before the multi-model feature won't have it — the code handles this gracefully with `provider.models || []`.
- If `defaultModel` is empty or missing, the proxy uses **pass-through mode** — it does NOT rewrite the model field, forwarding whatever the client originally sent.

---

## How The Proxy Works

### Request Flow (step by step)

When Claude Code sends `POST http://127.0.0.1:8319/v1/messages`:

1. **Read config** — `loadConfig()` reads `config.json` from disk (every request).
2. **Extract token** — Reads `Authorization: Bearer <token>` or `x-api-key` header.
3. **Smart routing** — If token is `providerName:apiKey` format (e.g., `tabitoken:sk-123`), route to that specific provider. Otherwise, route to `active_provider`.
4. **Resolve API key** — If the token contains `"dummy"` or is too short (< 15 chars), replace it with the stored `apiKey` from config. Otherwise, pass the client's key through.
5. **Build outgoing request** — Target: `https://<provider-host>:443`. Apply spoofed headers.
6. **Inject auth headers** — ALWAYS sets BOTH `Authorization: Bearer <key>` AND `x-api-key: <key>` for maximum provider compatibility.
7. **Model rewriting** (POST `/messages` only) — If `defaultModel` is set, replace the `model` field in the JSON body. If empty, pass through.
8. **Forward & stream** — Pipe the response back to the client (supports SSE streaming).
9. **Log** — Record the request in the in-memory circular buffer.

### Spoofed Headers

Some providers (Tabitoken) use Cloudflare WAF that blocks direct API requests. The proxy spoofs these headers to bypass it:

```javascript
const SPOOFED_HEADERS = {
  'user-agent': 'codex_cli_rs/0.101.0',
  'anthropic-version': '2023-06-01',
  'x-stainless-lang': 'js',
  'x-stainless-package-version': '0.24.0',
  'x-stainless-os': 'linux',
  'x-stainless-arch': 'x64',
  'x-stainless-runtime': 'node',
  'x-stainless-runtime-version': 'v20.0.0'
};
```

**Location:** `src/core/proxyServer.js` lines 21-30.

### Dual Header Injection

The proxy always sends BOTH:
- `Authorization: Bearer <key>` — Required by Tabitoken, GoRouter
- `x-api-key: <key>` — Required by official Anthropic SDK

This ensures compatibility across all providers without per-provider configuration.

---

## REST API Reference

All endpoints return JSON. All endpoints accept `Content-Type: application/json`.

### Provider Management

| Method | Endpoint | Body | Description |
|:---|:---|:---|:---|
| `GET` | `/api/providers` | — | List all providers (name, url, models, hasKey, isActive) |
| `POST` | `/api/providers` | `{ name, url, apiKey?, defaultModel?, models? }` | Create a new provider |
| `PUT` | `/api/providers/:name` | `{ url?, apiKey?, defaultModel?, models? }` | Update provider fields |
| `DELETE` | `/api/providers/:name` | — | Delete a provider |
| `POST` | `/api/providers/:name/activate` | — | Set as active provider |

### Model Management

| Method | Endpoint | Body | Description |
|:---|:---|:---|:---|
| `POST` | `/api/providers/:name/model` | `{ model }` | Switch active model (also adds to models list if new) |
| `POST` | `/api/providers/:name/models/add` | `{ model }` | Add a model to the provider's list |
| `POST` | `/api/providers/:name/models/remove` | `{ model }` | Remove a model from the provider's list |

### Status & Logs

| Method | Endpoint | Description |
|:---|:---|:---|
| `GET` | `/api/status` | Returns `{ ok, activeProvider, providerCount, totalRequests, uptimeSeconds }` |
| `GET` | `/api/logs` | Returns `{ ok, logs: [...] }` — last 50 proxied requests |

### Response Format

All responses follow: `{ ok: true/false, message?: string, error?: string, ... }`

---

## CLI Commands

The tool is globally installed as `ai-proxy` (via `npm link`).

```
ai-proxy list                              Show all registered providers
ai-proxy add-provider <name> <url>         Register a new AI provider
ai-proxy set-key <name> <api-key>          Set the API key for a provider
ai-proxy set-model <name> <model-name>     Set the default model for a provider
ai-proxy add-model <name> <model-name>     Add a model to a provider's list
ai-proxy remove-model <name> <model-name>  Remove a model from a provider's list
ai-proxy use <name>                        Set a provider as the active default
ai-proxy start                             Start the Smart Proxy Server + Dashboard
ai-proxy sync-vscode                       Inject providers into VS Code GUI
ai-proxy setup-terminal                    Configure ~/.bashrc for Claude Code
ai-proxy help                              Show help text
```

---

## Web Dashboard

**URL:** `http://127.0.0.1:8319` (served by the same proxy server)

### Sections:
1. **Stats Bar** — Active provider, provider count, total requests, uptime
2. **Provider Cards** — Visual grid with:
   - Model dropdown (switch models instantly)
   - Model tags with ✕ delete buttons
   - "⚡ Use This" / "✏️ Edit" / "+ Model" / "🗑️" actions
3. **Add Provider Modal** — Form: name, URL, API key, default model
4. **Add Model Modal** — Quick-add a model to any provider
5. **Live Request Log** — Auto-updating table of proxied requests
6. **Claude Code Setup** — Instructions for terminal configuration

### Technical Details:
- **Polling:** Dashboard polls `/api/status`, `/api/providers`, and `/api/logs` every 2 seconds.
- **No WebSocket:** MVP uses simple polling. Can upgrade to WebSocket/SSE later.
- **Zero dependencies:** Pure vanilla HTML/CSS/JS, no build tools.
- **Provider data cache:** Provider data is stored in `providersCache` JS variable — edit buttons reference data from this cache, NOT from inline onclick attributes (this avoids HTML attribute escaping issues).

---

## Integration Points

### Claude Code (Primary Target)

Claude Code reads `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` environment variables.

The `ai-proxy setup-terminal` command injects this into `~/.bashrc`:
```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:8319"
export ANTHROPIC_AUTH_TOKEN="dummy-key-managed-by-proxy"
```

Claude Code then sends all requests to the proxy. The proxy resolves the real API key from config (the `"dummy"` token triggers database lookup).

### VS Code (sync-vscode)

The `ai-proxy sync-vscode` command injects provider blocks into:
`~/.config/Code/User/chatLanguageModels.json`

Each block uses the `providerName:apiKey` token format which the proxy's smart routing recognizes to route to the correct provider.

### OpenCode

**NOT integrated.** The user explicitly stated OpenCode works directly with provider APIs and doesn't need the proxy.

---

## Known Issues & Constraints

### SeekAI Backend Hangs
- **Status:** Server-side issue, NOT a proxy bug.
- **Behavior:** SeekAI returns HTTP 200 + `message_start` + `ping` SSE events, then never sends actual content tokens. The stream hangs indefinitely.
- **Affected models:** ALL tested models (`claude-fable-5`, `claude-opus-5`, `claude-sonnet-5`, `gpt-5-5`, `deepseek-v4-flash`).
- **Workaround:** Use a different provider.

### Tabitoken Cloudflare Block
- Direct `curl` requests to Tabitoken get HTTP 403 ("You have been blocked").
- The proxy's spoofed headers bypass this. If Cloudflare changes rules, update the `SPOOFED_HEADERS` in `proxyServer.js`.

### Config Read on Every Request
- `loadConfig()` does `fs.readFileSync()` on every incoming request. This enables instant switching but is not optimal under high load.
- For the current use case (local single-user proxy), this is fine.

### In-Memory Logs Only
- Request logs are stored in a circular buffer (max 50) and reset when the server restarts.
- There is no persistent log storage.

### No Authentication on Dashboard
- The dashboard is served on localhost only (`127.0.0.1`). No auth is needed.
- If the proxy is ever exposed to a network, authentication MUST be added.

---

## Development Guide

### Prerequisites
- Node.js v18+ (ES modules support required)
- No `npm install` needed (zero dependencies)

### Local Setup
```bash
git clone https://github.com/marajulcsecu/ai-proxy-manager.git
cd ai-proxy-manager
npm link          # Makes "ai-proxy" available globally
ai-proxy start    # Launches proxy + dashboard on :8319
```

### Making Changes

1. **Config Manager** (`configManager.js`) — Only modify if changing the config schema.
2. **Provider Controller** (`providerController.js`) — Add new CLI commands for provider/model management.
3. **API Routes** (`apiRoutes.js`) — Add new `/api/*` endpoints here. Must return `true` if handled.
4. **Proxy Server** (`proxyServer.js`) — Core routing logic. Be careful with:
   - Header injection (lines 130-135)
   - Model rewriting (lines 153-162)
   - Spoofed headers (lines 21-30)
5. **Dashboard** — Pure client-side JS in `dashboard/app.js`. All data comes from polling the REST API.

### Key Design Patterns

- **Config is the single source of truth.** Both CLI and dashboard modify the same `config.json`. The proxy reads it on every request.
- **No process restart needed.** Any change to config takes effect on the next request.
- **Backward compatibility.** New fields (like `models[]`) are optional. Code always handles their absence with `|| []` or similar fallbacks.
- **Dual interface.** Every operation available in the dashboard is also available via CLI, and vice versa.

### Testing

Currently no automated test suite. Manual testing:
```bash
# Start the proxy
ai-proxy start

# Test API
curl http://127.0.0.1:8319/api/status
curl http://127.0.0.1:8319/api/providers

# Test proxy (forwards to active provider)
curl http://127.0.0.1:8319/v1/messages \
  -H "Authorization: Bearer dummy" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-opus-5","messages":[{"role":"user","content":"Hi"}]}'
```

---

## Security Notes

> **CRITICAL:** NEVER commit real API keys to the repository.

- A real API key was accidentally committed to `SETUP_GUIDE.md` in an early commit. It exists in git history. The key was revoked.
- API keys are stored in `~/.config/ai-proxy-manager/config.json` on the local machine only.
- The dashboard's GET `/api/providers` endpoint does NOT return API keys — only a `hasKey: true/false` flag.
- The PUT endpoint accepts `apiKey` updates but the dashboard only sends it when the user explicitly enters a new one.

---

## Commit History & Design Decisions

| Commit | What & Why |
|:---|:---|
| `9e878f3` | Initial modular architecture (configManager + providerController) |
| `4af2aa4` | Proxy engine + integrations (setupTerminal, syncVsCode) |
| `7e535aa` | JSDoc syntax error fix + README documentation |
| `14c5c33` | Setup guide (accidentally included real API key) |
| `497c34e` | Redacted the leaked API key |
| `676bbcb` | Added dual auth headers (both `Authorization` + `x-api-key`) — Tabitoken requires `Authorization: Bearer` while Anthropic SDK uses `x-api-key` |
| `21f3ae3` | Fixed dummy-key parsing — `setup-terminal` generated `dummy-key-managed-by-proxy` but proxy checked for `dummy-token` |
| `09fd2ae` | Web dashboard MVP — REST API, static file serving, live logs, model pass-through |
| `61bb8e0` | Multi-model support — `models[]` array per provider, model dropdown, CLI add/remove-model |
| `8c661fa` | Fixed edit button (JSON double-quotes broke HTML onclick), added model deletion from cards |

### Key Design Decision: Why Single Port?

The dashboard, REST API, and proxy all run on the same port (8319). This was chosen because:
1. **Zero config for users.** No "start the dashboard on port X and the proxy on port Y".
2. **Same-origin requests.** The dashboard JS calls `/api/*` endpoints without CORS issues.
3. **Single process.** One `ai-proxy start` command runs everything.

### Key Design Decision: Why Zero Dependencies?

The entire project uses only Node.js built-in modules (`http`, `https`, `fs`, `path`, `os`). This was chosen because:
1. **No `npm install` step.** Clone and run.
2. **No supply chain risk.** No third-party packages to audit.
3. **Portable.** Works on any system with Node.js 18+.

---

*Last updated: 2026-08-28*
