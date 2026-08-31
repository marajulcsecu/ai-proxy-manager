# Troubleshooting

Start here before filing an issue. Three commands answer most questions:

```bash
ai-proxy status          # daemon, active route, traffic, integration state
ai-proxy test            # send one real request to the active provider
ai-proxy logs -n 50      # what the daemon actually did
```

The dashboard's **Requests** view is the same information with a click-through to the exact
request and response bodies.

---

## The client tool cannot connect at all

**Symptom:** Claude Code reports a connection error, or `curl` gets "connection refused".

1. Is the daemon running? `ai-proxy status`. If not: `ai-proxy start --daemon`.
2. Is your shell pointed at the right port?
   ```bash
   echo "$ANTHROPIC_BASE_URL"        # expect http://127.0.0.1:8319
   ```
   Empty means the environment block was never loaded — run `ai-proxy setup-terminal`, then
   open a new terminal (or `source ~/.bashrc`).
3. Did you change the port? `ai-proxy set-port` rewrites the config but does **not** update
   your shell. Re-run `ai-proxy setup-terminal` and reload the shell. The dashboard's Setup
   view flags this mismatch explicitly.

## `Port 8319 is already in use`

The daemon is probably already up. The error names the process holding the port:

```
✖ Port 8319 is already in use.
ℹ Held by PID 801554 (node …/ai-proxy start)
ℹ Stop it with: ai-proxy stop   (or: kill 801554)
```

If `ai-proxy stop` says nothing is running while the port is still held, the PID file is
gone (for example the daemon was killed with `-9`). Kill the PID the message names, then
start again.

> If an AI coding session is routing through this proxy, stopping it disconnects that
> session. Use a second instance for experiments:
> `AI_PROXY_HOME=/tmp/scratch ai-proxy start --daemon --port 8321`.

## 401 Unauthorized

```bash
ai-proxy test <provider>
```

- **"Unauthorized — API key rejected"** → the stored key is wrong or revoked:
  `ai-proxy set-key <provider> sk-…`.
- **"No API key saved for this provider"** → nothing is stored at all. Check `ai-proxy list`;
  a provider shows `key not set`.
- If your tool sends a *real* key of its own, the proxy forwards that one instead of the
  stored key. Only a token containing `dummy`, or shorter than 16 characters, triggers the
  database lookup. Use `dummy-key-managed-by-proxy`, or `<provider>:dummy` to pin a
  provider.

## 403, or an HTML "you have been blocked" page

The provider sits behind a WAF that rejects non-SDK traffic. The proxy already sends
first-party SDK headers; if a provider has tightened its rules, the header set in
`src/core/headers.js` (`SPOOFED_HEADERS`) is what needs updating.

To check whether spoofing is the problem, turn it off and compare:
Settings → **Spoof SDK headers**, or `PUT /api/settings {"spoofHeaders": false}`.

## 404 from the provider

Almost always the base URL or the model name.

- The base URL must include the API version segment the provider expects, usually `/v1`,
  and must **not** include `/messages` or `/chat/completions`.
- The proxy joins the provider's base path with the client's path without duplicating the
  version, so `https://host/openai/v1` plus `/v1/messages` becomes
  `/openai/v1/messages`. Check the resolved URL in the Requests view (`targetUrl`) — that is
  exactly what was requested.
- `ai-proxy test <provider> --model <id>` tells you whether a specific model exists there.

## The model is not the one I asked for

That is the point of a pinned model: if `defaultModel` is set, every request is rewritten to
it. The Requests view shows the swap as `claude-sonnet-4-5 → claude-opus-5-thinking`.

To let your tool choose instead:

```bash
ai-proxy set-model <provider> ""     # pass-through
```

Or pick **— pass-through —** in the model dropdown on the provider card.

## Requests hang, or the reply stops mid-stream

Some providers answer `200`, emit a couple of SSE keep-alives, then never send content. The
proxy now aborts that after `upstreamStallTimeoutMs` (default 5 minutes) and records the
reason, so you get an error instead of a client that waits forever:

```json
{ "type": "error", "error": { "type": "timeout", "message": "Upstream sent nothing for 300s (stalled)" } }
```

