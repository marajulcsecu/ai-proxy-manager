# Keys — many accounts per provider

One provider, many accounts. The proxy holds every key you own for a relay, sends one of
them, notices when that account runs out of credit, and either tells you to switch or
switches by itself.

Nothing here is guesswork about billing: these relays refuse a request *before* running it
when the balance is too low, and the refusal quotes the balance. That refusal is what the
proxy reads.

---

## The shape of the data

Each provider in `config.json` carries a pool:

```json
"gorouter": {
  "url": "https://gorouter.app/v1",
  "apiKey": "sk-…",              // mirror of the selected key — never edit by hand
  "selectedKeyId": "9f2c1a44",
  "keyRotation": "manual",
  "keys": [
    {
      "id": "9f2c1a44",
      "label": "marajul.cu.cse@gmail.com",
      "key": "sk-…",
      "status": "active",
      "remaining": 55.34,
      "needed": null,
      "dashboardUrl": "https://gorouter.app/",
      "referralUrl": "https://gorouter.app/sign-up?aff=…",
      "addedAt": "2026-09-02T…",
      "lastUsedAt": "2026-09-03T…",
      "requestsServed": 41,
      "lastError": null
    }
  ]
}
```

`apiKey` is a **mirror**, not a second source of truth: it is rewritten from the pool on
every save, so the CLI, the tester, the dashboard and the `<provider>:<key>` inline token
keep working unchanged. `id` is derived from the key value, so the same key always gets the
same id — importing twice cannot produce two entries.

| status | means |
|---|---|
| `active` | usable; a probe or a served request has accepted it |
| `exhausted` | out of credit. Kept, never deleted |
| `invalid` | revoked or wrong (`401`) |
| `unknown` | imported but never tested |
| `disabled` | you turned it off. A measurement never overrules this |

Selection is **sequential**: the selected key is used until it is spent, then the next usable
one. `unknown` counts as usable — an untested key is tried, not skipped. A key you picked
yourself is honoured even when it is marked `exhausted`, because a key refused for a huge
request can still answer a small one; only `invalid` and `disabled` are never sent.

## Commands

```bash
ai-proxy keys import <file…> [--dry-run] [--create-providers]   # .xlsx or .csv, any number
ai-proxy keys list [provider]              # the pools, with balances and which key is in use
ai-proxy keys check [provider] [--balance] # probe every key: accepted, spent or revoked
ai-proxy keys add <provider> <key> --label me@gmail.com [--note …] [--credit N] [--use]
ai-proxy keys edit <provider> <n|id|label> [--label …] [--note …] [--dashboard …] [--referral …]
ai-proxy keys remove <provider> <n|id|label> --yes   # delete; the vault still keeps it
ai-proxy keys reveal <provider> <n|id|label>   # print one key in full
ai-proxy keys next <provider>              # switch to the next usable key
ai-proxy keys use <provider> <n|id|label>  # switch to a specific one
ai-proxy keys retire <provider> [n|id|label]   # mark spent and move on
ai-proxy keys revive <provider> <n|id|label>   # put it back as untested
ai-proxy keys rotation <provider> [auto|manual]
ai-proxy keys export [file] [--with-keys]  # the CSV second copy
```

Anywhere a key is named, `<n|id|label>` accepts its position in the pool, its id, or the
account label — whichever you have in front of you.

