/*!
 * dsh-recall — host half.
 *
 * The measured lever (LC_CRM, 8 504 tool results): 4.6% of results are bigger
 * than 6 KB, they hold 40.7% of all tool-result volume, and 76% of them are
 * never opened again. So: keep the head (and a tail) of a big result in the
 * conversation, move the middle to a local SQLite store, and leave a pointer the
 * model can dereference with `recall(id)`.
 *
 * Rules:
 *  - only results older than the newest KEEP results are touched (the freshest
 *    output is always intact);
 *  - only results above `thresholdChars`;
 *  - the head AND the tail stay inline — the tail is where tools put their own
 *    retrieval notices and summaries (the stock pruner keeps one for the same
 *    reason), and a head-only cut throws that away;
 *  - non-text blocks (images) survive the rewrite; only text is shortened;
 *  - the rewrite reuses the replay-safe replace path of the stock pruner;
 *  - a result is never offloaded twice: the store knows the (session, seq) pair,
 *    so a tool that merely *prints* the `[recall]` marker cannot fool it.
 */
import { createHash } from 'node:crypto'
import path from 'node:path'
import { homedir } from 'node:os'
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { Store } from './store.js'

export const name = 'dsh-recall'
export const inject = ['tools', 'tokenMeter']

/** Marker the model sees and recognises in an already-shortened result. */
const MARK = '[recall]'
const STATE_DIR = path.join(homedir(), '.local/share/dsh-recall')

/**
 * Knobs, as configuration instead of as constants you have to edit in place.
 * The 2 500 / 600 defaults are the measured knee: threshold 6 000 covered only
 * 23.5% of tool-result volume, 2 500 covers 53.0%.
 */
export const Config = z.object({
  thresholdChars: z.number().step(1).min(1).default(2500).description('Only tool results longer than this are offloaded.'),
  headChars: z.number().step(1).min(0).default(600).description('Characters of the result kept inline at the start.'),
  tailChars: z.number().step(1).min(0).default(240).description('Characters kept inline at the end (tool retrieval notices live here).'),
  keep: z.number().step(1).min(0).default(2).description('How many of the newest tool results are always left intact.'),
  enabled: z.boolean().default(true).description('Turn the reaper off without unloading the plugin; recall(id) keeps working.'),
  stateDir: z.string().default(STATE_DIR).description('Directory holding the object store.'),
})

/** Resolve and sanity-check configuration; a no-op pointer is worse than no rewrite. */
function resolveConfig(raw) {
  const config = {
    thresholdChars: Number(raw?.thresholdChars ?? 2500),
    headChars: Number(raw?.headChars ?? 600),
    tailChars: Number(raw?.tailChars ?? 240),
    keep: Number(raw?.keep ?? 2),
    enabled: raw?.enabled !== false,
    stateDir: String(raw?.stateDir ?? STATE_DIR),
  }
  if (!Number.isInteger(config.thresholdChars) || config.thresholdChars < 1) throw new Error('dsh-recall: thresholdChars must be a positive integer')
  for (const key of ['headChars', 'tailChars', 'keep']) {
    if (!Number.isInteger(config[key]) || config[key] < 0) throw new Error(`dsh-recall: ${key} must be a non-negative integer`)
  }
  if (config.headChars + config.tailChars >= config.thresholdChars) {
    throw new Error('dsh-recall: headChars + tailChars must stay below thresholdChars, otherwise nothing is saved')
  }
  const known = new Set(['thresholdChars', 'headChars', 'tailChars', 'keep', 'enabled', 'stateDir'])
  for (const key of Object.keys(raw ?? {})) {
    if (!known.has(key)) throw new Error(`dsh-recall: unknown config key "${key}" (allowed: ${[...known].join(', ')})`)
  }
  return config
}

/** Concatenated text of a message's text blocks (non-text blocks are kept separately). */
function textOf(content) {
  let text = ''
  for (const block of content ?? []) {
    if (block?.type === 'text' && typeof block.text === 'string') text += block.text
  }
  return text
}

/** Count Unicode code points, never UTF-16 units: `slice()` can split a surrogate pair. */
const points = (text) => Array.from(text)
const lengthInPoints = (text) => points(text).length

/**
 * Build the replacement content: head + a [recall] note + tail, followed by any
 * non-text blocks of the original (images) so the rewrite never drops them.
 */
function pointerContent(original, text, config, objectId, label) {
  const chars = points(text)
  const total = chars.length
  const headCount = Math.min(config.headChars, total)
  const tailCount = Math.min(config.tailChars, Math.max(0, total - headCount))
  const middle = total - headCount - tailCount
  const head = chars.slice(0, headCount).join('')
  const tail = tailCount > 0 ? chars.slice(total - tailCount).join('') : ''
  const note =
    `\n\n${MARK} ${label} — ${total} chars total. The head and tail are above and below; ` +
    `the middle ${middle} chars are stored as object #${objectId}. ` +
    `Fetch any part with recall("${objectId}") (optionally recall("${objectId}", start, count)).\n\n`
  const textBlock = { type: 'text', text: head + note + tail }
  const content = [textBlock]
  for (const block of original.content ?? []) {
    if (block?.type !== 'text') content.push(block)
  }
  return { content, inlineChars: lengthInPoints(textBlock.text) }
}

