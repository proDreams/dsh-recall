// Client-half probe: run dsh-recall/client.js in Node with a `slots` facade that
// mirrors the REAL one in 0.2.0-rc.2:
//   dsh-client-ui-renderer/lib/client.js
//     SlotRegistry.prototype.register = (o, c) =>
//       this.ctx.effect(() => this._register(o, c), "slots.register()")
//     Slots.inject = (key, callback) => ctx.effect(callback, ...)
//   cordis ctx.effect() returns a thenable FUNCTION (has .then, no .catch).
//
// It also renders the registered component once, with refs and effects ordered
// the way React orders them (refs at commit, effects after), so the anchor
// contract is actually exercised.
import assert from 'node:assert/strict'

const chip = { getBoundingClientRect: () => ({ top: 700, right: 1400, height: 26 }) }

let captured
const win = { innerWidth: 1440 }
const frames = []
win.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length }
win.cancelAnimationFrame = () => {}
win.setTimeout = () => 0
win.clearTimeout = () => {}
win.setInterval = () => 0
win.clearInterval = () => {}
win.addEventListener = () => {}
win.removeEventListener = () => {}
win.__ModuleLoader__ = { load: ({ factory }) => { captured = factory(requireStub) } }
globalThis.window = win

let queries = 0
globalThis.document = {
  getElementById: () => undefined,
  createElement: () => ({ set textContent(v) {}, id: '', style: {} }),
  head: { appendChild() {} },
  body: {},
  // 15px narrower than window.innerWidth: a visible vertical scrollbar.
  documentElement: { clientWidth: 1425 },
  querySelector: (selector) => {
    queries += 1
    return selector.includes('data-dsh-tide-anchor') || selector.includes('.tw-chip') ? chip : null
  },
}
Object.defineProperty(globalThis, 'navigator', { value: { language: 'ru-RU' }, configurable: true })
// The client also uses BARE setInterval (the 12 s stats poll), and a live Node
// timer keeps the process alive forever — stub the globals, not just window.
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}
globalThis.setTimeout = () => 0
globalThis.clearTimeout = () => {}
globalThis.fetch = () => new Promise(() => {}) // never resolves: the pill stays collapsed

const effects = []
const refs = []
function requireStub(name) {
  if (name !== 'react') throw new Error('unexpected require ' + name)
  return {
    createElement: (type, props, ...kids) => ({ type, props, kids }),
    useState: (init) => [init, () => {}],
    useEffect: (fn) => { effects.push(fn) },
    useCallback: (fn) => fn,
    useRef: (v) => { const ref = { current: v }; refs.push(ref); return ref },
  }
}

// A faithful stand-in for cordis ctx.effect(): a thenable function, no .catch.
function effectLike(fn) {
  const wrapper = () => {}
  wrapper.then = async () => {}
  return fn === undefined ? wrapper : (fn(), wrapper)
}

const registered = []
const slots = {
  inject: (key, callback) => effectLike(callback),
  register: (options, component) => {
    registered.push({ options, component })
    return effectLike()
  },
}

await import('../client.js')
assert.ok(captured, 'the module factory ran')

const ctx = {
  inject: (deps, callback) => callback({ slots, get: () => slots }),
  effect: (fn) => effectLike(fn),
  get: () => slots,
}

let threw
try { captured.apply(ctx) } catch (e) { threw = e }
assert.equal(threw, undefined, `apply() must not throw, got ${threw && threw.message}`)
assert.equal(registered.length, 1, 'the pill registers exactly one shell.overlay entry')
assert.equal(registered[0].options.name, 'shell.overlay')
assert.equal(registered[0].options.id, 'dsh-recall-pill')

// Render once: refs are assigned at commit, effects run after — as React does.
const tree = registered[0].component()
for (const ref of refs) if (ref.current === null) ref.current = { style: {}, offsetHeight: 26 }
for (const effect of effects) effect()
// Tick one frame: a browser runs the queued rAF callback right after commit.
while (frames.length > 0) frames.shift()()

const root = refs.find((ref) => ref.current && ref.current.style && Object.keys(ref.current.style).length > 0)?.current
assert.ok(root, 'the pill root received its ref and was positioned')
assert.equal(root.style.right, '25px', 'right edge aligned to the chip, scrollbar excluded')
assert.equal(root.style.top, '668px', 'stacked 6px above the tide chip')
assert.equal(root.style.bottom, 'auto')
assert.ok(queries > 0, 'the anchor was actually looked up')

console.log('CLIENT OK — pill mounted, anchor contract honoured (data-dsh-tide-anchor → .tw-chip)')
