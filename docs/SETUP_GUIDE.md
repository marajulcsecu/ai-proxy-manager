# Setup Guide

From nothing to a working proxy, using **Tabitoken** as the example. Substitute your own
provider's base URL and key anywhere it appears.

> Prerequisite: `ai-proxy` on your PATH. If `ai-proxy version` fails, run `npm link` in the
> repository directory.

---

## 1. Register the provider

The base URL is the API root — usually ending in `/v1`. Do **not** include `/messages` or
`/chat/completions`.

```bash
ai-proxy add-provider tabitoken https://tabitoken.com/v1
```

Anything the URL contains is honoured: scheme, port and path prefix. All of these are valid:

```bash
ai-proxy add-provider gorouter   https://gorouter.app/v1
ai-proxy add-provider gateway    https://my-gateway.example/openai/v1   # path prefix kept
ai-proxy add-provider ollama     http://127.0.0.1:11434/v1              # local, plain HTTP
ai-proxy add-provider lmstudio   http://127.0.0.1:1234/v1
```

## 2. Store the API key

```bash
ai-proxy set-key tabitoken sk-your-secret-api-key-here
```

The key is written to `~/.config/ai-proxy-manager/config.json` at file mode `0600`. It is
masked everywhere it is displayed afterwards.

## 3. Choose a model — or don't

Two modes, and the difference matters:

```bash
# Pinned: every request is rewritten to this model, whatever the client asked for.
ai-proxy add-model tabitoken claude-opus-5-thinking
ai-proxy set-model tabitoken claude-opus-5-thinking

# Pass-through: the client's own model choice is forwarded untouched.
ai-proxy set-model tabitoken ""
```

Pin a model when the provider's names differ from what your tool sends (the common case with
relays). Use pass-through when the provider accepts the same names your tool uses.

You can register several models and switch between them at any time — from the CLI, or from
the dropdown on the provider's dashboard card:

```bash
ai-proxy add-model tabitoken claude-sonnet-5
ai-proxy set-model tabitoken claude-sonnet-5
```

## 4. Make it the active provider

```bash
ai-proxy use tabitoken
ai-proxy list          # confirm: ▶ marks the active one
```

## 5. Start the daemon

Run it in the background and carry on in the same terminal:

```bash
ai-proxy start --daemon      # `ai-proxy stop` / `restart` / `status` control it
```

Or keep it in the foreground in its own tab, if you like watching the traffic:

```bash
ai-proxy start
```

## 6. Verify before wiring anything up

```bash
ai-proxy test tabitoken
```

This sends one real request with `max_tokens: 1` and names the outcome:

```
✔ Key accepted, model responded (204ms)
  endpoint  https://tabitoken.com/v1/messages
  model     claude-opus-5-thinking
```

If it fails, the summary says why — rejected key, wrong URL, unknown model, WAF block, out of
credit — so fix that before blaming your editor. See
[TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## 7. Connect your tools

### Claude Code

```bash
ai-proxy setup-terminal
```

This writes a managed block to every shell startup file you have (`~/.bashrc`, `~/.zshrc`,
`~/.config/fish/config.fish`):

```bash
# --- AI Proxy Manager (managed block) ---
export ANTHROPIC_BASE_URL="http://127.0.0.1:8319"
export ANTHROPIC_AUTH_TOKEN="dummy-key-managed-by-proxy"
# --- end AI Proxy Manager ---
```

Then reload and run it:

```bash
source ~/.bashrc      # or just open a new terminal
claude
```

Re-running `setup-terminal` rewrites the block in place, so do it again after changing the
port. `ai-proxy remove-terminal` takes it back out.

### VS Code

```bash
ai-proxy sync-vscode
```

Every provider that has a key **and** at least one model is injected into
`~/.config/Code/User/chatLanguageModels.json` as `ai-proxy:<provider>`, with all of its models.
Reload VS Code, open the chat model picker, and they are there.

### Anything else

Any tool that lets you set a base URL and a key:

| | |
|:---|:---|
| Base URL | `http://127.0.0.1:8319` |
| API key | `dummy-key-managed-by-proxy` — use the active provider |
| | `gorouter:dummy` — that provider specifically, with the stored key |
| | `gorouter:sk-your-own-key` — that provider, with a key you supply |

The dashboard's **Setup** view has this block ready to copy.

## 8. Switching later

No restart, ever — configuration is re-read per request:

```bash
ai-proxy use gorouter                       # different provider
ai-proxy set-model gorouter claude-opus-5   # different model
```

Or click **Use this** / pick from the model dropdown at <http://127.0.0.1:8319>.

---

## Running two providers at once

Because routing follows the key each client sends, two tools can use two providers
simultaneously. Point one tool at a specific provider by giving it a prefixed token:

```bash
# This shell talks to GoRouter regardless of which provider is globally active.
export ANTHROPIC_BASE_URL="http://127.0.0.1:8319"
export ANTHROPIC_AUTH_TOKEN="gorouter:dummy"
claude
```

Meanwhile another terminal using `dummy-key-managed-by-proxy` keeps following
`ai-proxy use`. This is also how the VS Code integration exposes every provider at once.

## Moving to another machine

```bash
ai-proxy export ~/ai-proxy-config.json --with-keys   # omit the flag to redact keys
# …copy the file across, then:
ai-proxy import ~/ai-proxy-config.json
```

A file whose keys were redacted never overwrites keys already stored on the target machine, so
you can safely share a redacted export as a template. **A file exported `--with-keys` contains
plaintext credentials — do not commit it** (`.gitignore` already covers
`ai-proxy-export*.json`).

## Checking on it

```bash
ai-proxy status         # daemon, active route, traffic, integration state
ai-proxy logs -n 50 -f  # follow the daemon log
```

The dashboard's **Requests** view shows every forwarded call with its latency, model swap and
status; click a row for the full request and response.
