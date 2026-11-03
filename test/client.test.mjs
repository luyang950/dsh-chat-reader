// The browser bundle's loader contract: one ModuleLoader registration, only `react`
// required, the declared services are the only ones touched, the `/read` lifecycle
// folds into one reader node, and the keyboard never reaches beyond its scope.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

const REACT_STUB = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  memo: (component) => component,
  Fragment: 'fragment',
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useReducer: (reducer, initial) => [initial, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: (initial) => ({ current: initial }),
  useSyncExternalStore: (subscribe, get) => get(),
}

function makeWindow() {
  const listeners = []
  return {
    listeners,
    addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture }),
    removeEventListener: (type, fn) => {
      const at = listeners.findIndex((entry) => entry.type === type && entry.fn === fn)
      if (at >= 0) listeners.splice(at, 1)
    },
  }
}

function loadBundle({ react = REACT_STUB, fetch } = {}) {
  const registrations = []
  const window = makeWindow()
  window.__ModuleLoader__ = { load: (registration) => registrations.push(registration) }
  const required = []
  const sandbox = {
    window,
    document: { createElement: () => ({ dataset: {}, remove() {} }), head: { append() {} } },
    fetch: fetch || (() => Promise.reject(new Error('network disabled in tests'))),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
  }
  sandbox.globalThis = sandbox
  runInNewContext(SOURCE, sandbox, { filename: 'lib/client.js' })
  assert.equal(registrations.length, 1)
  const plugin = registrations[0].factory((id) => {
    required.push(id)
    return react
  })
  return { registration: registrations[0], plugin, required, window, sandbox }
}

function mount(options) {
  const loaded = loadBundle(options)
  const effects = []
  const definitions = []
  const slots = []
  const ctx = {
    effect: (run, label) => effects.push({ run, label }),
    uiConversation: { events: { register: (definition) => (definitions.push(definition), () => {}) } },
    slots: {
      inject: (key, run) => run(),
      register: (options, component) => (slots.push({ options, component }), () => {}),
    },
  }
  loaded.plugin.apply(ctx)
  const disposers = effects.map((effect) => effect.run())
  return Object.assign(loaded, { effects, definitions, slots, disposers })
}

/** Replay a command lifecycle the way the conversation assembler does. */
function fold(definition, run, done) {
  const startMatch = definition.match({ type: 'command/run', seq: 11, time: run.time, data: run })
  if (startMatch === null) return { startMatch, node: null }
  const startEvent = { type: 'command/run', seq: 11, time: run.time, data: run }
  const start = { event: startEvent, role: 'start', location: { turn: 2, step: 0 } }
  let context = { key: `${definition.kind}:${startMatch.id}`, id: startMatch.id, start, state: undefined }
  context.state = definition.start(context, start)
  if (done) {
    const updateMatch = definition.match({ type: 'command/done', seq: 12, data: done })
    if (updateMatch && updateMatch.id === startMatch.id) {
      context = Object.assign({}, context, { state: definition.update(context, { event: { type: 'command/done', seq: 12, data: done } }) })
    }
  }
  return { startMatch, node: definition.buildViewNode(context) }
}

/** Strip vm-realm prototypes so deepEqual compares structure only. */
const plain = (value) => JSON.parse(JSON.stringify(value))

const SUMMARY = { book: '武侠/小说.txt', title: '小说', format: 'txt', paragraphCount: 6 }

test('one ModuleLoader registration under the package id; only react is required', () => {
  const { registration, plugin, required } = loadBundle()
  assert.equal(registration.id, 'dsh-chat-reader')
  assert.equal(typeof registration.factory, 'function')
  assert.deepEqual([...new Set(required)], ['react'])
  assert.equal(plugin.name, 'dsh-chat-reader')
  assert.equal(typeof plugin.apply, 'function')
})

