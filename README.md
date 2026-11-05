# dsh-recall

![GitHub License](https://img.shields.io/github/license/sh-222/dsh-recall)
![GitHub Last Commit](https://img.shields.io/github/last-commit/sh-222/dsh-recall)
![GitHub Repo Stars](https://img.shields.io/github/stars/sh-222/dsh-recall)
![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.5-3c873a)
![dsh](https://img.shields.io/badge/dsh-%E2%89%A5%200.2.0--0-4b6bfb)

## [Русская версия](./README-RU.md)

A context-reclaim plugin for the **DeepSeek Harness** (`dsh`). A big tool result keeps its head
**and** its tail in the conversation; the middle moves to a local SQLite store under a short object
id, and the model pulls back the part it needs with `recall("<id>")` — or finds it without guessing
offsets with `recall("<id>", query: "…")`.

A strip under the composer reports the three numbers that decide whether the trade is worth it: how
much was moved out, how many tokens that kept out of the context, and how often the model actually
went back for more.

## Table of contents

- [Why](#why)
- [Features](#features)
- [Requirements](#requirements)
- [Install](#install)
  - [Upgrade and uninstall](#upgrade-and-uninstall)
  - [Installing from a local checkout](#installing-from-a-local-checkout)
- [Usage](#usage)
  - [What happens to a big result](#what-happens-to-a-big-result)
  - [The `recall` tool](#the-recall-tool)
  - [The strip](#the-strip)
- [Configuration](#configuration)
- [Storage](#storage)
- [How it works](#how-it-works)
- [What this is not: the 15% compaction](#what-this-is-not-the-15-compaction)
- [Interface language](#interface-language)
- [Development and verification](#development-and-verification)
- [Known limitations](#known-limitations)
- [Credits](#credits)
- [Author](#author)
- [License](#license)

## Why

Measured on 8 504 tool results from real sessions:

| fact | value |
|---|---|
| results larger than 6 KB | 4.6% of results |
| …and their share of all tool-result characters | 40.7% |
| …that are never opened again | 76% |

So the expensive part of a coding session is a handful of huge results that nobody reads twice.
Offloading them removes tokens that would otherwise be **re-sent on every later step**: the saving
is `removed_tokens × remaining_steps × cache_price`, not `removed_tokens`.

Ceiling, stated plainly: tool results are roughly 46% of the context, so offloading *all* of them
still caps at about 18% of the context. On a route that bills cache reads near input price that is
a real 20–25% of a long session; on a first-party route with a cheap cache it is single digits, and
there the lever is fresh input and step count instead.

## Features

- **Head and tail, not just head** — the tail is where tools put their own retrieval notices and
  summaries. A head-only cut throws that away, so the stock spill notice
  (`Full formatted result stored at: …`) is kept whole, opening paren included.
- **Budget gate** — optionally offload only while the surface actually exceeds a token budget
  (`budgetTokens`), so nothing is shortened for a saving that was not needed.
- **Replay-safe rewrite** — the same pair the stock pruner uses: a `compaction/prune` event that
  prices and cites the shadowed node, then a `tool/result` with `surfaceOp: {op:'replace'}`. The
  durable log keeps the original, so a resumed session replays identically.
- **Structural idempotence** — the store remembers which `(session, seq)` pairs were offloaded, so a
  tool that merely *prints* the `[recall]` marker cannot make the reaper skip a genuine result.
- **Non-text blocks survive** — images in a tool result ride along untouched; only text is shortened.
- **Code-point safe** — slices and counts use Unicode code points, so a surrogate pair is never split
  down the middle.
- **Searchable recall** — `recall(id, query: "…")` returns matching lines with their real character
  offsets, so the model can jump straight to the spot instead of bisecting a 200 KB log.
- **Deduplicated, compressed store** — one SQLite file, payloads deflated and keyed by the SHA-256 of
  the raw text: the same output read twice is stored once.
- **Retention that exists** — `maxAgeDays` and `maxBytes` evict oldest-first and reclaim the blobs
  nobody references any more.
- **Exact token accounting** — savings are priced by the harness token meter, not by `chars / 4`.
- **The strip** — a compact pill in `shell.overlay` with offloads, tokens kept out of context, recall
  hits and the on-disk footprint.
- **Degrades instead of breaking** — an unreadable or unsupported store logs one line, the profile
  loads, and `recall` says the store is unavailable.

## Requirements

| | |
|---|---|
| `dsh` | `>= 0.2.0-0` (declared in `package.json`) |
| Node | `>= 22.5` for the object store (`node:sqlite` is a standard-library module) |
| Profile | any for the host half; a **web** profile for the strip (`dsh.client.platform: web`) |

On older Node the plugin still loads and the `recall` tool still answers — it just reports that the
store is unavailable, because there is no SQLite to put it in.

## Install

Web / TUI profile:

```sh
dsh plugin --profile web add github:sh-222/dsh-recall
```

The Electron **desktop** profile cannot be managed from the CLI by design. Add the dependency and
the bundle row to `~/.dsh/profiles/desktop/package.json`, then install:

```json
{
  "dependencies": { "dsh-recall": "github:sh-222/dsh-recall" },
  "dsh": { "profile": { "bundles": ["…", "dsh-recall"] } }
}
```

```sh
cd ~/.dsh/profiles/desktop && pnpm install --ignore-scripts
```

Restart the harness. A plugin only loads at boot.

### Upgrade and uninstall

```sh
dsh plugin --profile web remove dsh-recall   # or edit the bundle row and pnpm install
```

The store at `~/.local/share/dsh-recall/` is yours and is never touched by uninstall; delete it when
you no longer want the objects.

See [CHANGELOG.md](CHANGELOG.md) for the release history.

### Installing from a local checkout

`dsh plugin --profile <p> add ~/Projects/dsh-recall` writes a `link:` dependency, and **node
resolves `@deepseek-ai/*` from the real path**, not through the profile — so a `link:`ed checkout
dies with `ERR_MODULE_NOT_FOUND` unless you create the symlinks once:

```sh
cd ~/Projects/dsh-recall && mkdir -p node_modules/@deepseek-ai
DSH="$(dirname "$(dirname "$(readlink -f "$(command -v dsh)")")")/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai"
for pkg in dsh-llm dsh-tools schemastery; do ln -sfn "$DSH/$pkg" node_modules/@deepseek-ai/; done
```

## Usage

### What happens to a big result

1. A tool result lands on the surface.
2. On the next tool call, every result **older than the newest `keep`** and **longer than
   `thresholdChars`** is rewritten to `head + [recall] note + tail`.
3. The middle is written to the store under `md5(session:seq:chars)[:8]`, e.g. `#4d3661d2`.

The model sees this instead of 4 000 characters of output:

```
XXXX… (600 chars of head) …

[recall] read call_A — 4000 chars total. The head and tail are above and below; the middle 3160
chars are stored as object #4d3661d2. Fetch any part with recall("4d3661d2") (optionally
recall("4d3661d2", start, count)), or search it with recall("4d3661d2", query).

XXXX… (240 chars of tail, or the whole stock spill notice when there is one)
```

Nothing is deleted: the full text stays in the session log and in the store.

### The `recall` tool

| call | result |
|---|---|
| `recall("4d3661d2")` | the first 8 000 characters |
| `recall("4d3661d2", start, count)` | a character range (hard cap 24 000 per call) |
| `recall("4d3661d2", query: "FATAL")` | up to 20 matching lines with their character offsets |

Offsets are code points, the same unit the note quotes, so a number copied out of a search result
can be fed straight back into the range form.

### The strip

A compact pill in `shell.overlay`. It docks directly above the **dsh-tidewatch** badge when that
plugin is installed — it reads the `[data-dsh-tide-anchor]` element that tidewatch exposes (falling
back to `.tw-chip` on older installs), so the two read as one card, and it sits in the bottom-right
corner otherwise. Nothing else is shared with tidewatch: the plugins stay independent packages with
their own releases.

Click to expand the last 12 offloads with tool name, size and age, plus the on-disk footprint. Data
comes from `GET /recall/api/stats` on the host's loopback port, polled every 12 s:

```json
{
  "offloaded": 196,
  "charsSaved": 1207034,
  "tokensSaved": 301759,
  "recalls": 12,
  "bytes": 1834211,
  "rawBytes": 4021337,
  "threshold": 2500,
  "head": 600,
  "tail": 240,
  "keep": 2,
  "budgetTokens": 0,
  "maxBytes": 0,
  "recent": [{ "session": "…", "seq": 82, "tool": "read", "id": "4d3661d2", "chars": 4000, "ts": 1793906054462 }]
}
```

Every number except `recalls` is an aggregate over the store, so restarts and a second harness
process cannot make them drift.

## Configuration

All knobs are plugin configuration, validated on load (an unknown key is an error, not a silent
no-op):

```yaml
- id: dsh-recall
  name: dsh-recall
  config:
    thresholdChars: 2500   # only longer results are offloaded at all
    headChars: 600         # kept inline at the start
    tailChars: 240         # kept inline at the end (retrieval notices live here)
    keep: 2                # the newest results are never touched
    budgetTokens: 0        # 0 = offload on threshold alone; >0 = only while over budget
    spillNoticeChars: 600  # extra tail spent keeping a stock spill notice intact (0 disables)
    maxAgeDays: 0          # 0 = keep forever
    maxBytes: 0            # 0 = no size cap; >0 evicts oldest-first
    enabled: true          # turn the reaper off, keep recall(id) working
    stateDir: ~/.local/share/dsh-recall
```

`thresholdChars: 2500 / headChars: 600` were chosen from the size distribution of 12 real sessions
(1 150 results, 487 k tokens), not by feel:

| threshold | head | results hit | saved | share of volume | recall objects |
|---|---|---|---|---|---|
| 6 000 | 1 200 | 40 | 114 k tok | 23.5% | 40 |
| 4 000 | 600 | 103 | 186 k tok | 38.1% | 103 |
| **2 500** | **600** | 218 | 258 k tok | **53.0%** | 218 |
| 1 500 | 600 | 368 | 308 k tok | 63.3% | 368 |

2 500 / 600 is the knee: coverage doubles over 6 000 while the object count stays around 18 per
session. Going to 1 500 buys ten points of volume for three times the objects — more chances for the
model to chase a pointer where re-reading would have been cheaper. Never drop `headChars` below a
few hundred characters: the model must still recognise the shape of the result.

**Read the ratio `recalls / offloaded` as the experiment.** Near zero means the content was never
needed. Close to 1 means the head is too small — raise `headChars` to ~2 000 before touching
anything else. Anything in between is the tool earning its keep.

## Storage

```
~/.local/share/dsh-recall/store.db    one SQLite database (WAL)
```

Three tables:

| table | holds |
|---|---|
| `objects` | id, session, seq, tool, char and token accounting, timestamp |
| `blobs` | the payload, zlib-deflated, keyed by the SHA-256 of the raw text |
| `counters` | only `recalls`; everything else is an aggregate |

A database rather than a directory of files buys four things: identical output is stored once, the
payload is compressed — how much depends on the text: repetitive tool output shrinks by an order of
magnitude, mixed prose and code by roughly 2–4× — the strip's numbers are one query instead of a full
index parse, and two processes can write concurrently without last-writer-wins.

One flat pool per `$HOME`, shared by every project. Ids are `md5(session:seq:chars)`. Inspect it with
any SQLite client:

```sh
sqlite3 ~/.local/share/dsh-recall/store.db \
  'select tool, chars, datetime(ts/1000,"unixepoch") from objects order by ts desc limit 5'
```

Upgrading from the 0.3 layout (`objects/*.txt` + `index.jsonl`) imports it on first run and renames
the JSONL index to `index.jsonl.migrated`; old object ids keep resolving and keep their original
timestamps.

**Retention.** With `maxAgeDays` / `maxBytes` set, the store evicts at open and after each 64th
offload, oldest first, then drops unreferenced blobs and returns the pages to the filesystem
(`auto_vacuum = INCREMENTAL`). Deleting an object breaks pointers to it — that is inherent to any
cap, which is why nothing is deleted by default.

## How it works

The reaper is a `tools/post-execute` waterfall listener — the same hook the stock spill policy uses:

1. take the surface snapshot and find the `tool/result` nodes;
2. drop the newest `keep` and anything at or below `thresholdChars`;
3. for each candidate, derive the message, cut it to head and tail, and skip the rewrite when the
   pointer would not actually be shorter;
4. append `compaction/prune` (prices and cites the shadowed node) and then `tool/result` with
   `surfaceOp: {op:'replace', startSeq, endSeq}` and `sourceEventSeqs: [seq]`;
5. record the object in the store and stop when the token budget is satisfied.

Two details keep the hot path cheap: a per-session set of already-judged seqs (so a result is
derived once, not on every tool call), and prepared statements in the store (the candidate check is
an indexed lookup, not a parse).

## What this is not: the 15% compaction

`dsh-recall` never decides *when* the context gets compressed and never touches the context window.
The percentage-based compression is the stock `@deepseek-ai/dsh-compaction-basic` plugin, configured
in the profile's own patch layer (`~/.dsh/profiles/<profile>/cordis.patch.yml`):

```yaml
- id: compaction-basic
  name: "@deepseek-ai/dsh-compaction-basic"
  config:
    thresholdRatio: 0.15
    retainRatio: 0.05
```

`thresholdRatio` is the share of the model's window at which a compaction pass starts; `retainRatio`
is the share kept afterwards. The stock defaults are `0.8` / `0.16`. On this machine the desktop
profile runs `0.15 / 0.05`, so a 256k window compacts at ~38k tokens and keeps ~13k — a much smaller
working window than the model allows. That is the knob to raise if you need more room:

```yaml
thresholdRatio: 0.6   # compact at 60% of the window instead of 15%
retainRatio: 0.15
```

The two mechanisms are independent and complementary: compaction rewrites the *whole* history into a
summary once the window fills up, while `dsh-recall` leaves the history intact and only shortens
individual large tool results — which is what delays the moment compaction has to run. Disabling
recall does not change the 15%, and raising the 15% does not change what recall does.

Two other stock plugins are worth knowing about, because they overlap by design:

| plugin | what it does | how recall differs |
|---|---|---|
| `dsh-spill-policy` (`maxInlineTokens: 12500`) | spills an oversized *incoming* result to a file and leaves a locator notice | recall works **retroactively** on results already in the surface, at a much lower threshold — and keeps the spill notice intact when both apply |
| `dsh-compaction-tool-result-pruner` (`8192 / 4096 / 1024`) | prunes old results **during** a compaction pass | recall acts on every tool call, so the pressure that triggers compaction arrives later |

## Interface language

The strip follows the interface language: English and Russian copy, with numbers and durations
formatted through `Intl` for the active locale (`ru-RU` or `en-US`). Anything else falls back to
English.

## Development and verification

```sh
npm run check   # node --check on index.js, store.js, client.js
npm test        # five probes, each with its own throwaway state directory
```

| probe | covers |
|---|---|
| `test/store.mjs` | verbatim roundtrip, code points, content-hash dedupe, compression, derived counters, the foreign-database guard, 0.3 layout migration, retention |
| `test/reaper.mjs` | the base policy (head + tail + tool name), spill-notice preservation, the budget gate, idempotence, slice and search |
| `test/realsession.mjs` | the rewrite driven through the **real** `Session` from `@deepseek-ai/dsh-session`, so the surface-replace contract is the harness's, not a stub's |
| `test/http-harness.mjs` | `GET /recall/api/stats`, its shape, and its 404 |
| `test/client-harness.mjs` | the client half mounts, registers its `shell.overlay` entry, and positions itself from the anchor |

`npm test` runs in two environments. In a bare checkout — a fresh clone, a CI runner — the three probes
that import the host half (`reaper`, `realsession`, `http-harness`) print `skip — …` and exit 0, while
`store` and `client-harness` run; that is what the release workflow gates on, because installing the
whole harness there would cost ~80 s per release and still test a different harness version than the
one you run. Inside a dsh profile, or after `npm install --no-save @deepseek-ai/dsh`, all five run.
Only a missing `@deepseek-ai/*` is tolerated: any other missing module fails the probe.

The client probe exists because of a real regression: `slots.register()` returns a disposer, not a
promise, so `.catch()`-ing it threw `TypeError: slots.register(...).catch is not a function` and the
pill never mounted. The harness reproduces the real facade (a thenable function with no `.catch`) and
renders the component once, refs before effects, the way React does.

## Known limitations

- **A pointer is only useful while the head still explains the result.** That is why the note carries
  the tool name and the full size.
- **The last big result of a session is never offloaded.** The hook runs before the current result
  enters the surface, so the reaper only sees older ones; something newer has to arrive first.
- **Text blocks collapse into one.** Multi-text-block results keep their text in order and their
  images, but an image that sat *between* two text blocks moves after them.
- **The `[recall]` marker is a conservative pre-filter.** A genuine result that happens to contain
  the literal `[recall]` is left alone.
- **Resumed sessions start with an empty `callId → name` map**, so a result offloaded right after a
  restart may be labelled `tool` instead of `read`. Cosmetic.
- **Retention breaks old pointers by construction.** With `maxBytes`/`maxAgeDays` set, a deleted
  object answers `not found`.
- **Two harness instances share one pool.** SQLite serializes their writes (`busy_timeout`); every
  displayed number except `recalls` is derived, so they cannot disagree.

## Credits

- The replay-safe replace pair (`compaction/prune` + `tool/result` with `surfaceOp`) mirrors
  `@deepseek-ai/dsh-compaction-tool-result-pruner` from the harness itself (MIT) — that is the
  contract that makes the rewrite survive replay, and it is theirs, not this plugin's.
- The strip docks to the anchor of **dsh-tidewatch** by Ivan Ashikhmin (proDreams) when it is
  installed. The two plugins share nothing but a DOM contract; tidewatch never knows recall exists.

## Author

[sh-222](https://github.com/sh-222)

## License

MIT — see [LICENSE](./LICENSE).
