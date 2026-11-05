/**
 * dsh-plugin-tts — host half.
 *
 * Registers two same-origin routes on the DSH web server so the browser never
 * reaches a speech engine directly (no CORS, works from any browser that can
 * open the GUI, keeps engines on loopback):
 *
 *   GET  /tts/info   → discovered speech-capable providers, their models, and voices
 *   POST /tts/speak  → { text, server?, model?, voice?, speed? } → audio/wav bytes
 *
 * Nothing is hardcoded. Servers come from the model providers already configured
 * in the profile: every provider with an explicit `baseURL` is probed for its
 * model list, and each model is asked for its voices (`/audio/voices?model=`).
 * No model is filtered out — audio.cpp declares `task: "tts"` while Ollama
 * serves speech from models that declare nothing (`lfm3-omni`), so a capability
 * probe would hide working engines. Declaration only decides ordering.
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

/** Behaviour defaults; no server, model, or voice is assumed. */
const DEFAULTS = {
  /** Extra servers that are not configured as model providers. */
  endpoints: [],
  /** Preferred server/model/voice; unset means "first discovered". */
  server: null,
  model: null,
  voice: null,
  /** Rates offered by the GUI; the engine resynthesizes, so pitch is preserved. */
  speeds: [0.75, 1, 1.25, 1.5, 2],
  /** How long a discovery result is reused before probing the engines again. */
  discoveryTtlMs: 15000,
  /** How long a provider that failed its capability probe is left alone. */
  failureTtlMs: 300000,
  /** Upper bound for one synthesis request; the GUI splits longer replies. */
  maxChars: 4000,
  /** Total bytes of synthesized audio kept for instant re-listening. */
  cacheBytes: 24 * 1024 * 1024,
  /** One synthesis may take a while on a slow model. */
  timeoutMs: 120000,
  /** Paths to the engines' own `server.json` catalogs, for voice tags. */
  voiceCatalog: [],
}

/**
 * The instruction injected while the multi-voice experiment is on. It rides the
 * system prompt, so the operator's own message is never modified.
 */
const CAST_INSTRUCTION = [
  '## Reading aloud with several voices',
  'A text-to-speech experiment is active: this reply may be read by more than one voice.',
  '- Write as a small cast only when the content genuinely has several voices — a dialogue, an interview, a review with distinct roles. Otherwise keep one narrator voice.',
  '- In a cast, put each speaker at the start of a line as `Name: sentence`, with two to four short, distinct names, and prefer several short labelled turns over one long block.',
  '- Never label ordinary prose, code, or lists: the narrator reads everything unlabelled.',
].join('\n')

/** Required Host services: routes, provider configuration, and the provider directory. */
export const inject = ['webServer', 'settings', 'llm']