test('every ctx.<service> the bundle touches is declared in inject', () => {
  const { plugin } = loadBundle()
  assert.deepEqual([...plugin.inject].sort(), ['slots', 'uiConversation'])
  const builtins = new Set(['effect', 'inject', 'get', 'on', 'off', 'logger'])
  for (const [, service] of SOURCE.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)) {
    if (builtins.has(service)) continue
    assert.ok(plugin.inject.includes(service), `ctx.${service} used but not injected`)
  }
})

test('apply registers the four seams: event definition, chat node, hidden command row, settings section', () => {
  const { definitions, slots } = mount()
  assert.equal(definitions.length, 1)
  assert.equal(definitions[0].kind, 'dsh-chat-reader')
  assert.equal(definitions[0].target, 'chat')
  for (const method of ['match', 'start', 'update', 'buildViewNode']) assert.equal(typeof definitions[0][method], 'function')

  const byName = Object.fromEntries(slots.map((slot) => [slot.options.name, slot]))
  assert.deepEqual(plain(byName['conversation.chat.node'].options), { name: 'conversation.chat.node', key: 'dsh-chat-reader' })
  assert.deepEqual(plain(byName['conversation.chat.commandview'].options), { name: 'conversation.chat.commandview', key: 'read' })
  assert.equal(byName['conversation.chat.commandview'].component(), null)
  assert.deepEqual(plain(byName['settings.section'].options), { name: 'settings.section', id: 'dsh-chat-reader', order: 22, label: '阅读' })
})

test('command/run(read) + command/done(success) fold into one reader node', () => {
  const [definition] = mount().definitions
  const { startMatch, node } = fold(
    definition,
    { commandId: 42, name: 'read', args: ' 小说', time: 1700000000000 },
    { commandId: 42, kind: 'success', text: JSON.stringify(SUMMARY) },
  )
  assert.equal(startMatch.id, '42')
  assert.equal(startMatch.role, 'start')
  assert.notEqual(startMatch.exclusive, true, 'the built-in command node must keep name=read to hit the empty commandview')
  assert.equal(node.kind, 'dsh-chat-reader')
  assert.equal(node.target, 'chat')
  assert.equal(node.key, 'dsh-chat-reader:42')
  assert.equal(node.id, '42')
  assert.equal(node.anchorSeq, 11)
  assert.deepEqual(plain(node.location), { turn: 2, step: 0 })
  assert.equal(node.visibility, 'visible')
  assert.equal(node.data.status, 'ready')
  assert.deepEqual(plain(node.data.summary), SUMMARY)
  assert.equal(node.data.time, 1700000000000)
})

test('a pending /read (no command/done yet) renders a pending node', () => {
  const [definition] = mount().definitions
  const { node } = fold(definition, { commandId: 1, name: 'read' }, null)
  assert.equal(node.data.status, 'pending')
})

test('failed /read and malformed results become an error node', () => {
  const [definition] = mount().definitions
  const failed = fold(definition, { commandId: 2, name: 'read' }, { commandId: 2, kind: 'error', text: '书库里没有这本书' })
  assert.equal(failed.node.data.status, 'error')
  assert.equal(failed.node.data.error, '书库里没有这本书')
  const garbled = fold(definition, { commandId: 3, name: 'read' }, { commandId: 3, kind: 'success', text: 'not json' })
  assert.equal(garbled.node.data.status, 'error')
})

test('other commands are never claimed; command/done without a start builds nothing', () => {
  const [definition] = mount().definitions
  assert.equal(definition.match({ type: 'command/run', data: { commandId: 5, name: 'compact' } }), null)
  assert.equal(definition.match({ type: 'assistant/live-chunk', data: {} }), null)
  assert.equal(definition.match({ type: 'user/message', data: { text: '/read x' } }), null)
  assert.equal(definition.buildViewNode({ key: 'k', id: '5', start: undefined, state: undefined }), null)
})

test('the node carries only metadata — never book text — so nothing new enters the model', () => {
  const [definition] = mount().definitions
  const { node } = fold(definition, { commandId: 9, name: 'read' }, { commandId: 9, kind: 'success', text: JSON.stringify(SUMMARY) })
  assert.deepEqual(Object.keys(node.data).sort(), ['error', 'status', 'summary', 'time'])
  assert.deepEqual(Object.keys(node.data.summary).sort(), ['book', 'format', 'paragraphCount', 'title'])
})