export async function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)

  let store = null
  try {
    store = await Store.open(config.stateDir, { headChars: config.headChars })
    const opened = store
    ctx.effect(() => () => opened.close(), 'dsh-recall: store')
  } catch (e) {
    // A missing/broken store must not take the profile down with it.
    console.error('[recall] object store unavailable:', e && (e.message || e))
    store?.close()
    store = null
  }

  // callId → tool name, learned from the exec objects we see. `surface.nodes` holds
  // only message-bearing events, so a `tool/call` lookup there finds nothing and the
  // pointer note degrades to "tool call_01_"; this map is filled as calls happen.
  const names = new Map()

  // ------------------------------------------------------------ the reaper
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (!config.enabled || store === null) return decision
    const session = exec.agent?.session
    if (exec?.callId && exec?.name) {
      // Bounded: a very long session must not grow this map without limit.
      if (names.size > 512) names.clear()
      names.set(String(exec.callId), String(exec.name))
    }
    if (!session?.surface) return decision

    try {
      const results = []
      const toolNames = new Map()
      for (const seq of [...session.surface.nodes]) {
        const event = session.eventAt(seq)
        if (event?.type === 'tool/result') results.push({ seq, event })
        else if (event?.type === 'tool/call' && event.data?.callId) {
          toolNames.set(String(event.data.callId), String(event.data.name ?? 'tool'))
        }
      }
      const older = results.slice(0, Math.max(0, results.length - config.keep))
      const sessionId = String(session.id ?? 'session')
      for (const { seq, event } of older) {
        // Already offloaded? Ask the store, and also honour the durable link a
        // previous replacement left behind (its sourceEventSeqs cites this seq).
        if (store.has(sessionId, seq)) continue
        if ((event.sourceEventSeqs ?? []).some((src) => store.has(sessionId, src))) continue

        const original = session.deriveEventMessage(event)
        const text = textOf(original.content)
        if (text.length <= 0 || text.includes(MARK)) continue
        const chars = lengthInPoints(text)
        if (chars <= config.thresholdChars) continue

        const objectId = createObjectId(sessionId, seq, chars)
        const source = event.data?.message?.source ?? {}
        const toolName = String(
          source.toolName ?? names.get(String(source.callId)) ?? toolNames.get(String(source.callId)) ?? 'tool',
        )
        const label = toolName + (source.callId ? ` ${String(source.callId).slice(0, 8)}` : '')
        const { content, inlineChars } = pointerContent(original, text, config, objectId, label)
        // A pointer that is not smaller than the original is pure loss: leave it alone.
        if (inlineChars >= chars) continue
        const message = freezeMessage({ ...original, content })
        const tokensInline = Math.max(0, Math.round(estimate(ctx, original) - estimate(ctx, message)))

        store.put({
          id: objectId,
          session: sessionId,
          seq,
          tool: toolName,
          text,
          chars,
          inlineChars,
          tokensSaved: tokensInline,
        })

        session.append('compaction/prune', {
          shadowedRange: { start: seq, end: seq },
          shadowedSeqs: [seq],
          shadowedTokenCount: estimate(ctx, original),
        })
        session.append(
          'tool/result',
          { ...event.data, message },
          { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] },
        )
      }
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
        'Read back a tool result that was moved out of the conversation to save context. Big results keep their head and tail inline and are stored under an object id shown in a [recall] note. Call recall("<id>") for the whole text, or recall("<id>", start, count) for a character range.',
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
        if (store === null) return 'recall: the object store is unavailable; see the harness log.'
        const text = store.text(id)
        if (text === null) return `recall: object #${id} not found (it may predate this store or have been removed).`
        const chars = points(text)
        const start = Math.min(chars.length, Math.max(0, Math.floor(Number(args?.start) || 0)))
        const count = Math.min(24000, Math.max(1, Math.floor(Number(args?.count) || 8000)))
        const slice = chars.slice(start, start + count).join('')
        store.bumpRecall()
        const end = Math.min(chars.length, start + count)
        return `${MARK} object #${id}, chars ${start}–${end} of ${chars.length}:\n\n${slice}`
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
          res.setHeader('cache-control', 'no-store')
          res.end(JSON.stringify(body))
        }
        if (url.pathname !== '/recall/api/stats') return send(404, { error: 'not found' })
        if (store === null) return send(503, { error: 'object store unavailable' })
        try {
          const stats = store.stats(12)
          return send(200, {
            ...stats,
            threshold: config.thresholdChars,
            head: config.headChars,
            tail: config.tailChars,
            keep: config.keep,
          })
        } catch (e) {
          return send(500, { error: e && (e.message || String(e)) })
        }
      }
      return scope.webServer.register({ kind: 'prefix', path: '/recall', handler })
    })
  })
}

/** Token price of one message, through the injected meter (0 when unavailable). */
function estimate(ctx, message) {
  try {
    return Number(ctx.tokenMeter.estimateMessage(message)) || 0
  } catch {
    return 0
  }
}

/**
 * Object id: `md5(session:seq:chars)` cut to 8 hex. Deterministic, so a repeated
 * pass over the same result addresses the same object instead of duplicating it.
 */
function createObjectId(sessionId, seq, chars) {
  return createHash('md5').update(`${sessionId}:${seq}:${chars}`).digest('hex').slice(0, 8)
}
