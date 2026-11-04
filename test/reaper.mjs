// Unit probe for the reaper: drives the `tools/post-execute` hook with a hand-rolled
// session and asserts the three things that matter — only old oversized results are
// replaced, the pointer carries the real tool name, and recall(id, start, count) can
// read the slice back out of the store.
//
// The state dir is derived from $HOME, so the test points HOME at a throwaway
// directory BEFORE importing the plugin; the real ~/.local/share/dsh-recall is never
// touched.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

if (!process.env.DSH_RECALL_TEST_HOME) {
  process.env.HOME = mkdtempSync(path.join(tmpdir(), 'dsh-recall-test-'))
}
const STATE = path.join(process.env.HOME, '.local/share/dsh-recall')
const { apply } = await import('../index.js')

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
    if (type === 'tool/result' && opts?.surfaceOp) {
      const seq = opts.surfaceOp.startSeq
      events.set(seq, { type: 'tool/result', data })
    }
  },
}

let hook
const tools = []
apply({
  on: (ev, fn) => { if (ev === 'tools/post-execute') hook = fn },
  inject: () => {},
  tokenMeter: { estimateMessage: () => 1200 },
  tools: { register: (t) => tools.push(t) },
})

const decision = { kind: 'accept', content: [] }
await hook({ callId: 'call_D', name: 'bash', agent: { session } }, { content: [] }, async () => decision)

const textAt = (seq) => events.get(seq).data.message.content.map((b) => b.text).join('')
const prunes = appended.filter((a) => a.type === 'compaction/prune')

// 1. only the old oversized result was shadowed
assert.deepEqual(prunes.map((p) => p.data.shadowedSeqs[0]), [2], 'exactly seq 2 should be pruned')
assert.equal(prunes[0].data.shadowedTokenCount, 1200, 'shadow price comes from tokenMeter')

// 2. the pointer keeps a head, names the tool, and quotes the real size
const note = textAt(2)
assert.ok(note.startsWith('X'.repeat(600)), 'head of 600 chars stays inline')
assert.ok(note.includes('[recall] read call_A'), 'pointer carries the tool name resolved from tool/call')
assert.ok(note.length < 1000, 'pointer is much shorter than the original')
const id = /#([0-9a-f]{8})/.exec(note)?.[1]
assert.ok(id, 'pointer carries an object id')

// 3. the newest big result and every small one are untouched
assert.equal(textAt(6), 'fresh ' + big(5000, 'Y'), 'fresh result stays intact (KEEP=2)')
assert.equal(textAt(4), 'small')
assert.equal(textAt(8), 'hi')

// 4. the full text is on disk and the index is honest about the tool
assert.equal(readFileSync(path.join(STATE, 'objects', `${id}.txt`), 'utf8'), big(4000, 'X'))
const index = readFileSync(path.join(STATE, 'index.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
assert.equal(index.length, 1)
assert.equal(index[0].tool, 'read')
assert.equal(index[0].chars, 4000)

// 5. recall reads back a slice and counts the hit
const recall = tools.find((t) => t.name === 'recall')
assert.ok(recall, 'recall tool is registered')
assert.equal(typeof recall.output.render, 'function', 'output.render must exist or every call dies')
const out = String(await recall.execute({ id, start: 3900, count: 200 }))
assert.ok(out.includes(big(100, 'X')), 'slice from the tail is real content')
assert.ok(out.startsWith('[recall] object #' + id), 'slice is labelled')
assert.equal(String(await recall.execute({ id: 'nope' })), 'recall: "nope" is not an object id (expected 8 hex chars).')

// 6. counters were written, and the second pass is idempotent
const counters = JSON.parse(readFileSync(path.join(STATE, 'counters.json'), 'utf8'))
assert.equal(counters.hits, 1)
assert.equal(counters.recalls, 1)
await hook({ callId: 'call_D', name: 'bash', agent: { session } }, { content: [] }, async () => decision)
assert.equal(appended.filter((a) => a.type === 'compaction/prune').length, 1, 'a marked result is never offloaded twice')
assert.equal(readdirSync(path.join(STATE, 'objects')).length, 1)

console.log(`ok — 1 offload, ${note.length} chars inline, recall slice verified, state dir ${STATE}`)
