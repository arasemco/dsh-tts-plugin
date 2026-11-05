/**
 * Browser-half tests: load the hand-authored module bundle the way the shell
 * does, mount the plugin against a fake Cordis context, render both surfaces in
 * jsdom, and drive the speech engine with a fake transport.
 * Run with `node --test test/`.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import React from 'react'
import { createPortal } from 'react-dom'
import ReactDOMClient from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { act } from 'react-dom/test-utils'
import { JSDOM } from 'jsdom'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const LONG = Array.from({ length: 24 }, (_, index) => `Sentence number ${index} is here, and it carries enough words to matter.`).join(' ')

/** Voice roster the fake Host reports for the first model. */
const VOICES = [
  { id: 'bella', label: 'Bella' },
  { id: 'heart', label: 'Heart' },
  { id: 'michael', label: 'Michael' },
  { id: 'emma', label: 'Emma' },
  { id: 'xiaobei', label: 'Xiaobei' },
]
/** Model roster the fake Host discovers from the configured provider. */
const MODELS = [
  { id: 'kokoro', label: 'kokoro', voices: VOICES },
  { id: 'qwen-cv', label: 'qwen-cv', voices: [{ id: 'vivian', label: 'Vivian' }, { id: 'serena', label: 'Serena' }] },
]
/** Rate roster the fake Host reports. */
const SPEEDS = [0.75, 1, 1.25, 1.5, 2]

/* ------------------------------------------------------------------ harness */

/**
 * Load the browser bundle the way the shell does and return its exports.
 * @param dom - jsdom window bound as the bundle's `window`.
 * @param env - transport overrides: fetch, Audio, URL.
 * @returns The plugin module exports.
 */
function loadBundle (dom, env) {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const icon = (name) => (props) => React.createElement('svg', { ...props, 'data-icon': name })
  const modules = {
    react: React,
    'react-dom': { createPortal },
    '@deepseek-ai/dsh-client-ui-primitives': {
      IconPlayOutlineRegular: icon('play'),
      IconCloseOutlineRegular: icon('close'),
      IconStopFillRegular: icon('stop'),
      IconChevronDownOutlineRegular: icon('chevron'),
      IconChevronLeftOutlineRegular: icon('chevron-left'),
      IconChevronRightOutlineRegular: icon('chevron-right'),
      IconPauseOutlineRegular: icon('pause'),
      Switch: ({ checked, label, onChange }) => React.createElement('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked,
        'aria-label': label,
        onClick: () => onChange(!checked),
      }),
    },
  }
  const requireShim = (id) => {
    if (id in modules) return modules[id]
    throw new Error(`unexpected require: ${id}`)
  }
  const evaluate = new Function('window', 'document', 'Audio', 'fetch', 'URL', source)
  dom.window.__ModuleLoader__ = { load: (value) => { dom.window.__ModuleLoader__.definition = value } }
  evaluate(dom.window, dom.window.document, env.Audio, env.fetch, env.URL)
  const definition = dom.window.__ModuleLoader__.definition
  assert.ok(definition !== undefined, 'bundle must register a module definition')
  assert.equal(definition.id, 'dsh-plugin-tts')
  return definition.factory(requireShim)
}

/** Create a fresh jsdom document. */
function makeDom () {
  return new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1:3080/' })
}

/**
 * Fake transport: /tts/info reports configuration, /tts/speak returns audio,
 * Audio fires `ended` on the next tick.
 * @param options - `blocked` rejects play() like an autoplay policy would.
 * @returns Transport plus recording buffers.
 */
function makeEnvironment (options = {}) {
  const spoken = []
  const played = []
  const infos = []
  const pauses = []
  const requests = []
  const elements = []
  const environment = {
    spoken,
    played,
    infos,
    pauses,
    requests,
    elements,
    fetch: async (url, init) => {
      if (String(url).includes('/tts/log')) {
        return { ok: true, status: 204, body: null }
      }
      if (String(url).includes('/tts/cast')) {
        return { ok: true, status: 200, json: async () => ({ enabled: true }) }
      }
      if (String(url).includes('/tts/speak') && options.failSpeak === true) {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: { code: 'speech', message: '"chat-model" does not support audio input' } }),
        }
      }
      if (String(url).includes('/tts/info')) {
        infos.push(url)
        return {
          ok: true,
          status: 200,
          json: async () => ({
            servers: [{ id: 'audio-cpp', name: 'audio-cpp', baseURL: 'http://127.0.0.1:8080/v1', models: MODELS }],
            defaults: { server: 'audio-cpp', model: 'kokoro', voice: 'bella', speed: 1 },
            speeds: SPEEDS,
            maxChars: 4000,
          }),
        }
      }
      const payload = JSON.parse(init?.body ?? '{}')
      spoken.push(payload.text)
      requests.push(payload)
      if (typeof options.failNetworkTimes === 'number' && options.failNetworkTimes > 0) {
        options.failNetworkTimes -= 1
        options.networkSeen = (options.networkSeen ?? 0) + 1
        throw new TypeError('NetworkError when attempting to fetch resource.')
      }
      if (options.phonemeLimit !== undefined && payload.text.length > options.phonemeLimit) {
        return {
          ok: false,
          status: 502,
          json: async () => ({ error: { message: 'Kokoro phoneme string exceeds 510 symbols; segmenting is not implemented in the framework path yet' } }),
        }
      }
      if (Array.isArray(options.failModels) && options.failModels.includes(payload.model)) {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: { message: `"${payload.model}" does not support audio input` } }),
        }
      }
      return {
        ok: true,
        status: 200,
        blob: async () => ({ size: (payload.text?.length ?? 1) * 10, type: 'audio/wav' }),
      }
    },
    URL: { createObjectURL: () => `blob:${Math.random()}`, revokeObjectURL: () => {} },
    Audio: class FakeAudio {
      constructor (url) {
        this.url = url
        this.onended = null
        this.onerror = null
        this.onloadedmetadata = null
        this.ontimeupdate = null
        this.duration = options.chunkSeconds ?? 4
        this.currentTime = 0
        this.playbackRate = 1
        this.preservesPitch = false
        elements.push(this)
      }

      pause () {
        environment.pauses.push(this.url)
      }

      play () {
        if (options.blocked === true) {
          const error = new Error('blocked')
          error.name = 'NotAllowedError'
          return Promise.reject(error)
        }
        played.push(this.url)
        if (this.onloadedmetadata !== null) this.onloadedmetadata()
        const step = options.chunkSeconds ?? 4
        setTimeout(() => {
          this.currentTime = Math.min(step, this.currentTime + step / 2)
          if (this.ontimeupdate !== null) this.ontimeupdate()
        }, Math.max(1, (options.duration ?? 1) / 2))
        setTimeout(() => { if (this.onended !== null) this.onended() }, options.duration ?? 1)
        return Promise.resolve()
      }

      removeAttribute () {}
      load () {}
    },
  }
  return environment
}

