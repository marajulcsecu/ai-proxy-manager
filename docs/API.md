# REST API Reference

The proxy serves its own management API on the same port as the dashboard and the proxy
itself — by default `http://127.0.0.1:8319`.

**Everything under `/api/` is loopback-only.** A request whose `Host` or `Origin` header is
not a loopback name is answered with `403`, and no CORS wildcard is ever sent. That
combination is what prevents a web page you visit from reading your API keys out of
localhost. See [SECURITY.md](../SECURITY.md).

Every response is JSON with an `ok` boolean. Errors add `error` with a message meant to be
shown to a human:

```json
{ "ok": false, "error": "Provider 'gorouter' not found." }
```

| Status | Meaning |
|:---|:---|
| `200` / `201` | Success |
| `400` | Malformed body, or a value that failed validation |
| `403` | Non-loopback `Host`/`Origin` |
| `404` | Unknown route, or a provider/request that does not exist |
| `405` | Known path, wrong method — the response lists `allowed` methods |
| `409` | Conflict (creating a provider or model that already exists) |

Provider names in a path must match `[a-z0-9._-]+`; model names must be URL-encoded.

---

## Status and metadata

### `GET /api/meta`

Process-level facts, useful for a health check.

```bash
curl -s http://127.0.0.1:8319/api/meta
```

```json
{
  "ok": true,
  "version": "1.1.0",
  "node": "v20.20.2",
  "pid": 801554,
  "configPath": "/home/you/.config/ai-proxy-manager/config.json",
  "port": 8319,
  "configuredPort": 8319,
  "daemon": { "running": true, "pid": 801554, "port": 8319, "startedAt": "2026-08-28T16:50:40.848Z", "stale": false }
}
```

`port` is the port actually bound (which differs from `configuredPort` when the daemon was
started with `--port`).

### `GET /api/status`

Routing state plus traffic metrics. This is what the dashboard tiles read.

```json
{
  "ok": true,
  "configError": null,
  "activeProvider": "tabitoken",
  "providerCount": 4,
  "port": 8319,
  "version": "1.1.0",
  "totalRequests": 15,
  "uptimeSeconds": 39,
  "startedAt": "2026-08-28T16:50:40.848Z",
  "logBufferSize": 15,
  "p50Ms": 215,
  "p95Ms": 626,
  "errorRate": 0.133,
  "errorCount": 2,
  "byProvider": { "tabitoken": { "requests": 14, "errors": 2 } },
  "persistLogs": true
}
```

`ok` is `false` with a populated `configError` when `config.json` cannot be parsed — the
daemon keeps serving so you can see why. Latency and error figures cover requests made
since this process started; rows restored from disk are excluded.

---

## Providers

### `GET /api/providers`

```json
{
  "ok": true,
  "activeProvider": "tabitoken",
  "providers": [
    {
      "name": "tabitoken",
      "url": "https://tabitoken.com/v1",
      "host": "tabitoken.com",
      "urlValid": true,
      "defaultModel": "claude-opus-5-thinking",
      "models": ["claude-opus-5-thinking", "claude-sonnet-5"],
      "hasKey": true,
      "keyPreview": "sk-ab…7f2c",
      "passThrough": false,
      "isActive": true
    }
  ]
}
```

Keys are never returned here — only `hasKey` and a masked `keyPreview`.

### `POST /api/providers`

```bash
curl -s -X POST http://127.0.0.1:8319/api/providers \
  -H 'content-type: application/json' \
  -d '{"name":"gorouter","url":"https://gorouter.app/v1","apiKey":"sk-…","defaultModel":"claude-opus-5"}'
```

| Field | Required | Notes |
|:---|:---|:---|
| `name` | yes | Normalized to lowercase `[a-z0-9._-]` |
| `url` | yes | Any `http`/`https` URL; the scheme may be omitted for a dotted host |
| `apiKey` | no | |
| `defaultModel` | no | Omit or pass `""` for pass-through |
| `models` | no | Array; `defaultModel` is added automatically |

Returns `201` with the normalized `name`, or `409` if the provider already exists (use
`PUT` to change one). Becomes the active provider if none is set.

### `GET /api/providers/:name`

One provider, in the same shape as the list entry.

### `PUT /api/providers/:name`

Partial update — only the fields you send are touched.

```bash
curl -s -X PUT http://127.0.0.1:8319/api/providers/gorouter \
  -H 'content-type: application/json' \
  -d '{"url":"https://gorouter.app/openai/v1"}'
```

**An absent or empty `apiKey` leaves the stored key alone.** To erase it, send
`{"clearKey": true}`.

### `DELETE /api/providers/:name`

Deletes the provider. If it was active, the first remaining provider takes over; the
response reports the new `activeProvider` (or `null`).

### `POST /api/providers/:name/activate`

Makes it the active provider. Takes effect on the very next proxied request.

### `GET /api/providers/:name/key`

The only endpoint that returns a key in clear — it backs the dashboard's *reveal* button.

```json
{ "ok": true, "apiKey": "sk-…" }
```

### `POST /api/providers/:name/test`

Sends **one real request** to the provider (`max_tokens: 1`) and translates the outcome.
Optional body: `{"model": "…"}` to probe a specific model. Tries the Anthropic shape
(`/v1/messages`) first, then the OpenAI shape (`/v1/chat/completions`).

```json
{
  "ok": true,
  "provider": "tabitoken",
  "result": {
    "ok": true,
    "level": "ok",
    "summary": "Key accepted, model responded",
    "statusCode": 200,
    "latencyMs": 204,
    "endpoint": "https://tabitoken.com/v1/messages",
    "model": "claude-opus-5-thinking",
    "detail": "{\"id\":\"msg_016\",…}"
  }
}
```

