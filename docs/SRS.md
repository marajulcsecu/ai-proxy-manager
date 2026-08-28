# Software Requirements Specification

**Project:** AI Proxy Manager
**Version:** 1.1.0 · verified against the code on 2026-08-28

---

## 1. Purpose

Developers using AI coding tools often hold accounts with several API providers — for price,
rate limits, model availability, or redundancy. The tools, however, expect one hardcoded
endpoint. Switching provider means editing shell startup files, restarting daemons and
editing editor configuration, and running two tools against two different providers at once is
not possible at all.

AI Proxy Manager is a local daemon that owns that decision instead. Tools point at it once;
routing is then a CLI command or a dashboard click, applied to the next request.

## 2. Scope

**In scope:** a local HTTP reverse proxy, a provider/model/key store, a CLI, a web dashboard,
request observability, and integration with the shell environment and VS Code's custom model
list.

**Out of scope:** hosting or load-balancing across providers on a per-request basis, response
caching, prompt transformation, billing or usage accounting, multi-user operation, and any
form of remote or networked deployment.

## 3. Definitions

| Term | Meaning |
|:---|:---|
| Provider | A named upstream API: base URL, API key, optional model list |
| Active provider | The provider used when a request does not name one |
| Pinned model | `defaultModel`; every request is rewritten to it |
| Pass-through | No pinned model, so the client's requested model is forwarded unchanged |
| Managed block | The delimited section this tool owns inside a user's shell rc file |

## 4. Functional requirements

### FR-1 Provider store
Any number of providers, each with a name, base URL, API key and model list. Persisted as
JSON at `~/.config/ai-proxy-manager/config.json`, relocatable with `AI_PROXY_HOME`. The
schema is repaired on load: names normalized, models deduplicated, a pinned model always
present in its own list, and a dangling active provider reassigned.

### FR-2 Routing
The credential the client sends selects the destination:

| Token | Destination | Key used |
|:---|:---|:---|
| Contains `dummy`, or shorter than 16 chars | Active provider | Stored |
| `<provider>:dummy` | That provider | Stored |
| `<provider>:<key>` | That provider | The supplied key |
| Any other real-looking key | Active provider | The supplied key |

This satisfies the original requirement that two tools use two providers simultaneously,
without either tool knowing the proxy exists.

### FR-3 Upstream resolution
The scheme, host, port and base path all come from the provider's URL, so remote HTTPS
gateways, path-prefixed gateways (`https://host/openai/v1`) and local HTTP servers
(`http://127.0.0.1:11434/v1`) are all supported. The API version segment is never duplicated
when joining the base path to the client's path.

### FR-4 Model handling
For `POST` requests to a model-bearing endpoint (`/messages`, `/chat/completions`,
`/completions`, `/responses`, `/embeddings`, `/messages/count_tokens`), the `model` field is
rewritten to the pinned model. With no pinned model, the body is untouched. A body that is
not JSON is forwarded as-is. All other paths stream through without being buffered.

### FR-5 Compatibility headers
Both `Authorization: Bearer` and `x-api-key` are sent, since providers disagree on which they
read. Hop-by-hop headers are stripped. First-party SDK headers are sent by default so that
providers fronted by a WAF accept the traffic; this is switchable.

### FR-6 Live reconfiguration
Configuration is re-read per request (cached by mtime). Changing the provider, the model, a
key or a setting — from the CLI, the dashboard, or by editing the file — takes effect on the
next request with no restart. Changing the listening port is the sole exception.

### FR-7 Observability
Every forwarded request records id, timestamp, method, path, provider, resolved upstream URL,
model swap, status, duration, time to first byte, byte counts, streaming flag, calling tool
and error text. Metadata is mirrored to a rotating JSONL file and restored on start.
Request/response body previews (≤4 KB) are held in memory for inspection and can be disabled.
Aggregates: total, p50, p95, error rate, per-provider counts.

### FR-8 Failure reporting
Failures return an Anthropic-shaped error envelope so client tools display them, with a
message naming the corrective action. A provider that accepts a request and then sends
nothing is aborted after a configurable stall timeout rather than hanging the client.
A client disconnect tears down the upstream request.

### FR-9 Connection testing
On request only, a single 1-token request is sent to a provider and the outcome is translated
into a cause: key rejected, out of credit, WAF block, unknown model or URL, rate limit, or a
specific network error. Both the Anthropic and OpenAI request shapes are attempted.

### FR-10 CLI
Provider and model CRUD, active-provider selection, connection testing, daemon lifecycle
(`start [--daemon]`, `stop`, `restart`, `status`, `logs`), port configuration, integrations,
and config export/import. Exit code 1 on any usage error.

### FR-11 Dashboard
A single page on the proxy's own port covering everything the CLI can do: routing state and
metrics, provider management, filterable request history with an inspector, integration
status with one-click apply, and settings. Light and dark themes; keyboard-accessible.

### FR-12 Integrations
`setup-terminal` maintains an idempotent managed block in every shell rc file that exists
(bash, zsh, fish) exporting `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`; re-running
updates it in place, and `remove-terminal` deletes it. `sync-vscode` rewrites the `ai-proxy:`
entries of VS Code's custom model list, one per keyed provider, listing all of its models.

## 5. Non-functional requirements

| | Requirement |
|:---|:---|
| NFR-1 Dependencies | Node.js built-ins only. No runtime or dev dependencies, no build step. |
| NFR-2 Platform | Node.js ≥ 18.17 on Linux and macOS. Tested on 18, 20 and 22. |
| NFR-3 Reach | Listens on `127.0.0.1` only. The dashboard and API additionally reject non-loopback `Host`/`Origin`. |
| NFR-4 Secrets | `config.json` is written atomically at mode `0600` in a `0700` directory. The API masks keys; prompt text is never written to disk. |
| NFR-5 Latency | Proxy overhead is a config stat plus header rewriting; bodies are buffered only when a model rewrite is possible. |
| NFR-6 Streaming | SSE responses stream unbuffered; long generations must not be cut off by server-side timeouts. |
| NFR-7 Resilience | A corrupt config, an unreachable provider or a malformed body must never stop the daemon. |
| NFR-8 Testability | The whole tool is exercisable offline; `AI_PROXY_HOME` isolates every path so tests never touch real data. |
| NFR-9 Maintainability | JSDoc on exported functions; comments record why a line exists. |

## 6. Constraints and assumptions

- Single user, single machine, loopback only. There is no authentication, so exposing the
  port to a network would be unsafe without adding it.
- API keys are stored in plaintext, as the upstream APIs require them at request time. File
  permissions are the protection.
- Upstream providers are assumed to be Anthropic-compatible (or OpenAI-compatible for the
  endpoints listed in FR-4). No translation between the two dialects is performed.
- Providers may change WAF behaviour at any time; the spoofed header set is a maintenance
  surface, not a guarantee.

## 7. Acceptance

`npm test` (47 tests) covers configuration repair and persistence, upstream URL resolution,
the REST contract, the full proxy request flow — including model rewriting, key substitution,
SSE, stalls, unreachable upstreams and the rebinding guard — and the request logger. CI runs
it on Node 18, 20 and 22, plus a CLI and daemon smoke test and a credential scan.
