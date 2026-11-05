// Unit probe for the reaper: drives the `tools/post-execute` hook with a hand-rolled
// session and asserts the things that matter — only old oversized results are
// replaced, the pointer keeps a head AND a tail plus the real tool name, the
// rewrite is idempotent without trusting a text marker, and recall(id, start,
// count) reads the exact slice back out of the store.
//
// The state dir is derived from $HOME, so the test points HOME at a throwaway
// directory BEFORE importing the plugin; the real ~/.local/share/dsh-recall is
// never touched.
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

process.env.HOME = mkdtempSync(path.join(tmpdir(), 'dsh-recall-test-'))
const STATE = path.join(process.env.HOME, '.local/share/dsh-recall')
const { apply } = await import('../index.js')
const { Store } = await import('../store.js')

const big = (n, ch) => ch.repeat(n)
const events = new Map([
  [1, { type: 'tool/call', data: { callId: 'call_A', name: 'read', arguments: '{}' } }],
  [2, { type: 'tool/result', data: { message: { role: 'tool', source: { kind: 'tool', callId: 'call_A' }, content: [{ type: 'text', text: big(4000, 'X') }] } } }],
  [3, { type: 'tool/call', data: { callId: 'call_B', name: 'bash', arguments: '{}' } }],
  [4, { type: 'tool/result', data: { message: { role: 'tool', source: { kind: 'tool', callId: 'call_B' }, content: [{ type: 'text', text: 'small' }] } } }],
  [5, { type: 'tool/call', data: { callId: 'call_C', name: 'bash', arguments: '{}' } }],
  [6, { type: 'tool/result', data: { message: { role: 'tool', source: { kind: 'tool', callId: 'call_C' }, content: [{ type: 'text', text: 'fresh ' + big(5000, 'Y') }] } } }],
  [7, { type: 'tool/call', data: { callId: 'call_D', name: 'bash', arguments: '{}' } }],
  [8, { type: 'tool/result', data: { message: { role: 'tool', source: { kind: 'tool', callId: 'call_D' }, content: [{ type: 'text', text: 'hi' }] } } }],
])

const appended = []
const session = {
  id: 'stub-session',
  surface: { nodes: new Set(events.keys()) },
  eventAt: (seq) => events.get(seq),
  deriveEventMessage: (ev) => ({ ...ev.data.message, role: 'tool' }),
  append: (type, data, opts) => {
    appended.push({ type, data, opts })
    const seq = appended.length + 100
    if (type === 'tool/result' && opts?.surfaceOp) {
      events.set(opts.surfaceOp.startSeq, { type: 'tool/result', data, sourceEventSeqs: opts.sourceEventSeqs })
    }
    return { seq }
  },
}

const textOfMessage = (m) => (m.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('')
// Token price proportional to text, so the accounting assertion is meaningful.
const meter = { estimateMessage: (m) => Math.ceil(textOfMessage(m).length / 4) }

let hook
const tools = []
const ctx = {
  on: (ev, fn) => { if (ev === 'tools/post-execute') hook = fn },
  effect: (fn) => fn(),
  inject: () => {},
  tokenMeter: meter,
  tools: { register: (t) => tools.push(t) },
}
await apply(ctx, {})

const decision = { kind: 'accept', content: [] }
const exec = { callId: 'call_D', name: 'bash', agent: { session } }
await hook(exec, { content: [] }, async () => decision)

const textAt = (seq) => textOfMessage(events.get(seq).data.message)
const prunes = appended.filter((a) => a.type === 'compaction/prune')

// 1. only the old oversized result was shadowed (KEEP=2 leaves 6 and 8 alone)
assert.deepEqual(prunes.map((p) => p.data.shadowedSeqs[0]), [2], 'exactly seq 2 should be pruned')
assert.ok(prunes[0].data.shadowedTokenCount > 0, 'shadow price comes from the token meter')

// 2. the pointer keeps a head and a tail, names the tool, quotes the real size
const note = textAt(2)
assert.ok(note.startsWith('X'.repeat(600)), 'head of 600 chars stays inline')
assert.ok(note.endsWith('X'.repeat(240)), 'tail of 240 chars stays inline')
assert.ok(note.includes('[recall] read call_A'), 'pointer carries the tool name resolved from tool/call')
assert.ok(note.length < 1400, 'pointer is much shorter than the original')
const id = /#([0-9a-f]{8})/.exec(note)?.[1]
assert.ok(id, 'pointer carries an object id')
assert.ok(note.includes(`recall("${id}")`), 'pointer tells the model how to fetch the rest')

// 3. the newest big result and every small one are untouched
assert.equal(textAt(6), 'fresh ' + big(5000, 'Y'), 'fresh result stays intact (KEEP=2)')
assert.equal(textAt(4), 'small')
assert.equal(textAt(8), 'hi')

// 4. the store has the full text and honest accounting
const store = await Store.open(STATE)
const full = store.text(id)
assert.equal(full, big(4000, 'X'))
let stats = store.stats()
assert.equal(stats.offloaded, 1)
assert.ok(stats.charsSaved > 0, 'chars saved is an aggregate over the store')
assert.ok(stats.tokensSaved > 0, 'token savings come from the meter, not a /4 guess')
assert.equal(stats.recent[0].tool, 'read', 'the index row carries the real tool name')
assert.equal(stats.recent[0].chars, 4000)

// 5. recall reads back a slice and counts the hit
const recall = tools.find((t) => t.name === 'recall')
assert.ok(recall, 'recall tool is registered')
assert.equal(typeof recall.output.render, 'function', 'output.render must exist or every call dies')
const out = String(await recall.execute({ id, start: 3900, count: 200 }))
assert.ok(out.includes(big(100, 'X')), 'slice from the tail is real content')
assert.ok(out.startsWith('[recall] object #' + id), 'slice is labelled')
assert.equal(String(await recall.execute({ id: 'nope' })), 'recall: "nope" is not an object id (expected 8 hex chars).')
assert.ok(String(await recall.execute({ id: 'abcdef12' })).includes('not found'))

// 6. a second pass is idempotent, and it is the store — not the text marker —
//    that decides: a result merely *containing* "[recall]" is still skipped,
//    but seq 2 is never offloaded twice.
await hook(exec, { content: [] }, async () => decision)
assert.equal(appended.filter((a) => a.type === 'compaction/prune').length, 1, 'a stored result is never offloaded twice')
stats = store.stats()
assert.equal(stats.offloaded, 1)

// 7. the counters survive a restart (they are rows, not in-memory state)
store.close()
const reopened = await Store.open(STATE)
assert.equal(reopened.stats().recalls, 1, 'recall count persisted')
assert.equal(reopened.stats().offloaded, 1)
reopened.close()

console.log(`ok — 1 offload, ${note.length} chars inline, recall slice verified, store ${existsSync(path.join(STATE, 'store.db')) ? 'store.db' : 'MISSING'}`)
