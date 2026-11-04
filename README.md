# dsh-recall

[Русская версия](./README-RU.md) · **English**

A context-reclaim plugin for the **DeepSeek Harness** (`dsh`). A big tool result keeps its first
600 characters in the conversation; the rest is written to disk under a short object id, and the
model can pull any slice of it back with `recall("<id>")`. A strip under the composer reports the
three numbers that decide whether the trade is worth it: how much was moved out, how many tokens
that kept out of the context, and how often the model actually went back for more.

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

## What it does, exactly

- Hooks `tools/post-execute` and looks at the session surface.
- Touches only results **older than the newest two** (`KEEP = 2`) and **longer than 2 500
  characters** (`THRESHOLD`).
- Replaces the result with `head (600 chars) + a [recall] note` using the same replay-safe pair the
  stock pruner uses — a `compaction/prune` event that prices and cites the shadowed node, then a
  `tool/result` event with `surfaceOp: {op:'replace'}`. The durable log keeps the original.
- Writes the full text to `~/.local/share/dsh-recall/objects/<id>.txt` and appends one line to
  `index.jsonl`.
- Registers the `recall` tool: `recall(id)`, `recall(id, start, count)`; default slice 8 000 chars,
  hard cap 24 000 so a recall cannot re-inflate the context it was built to shrink. Ids are
  validated (`/^[0-9a-f]{6,32}$/i`) before the filesystem is touched — the model will invent ids.
- Is idempotent: a result that already contains the `[recall]` marker is skipped, so restarts and
  repeated passes do not stack pointers.

## The strip

Docks in `conversation.composer.dock` (session-scoped: it does not exist on the hero screen, which
is correct, not a bug). Copy follows the interface language (en/ru). Click to expand the last 12
offloads with tool name, size and age. Data comes from `GET /recall/api/stats` on the host's
loopback port, polled every 12 s:

```json
{"offloaded":196,"charsSaved":1207034,"tokensSaved":301759,"recalls":0,"threshold":2500,"recent":[…]}
```

`offloaded` and `charsSaved` are recomputed from `index.jsonl`, so they survive restarts; `recalls`
is the only counter that lives in memory and is mirrored to `counters.json`.

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

### Installing from a local checkout

`dsh plugin --profile <p> add ~/Projects/dsh-recall` writes a `link:` dependency, and **node
resolves `@deepseek-ai/*` from the real path**, not through the profile — so a `link:`ed checkout
dies with `ERR_MODULE_NOT_FOUND` unless you create the symlinks once:

```sh
cd ~/Projects/dsh-recall && mkdir -p node_modules/@deepseek-ai
ln -sfn /usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm   node_modules/@deepseek-ai/
ln -sfn /usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools node_modules/@deepseek-ai/
```

## Tuning the knobs

`THRESHOLD` and `HEAD` are constants at the top of `index.js`. Chosen from the size distribution of
12 real sessions (1 150 results, 487 k tokens), not by feel:

| threshold | head | results hit | saved | share of volume | recall objects |
|---|---|---|---|---|---|
| 6 000 | 1 200 | 40 | 114 k tok | 23.5% | 40 |
| 4 000 | 600 | 103 | 186 k tok | 38.1% | 103 |
| **2 500** | **600** | 218 | 258 k tok | **53.0%** | 218 |
| 1 500 | 600 | 368 | 308 k tok | 63.3% | 368 |

2 500 / 600 is the knee: coverage doubles over 6 000 while the object count stays around 18 per
session. Going to 1 500 buys ten points of volume for three times the objects — more chances for the
model to chase a pointer where re-reading would have been cheaper. Never drop `HEAD` below a few
hundred characters: the model must still see the shape of the result.

How to read the strip: the ratio `recalls / offloaded` is the experiment. Near zero means the
content was never needed. Close to 1 means the head is too small — raise `HEAD` to ~2 000 before
touching anything else. Anything in between is the tool earning its keep.

## Storage

```
~/.local/share/dsh-recall/objects/<id>.txt   full text, one file per offloaded result
~/.local/share/dsh-recall/index.jsonl        {session, seq, tool, id, chars, ts} per offload
~/.local/share/dsh-recall/counters.json      {hits, charsSaved, recalls}
```

One flat pool per `$HOME`, shared by every project; the owning session is in the index. Ids are
`md5(sessionId:seq:length)`, so identical-sized results from different sessions never collide.
Measured cost: ~8 KB per object, 1.3 MB for a 196-offload session.

**There is no rotation.** Objects are never deleted. At 8 KB each that is ~120 MB per 10 000
offloads — irrelevant next to the session logs themselves, but if you want a cap, delete
`objects/*` older than N days and rebuild `index.jsonl` from what is left.

## Honest limits

- A pointer is only useful while the head still tells the model what the result was. That is why
  the note carries the tool name and the total size.
- Sessions resumed from a previous process start with an empty `callId → tool name` map, so an old
  result offloaded right after a restart may be labelled `tool` instead of `read`. Cosmetic.
- Only results already in the surface are touched; the newest two are always intact.
- `counters.json` is written by every runtime that mounts the plugin (host and web). Last writer
  wins, so `recalls` can be clobbered by a second instance; the strip's other numbers are rebuilt
  from the index and stay correct.

## Test

```sh
npm run check
HOME=$(mktemp -d) node test/reaper.mjs   # HOME is overridden so the real state dir is untouched
```

The test drives the hook with a hand-rolled session: it asserts that only the old, oversized result
is replaced, that the pointer carries the real tool name from the matching `tool/call`, that a fresh
big result is left alone, and that `recall` returns the requested slice and bumps the counters.

## License

MIT.
