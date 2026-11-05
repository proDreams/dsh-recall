/*!
 * dsh-recall — object store.
 *
 * One SQLite file instead of a directory of loose .txt files plus a JSONL index:
 *
 *  - `objects`  one row per offloaded result: id, session, seq, tool, char and
 *               token accounting, timestamp;
 *  - `blobs`    the payload, zlib-deflated, keyed by the SHA-256 of the raw
 *               text — the same output read twice is stored once;
 *  - `counters` the only value that cannot be derived (`recalls`).
 *
 * Every displayed number is an aggregate over `objects`, so a second process
 * writing concurrently can no longer clobber `charsSaved` (the JSONL-era
 * "last writer wins" caveat), and `recalls` is an atomic `v = v + 1`.
 *
 * `node:sqlite` is a standard-library module (Node >= 22.5) and the harness
 * itself uses it for session search, so this adds no dependency. It is imported
 * lazily: on an older Node the caller degrades instead of breaking the profile.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

/** Magic in PRAGMA application_id: "RCLL", so we never adopt a foreign database. */
const APPLICATION_ID = 0x52434c4c
const SCHEMA_VERSION = 1

const SCHEMA = `
CREATE TABLE IF NOT EXISTS blobs (
  hash    TEXT PRIMARY KEY,
  enc     TEXT NOT NULL,
  bytes   INTEGER NOT NULL,
  payload BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS objects (
  id           TEXT PRIMARY KEY,
  session      TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  tool         TEXT NOT NULL,
  chars        INTEGER NOT NULL,
  inline_chars INTEGER NOT NULL,
  tokens_saved INTEGER NOT NULL,
  ts           INTEGER NOT NULL,
  hash         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS objects_ts ON objects(ts);
CREATE UNIQUE INDEX IF NOT EXISTS objects_origin ON objects(session, seq);
CREATE TABLE IF NOT EXISTS counters (
  k TEXT PRIMARY KEY,
  v INTEGER NOT NULL
);
`

export class Store {
  #db
  #file
  #dir
  #sql = new Map()

  constructor(db, file, dir) {
    this.#db = db
    this.#file = file
    this.#dir = dir
  }