`ok` on the envelope means the test *ran*; `result.ok` means the provider answered
successfully. `result.level` is `ok`, `warn` or `error`. Representative summaries:

| Situation | `summary` |
|:---|:---|
| 200 | Key accepted, model responded |
| 401 | Unauthorized — API key rejected |
| 402 | Payment required — out of credit |
| 403 | Blocked by the provider WAF (Cloudflare) / Forbidden — key lacks access |
| 404 | Not found — check the base URL or model name |
| 429 | Rate limited — key works, quota exhausted |
| 400/422 | Provider reachable, request rejected (often an unknown model) |
| DNS/TCP/TLS failure | Host not found · Connection refused · Timed out · TLS handshake failed |

---

## Models

### `POST /api/providers/:name/model`

Sets the pinned model. **`{"model": ""}` restores pass-through**, where the client's
requested model is forwarded unchanged. A model that is not in the list is added to it.

### `POST /api/providers/:name/models`

Adds a model. `409` if it is already listed. Becomes the pinned model if none is set.
`POST /api/providers/:name/models/add` is kept as an alias.

### `DELETE /api/providers/:name/models/:model`

Removes a model — URL-encode names containing `/` or `:`.

```bash
curl -s -X DELETE "http://127.0.0.1:8319/api/providers/gorouter/models/$(printf 'vendor/model:v2' | jq -sRr @uri)"
```

If the removed model was the pinned one, the first remaining model takes over (or
pass-through, if the list is now empty). The response reports the resulting
`defaultModel`. `POST /api/providers/:name/models/remove` with `{"model":"…"}` also works.

---

## Request history

### `GET /api/logs`

Newest last. Query parameters: `limit`, `provider`, and
`status` = `ok` | `error` | `pending`.

```json
{
  "ok": true,
  "logs": [
    {
      "id": 14,
      "timestamp": "2026-08-28T16:57:34.221Z",
      "method": "POST",
      "path": "/v1/messages",
      "provider": "tabitoken",
      "targetHost": "tabitoken.com",
      "targetUrl": "https://tabitoken.com/v1/messages",
      "originalModel": "claude-sonnet-4-5",
      "swappedModel": "claude-opus-5-thinking",
      "streaming": false,
      "client": "claude-cli/1.0",
      "bytesIn": 142,
      "bytesOut": 213,
      "statusCode": 200,
      "durationMs": 215,
      "ttfbMs": 208,
      "error": null
    }
  ]
}
```

An entry with `statusCode: null` and no `error` is still in flight. Entries restored from
`requests.jsonl` after a restart carry `"historical": true`.

### `GET /api/logs/:id`

The same record plus `bodies`, which holds up to 4 KB each of the request and response
bodies (`{ request, response, truncated }`). Bodies live in memory only, so a historical
entry has none, and `bodies` is empty when `captureBodies` is off.

### `DELETE /api/logs`

Clears the in-memory history and truncates `requests.jsonl`. Traffic counters keep running.

---

## Settings

### `GET /api/settings`

```json
{
  "ok": true,
  "proxyPort": 8319,
  "settings": {
    "upstreamTimeoutMs": 900000,
    "upstreamFirstByteTimeoutMs": 0,
    "upstreamStallTimeoutMs": 300000,
    "spoofHeaders": true,
    "persistLogs": true,
    "logBufferSize": 200,
    "captureBodies": true,
    "theme": "system"
  },
  "defaults": { "…": "the built-in defaults, for a reset link" }
}
```

### `PUT /api/settings`

Send any subset of the settings keys, plus `proxy_port`.

```bash
curl -s -X PUT http://127.0.0.1:8319/api/settings \
  -H 'content-type: application/json' -d '{"spoofHeaders":false}'
```

Changing `proxy_port` only rewrites the config — the response sets
`restartRequired: true`, and the new port is bound on the next `ai-proxy restart`.

---

## Configuration file

### `GET /api/config/export`

Returns the whole config. **Keys are redacted unless you pass `?redact=0`.**

### `POST /api/config/import`

```json
{ "config": { "providers": { "…": {} } }, "mode": "merge" }
```

`mode` is `merge` (default — keeps providers absent from the file) or `replace`. A provider
whose incoming `apiKey` is empty **keeps the key already stored**, so re-importing a
redacted export is safe. Responds with `imported` and the resulting provider names.

---

## Integrations

### `GET /api/integrations`

Whether the shell block and the VS Code model list are currently applied, and to which
port — this is how the dashboard detects a stale port after you change it.

```json
{
  "ok": true,
  "integrations": {
    "expectedPort": 8319,
    "shell": {
      "applied": true,
      "upToDate": true,
      "files": [
        { "path": "/home/you/.bashrc", "label": "bash", "exists": true, "applied": true, "port": 8319, "upToDate": true }
      ]
    },
    "vscode": {
      "path": "/home/you/.config/Code/User/chatLanguageModels.json",
      "exists": true, "readable": true, "applied": true, "entries": 4
    }
  }
}
```

### `POST` / `DELETE /api/integrations/shell`

Writes or removes the managed block in every shell rc file that exists (bash, zsh, fish).
Idempotent: re-running rewrites the block in place.

### `POST /api/integrations/vscode`

Rewrites `chatLanguageModels.json`, replacing entries whose name starts with `ai-proxy:`
and injecting one per keyed provider with all of its models.

---

## Not part of this API

Everything that is **not** `/api/*` and not a dashboard asset is forwarded to the upstream
provider. Proxy-layer failures use the Anthropic error envelope so client tools render
them:

```json
{ "type": "error", "error": { "type": "upstream_unreachable", "message": "Could not reach …" } }
```

`type` is one of `proxy_error`, `config_error`, `not_configured`, `authentication_error`,
`upstream_unreachable`, `timeout`, `invalid_request_error`.
