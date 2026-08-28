# Security Policy

## Reporting a vulnerability

Please report security issues privately through
[GitHub Security Advisories](https://github.com/marajulcsecu/ai-proxy-manager/security/advisories/new)
rather than opening a public issue. Include the version (`ai-proxy version`), what an
attacker can reach, and a reproduction if you have one.

This is a single-maintainer hobby project — expect a first response within about a week.

## What this tool holds

AI Proxy Manager stores **plaintext API keys** for every provider you register, in
`~/.config/ai-proxy-manager/config.json`. Anything that can read that file, or reach the
REST API, can use your provider quota. Treat it accordingly.

## Protections in place

| Surface | Protection |
|:---|:---|
| `config.json` | Written atomically with mode `0600` inside a `0700` directory |
| Dashboard + REST API | Bound to `127.0.0.1`, and requests whose `Host`/`Origin` is not a loopback name are rejected with 403 — this is what stops a malicious web page from reading your keys via DNS rebinding. No CORS wildcard is sent. |
| `GET /api/providers` | Returns a masked preview (`sk-ab…7f2c`), never the key |
| `GET /api/providers/:name/key` | The only endpoint that returns a key in clear, for the dashboard's "reveal" button |
| Request history | `requests.jsonl` stores metadata only. Prompt and completion text is kept in memory, capped at 4 KB, and is dropped on restart. Disable entirely with `captureBodies: false` |
| `export` | Redacts keys unless you pass `--with-keys` (`?redact=0` on the API) |
| Client keys | Never forwarded upstream — the proxy substitutes the stored key or the one explicitly supplied in a `provider:key` token |

`scripts/check-secrets.sh` runs in CI against every tracked file, and can be installed as
a pre-commit hook:

```bash
ln -sf ../../scripts/check-secrets.sh .git/hooks/pre-commit
```

## Known exposure in git history

Commit [`14c5c33`](https://github.com/marajulcsecu/ai-proxy-manager/commit/14c5c33)
(2026-08-27) added a real Tabitoken API key to `docs/SETUP_GUIDE.md`. It was redacted in
`497c34e`, and **the key has been revoked**, but the blob is still reachable in the public
history of this repository. Nothing else has ever been committed. Run
`./scripts/check-secrets.sh --all` to verify.

## Deliberate non-goals

- **The dashboard has no authentication.** It is loopback-only by design. Do not bind it
  to another interface or put it behind a tunnel without adding authentication first.
- **Header spoofing.** By default the proxy sends first-party SDK headers upstream
  (`settings.spoofHeaders`). That is what gets past some providers' WAF rules; disable it
  if your provider objects.
- **TLS verification is left at Node's defaults.** There is no "ignore certificate errors"
  switch, and there will not be one.