/** Clamp a numeric config value. */
function number (value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

/** Strip trailing slashes so endpoint building is predictable. */
function baseUrl (value) {
  return String(value).replace(/\/+$/, '')
}

/**
 * Present an engine voice id as a title-case label (`af_heart` → `Af Heart`).
 * @param id - engine voice identity.
 * @returns Display label.
 */
function voiceLabel (id) {
  return String(id)
    .split(/[_-]+/)
    .filter((part) => part !== '')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

/**
 * Walk one path through a settings value.
 * @param value - section root.
 * @param path - path segments from the provider directory.
 * @returns The value at that path, or undefined.
 */
function follow (value, path) {
  let current = value
  for (const key of path ?? []) {
    if (current === null || typeof current !== 'object') return undefined
    current = current[key]
  }
  return current
}

/** Log levels a reader can filter by. */
const LEVELS = ['debug', 'info', 'warn', 'error']

/**
 * Bounded in-memory event log: the last `limit` entries, newest last.
 * @param limit - maximum retained entries.
 * @returns Log with `add`, `tail`, `clear`, and `counts`.
 */
function createLog (limit = 200) {
  const entries = []
  return {
    add (level, event, detail) {
      const entry = { at: Date.now(), level, event }
      if (detail !== undefined && detail !== null) entry.detail = detail
      entries.push(entry)
      if (entries.length > limit) entries.shift()
      return entry
    },
    tail (count = 20, level) {
      const filtered = level === undefined ? entries : entries.filter((entry) => entry.level === level)
      return filtered.slice(-count)
    },
    clear () {
      const total = entries.length
      entries.length = 0
      return total
    },
    counts () {
      const counts = { debug: 0, info: 0, warn: 0, error: 0 }
      for (const entry of entries) counts[entry.level] = (counts[entry.level] ?? 0) + 1
      return counts
    },
  }
}

/** How long one capability probe may take before it is called inconclusive. */
const PROBE_TIMEOUT_MS = 8000

/** Kokoro ids encode language and gender in their prefix. */
const KOKORO_LANGUAGES = { a: 'en-us', b: 'en-gb', e: 'es', f: 'fr-fr', h: 'hi', i: 'it', j: 'ja', p: 'pt-br', z: 'zh' }

/**
 * Tags carried by a voice id alone, for engines that follow the Kokoro naming.
 * @param id - voice id from the engine.
 * @returns Label plus gender and language when the id encodes them.
 */
function deriveVoice (id) {
  const match = /^([a-z])([fm])_([a-z0-9]+)$/.exec(id)
  if (match === null) return { label: voiceLabel(id), gender: null, language: null }
  const name = match[3]
  return {
    label: name.charAt(0).toUpperCase() + name.slice(1),
    gender: match[2] === 'f' ? 'female' : 'male',
    language: KOKORO_LANGUAGES[match[1]] ?? null,
  }
}

/** One JSON response, always closing the response. */
function json (res, status, body) {
  const payload = Buffer.from(JSON.stringify(body))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/** Read a JSON request body under a hard byte limit. */
async function readJson (req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) {
      const error = new Error('request body too large')
      error.status = 413
      throw error
    }
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    const error = new Error('request body is not valid JSON')
    error.status = 400
    throw error
  }
}

/**
 * Mount the speech proxy and the provider-driven discovery.
 * @param ctx - Host context carrying the web server, settings, and the provider directory.
 * @param config - Optional endpoint overrides, preferences, and cache budget.
 */
export function apply (ctx, config = {}) {
  const options = {
    ...DEFAULTS,
    ...config,
    speeds: Array.isArray(config.speeds) && config.speeds.length > 0 ? config.speeds : DEFAULTS.speeds,
    endpoints: Array.isArray(config.endpoints) ? config.endpoints : [],
    voiceCatalog: (Array.isArray(config.voiceCatalog) ? config.voiceCatalog : config.voiceCatalog === undefined || config.voiceCatalog === null ? [] : [config.voiceCatalog])
      .filter((path) => typeof path === 'string' && path !== ''),
    maxChars: number(config.maxChars, DEFAULTS.maxChars, 1, 20000),
    cacheBytes: number(config.cacheBytes, DEFAULTS.cacheBytes, 0, 512 * 1024 * 1024),
    timeoutMs: number(config.timeoutMs, DEFAULTS.timeoutMs, 1000, 600000),
    discoveryTtlMs: number(config.discoveryTtlMs, DEFAULTS.discoveryTtlMs, 0, 600000),
    failureTtlMs: number(config.failureTtlMs, DEFAULTS.failureTtlMs, 0, 3600000),
  }

  /** Synthesized-audio cache: key → bytes. Insertion order doubles as LRU order. */
  const cache = new Map()
  let cacheBytes = 0
  /** Last discovery result and when it was taken. */
  let discoveredAt = 0
  let discovered = null
  /** Endpoints that failed a probe, and when: nothing re-probes them for a while. */
  const failures = new Map()
  /** Credential variable per endpoint, so speaking authenticates like discovery. */
  const authByEndpoint = new Map()
  /** Host and browser events, bounded. */
  const log = createLog(200)
  /** Whether the multi-voice experiment is on, as the browser last reported it. */
  let castEnabled = false
  /** Voice tags by model and voice id, loaded from the providers' own catalogs. */
  let catalog = new Map()
  let catalogAt = 0

  /**
   * Load `server.json`-shaped catalogs, so a voice can carry the tags its engine
   * published (gender, language, category, description) instead of a bare id.
   * @returns Model id → voice id → tags.
   */
  async function loadCatalog () {
    if (Date.now() - catalogAt < 60_000) return catalog
    catalogAt = Date.now()
    const table = new Map()
    for (const path of options.voiceCatalog) {
      let parsed
      try {
        parsed = JSON.parse(await readFile(path, 'utf8'))
      } catch {
        continue
      }
      for (const model of Array.isArray(parsed?.models) ? parsed.models : []) {
        const presets = model?.voice_presets
        if (presets === null || typeof presets !== 'object' || typeof model?.id !== 'string') continue
        const voices = table.get(model.id) ?? new Map()
        for (const [key, preset] of Object.entries(presets)) {
          if (preset === null || typeof preset !== 'object') continue
          const tags = {
            label: key,
            gender: typeof preset.gender === 'string' ? preset.gender : null,
            language: typeof preset.language === 'string' ? preset.language : null,
            category: typeof preset.category === 'string' ? preset.category : null,
            default: preset.default === true,
            description: typeof preset.description === 'string' ? preset.description.slice(0, 240) : null,
          }
          voices.set(key, tags)
          if (typeof preset.voice_id === 'string' && preset.voice_id !== key) voices.set(preset.voice_id, tags)
        }
        table.set(model.id, voices)
      }
    }
    catalog = table
    return table
  }

  /** Write one event to the log and, when available, the Host logger. */
  function note (level, event, detail) {
    log.add(level, event, detail)
    const writer = level === 'error' ? ctx.logger?.error : level === 'warn' ? ctx.logger?.warn : ctx.logger?.debug
    try {
      writer?.call(ctx.logger, `[tts] ${event}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`)
    } catch { /* logging must never break a request */ }
  }

  /** Drop the oldest entries until the budget holds again. */
  function evict () {
    while (cacheBytes > options.cacheBytes && cache.size > 0) {
      const [key, entry] = cache.entries().next().value
      cache.delete(key)
      cacheBytes -= entry.body.length
    }
  }

  /**
   * Every provider this Host can reach over HTTP, plus any endpoint listed in
   * this plugin's own config. No provider is dropped for lacking an endpoint:
   * the directory's default URL is used when the profile sets none, and the
   * capability probe decides what actually speaks.
   * @returns Unique candidates in provider order.
   */
  function candidates () {
    const found = []
    const seen = new Set()
    /**
     * Add one candidate unless its endpoint was already offered.
     * @param id - provider key.
     * @param name - display name.
     * @param endpoint - base URL.
     * @param apiKeyEnv - environment variable holding the provider's credential.
     */
    const add = (id, name, endpoint, apiKeyEnv) => {
      const normalized = baseUrl(endpoint ?? '')
      if (normalized === '') return
      if (seen.has(normalized)) return
      seen.add(normalized)
      authByEndpoint.set(normalized, typeof apiKeyEnv === 'string' ? apiKeyEnv : undefined)
      found.push({ id, name: name ?? id, baseURL: normalized, apiKeyEnv: typeof apiKeyEnv === 'string' ? apiKeyEnv : undefined })
    }
    let entries = []
    try {
      entries = ctx.llm.listConfigurableProviders()
    } catch {
      entries = []
    }
    let descriptors = []
    try {
      descriptors = ctx.settings.describe()
    } catch {
      descriptors = []
    }
    const values = new Map(descriptors.map((descriptor) => [descriptor.ns, descriptor.value]))
    for (const entry of entries) {
      const path = entry.settingsPath ?? []
      /* Configured, not merely known: the catalog lists every route an adapter
         ships, and probing those would offer cloud models nobody asked for. */
      const section = follow(values.get(entry.settingsNs), path.slice(0, -1))
      const key = path[path.length - 1]
      if (section === null || typeof section !== 'object' || key === undefined || !Object.hasOwn(section, key)) continue
      const profile = section[key]
      const endpoint = profile !== null && typeof profile === 'object' && typeof profile.baseURL === 'string'
        ? profile.baseURL
        : entry.defaultBaseURL
      const apiKeyEnv = profile !== null && typeof profile === 'object' && typeof profile.apiKeyEnv === 'string'
        ? profile.apiKeyEnv
        : undefined
      add(entry.provider, entry.displayName, endpoint, apiKeyEnv)
    }
    for (const extra of options.endpoints) {
      if (extra !== null && typeof extra === 'object' && typeof extra.baseURL === 'string') {
        add(extra.id ?? extra.baseURL, extra.name, extra.baseURL, extra.apiKeyEnv)
      }
    }
    return found
  }

  /**
   * Request headers for one provider, including its credential when the profile
   * names an environment variable that is set. The value never leaves the Host.
   * @param candidate - provider candidate.
   * @returns Headers for every request to that provider.
   */
  function headersOf (candidate) {
    const headers = { accept: 'application/json' }
    const value = candidate.apiKeyEnv === undefined ? undefined : process.env[candidate.apiKeyEnv]
    if (typeof value === 'string' && value !== '') headers.authorization = `Bearer ${value}`
    return headers
  }

  /**
   * Fetch one server's model list.
   * @param candidate - provider candidate.
   * @returns Model records with their declared task/family, or null when the
   *   list cannot be read at all.
   */
  async function fetchModels (candidate) {
    try {
      const response = await fetch(`${candidate.baseURL}/models`, {
        headers: headersOf(candidate),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
      if (!response.ok) return null
      const body = await response.json().catch(() => null)
      const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : []
      return rows
        .map((row) => ({
          id: typeof row?.id === 'string' ? row.id : typeof row === 'string' ? row : undefined,
          task: typeof row?.task === 'string' ? row.task : undefined,
          family: typeof row?.family === 'string' ? row.family : undefined,
        }))
        .filter((row) => row.id !== undefined)
    } catch {
      return null
    }
  }

  /**
   * The OpenAI audio capability test: does this provider serve
   * `POST /audio/speech`? A deliberately empty body is sent — a handler rejects
   * it (400/422/500), a non-speech server answers 404/405/501. Nothing is
   * synthesized, so the probe costs no GPU time.
   * @param candidate - provider candidate.
   * @returns True when the audio route exists.
   */
  async function speaksAudio (candidate) {
    try {
      const response = await fetch(`${candidate.baseURL}/audio/speech`, {
        method: 'POST',
        headers: { ...headersOf(candidate), 'content-type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
      if (response.body !== null) await response.body.cancel().catch(() => {})
      return response.status !== 404 && response.status !== 405 && response.status !== 501 ? 'yes' : 'no'
    } catch {
      /* Busy, slow, or unreachable: unknown, not a refusal. */
      return 'unknown'
    }
  }

  /**
   * Whether the provider also implements the voice listing of the audio API.
   * @param candidate - provider candidate.
   * @returns True when `/audio/voices` answers.
   */
  async function listsVoices (candidate) {
    try {
      const response = await fetch(`${candidate.baseURL}/audio/voices`, {
        headers: headersOf(candidate),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
      if (response.body !== null) await response.body.cancel().catch(() => {})
      return response.ok
    } catch {
      return false
    }
  }

  /**
   * Ask one model which voices it can speak.
   * @param candidate - provider candidate.
   * @param model - engine model id.
   * @returns Voice rows in engine order, or an empty list.
   */
  async function fetchVoices (candidate, model) {
    try {
      const response = await fetch(`${candidate.baseURL}/audio/voices?model=${encodeURIComponent(model)}`, {
        headers: headersOf(candidate),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
      if (!response.ok) return []
      const body = await response.json().catch(() => null)
      const ids = Array.isArray(body?.voices) ? body.voices : []
      const tables = await loadCatalog()
      const tagsOf = tables.get(model)
      return ids
        .filter((voice) => typeof voice === 'string' && voice.trim() !== '')
        .map((id) => {
          const tags = tagsOf?.get(id)
          const derived = deriveVoice(id)
          return {
            id,
            label: derived.label !== id ? derived.label : tags?.label ?? derived.label,
            gender: tags?.gender ?? derived.gender,
            language: tags?.language ?? derived.language,
            category: tags?.category ?? null,
            default: tags?.default === true,
            description: tags?.description ?? null,
          }
        })
    } catch {
      return []
    }
  }

  /**
   * Whether one model declares itself a text-to-speech model. Ordering only:
   * engines such as Ollama serve speech from models that declare no task at all
   * (`lfm3-omni`), so no model is dropped for staying silent about itself.
   * @param model - model record from the server's list.
   * @returns True when its task or family names TTS.
   */
  function declaresTts (model) {
    return /tts/i.test(model.task ?? '') || /tts/i.test(model.family ?? '')
  }

  /**
   * Probe one candidate: it is offered when the OpenAI audio route answers.
   * @param candidate - id, name, endpoint, and credential variable.
   * @returns Server row, or null when the provider cannot speak.
   */
  async function probe (candidate) {
    const audio = await speaksAudio(candidate)
    if (audio === 'no') return { server: null, reason: 'no-speech' }
    const models = await fetchModels(candidate)
    if (models === null) return { server: null, reason: audio === 'unknown' ? 'timeout' : 'no-models' }
    const voiceAware = await listsVoices(candidate)
    const announced = await Promise.all(models.map(async (model) => ({
      id: model.id,
      label: model.id,
      declaresTts: declaresTts(model),
      voices: voiceAware ? await fetchVoices(candidate, model.id) : [],
    })))
    /* Declared speech models lead the list; the rest keep the server's order. */
    announced.sort((left, right) => Number(right.declaresTts) - Number(left.declaresTts))
    return {
      server: {
        id: candidate.id,
        name: candidate.name,
        baseURL: candidate.baseURL,
        declaresTts: announced.some((model) => model.declaresTts),
        models: announced.map(({ declaresTts: _declaresTts, ...model }) => model),
      },
      reason: null,
    }
  }

  /**
   * Discover TTS servers, reusing the last result until it expires.
   * @param force - probe again even when the cached result is fresh.
   * @returns Server rows in provider order.
   */
  async function discover (force = false) {
    if (!force && discovered !== null && Date.now() - discoveredAt < options.discoveryTtlMs) return discovered
    const probes = candidates().filter((candidate) => {
      /* An explicit refresh probes everything; a cached failure only delays the rest. */
      if (force) return true
      const failedAt = failures.get(candidate.baseURL)
      return failedAt === undefined || Date.now() - failedAt > options.failureTtlMs
    })
    const lastGood = new Map((discovered ?? []).map((server) => [server.baseURL, server]))
    const probed = await Promise.all(probes.map(async (candidate) => {
      const result = await probe(candidate)
      if (result.server !== null) {
        failures.delete(candidate.baseURL)
        return result.server
      }
      if (result.reason === 'timeout') {
        /* Still loading a model, or too busy to answer: keep what it offered
           before rather than deleting the provider for five minutes. */
        const kept = lastGood.get(candidate.baseURL)
        if (kept !== undefined) {
          note('debug', 'provider-slow', { provider: candidate.id, endpoint: candidate.baseURL })
          return kept
        }
        return null
      }
      failures.set(candidate.baseURL, Date.now())
      note('debug', 'provider-unusable', { provider: candidate.id, endpoint: candidate.baseURL, reason: result.reason })
      return null
    }))
    /* Servers that declare speech models lead, so a fresh browser defaults to one
       that can actually speak; every other server stays available after them. */
    discovered = probed
      .filter((server) => server !== null)
      .sort((left, right) => Number(right.declaresTts) - Number(left.declaresTts))
    discoveredAt = Date.now()
    note('debug', 'discovered', {
      servers: discovered.map((server) => `${server.id}:${server.models.length}`),
      probed: probes.length,
    })
    return discovered
  }

  /**
   * Resolve the server/model/voice a request means, honouring configured preferences.
   * @param servers - current discovery result.
   * @param wanted - explicitly requested server, model, and voice.
   * @returns The resolved selection, or null when nothing corresponds.
   */
  function select (servers, wanted) {
    let server = servers.find((row) => row.id === wanted.server) ??
      servers.find((row) => row.id === options.server) ??
      servers[0]
    if (server === undefined) return null
    /* A model named without its server is looked up across every provider, so a
       flat model list stays routable when two servers share the panel. */
    let model = wanted.model === undefined ? undefined : server.models.find((row) => row.id === wanted.model)
    if (model === undefined && wanted.model !== undefined && wanted.server === undefined) {
      const owner = servers.find((row) => row.models.some((candidate) => candidate.id === wanted.model))
      if (owner !== undefined) {
        server = owner
        model = owner.models.find((row) => row.id === wanted.model)
      }
    }
    model = model ??
      server.models.find((row) => row.id === options.model) ??
      /* Prefer something that can speak: a provider that lists voices knows its
         speech models; otherwise fall back to names that look like speech. */
      server.models.find((row) => row.voices.length > 0) ??
      server.models.find((row) => /(audio|omni|tts|speech|kokoro|whisper)/i.test(row.id)) ??
      server.models[0]
    if (model === undefined) return null
    const byId = (value) => (value === undefined || value === null ? undefined : model.voices.find((row) => row.id === value))
    const byLabel = (value) => {
      if (value === undefined || value === null) return undefined
      const wantedLabel = String(value).toLowerCase()
      return model.voices.find((row) => String(row.label ?? '').toLowerCase() === wantedLabel)
    }
    const voice = byId(wanted.voice) ?? byLabel(wanted.voice) ??
      byId(options.voice) ?? byLabel(options.voice) ??
      model.voices.find((row) => row.default === true) ??
      model.voices[0]
    return { server, model, voice: voice ?? null }
  }

  /**
   * POST one synthesis to an engine and buffer the audio.
   * @param endpoint - engine base URL.
   * @param text - prose to synthesize.
   * @param model - engine model id.
   * @param voice - engine voice id, or null for the model's own default.
   * @param speed - speaking rate.
   * @returns Buffered audio and whether it came from the cache.
   */
  async function synthesize (endpoint, text, model, voice, speed) {
    const key = createHash('sha256').update(`${endpoint}\u0000${model}\u0000${voice ?? ''}\u0000${speed}\u0000${text}`).digest('hex')
    const hit = cache.get(key)
    if (hit !== undefined) {
      cache.delete(key)
      cache.set(key, hit)
      return { ...hit, cached: true }
    }
    const payload = { model, input: text, response_format: 'wav', speed }
    if (voice !== null) payload.voice = voice
    const credential = authByEndpoint.get(endpoint)
    const secret = credential === undefined ? undefined : process.env[credential]
    const response = await fetch(`${endpoint}/audio/speech`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(typeof secret === 'string' && secret !== '' ? { authorization: `Bearer ${secret}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(options.timeoutMs),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      /* Engines answer with the OpenAI error envelope; unwrap it for the panel. */
      let message = detail.trim().slice(0, 400) || `speech server answered ${response.status}`
      try {
        const parsed = JSON.parse(detail)
        if (typeof parsed?.error?.message === 'string') message = parsed.error.message.slice(0, 400)
      } catch { /* not a JSON error body */ }
      const error = new Error(message)
      error.status = response.status >= 500 ? 502 : 400
      throw error
    }
    const body = Buffer.from(await response.arrayBuffer())
    if (body.length === 0) {
      const error = new Error('speech server returned no audio')
      error.status = 502
      throw error
    }
    const entry = { body, type: response.headers.get('content-type') ?? 'audio/wav' }
    if (options.cacheBytes > 0 && body.length <= options.cacheBytes) {
      cache.set(key, entry)
      cacheBytes += body.length
      evict()
    }
    return { ...entry, cached: false }
  }

  /** Route dispatcher: every unmatched path under /tts answers JSON, never HTML. */
  async function handler (req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/tts/info') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return json(res, 405, { error: { code: 'method', message: 'GET /tts/info' } })
      }
      const servers = await discover(url.searchParams.get('refresh') === '1')
      const fallback = select(servers, {})
      return json(res, 200, {
        /* Ordering hints stay on the Host; the browser sees only what it renders. */
        servers: servers.map(({ id, name, baseURL, models }) => ({ id, name, baseURL, models })),
        defaults: {
          server: fallback?.server.id ?? null,
          model: fallback?.model.id ?? null,
          voice: fallback?.voice?.id ?? null,
          speed: number(options.speed, 1, 0.25, 4),
        },
        speeds: options.speeds,
        maxChars: options.maxChars,
      })
    }
    if (url.pathname === '/tts/cast') {
      if (req.method === 'POST') {
        let body
        try {
          body = await readJson(req, 2048)
        } catch (error) {
          return json(res, error.status ?? 400, { error: { code: 'body', message: error.message } })
        }
        const enabled = body?.enabled === true
        if (enabled !== castEnabled) {
          castEnabled = enabled
          note('info', enabled ? 'cast-enabled' : 'cast-disabled')
        }
        return json(res, 200, { enabled: castEnabled })
      }
      if (req.method === 'GET') return json(res, 200, { enabled: castEnabled })
      return json(res, 405, { error: { code: 'method', message: 'GET or POST /tts/cast' } })
    }
    if (url.pathname === '/tts/log') {
      if (req.method === 'POST') {
        let entry
        try {
          entry = await readJson(req, 8192)
        } catch (error) {
          return json(res, error.status ?? 400, { error: { code: 'body', message: error.message } })
        }
        const level = LEVELS.includes(entry?.level) ? entry.level : 'warn'
        const event = typeof entry?.event === 'string' ? entry.event.slice(0, 40) : 'client-event'
        const detail = entry?.detail !== null && typeof entry?.detail === 'object' ? entry.detail : undefined
        note(level, event, detail === undefined ? undefined : JSON.parse(JSON.stringify(detail).slice(0, 2000)))
        res.writeHead(204, { 'cache-control': 'no-store' })
        return res.end()
      }
      if (req.method === 'GET') {
        const tail = number(url.searchParams.get('tail'), 20, 1, 200)
        const level = url.searchParams.get('level') ?? undefined
        if (level !== undefined && !LEVELS.includes(level)) {
          return json(res, 400, { error: { code: 'level', message: `unknown level: ${level}` } })
        }
        /* Debug is opt-in: a plain read shows what a reader can act on. */
        const entries = level === undefined
          ? log.tail(tail).filter((entry) => entry.level !== 'debug')
          : log.tail(tail, level)
        return json(res, 200, { entries, counts: log.counts() })
      }
      if (req.method === 'DELETE') {
        return json(res, 200, { cleared: log.clear() })
      }
      return json(res, 405, { error: { code: 'method', message: 'GET, POST, or DELETE /tts/log' } })
    }
    if (url.pathname === '/tts/speak') {
      if (req.method !== 'POST') return json(res, 405, { error: { code: 'method', message: 'POST /tts/speak' } })
      let body
      try {
        body = await readJson(req, 64 * 1024)
      } catch (error) {
        return json(res, error.status ?? 400, { error: { code: 'body', message: error.message } })
      }
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      if (text === '') return json(res, 400, { error: { code: 'text', message: 'text is required' } })
      if (text.length > options.maxChars) {
        return json(res, 413, { error: { code: 'text', message: `text exceeds ${options.maxChars} characters` } })
      }
      const servers = await discover()
      const chosen = select(servers, {
        server: typeof body.server === 'string' && body.server !== '' ? body.server : undefined,
        model: typeof body.model === 'string' && body.model !== '' ? body.model : undefined,
        voice: typeof body.voice === 'string' && body.voice !== '' ? body.voice : undefined,
      })
      if (chosen === null) {
        note('warn', 'no-speech-model', { requested: { server: body.server ?? null, model: body.model ?? null } })
        return json(res, 409, { error: { code: 'no-speech-model', message: 'no TTS model is configured as a provider' } })
      }
      const speed = number(body.speed, number(options.speed, 1, 0.25, 4), 0.25, 4)
      try {
        const audio = await synthesize(chosen.server.baseURL, text, chosen.model.id, chosen.voice?.id ?? null, speed)
        if (audio.cached) note('debug', 'synthesis-cache-hit', { model: chosen.model.id, chars: text.length })
        res.writeHead(200, {
          'content-type': audio.type,
          'content-length': audio.body.length,
          'cache-control': 'no-store',
          'x-tts-server': chosen.server.id,
          'x-tts-model': chosen.model.id,
          'x-tts-cache': audio.cached ? 'hit' : 'miss',
        })
        return res.end(audio.body)
      } catch (error) {
        note('error', 'synthesis-failed', {
          provider: chosen.server.id,
          model: chosen.model.id,
          voice: chosen.voice?.id ?? null,
          chars: text.length,
          status: error.status ?? 502,
          message: String(error.message ?? error).slice(0, 240),
        })
        return json(res, error.status ?? 502, { error: { code: 'speech', message: error.message } })
      }
    }
    return json(res, 404, { error: { code: 'route', message: `unknown tts route: ${url.pathname}` } })
  }

  /* Optional service: the routes above work even when no prompt registry exists. */
  ctx.inject?.(['systemPrompt'], (scope) => {
    scope.effect(() => scope.systemPrompt.section({
      name: 'dsh-tts-cast',
      order: 950,
      text: () => (castEnabled ? CAST_INSTRUCTION : ''),
    }), 'dsh-plugin-tts: multi-voice instruction')
    note('info', 'cast-instruction-registered', { chars: CAST_INSTRUCTION.length })
  })

  note('info', 'ready', {
    endpoint: options.endpoint,
    model: options.model,
    cacheBytes: options.cacheBytes,
    discoveryTtlMs: options.discoveryTtlMs,
  })

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/tts', handler }), 'dsh-plugin-tts: /tts routes')
}