The dashboard's **Keys** view mirrors all of it except `import`, `check` and `export`, which
are CLI-only: the first two want streaming progress over a run that takes minutes, and the
third writes a file to a path you choose. See
**[DASHBOARD.md](DASHBOARD.md#keys)**.

## Adding and correcting by hand

Not every account arrives in a spreadsheet. `keys add` appends one:

```bash
ai-proxy keys add gorouter sk-… --label me@gmail.com --note "trial" --credit 5 --use
```

It lands as `unknown` — never `active`, because nothing has tested it — at the end of the
pool, so adding a key never changes which account is serving traffic unless `--use` says so.
An exact duplicate within the same provider is refused: two rows for one account would each
keep their own idea of the balance. The same key under a *different* provider is allowed and
reported, because one relay's key pasted under a second name is a real thing to know about —
those two entries will empty together.

`keys edit` corrects only what a person knows: the label, the note and the two links. The key
value itself cannot be edited, because the id is derived from it — a new value is a new entry,
so add it and remove the old one. `status` follows what a relay actually answered and
`remaining` is measured by `keys check`; asking to set either is an error naming the verb that
owns it. Editing to what the pool already says writes nothing at all: a pointless save would
rotate a real backup off the end of the five.

`keys remove` needs `--yes`. It is the last resort, and rarely the right one — retiring keeps
the entry, its label and its balance, and stops it being sent. Even after a remove the value
survives in `keys.jsonl`, which is the one file the tool never rewrites.

## Importing

`keys import` reads the account spreadsheets directly — `.xlsx` is a zip of XML and is parsed
with `node:zlib` alone, so this adds no dependency. Both layouts in the real inventory are
handled: a row per provider (with the account in the header) and a column per provider (with
the account in the first column).

Four rules, all of them about not losing keys:

- **Never guess a provider.** A key whose provider cannot be resolved from the column header,
  the typed name or the URL is reported as *unresolved*, with the header that produced it.
- **Nothing is written if a single key went unaccounted for.** The importer counts the
  key-shaped cells in the file independently of its own parsing and compares. An earlier
  version silently kept 202 of 272 keys; this check is why that cannot recur.
- **An imported key is `unknown`**, and is appended *behind* the key already in use — an
  import never changes which account is serving traffic.
- **A measured figure beats a typed one.** A balance the proxy read from a refusal is never
  overwritten by a number from a spreadsheet; blank fields are filled in, that is all.

`--dry-run` prints the whole plan — added, updated, unchanged, skipped, unresolved — and
writes nothing.

### The models column

A `Top Models` column, where the sheet has one, fills the provider's model list. The column is
found by its header rather than by its contents, because a model id looks like an ordinary
hyphenated word and content detection would read a provider name or a note as a model. What it
takes from that cell is filtered hard: anything with a space in it is prose, and every real id
in the inventory carries a digit or a hyphen (`claude-opus-5`, `gpt-5.6-sol`). One row writes
"ALL KINDS OF MODELS" one word per line — four entries that would have reached the dashboard's
dropdown and 404'd from the relay much later, far from the import that invented them. Models
belong to the row rather than to the key, so they are collected even from a key that was
already known, and they are only ever added: a list you curated is never pruned by a sheet.

### `--create-providers`

An unresolved key usually means the sheet names a provider the config does not have.
`--create-providers` builds those from the URL in the sheet — opt-in, because it adds a host
the proxy will then send keys to. When it fires, the whole file is read again rather than the
leftovers being patched up: the same resolution rules then apply to these keys as to every
other one, and the accounting that refuses a lossy import still counts every key-shaped cell
exactly once. Run it with `--dry-run` first to see which providers it would invent.

## How "out of credit" is detected

These relays (New-API / One-API forks) estimate the cost of a request from the prompt and
`max_tokens`, and pre-authorise it against the balance. If the balance is short, the request
is rejected before any tokens are billed, and the rejection says by how much:

```
HTTP 403
预扣费额度失败, 用户剩余额度: ＄0.710336, 需要预扣费额度: ＄0.800000
   pre-deduction failed      remaining: $0.710336   required: $0.800000
```

Two things follow. The status code alone is useless — `403` is also a WAF block, a geo block
and a revoked key — so `src/core/creditSignals.js` reads the body. And every such rejection
is a free balance reading, which is why no billing API is needed.

The classifier returns one of `exhausted`, `invalid-key`, `rate-limited`, `transient`,
`other`, plus the parsed numbers and **which phrase fired**, in two confidence tiers:

- **Tier A** — verified wordings (`预扣费额度失败`, `用户剩余额度` with a number, any `402`).
- **Tier B** — the same product family's other phrasings (`额度不足`, `insufficient balance`,
  `insufficient quota`, `quota exhausted`, …). Acted on, but logged so it can be audited.

Everything else is explicitly **not** exhaustion: `429` is a rate limit, `401` is a revoked
key, a `403` with no balance phrase is a WAF page, `无可用渠道` is the relay's own routing
failure, and `5xx` is upstream trouble handled by the retry path. Mistaking any of these for
"spent" would retire a healthy account.

On the request path (`src/core/keyMonitor.js`) a `401`/`402`/`403`/`429` response is held back
up to 64 KB, classified, and then delivered. The key is marked, `remaining` is recorded, the
request row gets `keyId`, `keyLabel`, `keyVerdict` and `keyRemaining`, and a banner appears in
the dashboard. Nothing is written to disk for a WAF `403`, a `429`, or a repeat of a verdict
already on file.

## Manual or automatic

Default is **manual**: you are told, the request still fails, and you click *Switch →* or run
`ai-proxy keys next <provider>`. That is the conservative default because a wrong switch
spends the next account.

`ai-proxy keys rotation <provider> auto` lets that provider move on by itself. The refused
request is then re-sent on the next account, so the client gets an answer instead of the
refusal, and the banner reports the switch as news rather than asking for one.

Auto is deliberately narrow:

- Only on **exhaustion**, never on `invalid-key`. A relay having a bad `401` day would
  otherwise march through the pool marking every account revoked, one per request.
- Only on **Tier A**, or a Tier B wording already seen once on that provider.
- At most **three accounts per request** (`MAX_KEY_WALK`), and none at all for a request whose
  body was streamed rather than buffered — there would be nothing left to re-send.

Turn it on per provider *after* `keys check` has shown you that provider's real wording.

## Checking the whole inventory

```bash
ai-proxy keys check --balance --concurrency 4
```

Two probes per key, both effectively free:

1. **Liveness** — `GET /v1/models` with the key. `200` means accepted; `401`/`403` means dead.
   No tokens either way.
