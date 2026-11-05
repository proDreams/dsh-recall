// Integration probe: drive dsh-recall's hook against the REAL Session class
// from the installed @deepseek-ai/dsh-session (0.2.0-rc.2), not a stub.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

process.env.HOME = mkdtempSync(path.join(tmpdir(), 'recall-real-'))
const { Session } = await import('@deepseek-ai/dsh-session')
const { createToolResultMessage, createUserMessage } = await import('@deepseek-ai/dsh-llm')
const { apply } = await import('../index.js')

const big = (n, ch) => ch.repeat(n)

const s = Session.create('recall-integration')
s.append('user/message', { turn: 1, step: 0, message: createUserMessage({ content: [{ type: 'text', text: 'go' }] }) }, { surfaceOp: 'append' })

let turn = 1
for (const [callId, name, text] of [
  ['call_A', 'read', big(4000, 'X')],
  ['call_B', 'bash', 'small'],
  ['call_C', 'bash', 'fresh ' + big(5000, 'Y')],
  ['call_D', 'bash', 'hi'],
]) {
  s.append('tool/call', { turn, step: 0, callId, name, arguments: '{}' })
  const callSeq = s.log[s.log.length - 1].seq
  const msg = createToolResultMessage({ callId, content: [{ type: 'text', text }], isError: false })
  s.append('tool/result', { turn, step: 0, message: msg }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
}

const before = [...s.surface.nodes]
console.log('surface before:', before.length, 'nodes; seqs:', before.join(','))

let hook
const tools = []
await apply({
  on: (ev, fn) => { if (ev === 'tools/post-execute') hook = fn },
  effect: (fn) => fn(),
  inject: () => {},
  tokenMeter: { estimateMessage: (m) => Math.ceil((m.content ?? []).reduce((n, b) => n + (b.type === 'text' ? b.text.length : 0), 0) / 4) || 1 },
  tools: { register: (t) => tools.push(t) },
})

await hook({ callId: 'call_D', name: 'bash', agent: { session: s } }, { content: [] }, async () => ({ kind: 'accept' }))

const after = [...s.surface.nodes]
console.log('surface after: ', after.length, 'nodes; seqs:', after.join(','))
const replacedSeq = after[before.indexOf(before[0])]
const replaced = s.deriveEventMessage(s.eventAt(after[1]))
const text = replaced.content.map((b) => b.text).join('')
console.log('node[1] now:', JSON.stringify(text.slice(0, 40)), '... len', text.length)
console.log('has marker:', text.includes('[recall]'))
const pruneEvents = s.log.filter((e) => e.type === 'compaction/prune')
console.log('compaction/prune events:', pruneEvents.length)
console.log('tool/result log entries:', s.log.filter((e) => e.type === 'tool/result').length)

const recall = tools.find((t) => t.name === 'recall')
const id = /#([0-9a-f]{8})/.exec(text)?.[1]
console.log('object id:', id)
const out = String(await recall.execute({ id, start: 3900, count: 200 }))
assert.ok(out.includes(big(100, 'X')), 'recall returns the real tail slice')
console.log('recall slice OK, length', out.length)
console.log('INTEGRATION OK — real Session accepted every append')