  /** One prepared statement per distinct SQL text: the reaper asks `has()` per candidate. */
  #stmt(sql) {
    let statement = this.#sql.get(sql)
    if (statement === undefined) {
      statement = this.#db.prepare(sql)
      this.#sql.set(sql, statement)
    }
    return statement
  }

  /**
   * Open (or create) the store, migrating the pre-0.4 `.txt` + `index.jsonl`
   * layout on first run so object ids already quoted in old conversations keep
   * resolving.
   * @param dir state directory (`~/.local/share/dsh-recall`)
   * @param options.headChars head budget used to approximate legacy accounting
   */
  static async open(dir, options = {}) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = path.join(dir, 'store.db')
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(file)
    try {
      db.exec('PRAGMA busy_timeout = 5000')
      try {
        db.exec('PRAGMA journal_mode = WAL')
      } catch {
        // WAL is unavailable on some network filesystems; the rollback journal works.
      }
      const { application_id: appId } = db.prepare('PRAGMA application_id').get()
      const { user_version: version } = db.prepare('PRAGMA user_version').get()
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*'")
        .all()
      if (appId !== 0 && appId !== APPLICATION_ID) {
        throw new Error(`dsh-recall: "${file}" belongs to another application (application_id ${appId})`)
      }
      if (appId === 0 && tables.length > 0) {
        throw new Error(`dsh-recall: "${file}" is not empty and was not created by dsh-recall`)
      }
      if (appId === APPLICATION_ID && version !== SCHEMA_VERSION) {
        throw new Error(`dsh-recall: schema version ${version} at "${file}", this build expects ${SCHEMA_VERSION}`)
      }
      if (appId === 0) {
        db.exec(`PRAGMA application_id = ${APPLICATION_ID}`)
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
        // Declared before the first table so eviction can actually return pages to
        // the filesystem; on a legacy database it stays a no-op.
        db.exec('PRAGMA auto_vacuum = INCREMENTAL')
      }
      db.exec(SCHEMA)
    } catch (error) {
      db.close()
      throw error
    }
    const store = new Store(db, file, dir)
    store.#migrateLegacy(options.headChars ?? 600)
    return store
  }

  /** Filesystem path of the database (diagnostics). */
  get file() {
    return this.#file
  }

  /**
   * Whether this session/seq pair was already offloaded. Structural, unlike the
   * textual `[recall]` marker: a tool that *prints* the marker cannot make the
   * reaper skip a genuine result.
   * @param session session id
   * @param seq original tool/result seq
   */
  has(session, seq) {
    return this.#stmt('SELECT 1 AS hit FROM objects WHERE session = ? AND seq = ? LIMIT 1').get(session, seq) !== undefined
  }

  /**
   * Persist one offloaded text (verbatim) and its accounting row.
   * @returns whether a new object row was inserted (false when it already existed)
   */
  put({ id, session, seq, tool, text, chars, inlineChars, tokensSaved, ts }) {
    const raw = Buffer.from(text, 'utf8')
    const hash = createHash('sha256').update(raw).digest('hex')
    const deflated = zlib.deflateRawSync(raw)
    const useDeflate = deflated.length < raw.length
    this.#stmt('INSERT OR IGNORE INTO blobs (hash, enc, bytes, payload) VALUES (?, ?, ?, ?)').run(
      hash,
      useDeflate ? 'deflate-raw' : 'identity',
      raw.length,
      useDeflate ? deflated : raw,
    )
    const info = this.#stmt(
      'INSERT OR IGNORE INTO objects (id, session, seq, tool, chars, inline_chars, tokens_saved, ts, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, session, seq, tool, chars, inlineChars, tokensSaved, Number.isFinite(ts) ? ts : Date.now(), hash)
    return info.changes > 0
  }

  /**
   * Read one object back.
   * @returns the verbatim text, or null when the id is unknown
   */
  text(id) {
    const row = this.#stmt(
      'SELECT b.enc AS enc, b.payload AS payload FROM objects o JOIN blobs b ON b.hash = o.hash WHERE o.id = ?',
    ).get(id)
    if (row === undefined) return null
    const payload = Buffer.from(row.payload)
    return row.enc === 'identity' ? payload.toString('utf8') : zlib.inflateRawSync(payload).toString('utf8')
  }

  /** Count one successful `recall` call. */
  bumpRecall() {
    this.#stmt('INSERT INTO counters (k, v) VALUES (?, 1) ON CONFLICT(k) DO UPDATE SET v = v + 1').run('recalls')
  }

  /** Aggregate counters and the latest offloads for the strip. */
  stats(limit = 12) {
    const disk = this.#diskBytes()
    const agg = this.#stmt(
      'SELECT COUNT(*) AS n, COALESCE(SUM(chars - inline_chars), 0) AS charsSaved, COALESCE(SUM(tokens_saved), 0) AS tokensSaved FROM objects',
    ).get()
    const recalls = this.#stmt('SELECT v FROM counters WHERE k = ?').get('recalls')?.v ?? 0
    const recent = this.#stmt('SELECT session, seq, tool, id, chars, ts FROM objects ORDER BY ts DESC, rowid DESC LIMIT ?').all(
      limit,
    )
    return {
      offloaded: Number(agg.n),
      charsSaved: Number(agg.charsSaved),
      tokensSaved: Number(agg.tokensSaved),
      recalls: Number(recalls),
      bytes: Number(disk.bytes),
      rawBytes: Number(disk.raw),
      recent: recent.map((row) => ({ ...row })),
    }
  }

  /** Object/blob counts and raw payload bytes (diagnostics and dedupe checks). */
  diagnostics() {
    const { objects } = this.#stmt('SELECT COUNT(*) AS objects FROM objects').get()
    const { blobs } = this.#stmt('SELECT COUNT(*) AS blobs FROM blobs').get()
    const { bytes } = this.#stmt('SELECT COALESCE(SUM(bytes), 0) AS bytes FROM blobs').get()
    const { payload } = this.#stmt('SELECT COALESCE(SUM(LENGTH(payload)), 0) AS payload FROM blobs').get()
    return { objects: Number(objects), blobs: Number(blobs), bytes: Number(bytes), payloadBytes: Number(payload) }
  }

  /** Payload bytes actually held by the shared blob table (deduplicated). */
  #diskBytes() {
    const row = this.#stmt(
      'SELECT COALESCE(SUM(LENGTH(payload)), 0) AS bytes, COALESCE(SUM(bytes), 0) AS raw FROM blobs',
    ).get()
    return { bytes: Number(row.bytes), raw: Number(row.raw) }
  }

  /**
   * Evict to a retention policy: objects older than `maxAgeDays`, then oldest
   * first until the payload fits `maxBytes`, then drop unreferenced blobs.
   * Deleting an object breaks pointers to it — that is inherent to any cap, so
   * it only runs when a limit is configured.
   * @returns counts of evicted objects and reclaimed blobs
   */
  gc({ maxAgeDays = 0, maxBytes = 0 } = {}) {
    const evicted = { objects: 0, blobs: 0 }
    if (!(maxAgeDays > 0) && !(maxBytes > 0)) return evicted
    if (maxAgeDays > 0) {
      const cutoff = Date.now() - maxAgeDays * 86400000
      evicted.objects += Number(this.#stmt('DELETE FROM objects WHERE ts < ?').run(cutoff).changes)
    }
    if (maxBytes > 0) {
      // Batches of 64 bound the overshoot without one statement per object.
      for (let guard = 0; guard < 1024; guard += 1) {
        if (this.#diskBytes().bytes <= maxBytes) break
        const victims = this.#stmt('SELECT id FROM objects ORDER BY ts ASC, rowid ASC LIMIT 64').all()
        if (victims.length === 0) break
        for (const victim of victims) this.#stmt('DELETE FROM objects WHERE id = ?').run(victim.id)
        evicted.objects += victims.length
      }
    }
    evicted.blobs = Number(
      this.#stmt('DELETE FROM blobs WHERE hash NOT IN (SELECT hash FROM objects)').run().changes,
    )
    try {
      this.#db.exec('PRAGMA incremental_vacuum')
    } catch {
      // Legacy databases created without incremental auto-vacuum keep their pages.
    }
    return evicted
  }

  close() {
    try {
      this.#sql.clear()
      this.#db.close()
    } catch {}
  }

  /**
   * Import the 0.3 layout (`objects/<id>.txt` + `index.jsonl`) once. Legacy
   * rows never recorded inline size or token price, so those two columns are
   * estimated; everything addressable by id keeps working.
   */
  #migrateLegacy(headChars) {
    const index = path.join(this.#dir, 'index.jsonl')
    if (!existsSync(index)) return
    let imported = 0
    try {
      for (const line of readFileSync(index, 'utf8').split('\n')) {
        if (!line.trim()) continue
        let row
        try {
          row = JSON.parse(line)
        } catch {
          continue
        }
        const id = typeof row?.id === 'string' ? row.id : ''
        if (!/^[0-9a-f]{6,32}$/i.test(id)) continue
        if (typeof row?.session !== 'string' || !Number.isFinite(row?.seq)) continue
        if (this.has(row.session, row.seq)) continue
        const file = path.join(this.#dir, 'objects', `${id}.txt`)
        if (!existsSync(file)) continue
        const text = readFileSync(file, 'utf8')
        const chars = Array.from(text).length
        const inlineChars = Math.min(chars, headChars)
        const inserted = this.put({
          id,
          session: row.session,
          seq: Number(row.seq),
          tool: String(row.tool ?? 'tool'),
          text,
          chars,
          inlineChars,
          tokensSaved: Math.max(0, Math.round((chars - inlineChars) / 4)),
          // Keep the original age: a migrated object must not look brand new to
          // the retention policy.
          ...Number.isFinite(row.ts) ? { ts: row.ts } : {},
        })
        if (inserted) imported += 1
      }
      renameSync(index, `${index}.migrated`)
      if (imported > 0) console.error(`[recall] migrated ${imported} legacy object(s) into ${this.#file}`)
    } catch (e) {
      console.error('[recall] legacy migration failed:', e && (e.message || e))
    }
  }
}