/* ── reading model ───────────────────────────────────────────────────────── */

test('reducer: windows merge only when adjacent; a jump starts a fresh run', () => {
  const { reducer, INITIAL } = loadBundle().plugin
  const base = reducer(INITIAL, { type: 'loaded', from: 10, items: ['a', 'b'], total: 100 })
  assert.equal(reducer(base, { type: 'append', from: 13, items: ['x'], total: 100 }), base)
  assert.deepEqual(plain(reducer(base, { type: 'append', from: 12, items: ['c'], total: 100 }).items), ['a', 'b', 'c'])
  assert.equal(reducer(base, { type: 'prepend', from: 5, items: ['x'] }), base)
  const prepended = reducer(base, { type: 'prepend', from: 8, items: ['y', 'z'] })
  assert.equal(prepended.from, 8)
  assert.deepEqual(plain(prepended.items), ['y', 'z', 'a', 'b'])
  const jumped = reducer(prepended, { type: 'loaded', from: 60, items: ['q'], total: 100 })
  assert.deepEqual([jumped.from, jumped.items.length], [60, 1])
})

test('reducer: trimming either side keeps the run contiguous', () => {
  const { reducer, INITIAL } = loadBundle().plugin
  const base = reducer(INITIAL, { type: 'loaded', from: 0, items: ['a', 'b', 'c', 'd'], total: 4 })
  const front = reducer(base, { type: 'trimFront', count: 3 })
  assert.deepEqual([front.from, plain(front.items)], [3, ['d']])
  const back = reducer(base, { type: 'trimBack', count: 1 })
  assert.deepEqual([back.from, plain(back.items)], [0, ['a', 'b', 'c']])
  assert.equal(reducer(base, { type: 'trimFront', count: 0 }), base)
})

test('topParagraph finds the paragraph at the top of the viewport', () => {
  const { topParagraph } = loadBundle().plugin
  const offsets = [12, 60, 140, 300]
  assert.equal(topParagraph(offsets, 0), 0)
  assert.equal(topParagraph(offsets, 60), 1)
  assert.equal(topParagraph(offsets, 299), 2)
  assert.equal(topParagraph(offsets, 9999), 3)
})

test('chapterAt and fractionOf', () => {
  const { chapterAt, fractionOf } = loadBundle().plugin
  const chapters = [{ index: 0 }, { index: 10 }, { index: 20 }]
  assert.equal(chapterAt(chapters, 0), 0)
  assert.equal(chapterAt(chapters, 15), 1)
  assert.equal(chapterAt(chapters, 99), 2)
  assert.equal(chapterAt([{ index: 5 }], 2), -1)
  assert.equal(fractionOf(0, 101), 0)
  assert.equal(fractionOf(50, 101), 0.5)
  assert.equal(fractionOf(100, 101), 1)
})

