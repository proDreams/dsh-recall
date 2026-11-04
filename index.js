/*!
 * dsh-recall — host half.
 *
 * The measured lever (LC_CRM, 8 504 tool results): 4.6% of results are bigger
 * than 6 KB, they hold 40.7% of all tool-result volume, and 76% of them are
 * never opened again. So: keep the head of a big result in the conversation,
 * move the rest to disk, and leave a pointer the model can dereference.
 *
 * Rules:
 *  - only results older than the newest KEEP results are touched (the freshest
 *    output is always intact);
 *  - only results above THRESHOLD chars;
 *  - the head stays in the conversation, so the model always sees the beginning;
 *  - the full text is addressable by `recall(id)` / `recall(id, start, count)`;
 *  - the rewrite reuses the replay-safe replace path of the stock pruner.
 */
import { mkdirSync, writeFileSync, readFileSync, appendFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import { homedir } from 'node:os'
import { defineTool } from '@deepseek-ai/dsh-tools'
import path from 'node:path'

export const name = 'dsh-recall'
export const inject = ['tools', 'tokenMeter']

// Tuned 2026-11-03 on measured volume: threshold 6000 covered only 23.5% of
// tool-result volume, 2500 covers 53.0%; head 600 (not 1200) is enough for the
// model to recognise the result, and KEEP 2 keeps the freshest output intact.
const THRESHOLD = 2500
const HEAD = 600
const KEEP = 2
const STATE_DIR = path.join(homedir(), '.local/share/dsh-recall')
const OBJECTS = path.join(STATE_DIR, 'objects')
const INDEX = path.join(STATE_DIR, 'index.jsonl')
const COUNTERS = path.join(STATE_DIR, 'counters.json')
const MARK = '[recall]'

let hits = 0
let charsSaved = 0
let recalls = 0

// callId → tool name, learned from the exec objects we see. `surface.nodes` holds
// only message-bearing events, so a `tool/call` lookup there finds nothing and the
// pointer note degrades to "tool call_01_"; this map is filled as calls happen.
const names = new Map()

// Counters are read back at boot: in-memory state dies on restart, and the strip
// must keep showing the running total (`recalls` has no other source — the index
// only knows what was offloaded).
try {
  const saved = JSON.parse(readFileSync(COUNTERS, 'utf8'))
  hits = Number(saved.hits) || 0
  charsSaved = Number(saved.charsSaved) || 0
  recalls = Number(saved.recalls) || 0
} catch {}

function textOf(content) {
  let text = ''
  for (const block of content ?? []) {
    if (block?.type === 'text' && typeof block.text === 'string') text += block.text
  }
  return text
}

function save(objectId, text, meta) {
  mkdirSync(OBJECTS, { recursive: true })
  writeFileSync(path.join(OBJECTS, objectId + '.txt'), text)
  appendFileSync(INDEX, JSON.stringify({ ...meta, id: objectId, chars: text.length, ts: Date.now() }) + '\n')
}

function persistCounters() {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(COUNTERS, JSON.stringify({ hits, charsSaved, recalls }))
  } catch {}
}

function pointer(text, objectId, label) {
  const head = text.slice(0, HEAD)
  const rest = text.length - HEAD
  return [
    head,
    `\n\n${MARK} ${label} — ${text.length} chars total. The first ${HEAD} are above; ` +
      `the remaining ${rest} chars are stored as object #${objectId}. ` +
      `Fetch it with recall("${objectId}") (optionally recall("${objectId}", start, count)).`,
  ].join('')
}

