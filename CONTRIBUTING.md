# Contributing

Thanks for taking a look. This is a small, deliberately plain project — the constraints
below are what keep it that way.

## Ground rules

1. **Zero dependencies.** `src/` uses Node.js built-ins only, and `package.json` has no
   `dependencies` or `devDependencies`. Tests run on the built-in `node:test` runner.
   A pull request that adds a package will be asked to solve the problem another way.
2. **Node.js ≥ 18.17.** CI runs 18, 20 and 22.
3. **No build step.** The dashboard is plain HTML, CSS and JavaScript served straight from
   `src/dashboard/`.
4. **Never commit a credential.** `config.json` is git-ignored; run
   `./scripts/check-secrets.sh` before you push, or install it as a hook:
   `ln -sf ../../scripts/check-secrets.sh .git/hooks/pre-commit`.

## Getting set up

```bash
git clone https://github.com/marajulcsecu/ai-proxy-manager.git
cd ai-proxy-manager
npm link          # exposes `ai-proxy` on your PATH; there is nothing to install
npm test          # 47 tests, no network access required
```

### Never test against your own daemon

If you use this tool for real, the daemon on port 8319 is probably routing traffic you
care about — possibly the AI coding session you are working in. Run a throwaway instance
instead:

```bash
export AI_PROXY_HOME=/tmp/ai-proxy-dev     # separate config, pid file and logs
ai-proxy add-provider fake http://127.0.0.1:9911/v1
ai-proxy start --daemon --port 8321
```

`AI_PROXY_HOME` redirects every path the tool touches, so nothing can reach your real
configuration. A tiny fake upstream is usually enough to exercise the proxy — see
`tests/proxy.test.js` for one.

## Before opening a pull request

```bash
npm test
./scripts/check-secrets.sh
find src tests -name '*.js' -print0 | xargs -0 -n1 node --check
```

- Add a test for new behaviour. `tests/` is organised by module; each file points
  `AI_PROXY_HOME` at a fresh temp directory *before* importing the code under test.
- Update `docs/` when you change behaviour, and add a line to `CHANGELOG.md`.
- Check dashboard changes in both light and dark themes, and at a narrow width.

## Code conventions

The existing code is the specification, but the load-bearing ones:

- **JSDoc on every exported function**, including `@param` and `@returns`.
- **Comments explain *why*, not *what*.** Several comments record a bug that a line
  prevents; keep that habit.
- Two-space indent, single quotes, semicolons, ~110 column soft limit.
- `UsageError` for anything the user did wrong; `cli.js` is the only place that sets an
  exit code.
- In the dashboard: **no inline `onclick`**. Interaction is delegated from `document` via
  `data-action` attributes registered in the `ACTIONS` table, and every render function is
  guarded by a signature comparison so the polling loop cannot steal focus. See
  [docs/CONTEXT.md §7](docs/CONTEXT.md).

## Commit messages

Conventional Commits, lowercase subject, imperative mood:

```
feat(dashboard): add a command palette
fix(proxy): keep the provider base path when joining request paths
docs: document the stall timeout
test(api): cover the rebinding guard
chore/ci/refactor: …
```

## Where things live

A full module map, request-flow walkthrough and API reference are in
**[docs/CONTEXT.md](docs/CONTEXT.md)** — read that first if you are new, human or agent.
