// Probe for the reaper policy: drives `tools/post-execute` with a hand-rolled
// session and asserts what matters —
//   * only old oversized results are replaced (KEEP protects the newest);
//   * the pointer keeps a head AND a tail, plus the real tool name;
//   * a stock spill notice inside the tail budget survives whole;
//   * the token budget gates the whole pass (nothing is shortened for free);
//   * the rewrite is idempotent through the store, not through a text marker;
//   * recall(id, start, count) returns the slice and recall(id, query) finds lines.
//
// Every mount gets its own $HOME state dir, so the real one is never touched.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

process.env.HOME = mkdtempSync(path.join(tmpdir(), 'dsh-recall-test-'))
const { importHosted } = await import('./support/host.mjs')
const { apply } = await importHosted('../index.js', import.meta.url)

const big = (n, ch) => ch.repeat(n)
const textOfMessage = (m) => (m.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('')

/**
 * Build a fake session from [{callId, name, text}], mount the plugin on a fake
 * cordis ctx, and return the hook plus the observable pieces.
 */
async function mount({ texts, config = {}, measure }) {
  const events = new Map()
  let seq = 0
  for (const { callId, name, text } of texts) {
    seq += 1
    events.set(seq, { type: 'tool/call', data: { callId, name, arguments: '{}' } })
    seq += 1
    events.set(seq, {
      type: 'tool/result',
      data: { message: { role: 'tool', source: { kind: 'tool', callId }, content: [{ type: 'text', text }] } },
    })
  }
  const appended = []
  const session = {
    id: 'stub-session',
    surface: { nodes: new Set(events.keys()) },
    eventAt: (s) => events.get(s),
    deriveEventMessage: (ev) => ({ ...ev.data.message, role: 'tool' }),
    append: (type, data, opts) => {
      appended.push({ type, data, opts })
      if (type === 'tool/result' && opts?.surfaceOp) {
        events.set(opts.surfaceOp.startSeq, { type: 'tool/result', data, sourceEventSeqs: opts.sourceEventSeqs })
      }
      return { seq: events.size + appended.length }
    },
  }
  const meter = {
    estimateMessage: (m) => Math.ceil(textOfMessage(m).length / 4),
    measure: measure ?? (() => ({ totalTokens: 0 })),
  }
  let hook
  const tools = []
  await apply(
    {
      on: (ev, fn) => { if (ev === 'tools/post-execute') hook = fn },
      effect: (fn) => fn(),
      inject: () => {},
      tokenMeter: meter,
      tools: { register: (t) => tools.push(t) },
    },
    { stateDir: mkdtempSync(path.join(tmpdir(), 'recall-state-')), ...config },
  )
  const exec = { callId: texts.at(-1).callId, name: texts.at(-1).name, agent: { session } }
  const run = () => hook(exec, { content: [] }, async () => ({ kind: 'accept', content: [] }))
  await run()
  return { session, events, appended, tools, run, recall: tools.find((t) => t.name === 'recall'), textAt: (s) => textOfMessage(events.get(s).data.message) }
}

const prunes = (mounted) => mounted.appended.filter((a) => a.type === 'compaction/prune')

// ---------------------------------------------------------------- base policy
const base = await mount({
  texts: [
    { callId: 'call_A', name: 'read', text: big(4000, 'X') },
    { callId: 'call_B', name: 'bash', text: 'small' },
    { callId: 'call_C', name: 'bash', text: 'fresh ' + big(5000, 'Y') },
    { callId: 'call_D', name: 'bash', text: 'hi' },
  ],
})
assert.deepEqual(prunes(base).map((p) => p.data.shadowedSeqs[0]), [2], 'exactly seq 2 should be pruned')
assert.ok(prunes(base)[0].data.shadowedTokenCount > 0, 'the shadow price comes from the token meter')

const note = base.textAt(2)
assert.ok(note.startsWith('X'.repeat(600)), 'head of 600 chars stays inline')
assert.ok(note.endsWith('X'.repeat(240)), 'tail of 240 chars stays inline')
assert.ok(note.includes('[recall] read call_A'), 'the pointer carries the tool name from the matching tool/call')
assert.ok(note.length < 1400, 'the pointer is much shorter than the original')
assert.equal(base.textAt(6), 'fresh ' + big(5000, 'Y'), 'the newest big result stays intact (keep=2)')
assert.equal(base.textAt(4), 'small')
assert.equal(base.textAt(8), 'hi')

const id = /#([0-9a-f]{8})/.exec(note)?.[1]
assert.ok(id, 'the pointer carries an object id')
assert.ok(note.includes(`recall("${id}")`), 'the pointer says how to fetch the rest')

// ------------------------------------------------------------- idempotence
await base.run()
assert.equal(prunes(base).length, 1, 'a stored result is never offloaded twice')

// ------------------------------------------------------------------- search
const search = String(await base.recall.execute({ id, query: 'XXXX' }))
assert.ok(search.includes(`object #${id}`), 'search is labelled with the object')
assert.ok(search.includes('0: '), 'search reports the character offset of the match')
const missing = String(await base.recall.execute({ id, query: 'no-such-token' }))
assert.ok(missing.includes('no case-sensitive match'), 'an empty search says so instead of returning a slice')
const slice = String(await base.recall.execute({ id, start: 3900, count: 200 }))
assert.ok(slice.includes(big(100, 'X')), 'recall still returns the requested slice')
assert.ok(String(await base.recall.execute({ id: 'nope' })).includes('not an object id'))
assert.ok(String(await base.recall.execute({ id: 'abcdef12' })).includes('not found'))

// ------------------------------------------- the stock spill notice survives
const notice =
  '(' +
  'output omitted by the retention policy '.repeat(8) +
  ' Full formatted result stored at: /tmp/dsh-spill-x/session-abc/result-1.txt. ' +
  'Read the full result with the read tool on that path.)'
assert.ok(notice.length > 240, 'the notice is longer than the tail budget, so a plain tail would cut it')
const spill = await mount({
  texts: [
    { callId: 'call_S', name: 'bash', text: big(3000, 'D') + notice },
    { callId: 'call_E', name: 'bash', text: 'a' },
    { callId: 'call_F', name: 'bash', text: 'b' },
  ],
})
const spillNote = spill.textAt(2)
assert.ok(spillNote.endsWith(notice), 'the whole spill notice is kept, including its opening paren')
assert.ok(spillNote.includes(' Full formatted result stored at: '), 'the locator the model needs is intact')

// ------------------------------------------------------------ token budget
const texts = [
  { callId: 'call_A', name: 'read', text: big(4000, 'X') },
  { callId: 'call_B', name: 'bash', text: 'small' },
  { callId: 'call_C', name: 'bash', text: 'fresh ' + big(5000, 'Y') },
  { callId: 'call_D', name: 'bash', text: 'hi' },
]
const roomy = await mount({ texts, config: { budgetTokens: 200000 }, measure: () => ({ totalTokens: 120000 }) })
assert.equal(prunes(roomy).length, 0, 'nothing is shortened while the surface is inside its budget')

const tight = await mount({ texts, config: { budgetTokens: 5000 }, measure: () => ({ totalTokens: 900000 }) })
assert.equal(prunes(tight).length, 1, 'an over-budget surface is offloaded')

console.log('ok — policy, spill notice, budget gate, idempotence, slice and search')
