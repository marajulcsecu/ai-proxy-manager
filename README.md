<div align="center">

# AI Proxy Manager ⚡

**One local daemon that points your AI coding tools at whichever API provider you want —
switchable from a CLI or a web dashboard, with no restarts and no editing `.bashrc` by hand.**

[![CI](https://github.com/marajulcsecu/ai-proxy-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/marajulcsecu/ai-proxy-manager/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A518.17-5FA04E?logo=node.js&logoColor=white)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-0-4f46e5)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-6d7cff)](LICENSE)

</div>

```
Claude Code ─┐
VS Code ─────┼──► 127.0.0.1:8319 ──► tabitoken / gorouter / ollama / …
curl ────────┘         ▲
                       └── dashboard + REST API on the same port
```

- **Zero dependencies.** Node ≥ 18.17 and nothing else. Clone and run — no install step.
- **Switch provider or model instantly.** Config is re-read per request; nothing restarts.
- **Any upstream.** `https://host/v1`, `https://host/openai/v1`, `http://127.0.0.1:11434/v1`.
- **Two tools, two providers, at once.** Routing follows the key each tool sends.
- **See what happens.** Live request log with latency, model swaps, status and bodies.
- **Test before you trust.** One click sends a real 1-token request and tells you whether the
  key, the URL or the model is the problem.

<div align="center">
  <img src="docs/images/dashboard-overview.png" alt="The Overview view: traffic tiles, the active route and recent requests" width="820">
</div>

---

## Contents

- [Why](#why) · [Install](#install) · [Quick start](#quick-start)
- [Dashboard](#dashboard) · [Commands](#commands) · [How routing works](#how-routing-works)
- [Configuration](#configuration) · [Security](#security) · [Documentation](#documentation)

## Why

AI coding tools hardcode one API endpoint. If you hold accounts with several providers — for
price, rate limits, or model availability — switching means editing shell startup files,
restarting daemons, and editing editor config. Running two tools against two different
providers at the same time is not possible at all.

This daemon owns that decision instead. Your tools point at it once; after that, choosing a
provider is one command or one click, and it applies to the very next request.

## Install

Requires [Node.js](https://nodejs.org) 18.17 or newer.

```bash
git clone https://github.com/marajulcsecu/ai-proxy-manager.git
cd ai-proxy-manager
npm link          # exposes `ai-proxy` on your PATH — there is nothing to install
```

## Quick start

```bash
ai-proxy add-provider tabitoken https://tabitoken.com/v1
ai-proxy set-key     tabitoken sk-your-key…
ai-proxy add-model   tabitoken claude-opus-5-thinking
ai-proxy use         tabitoken

ai-proxy start --daemon        # background; plain `ai-proxy start` stays in the foreground
ai-proxy test                  # send one real request and confirm the provider answers
```

Open **<http://127.0.0.1:8319>** for the dashboard, then wire up your tools:

```bash
ai-proxy setup-terminal        # managed block in ~/.bashrc / ~/.zshrc / config.fish
source ~/.bashrc
claude                         # Claude Code now talks to the proxy
```

`ai-proxy sync-vscode` does the same for VS Code's custom model list. Step-by-step walkthrough:
**[docs/SETUP_GUIDE.md](docs/SETUP_GUIDE.md)**.

## Dashboard

Five views on one page, served from the proxy's own port.

**Providers** — add, edit and delete providers; switch the pinned model from a dropdown;
reveal a masked key; test a provider and see the verdict inline.

<div align="center">
  <img src="docs/images/dashboard-providers.png" alt="The Providers view: provider cards with model dropdowns, masked keys and an inline test result" width="820">
</div>

**Requests** — filterable history with latency, model swaps and status. Select a row for
timings, byte counts, the resolved upstream URL and the full bodies.

<div align="center">
  <img src="docs/images/dashboard-inspector.png" alt="The request inspector showing timings and pretty-printed request and response bodies" width="820">
</div>

**Overview** (traffic, p50/p95 latency, error rate), **Setup** (integration status with
one-click apply) and **Settings** (timeouts, header spoofing, history, export/import) complete
the set.

`Ctrl`/`⌘`+`K` opens a command palette — switch provider, switch model, run a test, jump
anywhere. Light and dark themes follow your system by default. More:
**[docs/DASHBOARD.md](docs/DASHBOARD.md)**.

## Commands

| | |
|:---|:---|
| `list` | Every provider with its models and key state |
| `add-provider <name> <url>` · `remove-provider <name>` | Register / delete a provider |
| `set-key <name> <key>` | Store an API key (file mode 600) |
| `use <name>` | Choose the active provider |
| `test [name] [--model <id>]` | Send one real request and explain the result |
| `set-model <name> <model\|"">` | Pin a model; `""` passes the client's choice through |
| `add-model` · `remove-model` | Manage the model list |
| `start [--daemon] [--port n]` · `stop` · `restart` | Daemon lifecycle |
| `status` · `logs [-n N] [-f]` | State overview · daemon log |
| `set-port <n>` | Change the listening port |
| `setup-terminal` · `remove-terminal` · `sync-vscode` | Tool integrations |
| `export <file> [--with-keys]` · `import <file> [--replace]` | Move config between machines |
| `help` · `version` | |

## How routing works

The API key your tool sends decides where the request goes:

| Token your tool sends | Result |
|:---|:---|
| `dummy-key-managed-by-proxy` | Active provider, stored key |
| `gorouter:dummy` | GoRouter specifically, stored key |
| `gorouter:sk-real-key…` | GoRouter specifically, the key you passed |
| any real-looking key | Active provider, your key passed straight through |

That is what lets two tools use two providers simultaneously, and it is how `sync-vscode`
exposes every provider in one dropdown.

If a provider pins a `defaultModel`, the proxy rewrites the `model` field on the way through
(`/messages`, `/chat/completions`, `/completions`, `/responses`, `/embeddings`,
`/messages/count_tokens`). Leave it empty for pass-through.

Both `Authorization: Bearer` and `x-api-key` are always sent upstream, since providers
disagree about which one they read.

## Configuration

Everything lives in `~/.config/ai-proxy-manager/`:

| File | |
|:---|:---|
| `config.json` | Providers, keys, active provider, port, settings. Mode `0600`. |
| `daemon.pid` | Lets `stop` / `status` / `restart` find the daemon |
| `daemon.log` | Output of a backgrounded daemon; `ai-proxy logs -f` follows it |
| `requests.jsonl` | Request **metadata** history, rotated at 5 MB. Never holds prompts. |

Set `AI_PROXY_HOME` to run an isolated second instance — useful when the main one is carrying
traffic you care about:

```bash
AI_PROXY_HOME=/tmp/scratch ai-proxy start --daemon --port 8321
```

Notable settings (dashboard → Settings, or edit `config.json`): `upstreamTimeoutMs`,
`upstreamStallTimeoutMs` (aborts providers that answer `200` then go silent),
`upstreamFirstByteTimeoutMs` (`0` = off; set it just below a CDN-fronted provider's edge
timeout to fail fast instead of collecting a Cloudflare 524 page), `spoofHeaders`,
`persistLogs`, `captureBodies`, `logBufferSize`, `theme`.

## Security

The dashboard and REST API answer **loopback requests only** — a request whose `Host` or
`Origin` is not a local name is refused, and no CORS wildcard is sent, so a web page you visit
cannot read your keys out of localhost. `config.json` is written atomically at mode `0600`,
the API masks keys, and prompt text is never written to disk.

Full detail, including one historical key exposure in this repository's git history:
**[SECURITY.md](SECURITY.md)**.

## Documentation

| | |
|:---|:---|
| [docs/SETUP_GUIDE.md](docs/SETUP_GUIDE.md) | Set up your first provider, step by step |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | 401s, WAF blocks, hangs, port conflicts |
| [docs/CONTEXT.md](docs/CONTEXT.md) | Architecture and internals — start here to contribute |
| [docs/API.md](docs/API.md) | REST API reference with examples |
| [docs/DASHBOARD.md](docs/DASHBOARD.md) | The dashboard, and the rules for editing it |
| [docs/SRS.md](docs/SRS.md) · [docs/ROADMAP.md](docs/ROADMAP.md) | Requirements · what is shipped and what is next |
| [CONTRIBUTING.md](CONTRIBUTING.md) · [CHANGELOG.md](CHANGELOG.md) | How to help · what changed |

## Development

```bash
npm test          # 47 tests on node:test, no network required
npm run verify    # syntax check + tests + credential scan
```

Never test against the daemon you actually use — point `AI_PROXY_HOME` at a temp directory
first. See [CONTRIBUTING.md](CONTRIBUTING.md).

---

<div align="center">
MIT © MD. MARAJUL HAQUE
</div>