export function apply(ctx) {
  // ------------------------------------------------------------ the reaper
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    const session = exec.agent?.session
    if (exec?.callId && exec?.name) names.set(String(exec.callId), String(exec.name))
    if (!session?.surface) return decision

    try {
      const nodes = [...session.surface.nodes]
      const results = []
      // `message.source` only carries {kind, callId}, never the tool name, so the
      // pointer note (and the index) would read "tool call_01_" without this map.
      const toolNames = new Map()
      for (const seq of nodes) {
        const event = session.eventAt(seq)
        if (event?.type === 'tool/result') results.push({ seq, event })
        else if (event?.type === 'tool/call' && event.data?.callId) {
          toolNames.set(String(event.data.callId), String(event.data.name ?? 'tool'))
        }
      }
      const older = results.slice(0, Math.max(0, results.length - KEEP))
      for (const { seq, event } of older) {
        const original = session.deriveEventMessage(event)
        const text = textOf(original.content)
        if (text.length <= THRESHOLD || text.includes(MARK)) continue

        const objectId = createHash('md5').update(`${session.id}:${seq}:${text.length}`).digest('hex').slice(0, 8)
        const source = event.data?.message?.source ?? {}
        const toolName = String(
          source.toolName ?? names.get(String(source.callId)) ?? toolNames.get(String(source.callId)) ?? 'tool',
        )
        const label = toolName + (source.callId ? ` ${String(source.callId).slice(0, 8)}` : '')
        save(objectId, text, { session: session.id ?? 'session', seq, tool: toolName })

        const content = [{ type: 'text', text: pointer(text, objectId, label) }]
        const message = freezeMessage({ ...original, content })

        session.append('compaction/prune', {
          shadowedRange: { start: seq, end: seq },
          shadowedSeqs: [seq],
          shadowedTokenCount: ctx.tokenMeter.estimateMessage(original),
        })
        session.append(
          'tool/result',
          { ...event.data, message },
          { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] },
        )

        hits += 1
        charsSaved += text.length - pointer(text, objectId, label).length
      }
      if (hits) persistCounters()
    } catch (e) {
      console.error('[recall] reaper failed:', e && (e.message || e))
    }
    return decision
  })

  // ------------------------------------------------------------- the tool
  ctx.tools.register(
    defineTool({
      name: 'recall',
      description:
        'Read back a tool result that was moved out of the conversation to save context. Big results keep only their head inline and are stored under an object id shown in a [recall] note. Call recall("<id>") for the whole text, or recall("<id>", start, count) for a character range.',
      parameters: {
        id: { type: 'string', required: true, description: 'Object id from the [recall] note, e.g. "3f9a1c2d".' },
        start: { type: 'number', description: 'Character offset to start from (default 0).' },
        count: { type: 'number', description: 'How many characters to return (default 8000, max 24000).' },
      },
      // defineTool dereferences options.output unconditionally and calls
      // output.render on every result, so both must exist even for one string.
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
      },
      async execute(args) {
        const id = String(args?.id ?? '').trim().replace(/^#/, '')
        if (!/^[0-9a-f]{6,32}$/i.test(id)) return `recall: "${id}" is not an object id (expected 8 hex chars).`
        const file = path.join(OBJECTS, id + '.txt')
        if (!existsSync(file)) return `recall: object #${id} not found. Known ids are in ~/.local/share/dsh-recall/index.jsonl.`
        const text = readFileSync(file, 'utf8')
        const start = Math.max(0, Math.floor(Number(args?.start) || 0))
        const count = Math.min(24000, Math.max(1, Math.floor(Number(args?.count) || 8000)))
        const slice = text.slice(start, start + count)
        recalls += 1
        persistCounters()
        const end = Math.min(text.length, start + count)
        return `${MARK} object #${id}, chars ${start}–${end} of ${text.length}:\n\n${slice}`
      },
    }),
  )

  // ---------------------------------------------------------------- HTTP API
  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => {
      const handler = (req, res) => {
        const url = new URL(req.url, 'http://x')
        const send = (code, body) => {
          res.statusCode = code
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.end(JSON.stringify(body))
        }
        if (url.pathname === '/recall/api/stats') {
          let counters = {}
          try {
            if (existsSync(COUNTERS)) counters = JSON.parse(readFileSync(COUNTERS, 'utf8'))
          } catch {}
          const recent = []
          try {
            if (existsSync(INDEX)) {
              for (const line of readFileSync(INDEX, 'utf8').split('\n')) {
                if (!line.trim()) continue
                try {
                  recent.push(JSON.parse(line))
                } catch {}
              }
            }
          } catch {}
          const savedChars = recent.reduce((n, e) => n + Math.max(0, (e.chars || 0) - HEAD), 0)
          return send(200, {
            offloaded: recent.length,
            charsSaved: Math.max(savedChars, counters.charsSaved ?? 0),
            tokensSaved: Math.round(Math.max(savedChars, counters.charsSaved ?? 0) / 4),
            recalls: counters.recalls ?? 0,
            threshold: THRESHOLD,
            recent: recent.slice(-12).reverse(),
          })
        }
        return send(404, { error: 'not found' })
      }
      return scope.webServer.register({ kind: 'prefix', path: '/recall', handler })
    })
  })
}