2. **Balance** (`--balance`) — a `/v1/messages` ping with `max_tokens: 1000000`, which no
   balance can pre-pay. The relay refuses and quotes the number. Nothing ran, so nothing was
   billed.

Five properties worth knowing before you read the output:

- **A refusal is a measurement, not a verdict.** A $200 key is refused exactly as a $0.71 key
  is. Only the quoted number decides, against `--low` (default `$1`).
- **`stream: true` is what caps the cost.** If a key *is* rich enough to be accepted, the
  socket is destroyed on the first byte. A non-streaming request that size would be generated,
  and billed, in full before the first byte arrived.
- **Liveness never overrules "spent".** `/v1/models` says the key is accepted, nothing about
  its credit: it can promote `unknown` → `active`, never revive an exhausted key. Each
  provider also gets one control probe with an invented key — a relay that answers `200` to
  that is not checking keys at all, so its liveness results promote nothing and are called out.
- **`disabled` is a decision, not a measurement**, and a funded probe does not undo it.
- **A balance is written where a number was quoted, and left alone where none was.** A relay
  rich enough to accept the probe has said the key *has* credit, not how much. Plenty of relays
  never quote a figure at all, so a check that wrote the entry regardless would erase every
  balance the import filled in; the last figure anyone actually has stands instead. A key whose
  status and balance both come back unchanged is not written at all.

One config write for the whole run, and none when nothing was learned.

## Not losing the keys

Four independent copies, by design:

| Where | What it is |
|---|---|
| `config.json` | the live pool. Atomic write (tmp + rename), mode `0600` |
| `config.json.bak.1` … `.bak.5` | the five previous versions, rotated on every save |
| `keys.jsonl` | append-only. Every key ever saved, every status change, never rewritten |
| `keys-<date>.csv` | your copy, written by `keys export` |

The vault is the real backstop: `config.json` can be rebuilt from it, and a key that a bad
save dropped is still in there. It is append-only on purpose and grows forever — a few hundred
bytes per key per change.

Nothing deletes a key. `exhausted` and `invalid` keys stay in the pool with their labels and
balances; removing one is a separate, explicit act, and the vault line survives it.

## The CSV second copy

```bash
ai-proxy keys export                          # masked, into the data directory
ai-proxy keys export ~/keys-backup.csv --with-keys
```

Columns: `Provider, Account, API Key:, Status, Remaining Credit, URL For API KEY,
Referral Link` — the same names the account spreadsheets use, so rows can be pasted between
the two files, and in the order the importer reads them. Re-importing it is a genuine restore:

```bash
ai-proxy keys export ~/keys-backup.csv --with-keys
# …later, on a fresh machine, with the providers already added:
ai-proxy keys import ~/keys-backup.csv
```

- **Masked unless you ask.** Without `--with-keys` the key column holds `sk-fa…000a`, which is
  safe to keep anywhere — and, being no longer a key, is not importable.
- **The account column must hold the e-mail address** for a re-import to attach the label; the
  importer identifies an account by the e-mail in the row.
- **Status does not survive a re-import.** Every restored key comes back `unknown`, because a
  status is a measurement and the copy may be months old. Run `keys check` after a restore.
- **`0600`, and not inside a git repository.** A `--with-keys` export aimed anywhere under a
  `.git` directory is refused, naming the repository; `--force` overrides it. The data
  directory itself is exempt, since it already holds the same keys in plain text. This tool's
  own history contains one accidentally committed key — hence the rule.
- Written on request only. An automatic export after every mutation would drop a full
  plaintext inventory into a second place every time a key was marked.

## Nothing leaks

- Exactly one call returns a key value: `GET /api/keys/:name/:id/value`, behind the
  dashboard's per-key *reveal* button and `ai-proxy keys reveal`. Every listing, every
  mutation response and every alert — `/api/keys`, `/api/providers`, `/api/status` — carries
  `masked` only, so a key reaches the screen only when someone asked for that key by name.
- `requests.jsonl` records `keyId` and `keyLabel` — never a key.
- `keys.jsonl` and `config.json` are `0600`, the data directory is `0700`, and both are outside
  any repository.
- `npm run verify` runs `check-secrets.sh` over the tree before anything ships.

## Where the code is

| File | Role |
|---|---|
| `src/core/keyStore.js` | pool schema, selection, verdicts, the vault |
| `src/core/keyImport.js` | spreadsheet → records → merge |
| `src/core/xlsx.js` | zip + XML reader, `node:zlib` only |
| `src/core/creditSignals.js` | the classifier. Pure, no I/O |
| `src/core/keyMonitor.js` | the only pool code on the request path |
| `src/core/keyCheck.js` | liveness and balance probes |
| `src/controllers/keysController.js` | the `keys …` commands |
| `src/dashboard/app.js` | the Keys view: `keyRowHtml` → `keyGroupHtml` → `renderKeys` |

Design decisions and their reasons: [KEY-POOL-PLAN.md](KEY-POOL-PLAN.md).
