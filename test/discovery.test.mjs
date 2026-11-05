/**
 * Discovery rules against fake engines: which configured providers become TTS
 * servers, how their models and voices are read, and what happens when a
 * provider is down or is not a speech server at all.
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'

import { apply } from '../lib/index.js'

/**
 * A fake OpenAI-compatible server.
 * @param spec - `models` rows and `voices` by model id.
 * @returns Its base URL plus a close handle.
 */
async function fakeServer (spec) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.pathname.replace(/^\/v1(?=\/|$)/, '')
    if (path === '/models') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: spec.models }))
      return
    }
    if (spec.audio !== false && path === '/audio/voices') {
      const voices = spec.voices?.[url.searchParams.get('model')] ?? []
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ voices }))
      return
    }
    if (spec.audio !== false && path === '/audio/speech') {
      res.writeHead(200, { 'content-type': 'audio/wav' }).end(Buffer.from('RIFF....WAVE'))
      return
    }
    res.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    baseURL: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/**
 * Mount the plugin over a provider map.
 * @param providers - provider profiles keyed by provider id.
 * @returns The plugin's origin plus a close handle.
 */
async function mount (providers, config = {}) {
  const routes = new Map()
  const ctx = {
    effect (fn) { fn() },
    webServer: {
      register (route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    settings: { describe: () => [{ ns: 'llm-pi-ai', value: { providers } }] },
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

test('a TTS provider contributes its models and their voices', async () => {
  const engine = await fakeServer({
    models: [
      { id: 'voice-a', task: 'tts', family: 'kokoro_tts' },
      { id: 'voice-b', task: 'tts', family: 'qwen3_tts' },
    ],
    voices: { 'voice-a': ['af_heart', 'am_michael'], 'voice-b': ['Vivian'] },
  })
  const plugin = await mount({ speech: { baseURL: engine.baseURL } })
  try {
    const body = await (await fetch(`${plugin.origin}/tts/info`)).json()
    assert.deepEqual(body.servers, [{
      id: 'speech',
      name: 'speech',
      baseURL: engine.baseURL,
      models: [
        {
          id: 'voice-a',
          label: 'voice-a',
          voices: [
            { id: 'af_heart', label: 'Heart', gender: 'female', language: 'en-us', category: null, default: false, description: null },
            { id: 'am_michael', label: 'Michael', gender: 'male', language: 'en-us', category: null, default: false, description: null },
          ],
        },
        {
          id: 'voice-b',
          label: 'voice-b',
          voices: [{ id: 'Vivian', label: 'Vivian', gender: null, language: null, category: null, default: false, description: null }],
        },
      ],
    }])
    assert.deepEqual(body.defaults, { server: 'speech', model: 'voice-a', voice: 'af_heart', speed: 1 })

    const spoken = await fetch(`${plugin.origin}/tts/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello', model: 'voice-b' }),
    })
    assert.equal(spoken.status, 200)
    assert.equal(spoken.headers.get('x-tts-model'), 'voice-b')
  } finally {
    await plugin.close()
    await engine.close()
  }
})

test('a provider without the audio route is not offered, whatever its models say', async () => {
  const llm = await fakeServer({ audio: false, models: [{ id: 'llama3.1:8b' }, { id: 'qwen3:8b' }] })
  const plugin = await mount({ ollama: { baseURL: llm.baseURL } })
  try {
    const body = await (await fetch(`${plugin.origin}/tts/info`)).json()
    assert.deepEqual(body.servers, [], 'capability, not the model list, decides')
  } finally {
    await plugin.close()
    await llm.close()
  }
})

test('a provider that speaks without declaring TTS models is offered', async () => {
  /* The Ollama case: `lfm3-omni` answers /audio/speech and declares no task. */
  const engine = await fakeServer({ models: [{ id: 'lfm3-omni:latest' }, { id: 'llama3.1:8b' }] })
  const plugin = await mount({ ollama: { baseURL: engine.baseURL } })
  try {
    const body = await (await fetch(`${plugin.origin}/tts/info`)).json()
    assert.deepEqual(body.servers.map((server) => server.id), ['ollama'])
    assert.deepEqual(body.servers[0].models.map((model) => model.id), ['lfm3-omni:latest', 'llama3.1:8b'], 'no model is filtered out')
    assert.deepEqual(body.servers[0].models[0].voices, [])
  } finally {
    await plugin.close()
    await engine.close()
  }
})

test('a provider with no explicit endpoint is not probed', async () => {
  const plugin = await mount({ hosted: { api: 'openai-completions' } })
  try {
    const body = await (await fetch(`${plugin.origin}/tts/info`)).json()
    assert.deepEqual(body.servers, [])
  } finally {
    await plugin.close()
  }
})

test('a dead provider is skipped while the live one still answers', async () => {
  const engine = await fakeServer({ models: [{ id: 'voice-a', task: 'tts' }], voices: { 'voice-a': ['af_heart'] } })
  const plugin = await mount({
    dead: { baseURL: 'http://127.0.0.1:9/v1' },
    speech: { baseURL: engine.baseURL },
  })
  try {
    const body = await (await fetch(`${plugin.origin}/tts/info`)).json()
    assert.deepEqual(body.servers.map((server) => server.id), ['speech'])
  } finally {
    await plugin.close()
    await engine.close()
  }
})

test('an endpoint listed in this plugin config is offered too', async () => {
  const engine = await fakeServer({ models: [{ id: 'voice-a', task: 'tts' }], voices: { 'voice-a': ['af_heart'] } })
  const plugin = await mount({}, { endpoints: [{ id: 'local', name: 'Local audio', baseURL: engine.baseURL }] })
  try {
    const body = await (await fetch(`${plugin.origin}/tts/info`)).json()
    assert.deepEqual(body.servers.map((server) => server.id), ['local'])
    assert.equal(body.servers[0].name, 'Local audio')
  } finally {
    await plugin.close()
    await engine.close()
  }
})

test('an engine refusal surfaces as a JSON error', async () => {
  const engine = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.pathname.replace(/^\/v1(?=\/|$)/, '')
    if (path === '/models') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'voice-a', task: 'tts' }] }))
      return
    }
    if (path === '/audio/voices') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ voices: ['af_heart'] }))
      return
    }
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'model failed to load' } }))
  })
  await new Promise((resolve) => engine.listen(0, '127.0.0.1', resolve))
  const plugin = await mount({ speech: { baseURL: `http://127.0.0.1:${engine.address().port}/v1` } })
  try {
    const response = await fetch(`${plugin.origin}/tts/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    })
    assert.equal(response.status, 502)
    assert.equal((await response.json()).error.code, 'speech')
  } finally {
    await plugin.close()
    await new Promise((resolve) => engine.close(resolve))
  }
})

test('a configured preference wins over the first discovered row', async () => {
  const engine = await fakeServer({
    models: [{ id: 'voice-a', task: 'tts' }, { id: 'voice-b', task: 'tts' }],
    voices: { 'voice-a': ['af_heart'], 'voice-b': ['Vivian'] },
  })
  const plugin = await mount({ speech: { baseURL: engine.baseURL } }, { model: 'voice-b', voice: 'Vivian' })
  try {
    const body = await (await fetch(`${plugin.origin}/tts/info`)).json()
    assert.deepEqual(body.defaults, { server: 'speech', model: 'voice-b', voice: 'Vivian', speed: 1 })
  } finally {
    await plugin.close()
    await engine.close()
  }
})