test('no typewriter is left: no timers driving the text, no speed setting', () => {
  assert.doesNotMatch(SOURCE, /setInterval\(/)
  assert.doesNotMatch(SOURCE, /speed/)
})

/* ── keyboard scope ──────────────────────────────────────────────────────── */

function keyEvent(init) {
  const event = Object.assign(
    { key: '', code: '', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, repeat: false, isComposing: false, keyCode: 0 },
    init,
  )
  event.defaultPrevented = false
  event.stopped = false
  event.preventDefault = () => (event.defaultPrevented = true)
  event.stopPropagation = () => (event.stopped = true)
  return event
}

test('the only window listener is the boss-key chord; space and arrows pass straight through', () => {
  const { window, plugin, disposers } = mount()
  const keydowns = window.listeners.filter((entry) => entry.type === 'keydown')
  assert.equal(keydowns.length, 1)
  plugin.shared.cards = 1
  plugin.shared.boss = false
  for (const init of [
    { key: ' ', code: 'Space' },
    { key: 'ArrowUp', code: 'ArrowUp' },
    { key: 'b', code: 'KeyB' },
    { key: 'f', code: 'KeyF', ctrlKey: true },
  ]) {
    const event = keyEvent(init)
    keydowns[0].fn(event)
    assert.equal(event.defaultPrevented, false, init.code)
    assert.equal(plugin.shared.boss, false)
  }
  for (const dispose of disposers) if (typeof dispose === 'function') dispose()
  assert.equal(window.listeners.filter((entry) => entry.type === 'keydown').length, 0, 'listener removed on dispose')
})

test('boss key toggles only with the configured chord, only while a reader exists, never mid-IME', () => {
  const { plugin } = loadBundle()
  const chord = { key: 'b', code: 'KeyB', ctrlKey: true, altKey: true }
  plugin.shared.config = Object.assign({}, plugin.shared.config, { bossKey: 'Ctrl+Alt+KeyB' })
  plugin.shared.boss = false

  plugin.shared.cards = 0
  plugin.onBossKey(keyEvent(chord))
  assert.equal(plugin.shared.boss, false, 'no reader mounted → key left alone')

  plugin.shared.cards = 1
  plugin.onBossKey(keyEvent(Object.assign({ isComposing: true }, chord)))
  assert.equal(plugin.shared.boss, false, 'IME composition is ignored')

  const event = keyEvent(chord)
  plugin.onBossKey(event)
  assert.equal(plugin.shared.boss, true)
  assert.equal(event.defaultPrevented, true)
  plugin.onBossKey(keyEvent(chord))
  assert.equal(plugin.shared.boss, false)
})

test('chordOf / chordLabel use the physical key code', () => {
  const { chordOf, chordLabel } = loadBundle().plugin
  assert.equal(chordOf({ ctrlKey: true, altKey: true, code: 'KeyB' }), 'Ctrl+Alt+KeyB')
  assert.equal(chordOf({ metaKey: true, shiftKey: true, code: 'Period' }), 'Shift+Meta+Period')
  assert.equal(chordLabel('Ctrl+Alt+KeyB'), 'Ctrl + Alt + B')
})

/* ── optional: render with the real React, if a DSH profile has it ────────── */

function findReact() {
  for (const base of [process.env.DSH_REACT_DIR, join(homedir(), '.dsh', 'profiles', 'node_modules')].filter(Boolean)) {
    try {
      const require = createRequire(join(base, 'noop.js'))
      return { React: require('react'), server: require('react-dom/server') }
    } catch {
      // not here
    }
  }
  return null
}

const real = findReact()

test('real React: boss mode renders only ··· and no book content', { skip: real ? false : 'react not found' }, () => {
  const { plugin, slots } = mount({ react: real.React })
  const ReaderCard = slots.find((slot) => slot.options.name === 'conversation.chat.node').component
  const node = { key: 'dsh-chat-reader:7', data: { status: 'ready', summary: SUMMARY, error: '', time: Date.now() } }

  plugin.shared.boss = true
  const hidden = real.server.renderToStaticMarkup(real.React.createElement(ReaderCard, { node }))
  assert.match(hidden, /···/)
  assert.doesNotMatch(hidden, /小说/)
  assert.doesNotMatch(hidden, /dcrStream/)

  plugin.shared.boss = false
  const pending = real.server.renderToStaticMarkup(real.React.createElement(ReaderCard, { node }))
  assert.match(pending, /data-state="pending"/)

  const error = real.server.renderToStaticMarkup(
    real.React.createElement(ReaderCard, { node: { key: 'x', data: { status: 'error', error: '书库里没有这本书' } } }),
  )
  assert.match(error, /书库里没有这本书/)
})

test('real React: the settings section renders', { skip: real ? false : 'react not found' }, () => {
  const { slots } = mount({ react: real.React })
  const Settings = slots.find((slot) => slot.options.name === 'settings.section').component
  const html = real.server.renderToStaticMarkup(real.React.createElement(Settings))
  for (const label of ['书库根目录', '字号', '行距', '老板键']) assert.match(html, new RegExp(label))
})
