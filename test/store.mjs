// Store probe: the storage contract the reaper depends on — verbatim roundtrip,
// code-point accounting, content-hash dedupe, compression, derived counters, the
// foreign-database guard, and the one-time import of the 0.3 `.txt` layout.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Store } from '../store.js'

const dir = mkdtempSync(path.join(tmpdir(), 'dsh-recall-store-'))

// ---------------------------------------------------------------- roundtrip
const store = await Store.open(dir)
const xText = 'X'.repeat(5000)
store.put({ id: 'aaaa1111', session: 's1', seq: 2, tool: 'read', text: xText, chars: 5000, inlineChars: 1000, tokensSaved: 1000 })
assert.equal(store.text('aaaa1111'), xText, 'the full text comes back verbatim')
assert.equal(store.text('bbbb2222'), null, 'unknown ids read as null')

// ------------------------------------------------------- dedupe + compression
store.put({ id: 'aaaa2222', session: 's2', seq: 7, tool: 'bash', text: xText, chars: 5000, inlineChars: 1000, tokensSaved: 1000 })
let d = store.diagnostics()
assert.equal(d.objects, 2, 'two object rows')
assert.equal(d.blobs, 1, 'identical text is stored once (content-hash dedupe)')
assert.equal(d.bytes, 5000, 'raw payload accounted once')
assert.ok(d.payloadBytes < d.bytes / 10, `deflate should shrink repetitive text (${d.payloadBytes} of ${d.bytes} bytes)`)

// ------------------------------------------------------------ code points
const emoji = '😀👍🏽'.repeat(50) // 100 code points, more UTF-16 units
const emojiChars = Array.from(emoji).length
store.put({ id: 'cccc3333', session: 's1', seq: 9, tool: 'read', text: emoji, chars: emojiChars, inlineChars: 10, tokensSaved: 5 })
assert.equal(store.text('cccc3333'), emoji, 'surrogate pairs survive the roundtrip')
const slices = Array.from(store.text('cccc3333'))
assert.equal(slices.length, emojiChars, 'code-point count is what the tool reports')
assert.equal(slices.slice(0, 2).join(''), '😀👍', 'a code-point slice never splits a surrogate pair')

// ------------------------------------------------------- derived counters
let stats = store.stats()
assert.equal(stats.offloaded, 3)
assert.equal(stats.charsSaved, (5000 - 1000) * 2 + (emojiChars - 10), 'chars saved is derived, not accumulated by hand')
assert.equal(stats.tokensSaved, 2005)
assert.equal(stats.recalls, 0)
assert.equal(stats.recent.length, 3)
assert.equal(stats.recent[0].id, 'cccc3333', 'newest first')
store.bumpRecall()
store.bumpRecall()
assert.equal(store.stats().recalls, 2, 'recalls is an atomic counter row')

// --------------------------------------------------- idempotent by origin
assert.equal(store.has('s1', 2), true)
assert.equal(store.has('s1', 3), false)
const dup = store.put({ id: 'aaaa1111', session: 's1', seq: 2, tool: 'read', text: xText, chars: 5000, inlineChars: 1000, tokensSaved: 1000 })
assert.equal(dup, false, 'the same (session, seq) is inserted once')
assert.equal(store.stats().offloaded, 3)

// ------------------------------------------------------------ reopening
store.close()
const again = await Store.open(dir)
assert.equal(again.text('aaaa1111'), xText)
assert.equal(again.stats().recalls, 2, 'counters persist across processes')
again.close()

// ------------------------------------------------- foreign database guard
const foreignDir = mkdtempSync(path.join(tmpdir(), 'dsh-recall-foreign-'))
const { DatabaseSync } = await import('node:sqlite')
const foreign = new DatabaseSync(path.join(foreignDir, 'store.db'))
foreign.exec('CREATE TABLE someone_else (a TEXT)')
foreign.close()
await assert.rejects(() => Store.open(foreignDir), /not empty and was not created by dsh-recall/)

// --------------------------------------------- legacy .txt layout migration
const legacyDir = mkdtempSync(path.join(tmpdir(), 'dsh-recall-legacy-'))
mkdirSync(path.join(legacyDir, 'objects'), { recursive: true })
writeFileSync(path.join(legacyDir, 'objects', 'deadbeef.txt'), 'legacy payload ' + 'Z'.repeat(3000))
writeFileSync(
  path.join(legacyDir, 'index.jsonl'),
  JSON.stringify({ session: 'old-session', seq: 4, tool: 'read', id: 'deadbeef', chars: 3015, ts: 1 }) + '\n',
)
const migrated = await Store.open(legacyDir, { headChars: 600 })
assert.equal(migrated.text('deadbeef'), 'legacy payload ' + 'Z'.repeat(3000), 'old pointers still resolve')
assert.equal(migrated.has('old-session', 4), true)
assert.ok(existsSync(path.join(legacyDir, 'index.jsonl.migrated')), 'the jsonl index is retired, not deleted')
assert.equal(migrated.diagnostics().objects, 1, 'migration is idempotent on a second open')
migrated.close()
const twice = await Store.open(legacyDir, { headChars: 600 })
assert.equal(twice.diagnostics().objects, 1, 're-running migration inserts nothing new')
twice.close()

console.log('ok — roundtrip, dedupe, compression, code points, counters, guard, migration')