If a legitimate slow model trips this, raise it in Settings → **Stall timeout**. If it
happens on every request to one provider, the provider is broken — switch with
`ai-proxy use <other>`.

`upstreamTimeoutMs` (default 15 minutes) is the separate hard ceiling for one request.

## `API Error: 524` on long conversations, but not short ones

Cloudflare returns **524** when the origin behind it produces nothing for 120 seconds. It is a
*silence* timer, so what matters is not how long the whole answer takes but how long the
provider waits before its first byte — and that grows with the size of the prompt, because the
whole conversation is re-sent on every turn. A short chat starts replying in seconds; a very
long one can take over two minutes just to begin, and dies at the edge.

The wall belongs to the provider, not to this proxy. Only they can raise the Proxy Read Timeout
or make their gateway emit a keep-alive while it works. What you can do:

1. **Keep the prompt small.** In Claude Code, `claude --autocompact 200k` compacts against a
   200k window instead of the full context, so requests never grow into the danger zone.
   Pasted images are the other culprit: cheap in tokens, huge in bytes, and re-sent every turn.
2. **Fail over automatically.** Turn on Settings → **Retry failed requests** and list one or
   more **Failover providers**. A 524 delivers only a small error page and never reaches the
   client, so re-sending to a different provider is safe — nothing is duplicated. Pick a target
   that is *not* behind the same CDN, or it will hit the same wall.
3. **Fail fast instead of waiting.** Set **First-byte timeout** just below the provider's edge
   timeout (say `115000`) so you get a readable error, and a retry, ten seconds earlier.

Check which providers share the problem with `curl -sI https://<provider-host>/ | grep -i
'^server:'` — anything answering `cloudflare` has the same 100–120s ceiling.

## A local provider (Ollama, LM Studio, LiteLLM) will not work

Use the full URL including the scheme and port — the proxy honours all of it:

```bash
ai-proxy add-provider ollama http://127.0.0.1:11434/v1
```

A schemeless single word is rejected on purpose (`'ollama' is not a valid base URL`),
because it is nearly always a typo. Local endpoints usually ignore the key, but the proxy
requires *some* key to be stored — any placeholder longer than a few characters works.

## The dashboard shows "Daemon unreachable"

The page is open but the daemon behind it stopped. Restart it, and the dashboard reconnects
on its next 2-second poll.

If the browser console shows `403` for `/api/*`, you are not reaching it over a loopback
name. Use `http://127.0.0.1:<port>` or `http://localhost:<port>` — the API deliberately
refuses any other `Host` or `Origin`.

## The dashboard shows a "Config error" badge

`config.json` is not valid JSON. The daemon keeps running so you can see the message;
`ai-proxy status` prints the parse error and the file path. Fix the file, or move it aside
to start fresh — the next start writes a clean default.

## `ai-proxy: command not found`

`npm link` was never run, or a Node version manager switched away from the version it was
linked into:

```bash
cd /path/to/ai-proxy-manager && npm link
which ai-proxy
```

## VS Code does not list the providers

1. `ai-proxy sync-vscode` — it only injects providers that have **both** a key and at least
   one model.
2. Reload VS Code. The model list is read at startup.
3. If sync reports invalid JSON, `~/.config/Code/User/chatLanguageModels.json` was
   hand-edited into an invalid state; fix or delete it and re-run.

## Everything looks fine but nothing is logged

The Requests view only shows traffic that reached the proxy. If it stays empty while your
tool is working, the tool is talking to the provider directly — its `ANTHROPIC_BASE_URL`
is not pointing here. Confirm with:

```bash
curl -s http://127.0.0.1:8319/v1/messages \
  -H 'Authorization: Bearer dummy-key-managed-by-proxy' \
  -H 'content-type: application/json' \
  -d '{"model":"whatever","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}'
```

That request must appear in the log. If it does, the proxy is fine and the client's
configuration is the problem.

---

## Still stuck?

Open an issue with the output of `ai-proxy status`, the relevant lines from
`ai-proxy logs -n 50`, and your Node version. **Redact anything starting with `sk-`.**
