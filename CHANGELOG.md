# Changelog

> The fork's history starts at 0.5.0. Versions 0.1.x–0.3.x belong to the original project:
> [sh-222/dsh-recall](https://github.com/sh-222/dsh-recall).

## v. 0.5.0

- **The object store is a SQLite database instead of a directory of files**:
    - `objects` holds one row per offload with its character and token accounting, `blobs` holds the payload
      deflated and keyed by the SHA-256 of the raw text, and `counters` holds only `recalls`. Identical output
      read twice is stored once: on a live profile 21 offloads took 84 808 bytes of text down to 29 301 bytes
      on disk.
    - Every number the strip shows is an aggregate over those tables, so a restart or a second harness process
      cannot make them drift. The 0.3 caveat about `counters.json` being last-writer-wins is gone.
    - Token savings are priced by the harness token meter — the original message minus the pointer message —
      instead of a `chars / 4` guess.
    - The 0.3 layout (`objects/*.txt` + `index.jsonl`) is imported on first open and keeps each object's
      original timestamp; the JSONL index is renamed to `index.jsonl.migrated`, so ids quoted in old
      conversations keep resolving.
    - A foreign database is refused through `PRAGMA application_id`. On Node < 22.5, where `node:sqlite` does
      not exist, the plugin logs one line and loads without a store instead of taking the profile down.

- **A result keeps its tail, not just its head**:
    - The middle goes to disk, but the last 240 characters stay inline: that is where tools put their own
      retrieval notices and summaries, and a head-only cut threw them away.
    - The stock spill policy's notice (`Full formatted result stored at: …`) is kept whole — opening paren
      included — even when it is longer than the tail budget, so the locator the model needs stays intact.
    - Non-text blocks (images) survive the rewrite; only text is shortened.
    - Slices and counts use Unicode code points, so a surrogate pair is never split down the middle.
    - A result is left alone when the pointer would not actually be shorter than the original.

- **Thresholds are configuration, not constants**:
    - `thresholdChars`, `headChars`, `tailChars`, `keep`, `enabled` and `stateDir` are plugin config, validated
      on load. An unknown key is an error rather than a silent no-op, and
      `headChars + tailChars` must stay below `thresholdChars` or nothing would be saved.

- **An optional token budget gates the rewrite**:
    - With `budgetTokens` set, offloading happens only while `tokenMeter.measure(session)` is over that budget,
      so a short session keeps its results intact instead of being shortened for a saving nobody needed.
      `0` keeps the threshold-only behaviour.

- **Retention exists**:
    - `maxAgeDays` and `maxBytes` evict oldest-first at open and after each 64th offload, then drop
      unreferenced blobs and return the pages to the filesystem (`auto_vacuum = INCREMENTAL`).
    - Deleting an object breaks pointers to it — that is inherent to any cap, which is why nothing is deleted
      by default.

- **`recall(id, query)` searches inside an object**:
    - Up to 20 matching lines with their real character offsets, so the model can jump straight to the spot
      instead of bisecting a large object.
    - Offsets use the same unit the note quotes, so a number copied out of a search result can be fed straight
      back into `recall(id, start, count)`.

- **Idempotence is structural, not textual**:
    - The store remembers which `(session, seq)` pairs were offloaded, and a replacement cites its original
      through `sourceEventSeqs`, so a tool that merely *prints* the `[recall]` marker can no longer make the
      reaper skip a genuine result.

- **The strip actually mounts, and lines up**:
    - `slots.register()` returns a disposer, not a promise, so `.catch()`-ing it threw
      `TypeError: slots.register(...).catch is not a function` and the strip never appeared at all on
      dsh 0.2.0-rc.2. The declaration effect now hands the disposer straight back.
    - Numbers and durations follow the interface language instead of being pinned to `ru-RU` and Russian
      suffixes.
    - The fourth stat card counts characters kept *out of the context* — which is what it always computed —
      instead of claiming to count characters on disk and disagreeing with the footer.
    - The strip measures its offset from `document.documentElement.clientWidth`, so it no longer sits a
      scrollbar-width left of the chip it is meant to align with.
    - It anchors to `[data-dsh-tide-anchor]`, falling back to `.tw-chip`, and repositions on mutations and
      resize instead of polling every 500 ms for the lifetime of the page. The panel also shows the on-disk
      footprint and the configured cap.

- **Release automation**:
    - Pushing to `main` releases whatever version `package.json` declares — checks, tarball, GitHub Release and
      tag — and does nothing when that version is already published. Release notes come from this file.

- **Tests**:
    - Five probes: the store (dedupe, compression, code points, migration, retention), the reaper policy
      (budget gate, spill notice, idempotence, slice and search), an integration run against the real
      `Session` class, the HTTP endpoint, and a client-mount guard that reproduces the real `slots` facade.