/** Build an engine from the bundle internals over a fake transport. */
function makeEngine (environment, discovered) {
  const dom = makeDom()
  const mod = loadBundle(dom, environment)
  const info = mod.__internals.createStore({
    status: 'ready',
    value: discovered ?? {
      servers: [{ id: 'audio-cpp', name: 'audio-cpp', baseURL: 'http://127.0.0.1:8080/v1', models: MODELS }],
      defaults: { server: 'audio-cpp', model: 'kokoro', voice: 'bella', speed: 1 },
      speeds: SPEEDS,
      maxChars: 4000,
    },
    error: null,
  })
  const settings = mod.__internals.createSettingsStore()
  const highlighter = mod.__internals.createHighlighter()
  const engine = mod.__internals.createEngine(settings, info, highlighter, () => {})
  return { engine, dom, mod, highlighter, settings, info }
}


/**
 * Publish one jsdom as the ambient browser for react-dom, which reads the
 * globals rather than a passed document.
 * @param dom - jsdom instance to install.
 * @returns Restore callback.
 */
function useDom (dom) {
  const names = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'CustomEvent']
  const saved = new Map()
  for (const name of names) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    const value = name === 'window' ? dom.window : dom.window[name]
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  }
  return () => {
    for (const [name, descriptor] of saved) {
      if (descriptor === undefined) delete globalThis[name]
      else Object.defineProperty(globalThis, name, descriptor)
    }
  }
}

/** Fake client context: records slot registrations, exposes one Session. */
function fakeContext (registrations, entries) {
  const subscribers = new Set()
  const binding = {
    eventSource: {
      getSnapshot: () => ({ entries, hasMore: false, revision: 1, change: null }),
      subscribe: (listener) => {
        subscribers.add(listener)
        return () => subscribers.delete(listener)
      },
    },
  }
  return {
    publish (mutate) {
      mutate()
      for (const listener of [...subscribers]) listener()
    },
    effect (fn) {
      const disposer = fn()
      return () => { if (typeof disposer === 'function') disposer() }
    },
    locale: { register: () => () => {} },
    sessions: { binding: (sessionId) => (sessionId === 's1' ? binding : undefined) },
    slots: {
      inject: (name, callback) => {
        callback()
        return () => {}
      },
      register: (spec, component) => {
        const injected = spec.inject === undefined ? {} : spec.inject('s1')
        const { hooks, ...rest } = injected
        const props = { ...rest }
        for (const [key, observable] of Object.entries(hooks ?? {})) {
          /* The renderer binds every injected observable as a selector hook. */
          props[`use${key.charAt(0).toUpperCase()}${key.slice(1)}`] = (selector) => React.useSyncExternalStore(
            (listener) => observable.subscribe(listener),
            () => selector(observable.getSnapshot()),
            () => selector(observable.getSnapshot()),
          )
        }
        registrations.push({ spec, component, injected: props })
        return () => {}
      },
    },
  }
}

test('both dictionaries carry the same keys', () => {
  const dom = makeDom()
  const { en, zh } = loadBundle(dom, makeEnvironment()).__internals.dictionaries
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  assert.ok(Object.keys(en).length >= 15)
  dom.window.close()
})

/* ------------------------------------------------------------- text helpers */

