// Client-half probe: run dsh-recall/client.js in Node with a `slots` facade that
// mirrors the REAL one in 0.2.0-rc.2:
//   dsh-client-ui-renderer/lib/client.js
//     SlotRegistry.prototype.register = (o, c) =>
//       this.ctx.effect(() => this._register(o, c), "slots.register()")
//     Slots.inject = (key, callback) => ctx.effect(callback, ...)
//   cordis ctx.effect() returns a thenable FUNCTION (has .then, no .catch).
import assert from 'node:assert/strict'

let mod
globalThis.window = {
  __ModuleLoader__: { load: ({ id, factory }) => { mod = factory(requireStub) } },
  innerWidth: 1440,
  addEventListener() {},
  setTimeout: () => 0,
  clearTimeout() {},
}
const elements = []
globalThis.document = {
  getElementById: () => undefined,
  createElement: () => ({ set textContent(v) {}, id: '', style: {} }),
  head: { appendChild() {} },
  querySelector: () => null,
}
Object.defineProperty(globalThis, 'navigator', { value: { language: 'ru-RU' }, configurable: true })
globalThis.fetch = () => new Promise(() => {})   // never resolves; Pill stays null

function requireStub(name) {
  if (name !== 'react') throw new Error('unexpected require ' + name)
  const React = {
    createElement: (type, props, ...kids) => ({ type, props, kids }),
    useState: (init) => [init, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (v) => ({ current: v }),
  }
  return React
}

// A faithful stand-in for cordis ctx.effect(): a thenable function, no .catch.
function effectLike(fn) {
  const wrapper = () => {}
  wrapper.then = async () => {}
  try { fn() } catch (e) { wrapper.setupError = e; throw e }
  return wrapper
}

const registered = []
const slots = {
  inject(key, callback) { return effectLike(callback) },
  register(options, component) {
    registered.push(options)
    return effectLike(() => () => {})
  },
}
globalThis.__slots = slots

await import('../client.js')

const ctx = {
  inject(deps, callback) { return callback({ slots, get: () => slots }) },
  effect: (fn, label) => effectLike(fn),
  get: () => slots,
}

let threw
try { mod.apply(ctx) } catch (e) { threw = e }

console.log('registered entries:', registered.length)
if (threw) {
  console.log('apply() THREW:', threw.constructor.name + ':', threw.message)
} else {
  console.log('apply() returned cleanly')
  assert.equal(registered.length, 1, 'pill should register in shell.overlay')
  assert.equal(registered[0].name, 'shell.overlay')
  console.log('CLIENT OK — pill mounted')
}
