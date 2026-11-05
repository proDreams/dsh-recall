// Host-half probe: mount dsh-recall with a fake cordis ctx that mimics the real
// service contracts, drive one offload, then serve GET /recall/api/stats.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

process.env.HOME = mkdtempSync(path.join(tmpdir(), 'recall-http-'))
const { importHosted } = await import('./support/host.mjs')
const { apply } = await importHosted('../index.js', import.meta.url)

const big = (n, ch) => ch.repeat(n)
const events = new Map([
  [1, { type: 'tool/call', data: { callId: 'call_A', name: 'read', arguments: '{}' } }],
  [2, { type: 'tool/result', data: { message: { role: 'tool', source: { kind: 'tool', callId: 'call_A' }, content: [{ type: 'text', text: big(4000, 'X') }] } } }],
  [3, { type: 'tool/call', data: { callId: 'call_B', name: 'bash', arguments: '{}' } }],
  [4, { type: 'tool/result', data: { message: { role: 'tool', source: { kind: 'tool', callId: 'call_B' }, content: [{ type: 'text', text: 'a' }] } } }],
  [5, { type: 'tool/result', data: { message: { role: 'tool', source: { kind: 'tool', callId: 'call_C' }, content: [{ type: 'text', text: 'b' }] } } }],
])
const session = {
  id: 'http-probe',
  surface: { nodes: new Set(events.keys()) },
  eventAt: (s) => events.get(s),
  deriveEventMessage: (ev) => ({ ...ev.data.message, role: 'tool' }),
  append: (type, data, opts) => {
    if (type === 'tool/result' && opts?.surfaceOp) events.set(opts.surfaceOp.startSeq, { type, data })
  },
}

let hook
const tools = []
const routes = []
const ctx = {
  on: (ev, fn) => { if (ev === 'tools/post-execute') hook = fn },
  effect: (fn) => fn(),
  tokenMeter: { estimateMessage: (m) => Math.ceil((m.content ?? []).reduce((n, b) => n + (b.type === 'text' ? b.text.length : 0), 0) / 4) || 1 },
  tools: { register: (t) => tools.push(t) },
  inject: (deps, callback) => callback({
    effect: (fn) => fn(),
    webServer: { register: (r) => { routes.push(r); return () => {} } },
  }),
}
await apply(ctx, {})
await hook({ callId: 'call_B', name: 'bash', agent: { session } }, { content: [] }, async () => ({ kind: 'accept' }))

console.log('routes registered:', routes.map((r) => `${r.kind}:${r.path}`).join(', '))
const route = routes.find((r) => r.path === '/recall')

function call(pathname) {
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v }, end(body) { this.body = body } }
  route.handler({ url: pathname }, res)
  return { code: res.statusCode, body: JSON.parse(res.body) }
}

const stats = call('/recall/api/stats')
console.log('stats status:', stats.code)
if (stats.body.bytes === undefined) throw new Error('stats must expose the on-disk footprint')
if (stats.body.tokensSaved <= 0) throw new Error('tokensSaved must be priced by the meter')
if (stats.body.threshold !== 2500) throw new Error('stats must echo the effective threshold')
console.log(JSON.stringify(stats.body, null, 1))
console.log('404 route:', call('/recall/nope').code)