test('cleans markdown before speaking', () => {
  const { cleanForSpeech } = bundleInternals()
  const prose = cleanForSpeech([
    '# Heading',
    '',
    'Here is **bold**, _italic_, and `inline code`.',
    '',
    '```js',
    'const hidden = true',
    '```',
    '',
    '- first item',
    '- second item with a [link](https://example.com/page).',
    '',
    '> quoted line',
    '',
    '![diagram](diagram.png) and https://example.com/bare',
  ].join('\n'))
  assert.equal(/```/.test(prose), false)
  assert.equal(/const hidden/.test(prose), false)
  assert.equal(/https?:\/\//.test(prose), false)
  assert.match(prose, /Heading/)
  assert.match(prose, /Here is bold, italic, and inline code\./)
  assert.match(prose, /first item second item with a link\./)
  assert.match(prose, /quoted line/)
  assert.match(prose, /diagram/)
  assert.equal(cleanForSpeech('The rate is 12.5 per second.'), 'The rate is 12 point 5 per second.')
  assert.equal(cleanForSpeech('It is 2× faster and 5% lighter at 45°.'), 'It is 2 times faster and 5 percent lighter at 45 degrees.')
  assert.equal(cleanForSpeech('Version 4.10.2 shipped.'), 'Version 4 point 10 point 2 shipped.')
  assert.equal(
    cleanForSpeech('**The button did change it — only for the *next* sentence.** It saved.'),
    'The button did change it — only for the next sentence. It saved.',
  )
})

test('keeps decimals inside one sentence', () => {
  const { splitChunks } = bundleInternals()
  const chunks = splitChunks('The playhead fired 12.5 times per second, about 3.14 radians, and 7.0 exactly.')
  assert.equal(chunks.length, 1, 'decimal points must not end a sentence')
  assert.match(chunks[0], /12\.5 times per second/)
  assert.match(chunks[0], /3\.14 radians/)
  assert.match(chunks[0], /7\.0 exactly/)
})

test('splits prose into sentence groups within the budget', () => {
  const { splitChunks } = bundleInternals()
  assert.deepEqual(splitChunks('   '), [])
  assert.deepEqual(splitChunks('One only.'), ['One only.'])
  const long = `${'Sentence number one is here. '.repeat(20)}Tail.`
  const chunks = splitChunks(long, 120)
  assert.ok(chunks.length > 1)
  for (const chunk of chunks) assert.ok(chunk.length <= 120, `chunk too long: ${chunk.length}`)
  assert.equal(chunks.join(' ').replace(/\s+/g, ' '), long.replace(/\s+/g, ' ').trim())
  const runaway = splitChunks(`word ${'x'.repeat(50)} ${'y'.repeat(50)} end`, 40)
  for (const chunk of runaway) assert.ok(chunk.length <= 52)
})

/* -------------------------------------------------------------- session log */

/** One assistant/message window entry. */
function assistantEvent (seq, turn, id, blocks, interrupted) {
  return {
    type: 'event',
    event: {
      type: 'assistant/message',
      seq,
      time: 1,
      data: {
        turn,
        step: 0,
        message: { id, role: 'assistant', content: blocks },
        stream: [],
        ...(interrupted === true ? { interrupted: true } : {}),
      },
    },
  }
}

/** Session service stub over one fixed window. */
function sessionsOf (entries) {
  return {
    sessions: {
      binding: () => ({
        eventSource: {
          getSnapshot: () => ({ entries, hasMore: false, revision: 1, change: null }),
          subscribe: () => () => {},
        },
      }),
    },
  }
}

test('reads one reply out of the durable window', () => {
  const { readAssistantText, findLastAssistant } = bundleInternals()
  const ctx = {
    ...sessionsOf([
      { type: 'event', event: { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } } },
      assistantEvent(2, 1, 'm-1', [{ type: 'text', text: 'First **answer**.' }]),
      assistantEvent(3, 1, 'm-2', [{ type: 'text', text: 'Second answer.' }]),
      assistantEvent(4, 2, 'm-3', [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: 'Final answer.' }]),
      { type: 'event', event: { type: 'turn/start', seq: 5, time: 1, data: { turn: 2 } } },
      { type: 'event', event: { type: 'turn/end', seq: 6, time: 1, data: { turn: 2, reason: { kind: 'completed' } } } },
    ]),
  }
  assert.equal(readAssistantText(ctx, 's1', 'm-1'), 'First answer.')
  assert.equal(readAssistantText(ctx, 's1', 'm-2'), 'Second answer.')
  assert.equal(readAssistantText(ctx, 's1', 'm-3'), 'Final answer.')
  assert.equal(readAssistantText(ctx, 's1', 'missing'), '')
  assert.deepEqual(findLastAssistant(ctx, 's1'), { id: 'm-3', text: 'Final answer.' })
})

test('finds the answer of one completed turn only', () => {
  const { findTurnAnswer } = bundleInternals()
  const ctx = {
    ...sessionsOf([
      { type: 'event', event: { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } } },
      assistantEvent(2, 1, 'm-1', [{ type: 'text', text: 'Old answer.' }]),
      { type: 'event', event: { type: 'turn/end', seq: 3, time: 1, data: { turn: 1, reason: { kind: 'completed' } } } },
      { type: 'event', event: { type: 'turn/start', seq: 4, time: 1, data: { turn: 2 } } },
      assistantEvent(5, 2, 'm-2', [{ type: 'tool-call', name: 'bash' }]),
      assistantEvent(6, 2, 'm-3', [{ type: 'text', text: 'New answer.' }]),
      { type: 'event', event: { type: 'turn/end', seq: 7, time: 1, data: { turn: 2, reason: { kind: 'completed' } } } },
    ]),
  }
  assert.deepEqual(findTurnAnswer(ctx, 's1', 2), { id: 'm-3', text: 'New answer.' })
  assert.deepEqual(findTurnAnswer(ctx, 's1', 1), { id: 'm-1', text: 'Old answer.' })
  assert.equal(findTurnAnswer(ctx, 's1', 9), null)
})

test('an interrupted reply is not offered for autoplay', () => {
  const { findLastAssistant } = bundleInternals()
  const ctx = {
    ...sessionsOf([
      { type: 'event', event: { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } } },
      assistantEvent(2, 1, 'm-1', [{ type: 'text', text: 'Half a thought' }], true),
      { type: 'event', event: { type: 'turn/end', seq: 3, time: 1, data: { turn: 1, reason: { kind: 'aborted' } } } },
    ]),
  }
  assert.equal(findLastAssistant(ctx, 's1'), null)
})

/* ------------------------------------------------------------------ engine */

test('speaks a short reply in one request and returns to idle', async () => {
  const environment = makeEnvironment()
  const { engine, dom } = makeEngine(environment)
  await engine.speak('m-1', 'First sentence. Second sentence. Third sentence.')
  assert.equal(environment.spoken.length, 1)
  assert.equal(environment.played.length, 1)
  assert.deepEqual(
    { server: environment.requests[0].server, model: environment.requests[0].model, voice: environment.requests[0].voice },
    { server: 'audio-cpp', model: 'kokoro', voice: 'bella' },
    'the request carries the selection resolved from discovery')
  assert.equal('speed' in environment.requests[0], false, 'the rate is applied at playback, not synth')
  assert.equal(engine.state.getSnapshot().status, 'idle')
  assert.equal(engine.state.getSnapshot().messageId, null)
  await engine.speak('m-2', 'Sentence with words. '.repeat(40))
  assert.ok(environment.spoken.length > 2, 'a long reply is pipelined in several requests')
  dom.window.close()
})

test('publishes loading then playing while speaking', async () => {
  const environment = makeEnvironment()
  const { engine, dom } = makeEngine(environment)
  const seen = []
  const unsubscribe = engine.state.subscribe(() => seen.push(engine.state.getSnapshot().status))
  const pending = engine.speak('m-1', 'One. Two.')
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.deepEqual([...new Set(seen.filter((status) => status !== 'idle'))], ['loading', 'playing'])
  await pending
  assert.equal(engine.state.getSnapshot().status, 'idle')
  unsubscribe()
  dom.window.close()
})

test('a rate change applies to the playing audio, not a new request', async () => {
  const environment = makeEnvironment({ duration: 40 })
  const { engine, dom } = makeEngine(environment)
  const pending = engine.speak('m-1', LONG)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const element = environment.elements.at(-1)
  assert.ok(element !== undefined, 'a chunk is playing')
  assert.equal(element.playbackRate, 1, 'it starts at the configured rate')
  engine.setRate(1.5)
  assert.equal(element.playbackRate, 1.5, 'the playing element is retimed in place')
  assert.equal(element.preservesPitch, true, 'pitch is preserved')
  assert.equal('speed' in environment.requests[0], false, 'no request carries a rate')
  engine.setRate(2)
  assert.equal(element.playbackRate, 2)
  engine.stop()
  await pending
  dom.window.close()
})

test('stop abandons playback and clears the state', async () => {
  const environment = makeEnvironment({ duration: 40 })
  const { engine, dom } = makeEngine(environment)
  const pending = engine.speak('m-1', 'Sentence with words. '.repeat(40))
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(engine.state.getSnapshot().status, 'playing')
  engine.stop()
  await pending
  assert.equal(environment.pauses.length, 1, 'stop must pause the playing element')
  assert.equal(engine.state.getSnapshot().status, 'idle')
  assert.equal(engine.state.getSnapshot().messageId, null)
  dom.window.close()
})

test('a model that cannot speak is replaced once, and remembered', async () => {
  const environment = makeEnvironment({ failModels: ['chat-model'] })
  const chatOnly = {
    servers: [{
      id: 'ollama',
      name: 'ollama',
      baseURL: 'http://127.0.0.1:11434/v1',
      models: [
        { id: 'chat-model', label: 'chat-model', voices: [] },
        { id: 'lfm3-audio:latest', label: 'lfm3-audio:latest', voices: [] },
      ],
    }],
    defaults: { server: 'ollama', model: 'chat-model', voice: null, speed: 1 },
    speeds: [1],
    maxChars: 4000,
  }
  const { engine, dom, settings, info } = makeEngine(environment, chatOnly)
  settings.save({ model: 'chat-model' })
  await engine.speak('m-1', 'Try to read this aloud.')
  const attempted = environment.requests.map((row) => row.model)
  assert.deepEqual(attempted, ['chat-model', 'lfm3-audio:latest'], 'the refusal triggers one retry with a speakable model')
  assert.equal(engine.state.getSnapshot().status, 'idle', 'and then it plays')
  assert.equal(settings.getSnapshot().model, 'lfm3-audio:latest', 'the working model is remembered')
  assert.ok(info !== undefined)
  dom.window.close()
})

test('a dropped connection is retried once, then reported as a network failure', async () => {
  const environment = makeEnvironment({ duration: 30, failNetworkTimes: 1 })
  const { engine, dom } = makeEngine(environment)
  await engine.speak('m-1', 'One sentence that survives a dropped connection.')
  assert.equal(engine.state.getSnapshot().status, 'idle', 'the retry recovers')
  assert.ok(environment.played.length >= 1, 'and the audio plays')

  const dead = makeEnvironment({ duration: 30, failNetworkTimes: 99 })
  const second = makeEngine(dead)
  await second.engine.speak('m-1', 'One sentence that keeps failing.')
  const state = second.engine.state.getSnapshot()
  assert.equal(state.status, 'failed')
  assert.equal(state.error.code, 'network', 'transport failures are their own code')
  second.dom.window.close()
  dom.window.close()
})

test('a chunk the engine finds too dense is split and retried', async () => {
  const environment = makeEnvironment({ duration: 30, phonemeLimit: 120 })
  const { engine, dom } = makeEngine(environment)
  const text = `${'This sentence is deliberately long so the phoneme budget is exceeded. '.repeat(4)}End.`
  const pending = engine.speak('m-1', text)
  await new Promise((resolve) => setTimeout(resolve, 40))
  await pending
  assert.equal(engine.state.getSnapshot().status, 'idle', 'the reply still finishes')
  const attempted = environment.requests.map((row) => row.text.length)
  assert.ok(attempted.some((length) => length > 120), 'the dense chunk was tried first')
  assert.ok(attempted.some((length) => length <= 120 && length > 0), 'and a smaller piece went through')
  assert.ok(attempted.length >= 3, 'splitting produced more requests')
  assert.ok(environment.played.length >= 2, 'both halves were played')
  dom.window.close()
})

test('a failed reply stays visible with its message', async () => {
  const environment = makeEnvironment({ failSpeak: true })
  const { engine, dom } = makeEngine(environment)
  await engine.speak('m-1', 'This sentence will fail.')
  const state = engine.state.getSnapshot()
  assert.equal(state.status, 'failed', 'the failure is not swallowed')
  assert.equal(state.error.code, 'server')
  assert.match(state.error.message, /does not support/)
  engine.dismiss()
  assert.equal(engine.state.getSnapshot().status, 'idle')
  assert.equal(engine.state.getSnapshot().error, null)
  dom.window.close()
})

test('reports an empty reply and a blocked autoplay', async () => {
  const { engine, dom } = makeEngine(makeEnvironment())
  await engine.speak('m-1', '')
  assert.deepEqual(engine.state.getSnapshot().error, { code: 'empty', message: null })
  dom.window.close()

  const blocked = makeEnvironment({ blocked: true })
  const second = makeEngine(blocked)
  await second.engine.speak('m-2', 'Audible text here.')
  assert.equal(second.engine.state.getSnapshot().error.code, 'blocked')
  second.dom.window.close()
})

/* ------------------------------------------------------------- highlighting */

test('finds the spoken sentence in rendered prose', () => {
  const dom = makeDom()
  const body = dom.window.document.body
  body.innerHTML = '<div data-chat-turn="1"><p>First sentence here, with <strong>bold</strong> words.</p></div>' + '<div data-chat-turn="1"><p>Second one is   spaced out.</p></div>'
  const { findTextRange } = loadBundle(dom, makeEnvironment()).__internals
  const rows = [...body.children]
  const range = findTextRange(rows, 'with bold words.')
  assert.ok(range !== null)
  assert.equal(range.toString().replace(/\s+/g, ' '), 'with bold words.')
  assert.equal(findTextRange(rows, 'not rendered anywhere'), null)
  /* Whitespace collapse: the doubled spaces must still match. */
  assert.equal(findTextRange(rows, 'Second one is spaced out.')?.toString().replace(/\s+/g, ' '), 'Second one is spaced out.')

  const first = findTextRange(rows, 'sentence', false)
  const last = findTextRange(rows, 'Second', true)
  assert.match(first.toString(), /sentence/)
  assert.equal(last.toString(), 'Second')
  dom.window.close()
})

test('matches a sentence whose markup changed its punctuation and spacing', () => {
  const dom = makeDom()
  const body = dom.window.document.body
  /* The engine speaks cleaned prose; the DOM keeps the code span, the dashes and
     the quoted link that the cleanup removed. */
  body.innerHTML = '<div data-chat-turn="1"><p>Use <code>npm i</code> — then open <a href="#">the docs</a>, and continue.</p></div>'
  const { findTextRange } = loadBundle(dom, makeEnvironment()).__internals
  const rows = [...body.children]
  const range = findTextRange(rows, 'Use npm i then open the docs, and continue.')
  assert.ok(range !== null, 'word-level matching bridges markup differences')
  assert.match(range.toString().replace(/\s+/g, ' '), /Use npm i .* the docs, and continue\./)
  dom.window.close()
})

test('matches across words the engine never says', () => {
  const dom = makeDom()
  const body = dom.window.document.body
  /* Bare URLs and image alt text are dropped from speech but still rendered. */
  body.innerHTML = '<div data-chat-turn="1"><p>Open https://example.com/x now, then read the chart.</p>' +
    '<p><img alt="a chart">Then continue with the summary.</p></div>'
  const { findTextRange } = loadBundle(dom, makeEnvironment()).__internals
  const rows = [...body.children]
  const first = findTextRange(rows, 'Open now, then read the chart.')
  assert.ok(first !== null, 'a dropped URL must not break the run')
  assert.match(first.toString(), /^Open https:\/\/example\.com\/x now, then read the chart\.$/)
  const second = findTextRange(rows, 'Then continue with the summary.')
  assert.ok(second !== null, 'image alt text the engine never says must not break the run')
  assert.equal(second.toString(), 'Then continue with the summary.')
  dom.window.close()
})

test('marks the message itself when the sentence cannot be found', () => {
  const dom = makeDom()
  const body = dom.window.document.body
  body.innerHTML = '<div data-chat-turn="1"><p>Something else entirely.</p></div>'
  const { createHighlighter } = loadBundle(dom, makeEnvironment()).__internals
  const highlighter = createHighlighter()
  highlighter.show('A sentence that is not rendered at all.', [...body.children])
  const marked = dom.window.document.querySelector('[data-dsh-tts-reading]')
  assert.ok(marked !== null, 'the message row is marked instead of nothing')
  assert.equal(marked.getAttribute('data-chat-turn'), '1')
  highlighter.clear()
  assert.equal(dom.window.document.querySelector('[data-dsh-tts-reading]'), null)
  dom.window.close()
})

test('the caption shows the sentence being read', async () => {
  const dom = makeDom()
  const environment = makeEnvironment({ duration: 60 })
  const mod = loadBundle(dom, environment)
  const registrations = []
  const entries = [assistantEvent(2, 1, 'm-1', [{ type: 'text', text: 'A brand new answer. It has two sentences.' }])]
  mod.apply(fakeContext(registrations, entries))
  const caption = registrations.find((row) => row.spec.id === 'tts-caption')
  const container = dom.window.document.getElementById('root')
  const restore = useDom(dom)
  const root = ReactDOMClient.createRoot(container)
  const t = (key) => key
  await act(async () => {
    root.render(React.createElement(caption.component, { ...caption.injected, sessionId: 's1', t }))
  })
  assert.equal(container.querySelector('.dsh-tts-player'), null, 'hidden while idle')

  const action = registrations.find((row) => row.spec.id === 'tts-listen')
  await act(async () => {
    action.injected.read('s1', 'm-1')
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  const strip = container.querySelector('.dsh-tts-player')
  assert.ok(strip !== null, 'the player appears while reading')
  assert.match(strip.textContent, /0:\d\d \/ \d:\d\d/, 'the player shows position and length')
  assert.match(strip.getAttribute('title') ?? '', /A brand new answer|First|answer/i, 'the sentence rides the tooltip')
  assert.equal(strip.querySelectorAll('.dsh-tts-player-text').length, 0, 'no caption line in the bar')
  assert.equal(strip.querySelectorAll('.dsh-tts-pbtn').length, 3, 'previous, play/pause, next')
  assert.ok(strip.querySelector('.dsh-tts-seek') !== null, 'the seek bar is there')
  const rate = strip.querySelector('select.dsh-tts-rate')
  assert.ok(rate !== null, 'the player carries the speaking rate as a dropdown')
  assert.equal(rate.value, '1')
  assert.equal(rate.options.length, 5, 'every configured rate is offered')
  const close = strip.querySelector('.dsh-tts-close')
  assert.ok(close !== null, 'the player can be closed')
  assert.equal(close.getAttribute('aria-label'), 'player.close')
  await act(async () => {
    rate.value = '1.5'
    rate.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  })
  assert.match(dom.window.localStorage.getItem('dsh.tts.settings.v1') ?? '', /"speed":1\.5/, 'the picked rate persists')
  await act(async () => {
    close.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  assert.equal(container.querySelector('.dsh-tts-player'), null, 'closing stops the voice and hides the bar')
  assert.ok(environment.pauses.length >= 1, 'the audio element was paused')
  await act(async () => { root.unmount() })
  restore()
  dom.window.close()
})

test('matches a sentence whose middle diverged from the domestic text', () => {
  const dom = makeDom()
  const body = dom.window.document.body
  /* The engine is told "12 point 5 times per second, and 3 point 14 radians";
     the transcript renders the numerals and the multiplication sign. */
  body.innerHTML = '<div data-chat-turn="1"><p>The playhead fired 12.5×/s, and 3.14 radians per turn.</p></div>'
  const mod = loadBundle(dom, makeEnvironment())
  const { findTextRange, findAnchorRange } = mod.__internals
  const rows = [...body.children]
  const chunk = 'The playhead fired 12 point 5 times per second, and 3 point 14 radians per turn.'
  assert.equal(findTextRange(rows, chunk), null, 'the words themselves no longer line up')
  const anchored = findAnchorRange(rows, chunk)
  assert.ok(anchored !== null, 'anchors still find the sentence')
  assert.match(anchored.toString(), /^The playhead fired 12\.5/)
  dom.window.close()
})

test('paints the current sentence and clears it afterwards', () => {
  const dom = makeDom()
  const painted = new Map()
  const registrations = []
  dom.window.Highlight = class {
    constructor (range) { this.range = range; registrations.push(range.toString()) }
  }
  dom.window.CSS = { highlights: { set: (name, value) => painted.set(name, value), delete: (name) => painted.delete(name) } }
  const body = dom.window.document.body
  body.innerHTML = '<div><p>Alpha sentence. Beta sentence.</p></div>'

  const { createHighlighter } = loadBundle(dom, makeEnvironment()).__internals
  const highlighter = createHighlighter()
  highlighter.show('Beta sentence.', body)
  assert.equal(painted.size, 1, 'the CSS highlight registry holds the range')
  assert.equal(registrations.at(-1), 'Beta sentence.')
  highlighter.clear()
  assert.equal(painted.size, 0, 'clearing removes the registry entry')
  dom.window.close()
})

test('falls back to marking the block when the browser has no highlight API', () => {
  const dom = makeDom()
  const body = dom.window.document.body
  body.innerHTML = '<div><p>Alpha sentence. Beta sentence.</p></div>'
  const { createHighlighter } = loadBundle(dom, makeEnvironment()).__internals
  const highlighter = createHighlighter()
  highlighter.show('Alpha sentence.', body)
  const marked = dom.window.document.querySelector('[data-dsh-tts-reading]')
  assert.ok(marked !== null, 'the containing block is marked')
  assert.ok(marked.textContent.includes('Alpha sentence.'))
  highlighter.clear()
  assert.equal(dom.window.document.querySelector('[data-dsh-tts-reading]'), null)
  dom.window.close()
})

test('cast splits a reply by heading and gives each part its own voice', () => {
  const dom = makeDom()
  const mod = loadBundle(dom, makeEnvironment())
  const { buildCast, castSegments } = mod.__internals
  const voices = [
    { id: 'bella', label: 'Bella' },
    { id: 'michael', label: 'Michael' },
    { id: 'emma', label: 'Emma' },
  ]
  const raw = [
    '## Intro',
    'The first part talks about setup.',
    '',
    '## Second section',
    'The second part talks about usage.',
    '',
    'Alice: and this labelled line introduces a speaker.',
  ].join('\n')
  const segments = castSegments(raw)
  assert.equal(segments.length, 3, 'headings and labels start segments')
  assert.deepEqual(segments.map((segment) => segment.key), ['Intro', 'Second section', 'Alice'])

  const { chunks, cast } = buildCast(raw, voices)
  assert.equal(cast.length, 3, 'three speakers, three voices')
  assert.deepEqual(cast.map((row) => row.voice), ['bella', 'michael', 'emma'])
  assert.deepEqual([...new Set(chunks.map((chunk) => chunk.voice))], ['bella', 'michael', 'emma'])
  assert.ok(chunks.every((chunk) => typeof chunk.text === 'string' && chunk.text.length > 0))
  dom.window.close()
})

test('a speaker keeps one voice across its segments', () => {
  const dom = makeDom()
  const mod = loadBundle(dom, makeEnvironment())
  const voices = [{ id: 'bella', label: 'Bella' }, { id: 'michael', label: 'Michael' }]
  const raw = ['Alice: first line.', 'Bob: second line.', 'Alice: third line.'].join('\n')
  const { cast } = mod.__internals.buildCast(raw, voices)
  assert.deepEqual(cast.map((row) => [row.key, row.voice]), [['Alice', 'bella'], ['Bob', 'michael']],
    'the same speaker reuses its voice')
  dom.window.close()
})

test('cast falls back to a single voice for a one-part reply or one voice', () => {
  const dom = makeDom()
  const mod = loadBundle(dom, makeEnvironment())
  assert.equal(mod.__internals.buildCast('Just one paragraph.', [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]).chunks, null)
  assert.equal(mod.__internals.buildCast('## A\nOne.\n## B\nTwo.', [{ id: 'only', label: 'Only' }]).chunks, null)
  dom.window.close()
})

test('the engine paints each chunk while speaking and clears on stop', async () => {
  const environment = makeEnvironment({ duration: 30 })
  const { engine, dom, highlighter } = makeEngine(environment)
  const calls = []
  const original = highlighter.show
  highlighter.show = (text, scope) => { calls.push(text); original(text, scope) }
  /* The engine captured the highlighter object, so patched methods are seen. */
  const pending = engine.speak('m-1', 'One sentence. Two sentence. Three sentence.')
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(calls.length >= 1, 'each chunk is highlighted before it plays')
  engine.stop()
  await pending
  assert.equal(dom.window.document.querySelector('[data-dsh-tts-reading]'), null)
  dom.window.close()
})

test('a cast plan sends one voice per chunk', async () => {
  const environment = makeEnvironment({ duration: 30 })
  const { engine, dom } = makeEngine(environment)
  const plan = [
    { text: 'Bella reads this one.', voice: 'bella', voiceLabel: 'Bella' },
    { text: 'Michael reads this one.', voice: 'michael', voiceLabel: 'Michael' },
  ]
  const pending = engine.speak('m-1', plan)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const voices = environment.requests.map((row) => row.voice)
  assert.deepEqual(voices.slice(0, 2), ['bella', 'michael'], 'each chunk carries its own voice')
  assert.equal(engine.state.getSnapshot().voice, 'Bella', 'the player knows who is speaking')
  engine.stop()
  await pending
  dom.window.close()
})

test('seeks, skips chapters, pauses and resumes', async () => {
  const environment = makeEnvironment({ duration: 40, chunkSeconds: 4 })
  const { engine, dom } = makeEngine(environment)
  const pending = engine.speak('m-1', LONG)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const started = engine.state.getSnapshot()
  assert.equal(started.status, 'playing')
  assert.ok(started.duration > 0, 'the timeline has a length')

  engine.pause()
  assert.equal(engine.state.getSnapshot().status, 'paused')
  const pausedAt = engine.state.getSnapshot().position
  engine.resume()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(engine.state.getSnapshot().status, 'playing')

  engine.skip(1)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.ok(engine.state.getSnapshot().chunk >= 1, 'next chapter moves the playhead')

  engine.skip(-1)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const before = engine.state.getSnapshot().chunk
  engine.seek(0)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(engine.state.getSnapshot().chunk, 0, 'seeking back to zero restarts the reply')
  assert.ok(engine.state.getSnapshot().position < 1)

  engine.stop()
  await pending
  assert.equal(engine.state.getSnapshot().status, 'idle')
  assert.equal(engine.state.getSnapshot().duration, 0)
  assert.ok(Number.isFinite(pausedAt))
  assert.ok(before >= 0)
  dom.window.close()
})

test('replay restarts the chapter being read', async () => {
  const environment = makeEnvironment({ duration: 40, chunkSeconds: 4 })
  const { engine, dom } = makeEngine(environment)
  const pending = engine.speak('m-1', LONG)
  await new Promise((resolve) => setTimeout(resolve, 20))
  engine.skip(2)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const at = engine.state.getSnapshot().chunk
  engine.replay()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(engine.state.getSnapshot().chunk, at, 'replay stays on the same chapter')
  assert.equal(engine.state.getSnapshot().status, 'playing')
  engine.stop()
  await pending
  dom.window.close()
})

/* --------------------------------------------------------------------- ui */

test('mounts both slot surfaces and renders the listen control', () => {
  const dom = makeDom()
  const mod = loadBundle(dom, makeEnvironment())
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual(mod.inject, ['slots', 'locale', 'sessions'])

  const registrations = []
  mod.apply(fakeContext(registrations, []))
  assert.deepEqual(registrations.map((row) => row.spec.name), [
    'conversation.chat.assistant-actions',
    'conversation.input.right',
    'conversation.input.dock',
  ])
  assert.deepEqual(registrations.map((row) => row.spec.id), ['tts-listen', 'tts-read-aloud', 'tts-caption'])
  assert.ok(dom.window.document.head.querySelector('style[data-plugin-css]') !== null, 'stylesheet is injected')

  const action = registrations[0]
  const markup = renderToStaticMarkup(React.createElement(action.component, {
    ...action.injected,
    messageId: 'm-1',
    sessionId: 's1',
    t: (key) => key,
  }))
  assert.match(markup, /aria-label="action.listen"/)
  assert.match(markup, /data-icon="play"/)

  const control = registrations[1]
  const trigger = renderToStaticMarkup(React.createElement(control.component, {
    ...control.injected,
    sessionId: 's1',
    t: (key) => key,
  }))
  assert.match(trigger, /dsh-tts-trigger/)
  assert.match(trigger, /aria-haspopup="dialog"/)
  dom.window.close()
})

test('opens the settings panel and persists choices', async () => {
  const dom = makeDom()
  const environment = makeEnvironment()
  const mod = loadBundle(dom, environment)
  const registrations = []
  mod.apply(fakeContext(registrations, []))
  const control = registrations.find((row) => row.spec.name === 'conversation.input.right')
  const container = dom.window.document.getElementById('root')
  const restore = useDom(dom)
  const root = ReactDOMClient.createRoot(container)
  const t = (key, params) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`)
  const props = { ...control.injected, sessionId: 's1', t }

  await act(async () => {
    root.render(React.createElement(control.component, props))
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  const trigger = container.querySelector('.dsh-tts-trigger')
  assert.ok(trigger !== null, 'trigger must render')
  await act(async () => {
    trigger.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 10))
  })

  const panel = dom.window.document.querySelector('.dsh-tts-panel')
  assert.ok(panel !== null, 'panel must portal into the body')
  assert.match(panel.textContent, /panel\.title/)
  assert.equal(panel.querySelectorAll('.dsh-tts-chip').length, 7, 'two models and five voices — rates live in the player')

  const voiceChip = [...panel.querySelectorAll('.dsh-tts-chip')].find((chip) => chip.textContent === 'Michael')
  assert.ok(voiceChip !== undefined)
  await act(async () => {
    voiceChip.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  assert.equal(dom.window.localStorage.getItem('dsh.tts.settings.v1')?.includes('michael'), true)

  const modelChip = [...panel.querySelectorAll('.dsh-tts-chip')].find((chip) => chip.textContent === 'qwen-cv')
  assert.ok(modelChip !== undefined, 'models discovered on the server are offered')
  await act(async () => {
    modelChip.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  assert.equal(dom.window.localStorage.getItem('dsh.tts.settings.v1')?.includes('qwen-cv'), true)
  assert.equal(panel.querySelectorAll('.dsh-tts-chip').length, 4, 'the voice row follows the selected model')

  const toggle = panel.querySelector('[role=switch]')
  assert.equal(toggle.getAttribute('aria-checked'), 'true')
  await act(async () => {
    toggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  assert.equal(dom.window.localStorage.getItem('dsh.tts.settings.v1')?.includes('"autoplay":false'), true)

  await act(async () => { root.unmount() })
  restore()
  dom.window.close()
})

test('autoplay reads a newly completed turn', async () => {
  const dom = makeDom()
  const environment = makeEnvironment()
  const mod = loadBundle(dom, environment)
  const entries = [{ type: 'event', event: { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } } }]
  const registrations = []
  const context = fakeContext(registrations, entries)
  mod.apply(context)
  const control = registrations.find((row) => row.spec.name === 'conversation.input.right')
  const container = dom.window.document.getElementById('root')
  const restore = useDom(dom)
  const root = ReactDOMClient.createRoot(container)
  await act(async () => {
    root.render(React.createElement(control.component, { ...control.injected, sessionId: 's1', t: (key) => key }))
  })

  context.publish(() => {
    entries.push(
      assistantEvent(2, 1, 'm-1', [{ type: 'text', text: 'A brand new answer.' }]),
      { type: 'event', event: { type: 'turn/end', seq: 3, time: 1, data: { turn: 1, reason: { kind: 'completed' } } } },
    )
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.deepEqual(environment.spoken, ['A brand new answer.'])
  await act(async () => { root.unmount() })
  restore()
  dom.window.close()
})

/** Internals of one freshly loaded bundle. */
function bundleInternals () {
  const dom = makeDom()
  const mod = loadBundle(dom, makeEnvironment())
  dom.window.close()
  return mod.__internals
}
