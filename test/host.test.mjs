/**
 * Host-half discovery: TTS servers come from the model providers configured in
 * the profile, never from this package. Runs against the live audio.cpp server
 * (configured here the same way the profile configures it) plus the failure
 * paths. Run with `node --test test/`.
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { access } from 'node:fs/promises'
import { after, before, test } from 'node:test'

import { apply, inject } from '../lib/index.js'

/** Provider profiles as the profile stores them under llm-pi-ai. */
const PROVIDERS = {
  'audio-cpp': { api: 'openai-completions', baseURL: 'http://192.168.1.48:8080/v1', models: [{ id: 'kokoro' }] },
  ollama: { api: 'openai-completions', baseURL: 'http://192.168.1.48:11434/v1' },
}

/**
 * Mount the plugin on its own fake web server.
 * @param providers - provider profiles the fake settings expose.
 * @returns Its origin plus a close handle.
 */
async function mount (providers = PROVIDERS, config = {}) {
  const routes = new Map()
  const ctx = {
    effect (fn) {
      fn()
    },
    webServer: {
      register (route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    settings: {
      describe: () => [{ ns: 'llm-pi-ai', value: { providers } }],
    },
    llm: {
      listConfigurableProviders: () => Object.keys(providers).map((provider) => ({
        provider,
        displayName: provider,
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', provider],
      })),
    },
  }
  apply(ctx, { discoveryTtlMs: 0, ...config })
  const server = createServer((req, res) => {
    const route = routes.get('/tts')
    if (route === undefined) return res.writeHead(500).end()
    route.handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

let plugin

before(async () => {
  plugin = await mount()
})

after(async () => {
  await plugin?.close()
})

test('requires the web server, settings, and the provider directory', () => {
  assert.deepEqual(inject, ['webServer', 'settings', 'llm'])
})

test('discovers the providers that implement the OpenAI audio API', async () => {
  const body = await (await fetch(`${plugin.origin}/tts/info`)).json()
  assert.deepEqual(body.servers.map((server) => server.id), ['audio-cpp', 'ollama'], 'capability decides, not declared metadata')
  const server = body.servers[0]
  assert.equal(server.baseURL, 'http://192.168.1.48:8080/v1')
  assert.ok(server.models.length >= 4, 'every model the engine lists is offered')
  assert.ok(server.models.some((model) => model.id === 'kokoro'))
  const kokoro = server.models.find((model) => model.id === 'kokoro')
  /* Kokoro ships dozens of voices; the ids and their tags come from the engine. */
  assert.ok(kokoro.voices.length >= 20, 'the engine reports its whole catalogue')
  assert.deepEqual(kokoro.voices.find((voice) => voice.id === 'af_bella'), {
    id: 'af_bella',
    label: 'Bella',
    gender: 'female',
    language: 'en-us',
    category: null,
    default: false,
    description: null,
  })
  const qwen = server.models.find((model) => model.id === 'qwen-cv')
  assert.ok(qwen.voices.length >= 5, 'each model reports its own voices')
  assert.equal(body.defaults.server, 'audio-cpp')
  assert.equal(body.defaults.model, 'kokoro')
  assert.ok(body.defaults.voice !== null, 'a voice is chosen even before one is stored')
  assert.equal(body.defaults.speed, 1)

  /* Ollama speaks TTS from models that declare nothing; every model it lists is offered. */
  const ollama = body.servers.find((row) => row.id === 'ollama')
  const omni = ollama.models.find((model) => model.id === 'lfm3-omni:latest')
  assert.ok(omni !== undefined, 'models without a declared TTS task are still offered')
  assert.deepEqual(omni.voices, [], 'a provider without the voices route simply has no voices')
  assert.ok(ollama.models.length > 5)
})

test('speaks with the model and voice the request selects', async () => {
  const speak = () => fetch(`${plugin.origin}/tts/speak`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Speaking through the discovered provider.', model: 'kokoro', voice: 'michael' }),
  })
  const response = await speak()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-tts-server'), 'audio-cpp')
  assert.equal(response.headers.get('x-tts-model'), 'kokoro')
  assert.match(response.headers.get('content-type') ?? '', /audio\/(wav|wave|x-wav)/)
  const bytes = Buffer.from(await response.arrayBuffer())
  assert.equal(bytes.subarray(0, 4).toString('ascii'), 'RIFF')

  const again = await speak()
  assert.equal(again.headers.get('x-tts-cache'), 'hit')
})

test('speaks through the Ollama provider too', async () => {
  const response = await fetch(`${plugin.origin}/tts/speak`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Spoken by the local omni model.', model: 'lfm3-omni:latest' }),
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-tts-server'), 'ollama')
  assert.equal(response.headers.get('x-tts-model'), 'lfm3-omni:latest')
  assert.equal((await response.json().catch(() => null)), null, 'audio, not JSON')
})

test('a request for another model uses that model', async () => {
  const response = await fetch(`${plugin.origin}/tts/speak`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'A short line.', model: 'qwen-cv', voice: 'vivian' }),
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-tts-model'), 'qwen-cv')
})

test('applies a rate to the synthesis request', async () => {
  const speak = async (speed) => {
    const response = await fetch(`${plugin.origin}/tts/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Speaking rate changes duration.', model: 'kokoro', voice: 'bella', speed }),
    })
    assert.equal(response.status, 200)
    return Buffer.from(await response.arrayBuffer()).length
  }
  const fast = await speak(2)
  const normal = await speak(1)
  assert.ok(fast < normal, `rate 2 (${fast}) must be shorter than rate 1 (${normal})`)
})

test('rejects a missing, oversized, or unroutable request', async () => {
  const missing = await fetch(`${plugin.origin}/tts/speak`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  assert.equal(missing.status, 400)
  assert.equal((await missing.json()).error.code, 'text')

  const oversized = await fetch(`${plugin.origin}/tts/speak`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'x'.repeat(4001) }),
  })
  assert.equal(oversized.status, 413)

  const wrongMethod = await fetch(`${plugin.origin}/tts/speak`)
  assert.equal(wrongMethod.status, 405)

  const unknown = await fetch(`${plugin.origin}/tts/nope`)
  assert.equal(unknown.status, 404)
})

test('voices carry the tags the engine publishes in its catalog', async (t) => {
  /* The deployment's engine catalog; the suite skips when it is not mounted. */
  const catalog = process.env.TTS_CATALOG ?? '/home/agent/stacks/ai/audio-cpp-server.json'
  try {
    await access(catalog)
  } catch {
    t.skip('no engine catalog on this machine')
    return
  }
  const tagged = await mount(PROVIDERS, { voiceCatalog: catalog })
  try {
    const info = await (await fetch(`${tagged.origin}/tts/info`)).json()
    const model = info.servers.find((row) => row.id === 'audio-cpp').models.find((row) => row.id === 'kokoro')
    const bella = model.voices.find((voice) => voice.id === 'af_bella')
    assert.equal(bella.label, 'Bella', 'the readable name wins over the catalog key')
    assert.equal(bella.gender, 'female')
    assert.equal(bella.language, 'en-us')
    assert.equal(bella.category, 'catalogue')
    assert.equal(bella.default, true, 'the engine default is carried through')
    assert.ok(model.voices.length >= 54, 'every preset is offered')
    assert.equal(info.defaults.voice, 'af_bella', 'the engine default wins over list position')
  } finally {
    await tagged.close()
  }
})

test('derives gender and language from a Kokoro voice id when no catalog exists', async () => {
  const plugin = await mount()
  try {
    const info = await (await fetch(`${plugin.origin}/tts/info`)).json()
    const model = info.servers.find((row) => row.id === 'audio-cpp').models.find((row) => row.id === 'kokoro')
    const pick = (id) => model.voices.find((voice) => voice.id === id)
    assert.deepEqual(
      [pick('af_bella'), pick('am_michael'), pick('zf_xiaobei')].map((voice) => [voice.label, voice.gender, voice.language]),
      [['Bella', 'female', 'en-us'], ['Michael', 'male', 'en-us'], ['Xiaobei', 'female', 'zh']],
    )
  } finally {
    await plugin.close()
  }
})

test('the multi-voice experiment is mirrored and injects one prompt section', async () => {
  const sections = new Map()
  const pluginCtx = {
    effect (fn) { fn() },
    inject (services, callback) {
      if (services.includes('systemPrompt')) callback({ effect: (fn) => fn(), systemPrompt: { section: (section) => { sections.set(section.name, section); return () => sections.delete(section.name) } } })
      return () => {}
    },
    webServer: {
      register (route) { sections.set('route', route); return () => sections.delete('route') },
    },
    settings: { describe: () => [] },
    llm: { listConfigurableProviders: () => [] },
  }
  apply(pluginCtx, { discoveryTtlMs: 0 })
  const route = sections.get('route')
  const server = createServer((req, res) => { route.handler(req, res) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  try {
    const section = sections.get('dsh-tts-cast')
    assert.ok(section !== undefined, 'the section is registered')
    assert.equal(section.text({}), '', 'the instruction is absent while the experiment is off')

    const posted = await fetch(`${origin}/tts/cast`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })
    assert.equal(posted.status, 200)
    assert.equal((await posted.json()).enabled, true)
    assert.match(section.text({}), /Reading aloud with several voices/)
    assert.match(section.text({}), /Name: sentence/)
    assert.equal((await (await fetch(`${origin}/tts/cast`)).json()).enabled, true)

    await fetch(`${origin}/tts/cast`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    assert.equal(section.text({}), '', 'turning it off removes the instruction')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('keeps an event log that can be filtered, read, and cleared', async () => {
  const warn = await fetch(`${plugin.origin}/tts/log`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ level: 'warn', event: 'highlight-miss', detail: { reason: 'no-anchors', roots: 'document', sentence: 'a sentence that was not found' } }),
  })
  assert.equal(warn.status, 204)
  const failure = await fetch(`${plugin.origin}/tts/log`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ level: 'error', event: 'playback-failed', detail: { code: 'server', message: 'boom' } }),
  })
  assert.equal(failure.status, 204)

  const all = await (await fetch(`${plugin.origin}/tts/log?tail=50`)).json()
  assert.ok(all.entries.length >= 2)
  assert.ok(all.counts.warn >= 1)
  assert.ok(all.counts.error >= 1)
  const miss = all.entries.find((entry) => entry.event === 'highlight-miss')
  assert.equal(miss.detail.reason, 'no-anchors')
  assert.equal(miss.detail.roots, 'document')

  const errorsOnly = await (await fetch(`${plugin.origin}/tts/log?level=error`)).json()
  assert.ok(errorsOnly.entries.length >= 1)
  assert.ok(errorsOnly.entries.every((entry) => entry.level === 'error'))
  assert.equal((await fetch(`${plugin.origin}/tts/log?level=nope`)).status, 400)
  assert.equal((await fetch(`${plugin.origin}/tts/log`, { method: 'PUT' })).status, 405)

  const cleared = await (await fetch(`${plugin.origin}/tts/log`, { method: 'DELETE' })).json()
  assert.ok(cleared.cleared >= 2)
  assert.deepEqual((await (await fetch(`${plugin.origin}/tts/log`)).json()).entries, [])
})

test('a stale stored voice falls back to one the model offers', async () => {
  /* A remembered voice can disappear when the model changes; speaking must not
     fail because of it. */
  const response = await fetch(`${plugin.origin}/tts/speak`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Fallback still speaks.', model: 'kokoro', voice: 'no_such_voice_xyz' }),
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-tts-model'), 'kokoro')
})

test('logs a synthesis failure with provider, model, and status', async () => {
  const engine = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.pathname.replace(/^\/v1(?=\/|$)/, '')
    if (path === '/health') return res.writeHead(200).end('{}')
    if (path === '/models') {
      return res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ data: [{ id: 'broken', task: 'tts' }] }))
    }
    if (path === '/audio/voices') {
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ voices: ['v1'] }))
    }
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'model exploded' } }))
  })
  await new Promise((resolve) => engine.listen(0, '127.0.0.1', resolve))
  const broken = await mount({}, { endpoints: [{ id: 'broken', name: 'Broken', baseURL: `http://127.0.0.1:${engine.address().port}/v1` }] })
  try {
    const response = await fetch(`${broken.origin}/tts/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'this will fail' }),
    })
    assert.equal(response.status, 502)
    const log = await (await fetch(`${broken.origin}/tts/log?level=error`)).json()
    const entry = log.entries.find((row) => row.event === 'synthesis-failed')
    assert.ok(entry !== undefined, 'the failure is logged')
    assert.equal(entry.detail.provider, 'broken')
    assert.equal(entry.detail.model, 'broken')
    assert.match(entry.detail.message, /model exploded/)
    assert.ok(entry.detail.chars > 0)
  } finally {
    await broken.close()
    await new Promise((resolve) => engine.close(resolve))
  }
})

test('an empty provider list yields no servers and a clear refusal', async () => {
  const empty = await mount({})
  try {
    const body = await (await fetch(`${empty.origin}/tts/info`)).json()
    assert.deepEqual(body.servers, [])
    assert.equal(body.defaults.server, null)
    const response = await fetch(`${empty.origin}/tts/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'anything' }),
    })
    assert.equal(response.status, 409)
    assert.equal((await response.json()).error.code, 'no-speech-model')
  } finally {
    await empty.close()
  }
})
