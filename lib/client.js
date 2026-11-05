/**
 * dsh-plugin-tts — browser half.
 *
 * Adds listening to the Web GUI:
 *  - a Listen control on each finalized assistant reply (play / stop),
 *  - automatic reading of new replies when autoplay is on,
 *  - a composer control with autoplay, voice, and rate choices.
 *
 * Speech comes from the Host proxy (`/tts/speak`), which buffers audio from the
 * local audio.cpp/Kokoro server. Replies are split into sentences and pipelined
 * one request ahead, so playback starts after the first sentence instead of
 * after the whole answer.
 *
 * Hand-authored bundle: `window.__ModuleLoader__.load` registers one factory; the
 * factory receives the shell's baseline `require` (react, react-dom, and the
 * client primitives are baseline modules, so nothing else needs declaring).
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-tts',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const { createPortal } = require('react-dom')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'tts'
    /** Internal cancellation sentinel: a stop is not an error. */
    const STOP = Symbol('tts stop')
    /** Routes owned by the host half. */
    const ROUTES = { info: '/tts/info', speak: '/tts/speak' }
    /** Persisted browser preferences. */
    const SETTINGS_KEY = 'dsh.tts.settings.v1'
    /** Longest sentence group sent in one synthesis request, in characters. */
    const CHUNK_CHARS = 380
    /** Stand-in for a decimal point while sentences are being split. */
    const DECIMAL = '\u0001'

    /* ------------------------------------------------------------------ locale */

    /** Simplified Chinese dictionary. */
    const zh = {
      'action.listen': '朗读这条回复',
      'action.stop': '停止朗读',
      'trigger': '朗读',
      'panel.aria': '朗读设置',
      'panel.title': '朗读回复',
      'autoplay': '自动朗读新回复',
      'highlight': '朗读时高亮当前句',
      'caption.loading': '准备朗读…',
      'caption.stop': '停止朗读',
      'player.prev': '上一句',
      'player.next': '下一句',
      'player.pause': '暂停',
      'player.resume': '继续',
      'player.seek': '播放进度',
      'player.replay': '重读这一句',
      'player.dismiss': '关闭',
      'player.speed': '点击切换语速',
      'player.close': '停止并关闭',
      'status.failed': '朗读失败',
      'status.hint.default': '这个语音服务没有响应，请检查语音设置。',
      'status.hint.network': '与语音服务的连接中断了，请再试一次。',
      'status.hint.server': '这个语音服务拒绝了请求，请检查语音设置。',
      'server': '服务',
      'model': '模型',
      'voice': '声音',
      'speed': '语速',
      'cast': '多角色朗读（实验）',
      'castVoice': '当前声音',
      'castHint': '让模型用多角色写作，并按段落切换声音；会向模型注入一条后台说明。',
      'readLast': '朗读最后一条回复',
      'status.ready': '语音服务就绪',
      'status.loading': '正在连接语音服务…',
      'status.offline': '无法读取语音服务配置。',
      'status.none': '未找到 TTS 模型 — 请先在模型提供方中添加语音服务。',
      'status.blocked': '浏览器拦截了自动播放 — 请点击回复上的朗读按钮。',
      'status.empty': '这条回复没有可朗读的文本。',
      'status.playing': '正在朗读 {index}/{total}',
      'hint': '由本地 audio.cpp 合成，音频不离开本机。',
    }

    /** English dictionary. */
    const en = {
      'action.listen': 'Listen to this reply',
      'action.stop': 'Stop reading',
      'trigger': 'Listen',
      'panel.aria': 'Read-aloud settings',
      'panel.title': 'Read replies aloud',
      'autoplay': 'Read new replies aloud',
      'highlight': 'Highlight the sentence being read',
      'caption.loading': 'Preparing speech…',
      'caption.stop': 'Stop reading',
      'player.prev': 'Previous sentence',
      'player.next': 'Next sentence',
      'player.pause': 'Pause',
      'player.resume': 'Resume',
      'player.seek': 'Playback position',
      'player.replay': 'Replay this sentence',
      'player.dismiss': 'Dismiss',
      'player.speed': 'Click to change the speaking rate',
      'player.close': 'Stop and close',
      'status.failed': 'Playback failed',
      'status.hint.default': 'The speech provider did not answer — check the speech settings.',
      'status.hint.network': 'The connection to the speech provider dropped — try again.',
      'status.hint.server': 'The speech provider refused the request — check the speech settings.',
      'server': 'Server',
      'model': 'Model',
      'voice': 'Voice',
      'speed': 'Speed',
      'cast': 'Multiple voices (experimental)',
      'castVoice': 'Voice on this part',
      'castHint': 'Asks the model to write with a small cast, then reads each part in its own voice. Adds a background note to the model; needs a model with several voices.',
      'readLast': 'Read the last reply',
      'status.ready': 'Speech server ready',
      'status.loading': 'Connecting to the speech service…',
      'status.offline': 'Could not read the speech configuration.',
      'status.none': 'No TTS model found — add a speech server as a model provider.',
      'status.blocked': 'The browser blocked autoplay — press Listen on a reply.',
      'status.empty': 'This reply has no readable text.',
      'status.playing': 'Reading {index}/{total}',
      'hint': 'Synthesized by the local audio.cpp server; audio never leaves the machine.',
    }

    /* --------------------------------------------------------------------- css */

    const STYLES = [
      '.dsh-tts-action{width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;justify-content:center;align-items:center;padding:6px;display:inline-flex}',
      '.dsh-tts-action svg{width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px))}',
      '.dsh-tts-action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '.dsh-tts-action[data-active]{color:var(--dsw-alias-state-business-primary)}',
      '.dsh-tts-trigger{border-radius:var(--dsw-radius-sm);height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;outline:none;align-items:center;gap:4px;padding:0 4px 0 8px;font-size:13px;font-weight:500;line-height:20px;display:inline-flex}',
      '.dsh-tts-trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-tts-trigger[data-on]{color:var(--dsw-alias-label-primary)}',
      '.dsh-tts-trigger svg{width:14px;height:14px}',
      '.dsh-tts-trigger-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-tts-panel{position:fixed;z-index:90;width:352px;max-height:min(72vh,560px);overflow-y:auto;box-sizing:border-box;display:flex;flex-direction:column;gap:12px;padding:14px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l4);box-shadow:0 12px 40px rgba(0,0,0,.32);color:var(--dsw-alias-label-primary);font-size:13px;text-align:left}',
      '.dsh-tts-title{font-size:13px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary)}',
      '.dsh-tts-row{display:flex;align-items:center;justify-content:space-between;gap:12px}',
      '.dsh-tts-field{display:flex;flex-direction:column;gap:6px}',
      '.dsh-tts-label{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.dsh-tts-chips{display:flex;flex-wrap:wrap;gap:6px;max-height:148px;overflow-y:auto;padding-right:2px}',
      '.dsh-tts-chip{box-sizing:border-box;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);height:26px;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;background:0 0;padding:0 9px}',
      '.dsh-tts-chip:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-tts-chip[data-active]{border-color:var(--dsw-alias-button-primary-fill);background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}',
      '.dsh-tts-read{border-radius:var(--dsw-radius-sm);height:30px;border:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-primary);background:0 0;font:inherit;font-size:12px;cursor:pointer}',
      '.dsh-tts-read:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-tts-status{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;overflow-wrap:anywhere}',
      '.dsh-tts-status[data-tone=warn]{color:var(--dsw-alias-label-tertiary)}',
      '.dsh-tts-footer{display:flex;align-items:center;justify-content:space-between;gap:10px}',
      '.dsh-tts-player{display:flex;flex-direction:column;gap:6px;padding:5px 12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:17px;box-sizing:border-box;width:100%;max-width:var(--dsh-composer-card-max-width,952px);margin-inline:auto;flex:none}',
      '.dsh-tts-player-row{display:flex;align-items:center;gap:6px;min-width:0}',
      '.dsh-tts-failed{gap:8px;border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary,#e5484d) 45%, transparent);background:color-mix(in srgb, var(--dsw-alias-state-error-primary,#e5484d) 10%, var(--dsw-alias-bg-layer-1))}',
      '.dsh-tts-failed-label{flex:none;font-weight:500;color:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.dsh-tts-failed-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}',
      '.dsh-tts-close{width:22px;height:22px;flex:none;display:inline-flex;align-items:center;justify-content:center;border:none;background:0 0;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0}',
      '.dsh-tts-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dsh-tts-close svg{width:12px;height:12px}',
      '.dsh-tts-pbtn{width:24px;height:24px;flex:none;display:inline-flex;align-items:center;justify-content:center;border:none;background:0 0;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0}',
      '.dsh-tts-pbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dsh-tts-pbtn svg{width:14px;height:14px}',
      '.dsh-tts-seek{flex:1;min-width:64px;height:14px;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer}',
      '.dsh-tts-voice{flex:none;max-width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:11px}',
      '.dsh-tts-rate{flex:none;border:.5px solid var(--dsw-alias-border-l4);background:0 0;border-radius:var(--dsw-radius-sm);padding:1px 2px 1px 4px;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;font-variant-numeric:tabular-nums;cursor:pointer;appearance:none;-webkit-appearance:none}',
      '.dsh-tts-rate:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dsh-tts-time{flex:none;border:none;background:0 0;padding:2px 4px;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-caption);font:inherit;font-size:11px;font-variant-numeric:tabular-nums;cursor:pointer}',
      '.dsh-tts-time:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '::highlight(dsh-tts-reading){background-color:rgba(106,166,255,.30);color:inherit}',
      '[data-dsh-tts-reading]{background-color:rgba(106,166,255,.22);border-radius:3px;box-shadow:0 0 0 1px rgba(106,166,255,.35)}',
    ].join('')

    /** Inject the plugin stylesheet once per page. */
    function installCss () {
      const id = 'dsh-plugin-tts/tts.css'
      if (typeof document === 'undefined') return
      if (document.querySelector(`style[data-plugin-css="${id}"]`) !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-plugin-tts'
      tag.dataset.pluginCss = id
      tag.textContent = STYLES
      document.head.appendChild(tag)
    }

    /* ------------------------------------------------------------------- store */

    /**
     * Minimal observable store (`getSnapshot`/`subscribe`), the shape the slot
     * system's injected hooks read.
     * @param initial - first value.
     * @returns A snapshot store with `set` and `update`.
     */
    function createStore (initial) {
      let value = initial
      const listeners = new Set()
      return {
        getSnapshot: () => value,
        subscribe (listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        set (next) {
          if (Object.is(next, value)) return
          value = next
          for (const listener of [...listeners]) listener()
        },
        update (patch) {
          this.set({ ...value, ...patch })
        },
      }
    }

    /* ---------------------------------------------------------------- settings */

    /**
     * Browser preferences, persisted in localStorage. Null fields mean "follow
     * the Host default from /tts/info" — the server, model, and voice are chosen
     * here, never assumed by the code.
     * @returns A store with `save(patch)`.
     */
    function createSettingsStore () {
      const fallback = { autoplay: true, highlight: true, server: null, model: null, voice: null, speed: null }
      let initial = fallback
      try {
        const raw = window.localStorage.getItem(SETTINGS_KEY)
        const parsed = raw === null ? null : JSON.parse(raw)
        if (parsed !== null && typeof parsed === 'object') {
          initial = {
            autoplay: typeof parsed.autoplay === 'boolean' ? parsed.autoplay : fallback.autoplay,
            highlight: typeof parsed.highlight === 'boolean' ? parsed.highlight : fallback.highlight,
            server: typeof parsed.server === 'string' ? parsed.server : null,
            model: typeof parsed.model === 'string' ? parsed.model : null,
            voice: typeof parsed.voice === 'string' ? parsed.voice : null,
            speed: typeof parsed.speed === 'number' ? parsed.speed : null,
          }
        }
      } catch {
        /* storage unavailable: session-only preferences */
      }
      const store = createStore(initial)
      return {
        ...store,
        getSnapshot: store.getSnapshot,
        subscribe: store.subscribe,
        save (patch) {
          store.update(patch)
          try {
            window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(store.getSnapshot()))
          } catch {
            /* ignore quota/denied storage */
          }
        },
      }
    }

    /* -------------------------------------------------------------- selection */

    /**
     * Resolve the server, model, and voice a preference set means against the
     * Host's discovery result: the stored choice, else the Host default, else the
     * first offered row.
     * @param preferences - settings snapshot.
     * @param discovered - `/tts/info` value, or null before it loads.
     * @returns The resolved selection plus the rosters the panel offers.
     */
    function selectionOf (preferences, discovered) {
      const servers = Array.isArray(discovered?.servers) ? discovered.servers : []
      const defaults = discovered?.defaults ?? {}
      const server = servers.find((row) => row.id === preferences.server) ??
        servers.find((row) => row.id === defaults.server) ??
        servers[0] ?? null
      const models = Array.isArray(server?.models) ? server.models : []
      const model = models.find((row) => row.id === preferences.model) ??
        models.find((row) => row.id === defaults.model) ??
        models[0] ?? null
      const voices = Array.isArray(model?.voices) ? model.voices : []
      const byName = (value) => {
        if (value === undefined || value === null) return undefined
        const wanted = String(value).toLowerCase()
        return voices.find((row) => String(row.label ?? '').toLowerCase() === wanted)
      }
      const voice = voices.find((row) => row.id === preferences.voice) ??
        byName(preferences.voice) ??
        voices.find((row) => row.id === defaults.voice) ??
        voices.find((row) => row.default === true) ??
        voices[0] ?? null
      const speeds = Array.isArray(discovered?.speeds) && discovered.speeds.length > 0 ? discovered.speeds : [0.75, 1, 1.25, 1.5, 2]
      const speed = typeof preferences.speed === 'number' ? preferences.speed : defaults.speed ?? 1
      return { server, model, voice, speed, servers, models, voices, speeds }
    }

    /* ------------------------------------------------------------ host config */

    /**
     * Fetch the Host's speech configuration and engine status.
     * @param store - configuration store to publish into.
     * @returns Completion; failures land in the store.
     */
    async function refreshInfo (store, refresh = false) {
      const previous = store.getSnapshot()
      if (previous.status !== 'ready') store.set({ ...previous, status: 'loading', error: null })
      try {
        const response = await fetch(refresh ? `${ROUTES.info}?refresh=1` : ROUTES.info, { headers: { accept: 'application/json' } })
        if (!response.ok) throw new Error(`/tts/info answered ${response.status}`)
        const value = await response.json()
        store.set({ status: 'ready', value, error: null })
      } catch (error) {
        store.set({ status: 'error', value: previous.value, error: String(error?.message ?? error) })
      }
    }

    /* -------------------------------------------------------------------- text */

    /**
     * Turn rendered markdown into speakable prose: drop code, keep words, drop
     * markup and bare URLs.
     * @param markdown - reply text as stored in the Session log.
     * @returns Prose with collapsed whitespace.
     */
    function cleanForSpeech (markdown) {
      let text = String(markdown)
      /* Symbol and numeral forms the engines read badly. Kokoro renders `12.5`
         as "twelve, five" — a pause, not a decimal — so the point is spelled. */
      text = text.replace(/(\d)\s*\.\s*(\d)/g, '$1 point $2')
      text = text.replace(/(\d)\s*[×x]\s*/g, '$1 times ')
      text = text.replace(/(\d)\s*%/g, '$1 percent')
      text = text.replace(/(\d)\s*°/g, '$1 degrees')
      text = text.replace(/```[\s\S]*?```/g, ' ')
      text = text.replace(/~~~[\s\S]*?~~~/g, ' ')
      text = text.replace(/`([^`]*)`/g, '$1')
      text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      text = text.replace(/<(https?:\/\/[^>\s]+)>/g, ' ')
      text = text.replace(/\bhttps?:\/\/\S+/g, ' ')
      text = text.replace(/<[^>\n]+>/g, ' ')
      text = text.replace(/^\s*\|?[\s:|-]{4,}\|?\s*$/gm, ' ')
      text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '')
      text = text.replace(/^\s{0,3}>\s?/gm, '')
      text = text.replace(/^\s{0,3}[-*+]\s+/gm, '')
      text = text.replace(/^\s{0,3}\d+[.)]\s+/gm, '')
      text = text.replace(/^\s*([-*_])\1{2,}\s*$/gm, ' ')
      text = text.replace(/\*\*/g, '')
      text = text.replace(/__/g, '')
      text = text.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1$2')
      text = text.replace(/(^|[\s(])_([^_\n]+)_/g, '$1$2')
      text = text.replace(/~~([^~]+)~~/g, '$1')
      text = text.replace(/[ \t]*\|[ \t]*/g, ', ')
      return text.replace(/\r/g, '\n').replace(/\s+/g, ' ').trim()
    }

    /**
     * Split prose into sentence groups of at most `max` characters.
     * @param text - cleaned prose.
     * @param max - character budget per group.
     * @returns Groups in reading order; empty when there is nothing to say.
     */
    function splitChunks (text, max = CHUNK_CHARS) {
      const prose = String(text).trim()
      if (prose === '') return []
      /* A decimal point is not a sentence end: `12.5` must stay `12.5`, or the
         engine says "twelve" and then "five" as a new sentence. */
      const guarded = prose.replace(/(\d)\.(\d)/g, (_, before, after) => `${before}${DECIMAL}${after}`)
      const sentences = (guarded.match(/[^.!?…]+[.!?…]+["')\]]*|[^.!?…]+$/g) ?? [guarded])
        .map((sentence) => sentence.split(DECIMAL).join('.'))
      const chunks = []
      let buffer = ''
      const flush = () => {
        const value = buffer.trim()
        if (value !== '') chunks.push(value)
        buffer = ''
      }
      for (const sentence of sentences) {
        const piece = sentence.trim()
        if (piece === '') continue
        if (piece.length > max) {
          flush()
          for (const line of hardSplit(piece, max)) chunks.push(line)
          continue
        }
        if (buffer === '') buffer = piece
        else if (buffer.length + 1 + piece.length <= max) buffer = `${buffer} ${piece}`
        else {
          flush()
          buffer = piece
        }
      }
      flush()
      return chunks
    }

    /**
     * Break one over-long sentence at commas, then at spaces.
     * @param sentence - sentence longer than the budget.
     * @param max - character budget.
     * @returns Pieces within the budget.
     */
    function hardSplit (sentence, max) {
      const pieces = []
      const parts = sentence.split(/(?<=[,;:])\s+/)
      let buffer = ''
      const flush = () => {
        const value = buffer.trim()
        if (value !== '') pieces.push(value)
        buffer = ''
      }
      for (const part of parts) {
        if (part.length > max) {
          flush()
          let line = ''
          for (const word of part.split(/\s+/)) {
            if (line === '') line = word
            else if (line.length + 1 + word.length <= max) line = `${line} ${word}`
            else {
              pieces.push(line)
              line = word
            }
          }
          if (line !== '') pieces.push(line)
          continue
        }
        if (buffer === '') buffer = part
        else if (buffer.length + 1 + part.length <= max) buffer = `${buffer} ${part}`
        else {
          flush()
          buffer = part
        }
      }
      flush()
      return pieces
    }

    /** Normalize one event-window entry to its Session event. */
    function eventOf (entry) {
      return entry !== null && typeof entry === 'object' && 'event' in entry ? entry.event : entry
    }

    /** Read the durable event window of one Session, or an empty list. */
    function windowOf (ctx, sessionId) {
      try {
        const binding = ctx.sessions.binding(sessionId)
        if (binding === undefined || binding === null) return null
        return binding.eventSource.getSnapshot()
      } catch {
        return null
      }
    }

    /** Join the visible text blocks of one assistant message. */
    function messageProse (event) {
      const content = event?.data?.message?.content
      if (!Array.isArray(content)) return ''
      const parts = []
      for (const block of content) {
        if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
      }
      return cleanForSpeech(parts.join('\n'))
    }

    /**
     * Read one finalized assistant message as speakable prose.
     * @param ctx - client context carrying `sessions`.
     * @param sessionId - Session owning the message.
     * @param messageId - durable message identity from the action slot.
     * @returns Prose, or an empty string when the message is not in the loaded window.
     */
    function readAssistantText (ctx, sessionId, messageId) {
      const window = windowOf(ctx, sessionId)
      if (window === null) return ''
      for (const entry of window.entries) {
        const event = eventOf(entry)
        if (event?.type !== 'assistant/message') continue
        if (event.data?.message?.id !== messageId) continue
        return messageProse(event)
      }
      return ''
    }

    /**
     * The raw markdown of one assistant message, before any cleanup.
     * @param ctx - client context carrying `sessions`.
     * @param sessionId - Session owning the message.
     * @param messageId - durable message identity.
     * @returns Raw text, or an empty string.
     */
    function readAssistantRaw (ctx, sessionId, messageId) {
      const window = windowOf(ctx, sessionId)
      if (window === null) return ''
      for (const entry of window.entries) {
        const event = eventOf(entry)
        if (event?.type !== 'assistant/message') continue
        if (event.data?.message?.id !== messageId) continue
        const content = event.data?.message?.content
        if (!Array.isArray(content)) return ''
        return content
          .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('\n')
      }
      return ''
    }

    /**
     * Split one reply into cast segments: headings and `Name:` labels start a
     * new segment, and a reply with neither falls back to its paragraphs.
     * @param raw - markdown of the reply.
     * @returns Segments with the key that decides their voice.
     */
    function castSegments (raw) {
      const lines = String(raw).split(/\r?\n/)
      const segments = []
      let current = { key: null, lines: [] }
      const flush = () => {
        const body = current.lines.join('\n').trim()
        if (body !== '') segments.push({ key: current.key, text: body })
        current = { key: null, lines: [] }
      }
      for (const line of lines) {
        const heading = /^\s{0,3}#{1,6}\s+(.+)$/.exec(line)
        const speaker = /^\s{0,3}(?:\*\*|__)?([A-Z][\w .'-]{0,23})(?:\*\*|__)?\s*:\s+(.+)$/.exec(line)
        if (heading !== null) {
          flush()
          current = { key: heading[1].trim().slice(0, 40), lines: [heading[1]] }
          continue
        }
        if (speaker !== null) {
          flush()
          current = { key: speaker[1].trim(), lines: [speaker[2]] }
          continue
        }
        current.lines.push(line)
      }
      flush()
      return segments.filter((segment) => cleanForSpeech(segment.text) !== '')
    }

    /**
     * Turn a reply into a cast plan: one entry per sentence group, each naming the
     * voice that reads it. A speaker keeps its voice; speakers rotate the roster.
     * @param raw - markdown of the reply.
     * @param voices - voice roster of the selected model.
     * @returns Chunks with their voice, and the speaker → voice map.
     */
    function buildCast (raw, voices, preferredVoiceId = null) {
      const segments = castSegments(raw)
      if (segments.length < 2 || voices.length < 2) return { chunks: null, cast: [] }
      /* The narrator speaks first and keeps the voice from the settings. */
      const ordered = preferredVoiceId === null
        ? voices
        : [...voices.filter((voice) => voice.id === preferredVoiceId), ...voices.filter((voice) => voice.id !== preferredVoiceId)]
      const assigned = new Map()
      const cast = []
      const chunks = []
      for (let index = 0; index < segments.length; index++) {
        const segment = segments[index]
        const key = segment.key ?? `part ${index + 1}`
        let voice = assigned.get(key)
        if (voice === undefined) {
          voice = ordered[assigned.size % ordered.length]
          assigned.set(key, voice)
          cast.push({ key, voice: voice.id, label: voice.label ?? voice.id })
        }
        for (const text of splitChunks(cleanForSpeech(segment.text))) {
          chunks.push({ text, voice: voice.id, voiceLabel: voice.label ?? voice.id })
        }
      }
      return chunks.length > 0 ? { chunks, cast } : { chunks: null, cast: [] }
    }

    /**
     * The newest assistant message with visible text and its prose.
     * @param ctx - client context carrying `sessions`.
     * @param sessionId - Session to read.
     * @returns Message identity plus prose, or null.
     */
    function findLastAssistant (ctx, sessionId) {
      const window = windowOf(ctx, sessionId)
      if (window === null) return null
      for (let index = window.entries.length - 1; index >= 0; index--) {
        const event = eventOf(window.entries[index])
        if (event?.type !== 'assistant/message') continue
        if (event.data?.interrupted === true) continue
        const text = messageProse(event)
        if (text === '') continue
        const id = event.data?.message?.id
        if (typeof id !== 'string') continue
        return { id, text }
      }
      return null
    }

    /**
     * The assistant message that closed one completed Turn.
     * @param ctx - client context carrying `sessions`.
     * @param sessionId - Session to read.
     * @param turn - turn number from the `turn/end` event.
     * @returns Message identity plus prose, or null when the turn said nothing.
     */
    function findTurnAnswer (ctx, sessionId, turn) {
      const window = windowOf(ctx, sessionId)
      if (window === null) return null
      for (let index = window.entries.length - 1; index >= 0; index--) {
        const event = eventOf(window.entries[index])
        if (event?.type === 'turn/start') {
          if (event.data?.turn === turn) break
          continue
        }
        if (event?.type !== 'assistant/message') continue
        if (event.data?.turn !== turn) continue
        if (event.data?.interrupted === true) continue
        const text = messageProse(event)
        if (text === '') continue
        const id = event.data?.message?.id
        if (typeof id !== 'string') continue
        return { id, text }
      }
      return null
    }

    /* -------------------------------------------------------------- highlight */

    /** Name of the CSS custom highlight painting the spoken sentence. */
    const HIGHLIGHT_NAME = 'dsh-tts-reading'

    /** Elements whose text must never be searched for spoken prose. */
    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'PRE'])

    /**
     * Collect the visible text of one or more subtrees as one whitespace-normalized
     * string, together with the node/offset each character came from.
     * @param roots - nodes to read, in reading order.
     * @returns Flattened text and its position map.
     */
    function flattenText (roots) {
      const containers = Array.isArray(roots) ? roots : [roots]
      const nodes = []
      for (const root of containers) {
        if (root === null || root === undefined || typeof root !== 'object') continue
        const walker = document.createTreeWalker(root, window.NodeFilter?.SHOW_TEXT ?? 4, null)
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          const parent = node.parentElement
          if (parent === null) continue
          if (SKIP_TAGS.has(parent.tagName)) continue
          if (parent.closest('.dsh-tts-panel') !== null) continue
          if (parent.closest('[data-dsh-tts-ignore]') !== null) continue
          nodes.push(node)
        }
      }
      let text = ''
      const map = []
      for (const node of nodes) {
        const value = node.nodeValue ?? ''
        for (let offset = 0; offset < value.length; offset++) {
          const character = value[offset]
          if (/\s/.test(character)) {
            if (text.endsWith(' ')) continue
            text += ' '
            map.push({ node, offset })
            continue
          }
          text += character
          map.push({ node, offset })
        }
      }
      return { text, map }
    }

    /**
     * Collapse whitespace the way {@link flattenText} does.
     * @param value - raw prose.
     * @returns Single-spaced, trimmed text.
     */
    function normalizeForSearch (value) {
      return String(value).replace(/\s+/g, ' ').trim()
    }

    /**
     * Read a subtree as word tokens with their exact DOM positions.
     * @param roots - subtrees to read, in reading order.
     * @returns Tokens in reading order, each with its word and node span.
     */
    function tokenize (roots) {
      const containers = Array.isArray(roots) ? roots : [roots]
      const tokens = []
      for (const root of containers) {
        if (root === null || root === undefined || typeof root !== 'object') continue
        const walker = document.createTreeWalker(root, window.NodeFilter?.SHOW_TEXT ?? 4, null)
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          const parent = node.parentElement
          if (parent === null) continue
          if (SKIP_TAGS.has(parent.tagName)) continue
          if (parent.closest('pre') !== null) continue
          if (parent.closest('.dsh-tts-panel') !== null) continue
          if (parent.closest('[data-dsh-tts-ignore]') !== null) continue
          const value = node.nodeValue ?? ''
          for (const match of value.matchAll(/[\p{L}\p{N}]+/gu)) {
            tokens.push({
              word: match[0].toLowerCase(),
              node,
              start: match.index,
              end: match.index + match[0].length,
            })
          }
        }
      }
      return tokens
    }

    /**
     * Find one sentence by its words, ignoring punctuation, markup and spacing.
     * The run is matched with a bounded gap: the transcript renders words the
     * engine never says (bare URLs, image alt text, a table's chrome), so a
     * contiguous subsequence would fail on exactly the sentences that contain
     * them.
     * @param roots - subtrees to search.
     * @param sentence - prose the engine is about to say.
     * @param preferLast - pick the newest match.
     * @returns A DOM range covering the words, or null.
     */
    function findWordRange (roots, sentence, preferLast) {
      const wanted = String(sentence).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
      if (wanted.length === 0) return null
      const tokens = tokenize(roots)
      if (tokens.length < wanted.length) return null
      /* Walk every place the first word appears and match the rest with a bounded
         gap, then keep the tightest span: the closest transcription of the
         sentence is the one that covers the fewest words it does not share. */
      const found = []
      let shortest = Number.POSITIVE_INFINITY
      for (let start = 0; start < tokens.length; start++) {
        if (tokens[start].word !== wanted[0]) continue
        let wantedAt = 1
        let tokenAt = start + 1
        let gap = 0
        let last = start
        while (wantedAt < wanted.length && tokenAt < tokens.length) {
          if (tokens[tokenAt].word === wanted[wantedAt]) {
            last = tokenAt
            wantedAt += 1
            tokenAt += 1
            gap = 0
            continue
          }
          gap += 1
          tokenAt += 1
          if (gap > 24) break
        }
        if (wantedAt !== wanted.length) continue
        const span = last - start
        if (span < shortest) {
          shortest = span
          found.length = 0
        }
        found.push({ first: start, last, span })
      }
      if (found.length === 0) return null
      const chosen = preferLast ? found[found.length - 1] : found[0]
      const first = tokens[chosen.first]
      const last = tokens[chosen.last]
      /* Keep the sentence's own punctuation inside the paint. */
      const tail = last.node.nodeValue ?? ''
      let end = last.end
      while (end < tail.length && /[.,;:!?…"'”’»)\]]/.test(tail[end])) end++
      const range = document.createRange()
      range.setStart(first.node, first.start)
      range.setEnd(last.node, end)
      return range
    }

    /**
     * Match by anchors: the first and last few words of the chunk, with anything
     * in between. Cleaning rewrites what the engine says (`12.5` becomes
     * `12 point 5`, `×` becomes `times`), so the middle of a sentence can diverge
     * from the DOM while its edges still line up.
     * @param roots - subtrees to search.
     * @param sentence - prose the engine is about to say.
     * @param preferLast - pick the newest match.
     * @returns A DOM range covering the anchors, or null.
     */
    function findAnchorRange (roots, sentence, preferLast) {
      const wanted = String(sentence).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
      if (wanted.length < 6) return null
      const tokens = tokenize(roots)
      if (tokens.length < 6) return null
      const head = wanted.slice(0, 3)
      const tail = wanted.slice(-3)
      const sequences = (sequence) => {
        const found = []
        for (let index = 0; index + sequence.length <= tokens.length; index++) {
          let matched = 0
          while (matched < sequence.length && tokens[index + matched].word === sequence[matched]) matched++
          if (matched === sequence.length) found.push(index)
        }
        return found
      }
      const heads = sequences(head)
      const tails = sequences(tail)
      if (heads.length === 0 || tails.length === 0) return null
      const limit = wanted.length * 2 + 24
      let best = null
      for (const from of heads) {
        for (const to of tails) {
          if (to < from + head.length) continue
          const span = to + tail.length - from
          if (span > limit) continue
          if (best === null || span < best.span) best = { from, to, span }
        }
      }
      if (best === null) return null
      const first = tokens[best.from]
      const last = tokens[best.to + tail.length - 1]
      const text = last.node.nodeValue ?? ''
      let end = last.end
      while (end < text.length && /[.,;:!?…"'”’»)\]]/.test(text[end])) end++
      const range = document.createRange()
      range.setStart(first.node, first.start)
      range.setEnd(last.node, end)
      return preferLast ? range : range
    }

    /**
     * Locate one spoken sentence in the rendered transcript.
     * @param roots - subtrees to search, in reading order.
     * @param sentence - prose the engine is about to say.
     * @param preferLast - pick the newest match instead of the first.
     * @returns A DOM range covering the sentence, or null when it is not rendered.
     */
    function findTextRange (roots, sentence, preferLast = false) {
      const needle = normalizeForSearch(sentence)
      if (needle === '') return null
      const { text, map } = flattenText(roots)
      let length = needle.length
      let at = preferLast ? text.lastIndexOf(needle) : text.indexOf(needle)
      if (at < 0) {
        /* Markdown cleanup can drop trailing punctuation the DOM still renders. */
        const shorter = needle.replace(/[\s.!?…,;:]+$/, '')
        if (shorter.length >= 12) {
          at = preferLast ? text.lastIndexOf(shorter) : text.indexOf(shorter)
          length = shorter.length
        }
      }
      if (at < 0) return findWordRange(roots, sentence, preferLast)
      const start = map[at]
      const end = map[at + length - 1]
      if (start === undefined || end === undefined) return findWordRange(roots, sentence, preferLast)
      const range = document.createRange()
      range.setStart(start.node, start.offset)
      range.setEnd(end.node, end.offset + 1)
      return range
    }

    /**
     * The DOM rows of the turn that owns one action button, so a highlight lands
     * in the message that is actually being read.
     * @param element - clicked action element.
     * @returns The turn's rows in reading order, or null when the shape is unknown.
     */
    function renderingScope (element) {
      if (element === null || element === undefined || typeof element.closest !== 'function') return null
      const row = element.closest('[data-chat-turn]')
      const container = row?.parentElement ?? null
      if (row === null || container === null) return null
      const turn = row.getAttribute('data-chat-turn')
      const rows = [...container.children].filter((child) => child.getAttribute('data-chat-turn') === turn)
      return rows.length === 0 ? null : rows
    }

    /**
     * Describe why a chunk could not be placed: how big the search space was and
     * whether its first words appear there at all.
     * @param roots - subtrees that were searched.
     * @param sentence - the chunk that failed.
     * @returns Counts a reader can act on.
     */
    function diagnose (roots, sentence) {
      const tokens = tokenize(roots)
      const wanted = String(sentence).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
      const head = wanted.slice(0, 3)
      const headFound = tokens.some((_, index) => head.every((word, offset) => tokens[index + offset]?.word === word))
      const tail = wanted.slice(-3)
      const tailFound = tokens.some((_, index) => tail.every((word, offset) => tokens[index + offset]?.word === word))
      return {
        domTokens: tokens.length,
        wantedTokens: wanted.length,
        headFound,
        tailFound,
        domStart: tokens.slice(0, 10).map((token) => token.word).join(' '),
      }
    }

    /**
     * Paint the sentence being read, and keep it in view.
     * Uses the CSS Custom Highlight API when the browser has it, so the
     * transcript's DOM is never mutated underneath React.
     * @returns Highlighter with `show`, `clear`, and `dispose`.
     */
    function createHighlighter (report) {
      let painted = null

      /** Remove whatever is painted. */
      function clear () {
        if (painted === null) return
        if (painted.kind === 'highlight') {
          window.CSS?.highlights?.delete(HIGHLIGHT_NAME)
        } else {
          painted.element.removeAttribute('data-dsh-tts-reading')
        }
        painted = null
      }

      /**
       * Bring the sentence into view when reading has scrolled it off screen.
       * @param range - painted range.
       */
      function keepVisible (range) {
        if (typeof range.getBoundingClientRect !== 'function') return
        const rect = range.getBoundingClientRect()
        if (rect.height === 0 && rect.width === 0) return
        if (rect.top >= 56 && rect.bottom <= window.innerHeight - 8) return
        const element = range.startContainer.parentElement
        if (element !== null) element.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }

      /**
       * Highlight one sentence.
       * @param sentence - prose chunk now being spoken.
       * @param scope - rows of the message being read, when the click knew them.
       */
      function show (sentence, scope) {
        clear()
        if (typeof document === 'undefined') return
        const known = Array.isArray(scope)
          ? scope.filter((root) => root !== null && root !== undefined && document.contains(root))
          : scope !== null && scope !== undefined && document.contains(scope) ? [scope] : []
        const roots = known.length > 0 ? known : [document.body]
        let range = findTextRange(roots, sentence, known.length === 0)
        let reason = null
        if (range === null) {
          range = findAnchorRange(roots, sentence, known.length === 0)
          reason = range === null ? 'no-anchors' : null
        }
        if (range === null) {
          report?.({
            reason: reason ?? 'no-range',
            sentence,
            scopeRows: known.length,
            roots: known.length > 0 ? 'turn' : 'document',
            ...diagnose(roots, sentence),
          })
          /* The message is known but the sentence is not where we looked (an
             unmounted row, or a chunk the DOM splits oddly): mark the message
             itself so the reader still sees where the voice is. */
          const fallback = known.at(-1)
          if (fallback !== undefined && fallback !== null) {
            fallback.setAttribute('data-dsh-tts-reading', '')
            painted = { kind: 'attribute', element: fallback }
          }
          return
        }
        const registry = window.CSS?.highlights
        if (typeof window.Highlight === 'function' && registry !== undefined && registry !== null) {
          registry.set(HIGHLIGHT_NAME, new window.Highlight(range))
          painted = { kind: 'highlight' }
        } else {
          /* Fallback: mark the nearest block. React re-renders that element only
             when the message behind it changes. */
          const element = range.startContainer.parentElement
          if (element === null) return
          element.setAttribute('data-dsh-tts-reading', '')
          painted = { kind: 'attribute', element }
        }
        keepVisible(range)
      }

      return { show, clear, dispose: clear }
    }

    /**
     * Halve one chunk at a word boundary near its middle.
     * @param chunk - the chunk to split, with its voice.
     * @returns Two chunks, in reading order.
     */
    function splitChunk (chunk) {
      const text = chunk.text
      const middle = Math.floor(text.length / 2)
      let at = text.lastIndexOf(' ', middle)
      if (at < text.length * 0.25) at = text.indexOf(' ', middle)
      if (at <= 0 || at >= text.length - 1) at = middle
      return [
        { ...chunk, text: text.slice(0, at).trim() },
        { ...chunk, text: text.slice(at).trim() },
      ]
    }

    /* ------------------------------------------------------------------ engine */

    /**
     * One page-wide speech engine: it owns the audio element, the request
     * pipeline, and a timeline of the reply so playback can be scrubbed, skipped
     * chapter by chapter, and replayed from any sentence.
     * @param settings - preference store (voice, rate, highlight).
     * @param info - Host configuration store (defaults, servers).
     * @param highlighter - paints the sentence being spoken.
     * @returns Engine with `speak`, `pause`, `resume`, `seek`, `skip`, `replay`, `stop`, `fail`.
     */
    function createEngine (settings, info, highlighter, report) {
      const IDLE = { status: 'idle', messageId: null, chunk: 0, total: 0, sentence: null, voice: null, error: null, autoplay: false, position: 0, duration: 0 }
      const state = createStore({ ...IDLE })
      let generation = 0
      let audio = null
      let cancelPlay = null
      const controllers = new Set()
      const urls = new Set()
      /** Current reply: its chunks and the timing learned for each of them. */
      let run = null

      /** Seconds the engine is expected to take for one chunk before it is measured. */
      function estimate (text, speed) {
        return Math.max(0.6, text.length / (18 * speed))
      }

      /** Absolute start of every chunk, from the durations known so far. */
      function starts () {
        if (run === null) return []
        if (run.starts !== undefined) return run.starts
        const offsets = []
        let at = 0
        for (const seconds of run.durations) {
          offsets.push(at)
          at += seconds
        }
        run.starts = offsets
        return offsets
      }

      /** Total length of the reply in seconds. */
      function total () {
        return (run?.durations ?? []).reduce((sum, seconds) => sum + seconds, 0)
      }

      /** Republish the timeline after a chunk's real duration becomes known. */
      function publishDuration () {
        /* A measured duration invalidates the derived offsets. */
        if (run !== null) run.starts = undefined
        const snapshot = state.getSnapshot()
        state.set({ ...snapshot, duration: total() })
      }

      /** Absolute playhead in seconds. */
      function position () {
        const snapshot = state.getSnapshot()
        if (run === null) return 0
        if (audio !== null && Number.isFinite(audio.currentTime)) {
          return (starts()[snapshot.chunk] ?? 0) + audio.currentTime
        }
        return snapshot.position
      }

      /** Stop sound, requests and paint, keeping the loaded reply. */
      function stopPlayback () {
        generation += 1
        const element = audio
        const cancel = cancelPlay
        audio = null
        cancelPlay = null
        if (cancel !== null) cancel(STOP)
        if (element !== null) {
          element.onended = null
          element.onerror = null
          try { element.pause() } catch { /* detached element */ }
          try {
            element.removeAttribute('src')
            element.load()
          } catch { /* ignore */ }
        }
        for (const controller of controllers) {
          try { controller.abort() } catch { /* already settled */ }
        }
        controllers.clear()
        for (const url of urls) URL.revokeObjectURL(url)
        urls.clear()
        if (highlighter !== undefined && highlighter !== null) highlighter.clear()
      }

      /** Stop everything and forget the reply. */
      function stop () {
        stopPlayback()
        run = null
        state.set({ ...IDLE })
      }

      /**
       * A model that can actually speak on the selected server, when the chosen
       * one cannot: a provider that lists voices names its speech models, and
       * otherwise the model id has to look like one.
       * @returns The alternative model, or null when the selection already speaks.
       */
      function fallbackModel () {
        const selection = selectionOf(settings.getSnapshot(), info.getSnapshot().value)
        if (selection.server === null || selection.model === null) return null
        if ((selection.model.voices?.length ?? 0) > 0) return null
        const voiceful = selection.server.models.find((row) => (row.voices?.length ?? 0) > 0)
        if (voiceful !== undefined) return voiceful
        return selection.server.models.find((row) => /(audio|omni|tts|speech|kokoro|whisper)/i.test(row.id)) ?? null
      }

      /** Publish one failure without pretending audio is still playing. */
      function fail (code, message = null) {
        stop()
        if (code !== 'empty') {
          const detail = { code, message: message === null ? null : String(message).slice(0, 240) }
          if (code === 'blocked') report?.('warn', 'autoplay-blocked', detail)
          else if (code === 'server') report?.('error', 'speech-server-error', detail)
          else if (code === 'network') report?.('error', 'speak-network-error', { ...detail, online: navigator.onLine })
          else report?.('error', 'playback-failed', detail)
        }
        /* Keep the error on screen: the player renders it instead of vanishing. */
        state.set({ ...IDLE, status: 'failed', error: { code, message } })
      }

      /** Clear a reported failure. */
      function dismiss () {
        state.set({ ...IDLE })
      }

      /**
       * Apply a speaking rate to whatever is playing right now.
       * @param rate - playback rate, 1 = the engine's own speed.
       */
      function setRate (rate) {
        if (audio === null) return
        try {
          audio.playbackRate = Math.min(4, Math.max(0.25, Number(rate) || 1))
        } catch { /* element already released */ }
      }

      /** POST one chunk and return an object URL for its audio. */
      function requestChunk (chunk) {
        const controller = new AbortController()
        controllers.add(controller)
        const selection = selectionOf(settings.getSnapshot(), info.getSnapshot().value)
        const body = { text: chunk.text }
        if (selection.server !== null) body.server = selection.server.id
        if (selection.model !== null) body.model = selection.model.id
        /* A cast chunk names its own voice; otherwise the selected voice speaks. */
        const voice = chunk.voice ?? selection.voice?.id ?? null
        if (voice !== null) body.voice = voice
        return fetch(ROUTES.speak, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        }).catch((error) => {
          /* A stopped run aborts its own requests; anything else never reached
             the Host, which is a different failure from the engine refusing. */
          if (controller.signal.aborted) throw STOP
          const wrapped = new Error(String(error?.message ?? error))
          wrapped.code = 'network'
          throw wrapped
        }).then(async (response) => {
          if (!response.ok) {
            let message = `speech request failed (${response.status})`
            try {
              const payload = await response.json()
              if (typeof payload?.error?.message === 'string') message = payload.error.message
            } catch { /* non-JSON failure body */ }
            const error = new Error(message)
            /* Kokoro refuses phoneme strings over 510 symbols: the chunk is too
               dense, not too long, so splitting it is the answer. */
            error.code = /exceeds \d+ symbols|phoneme string/i.test(message) ? 'too-long' : 'server'
            throw error
          }
          const blob = await response.blob()
          if (blob.size === 0) {
            const error = new Error('the speech server returned no audio')
            error.code = 'server'
            throw error
          }
          const url = URL.createObjectURL(blob)
          urls.add(url)
          return url
        }).finally(() => { controllers.delete(controller) })
      }

      /**
       * Play one object URL, optionally from an offset inside it.
       * @param url - object URL of the chunk's audio.
       * @param offset - seconds to skip into the chunk.
       * @param index - chunk index, used for duration learning and the playhead.
       * @returns Resolves at the end of the chunk; rejects on error or stop.
       */
      function play (url, offset, index) {
        return new Promise((resolve, reject) => {
          const element = new Audio(url)
          /* Rate is a playback property: changing it never re-synthesizes and
             never restarts the sentence. */
          const rate = selectionOf(settings.getSnapshot(), info.getSnapshot().value).speed
          try {
            element.preservesPitch = true
            element.playbackRate = rate
          } catch { /* older element */ }
          audio = element
          let settled = false
          const finish = (settle, value) => {
            if (settled) return
            settled = true
            cancelPlay = null
            element.onended = null
            element.onerror = null
            if (audio === element) audio = null
                settle(value)
          }
          element.onloadedmetadata = () => {
            if (run !== null && index < run.durations.length && Number.isFinite(element.duration) && element.duration > 0) {
              run.durations[index] = element.duration
              publishDuration()
            }
            if (offset > 0) {
              try { element.currentTime = Math.min(offset, Math.max(0, (element.duration || offset) - 0.05)) } catch { /* ignore */ }
            }
          }
          element.ontimeupdate = () => {
            if (run === null || audio !== element) return
            const snapshot = state.getSnapshot()
            const at = (starts()[index] ?? 0) + element.currentTime
            if (Math.abs(at - snapshot.position) < 0.15) return
            state.set({ ...snapshot, position: at })
          }
          element.onended = () => finish(resolve)
          element.onerror = () => {
            const error = new Error('audio playback failed')
            error.code = 'playback'
            finish(reject, error)
          }
          cancelPlay = () => finish(reject, STOP)
          element.play().then(() => {}, (error) => finish(reject, error))
        })
      }

      /**
       * Read the reply from one chunk onward.
       * @param startIndex - first chunk to speak.
       * @param startOffset - seconds to skip into that chunk.
       * @returns Completion once the reply is read through or abandoned.
       */
      async function loop (startIndex, startOffset) {
        if (run === null) return
        const current = generation
        const reply = run
        state.set({ ...state.getSnapshot(), status: 'loading', chunk: startIndex, sentence: reply.chunks[startIndex]?.text ?? null, voice: reply.chunks[startIndex]?.voiceLabel ?? null, duration: total() })
        let ahead = null
        const retried = new Set()
        try {
          let index = startIndex
          while (index < reply.chunks.length) {
            const pending = ahead === null ? requestChunk(reply.chunks[index]) : ahead
            ahead = index + 1 < reply.chunks.length ? requestChunk(reply.chunks[index + 1]) : null
            if (ahead !== null) ahead.catch(() => {})
            let url
            try {
              url = await pending
            } catch (error) {
              /* Too dense for the engine: split in place and retry the same spot,
                 so the rest of the reply keeps its timing and its place. */
              const chunk = reply.chunks[index]
              if (error?.code === 'network' && !retried.has(index)) {
                /* The connection dropped before the Host answered: ask again. */
                retried.add(index)
                ahead = null
                report?.('warn', 'chunk-retry', { code: error.code, chars: chunk?.text.length ?? 0, online: navigator.onLine })
                continue
              }
              if (error?.code === 'too-long' && chunk !== undefined && chunk.text.length > 24) {
                const halves = splitChunk(chunk)
                reply.chunks.splice(index, 1, ...halves)
                reply.durations.splice(index, 1, ...halves.map((half) => estimate(half.text, reply.rate)))
                reply.starts = undefined
                ahead = null
                report?.('warn', 'chunk-split', { chars: chunk.text.length, into: halves.map((half) => half.text.length) })
                state.set({ ...state.getSnapshot(), total: reply.chunks.length, duration: total() })
                continue
              }
              throw error
            }
            if (current !== generation) return
            const offset = index === startIndex ? startOffset : 0
            const chunk = reply.chunks[index]
            state.set({ ...state.getSnapshot(), status: 'playing', chunk: index, sentence: chunk.text, voice: chunk.voiceLabel ?? null })
            if (settings.getSnapshot().highlight !== false && highlighter !== undefined && highlighter !== null) {
              highlighter.show(chunk.text, reply.scope)
            }
            await play(url, offset, index)
            if (current !== generation) return
            index += 1
          }
          if (current !== generation) return
          if (highlighter !== undefined && highlighter !== null) highlighter.clear()
          run = null
          state.set({ ...IDLE })
        } catch (error) {
          if (current !== generation || error === STOP) return
          if (error?.name === 'NotAllowedError') {
            fail('blocked')
          } else if (error?.code === 'server' && reply.allowFallback) {
            /* The chosen model refused: try one that can speak, once, then keep
               that choice so the next Listen does not pay for the failure. */
            const alternative = fallbackModel()
            if (alternative === null) {
              fail('server', String(error.message))
              return
            }
            report?.('warn', 'selection-fallback', { from: run?.model ?? null, to: alternative.id })
            settings.save({ model: alternative.id, voice: null })
            await speak(reply.messageId, reply.input, {
              scope: reply.scope,
              autoplay: reply.autoplay,
              allowFallback: false,
            })
          } else if (error?.code === 'server') {
            fail('server', String(error.message))
          } else if (error?.code === 'network') {
            fail('network', String(error.message))
          } else {
            fail('playback', String(error?.message ?? error))
          }
        } finally {
          /* Only this run's own URLs: a newer run (or stop) owns the set after a generation change. */
          if (current === generation) {
            for (const url of urls) URL.revokeObjectURL(url)
            urls.clear()
          }
        }
      }

      /**
       * Restart playback at one chunk and offset.
       * @param index - chunk to start at.
       * @param offset - seconds into that chunk.
       */
      function seekTo (index, offset) {
        if (run === null) return
        const bounded = Math.min(Math.max(0, index), run.chunks.length - 1)
        stopPlayback()
        state.set({ ...state.getSnapshot(), position: (starts()[bounded] ?? 0) + Math.max(0, offset) })
        void loop(bounded, Math.max(0, offset))
      }

      /**
       * Say one reply from the beginning, replacing whatever was playing.
       * @param messageId - durable message identity the controls key off.
       * @param text - prose to read.
       * @param options - `autoplay` marks unsolicited speech; `scope` bounds the highlight.
       * @returns Completion once the reply is read through or abandoned.
       */
      async function speak (messageId, input, options) {
        stop()
        const plan = typeof input === 'string'
          ? splitChunks(input).map((text) => ({ text, voice: null, voiceLabel: null }))
          : input.map((chunk) => ({ text: chunk.text, voice: chunk.voice ?? null, voiceLabel: chunk.voiceLabel ?? null }))
        if (plan.length === 0) {
          fail('empty')
          return
        }
        const rate = (() => {
          const selection = selectionOf(settings.getSnapshot(), info.getSnapshot().value)
          return selection.speed || 1
        })()
        run = {
          messageId,
          input,
          chunks: plan,
          rate,
          scope: options?.scope ?? null,
          allowFallback: options?.allowFallback !== false,
          autoplay: options?.autoplay === true,
          starts: undefined,
          durations: plan.map((chunk) => estimate(chunk.text, rate)),
        }
        state.set({
          ...IDLE,
          status: 'loading',
          messageId,
          chunk: 0,
          total: plan.length,
          sentence: plan[0].text,
          voice: plan[0].voiceLabel ?? null,
          autoplay: options?.autoplay === true,
          duration: total(),
        })
        await loop(0, 0)
      }

      /** Pause at the playhead, keeping the reply loaded. */
      function pause () {
        const snapshot = state.getSnapshot()
        if (run === null || (snapshot.status !== 'playing' && snapshot.status !== 'loading')) return
        const at = position()
        stopPlayback()
        state.set({ ...state.getSnapshot(), status: 'paused', position: at })
      }

      /** Resume from the paused playhead. */
      function resume () {
        const snapshot = state.getSnapshot()
        if (run === null || snapshot.status !== 'paused') return
        const offsets = starts()
        const index = Math.min(snapshot.chunk, run.chunks.length - 1)
        seekTo(index, Math.max(0, snapshot.position - (offsets[index] ?? 0)))
      }

      /**
       * Jump to an absolute position in the reply.
       * @param seconds - target playhead.
       */
      function seek (seconds) {
        if (run === null) return
        const target = Math.min(Math.max(0, Number(seconds) || 0), Math.max(0, total() - 0.05))
        const offsets = starts()
        let index = 0
        for (let at = 0; at < offsets.length; at++) if (offsets[at] <= target) index = at
        seekTo(index, target - (offsets[index] ?? 0))
      }

      /**
       * Move by whole chapters.
       * @param delta - chapters to move; negative goes back.
       */
      function skip (delta) {
        if (run === null) return
        const snapshot = state.getSnapshot()
        seekTo(snapshot.chunk + delta, 0)
      }

      /** Replay the chapter being read, from its start. */
      function replay () {
        if (run === null) return
        seekTo(state.getSnapshot().chunk, 0)
      }

      return { state, speak, pause, resume, seek, skip, replay, stop, fail, dismiss, setRate, dispose: stop }
    }

    /* ----------------------------------------------------------------- watcher */

    /**
     * Follow each open Session's event window and read newly completed turns.
     * @param ctx - client context carrying `sessions`.
     * @param engine - speech engine.
     * @param settings - preference store read at every turn end.
     * @returns Watcher with `bind(sessionId)` and `dispose()`.
     */
    function createWatcher (ctx, engine, settings, planFor) {
      const bound = new Map()

      /** Highest durable sequence currently in the window. */
      function highestSeq (binding) {
        let highest = 0
        for (const entry of binding.eventSource.getSnapshot().entries) {
          const event = eventOf(entry)
          if (typeof event?.seq === 'number' && event.seq > highest) highest = event.seq
        }
        return highest
      }

      /**
       * Start watching one Session once, waiting briefly for its binding.
       * @param sessionId - Session to read aloud.
       */
      function bind (sessionId) {
        if (typeof sessionId !== 'string' || bound.has(sessionId)) return
        const slot = { cancelled: false, unsubscribe: null }
        bound.set(sessionId, slot)
        let attempts = 0
        const attach = () => {
          if (slot.cancelled) return
          let binding
          try {
            binding = ctx.sessions.binding(sessionId)
          } catch {
            binding = undefined
          }
          if (binding === undefined || binding === null) {
            if (attempts++ < 40) window.setTimeout(attach, 250)
            return
          }
          let highest = highestSeq(binding)
          slot.unsubscribe = binding.eventSource.subscribe(() => {
            const snapshot = binding.eventSource.getSnapshot()
            if (snapshot.change !== null && snapshot.change !== undefined && snapshot.change.kind === 'replace') {
              highest = highestSeq(binding)
              return
            }
            const fresh = []
            for (const entry of snapshot.entries) {
              const event = eventOf(entry)
              if (typeof event?.seq === 'number' && event.seq > highest) fresh.push(event)
            }
            if (fresh.length === 0) return
            for (const event of fresh) if (event.seq > highest) highest = event.seq
            if (!settings.getSnapshot().autoplay) return
            for (const event of fresh) {
              if (event.type !== 'turn/end') continue
              if (event.data?.reason?.kind !== 'completed') continue
              const found = findTurnAnswer(ctx, sessionId, event.data.turn)
              if (found === null) continue
              const plan = planFor(sessionId, found.id)
              if (plan === null) continue
              engine.speak(found.id, plan, { autoplay: true })
            }
          })
        }
        attach()
      }

      /** Stop watching every Session. */
      function dispose () {
        for (const slot of bound.values()) {
          slot.cancelled = true
          if (slot.unsubscribe !== null) slot.unsubscribe()
        }
        bound.clear()
      }

      return { bind, dispose }
    }

    /* -------------------------------------------------------------- components */

    /** Subscriber hook over one injected observable. */
    function useValue (useSnapshot) {
      return useSnapshot((value) => value)
    }

    /**
     * Per-message Listen control in the finalized assistant action row.
     * @param props - composed slot props.
     * @returns The play/stop button.
     */
    function ListenAction ({ messageId, sessionId, read, stop, useTtsState, t }) {
      /* Two scalars, not the whole engine state: a message button must not
         re-render on every playhead tick of an unrelated reply. */
      const status = useTtsState((value) => value.status)
      const playingId = useTtsState((value) => value.messageId)
      const active = playingId === messageId && (status === 'playing' || status === 'loading' || status === 'paused')
      const label = active ? t('action.stop') : t('action.listen')
      const Icon = active ? primitives.IconStopFillRegular : primitives.IconPlayOutlineRegular
      return h('button', {
        type: 'button',
        className: 'dsh-tts-action',
        'aria-label': label,
        title: label,
        'data-active': active ? '' : undefined,
        onClick: (event) => {
          if (active) stop()
          else read(sessionId, messageId, event.currentTarget)
        },
      }, h(Icon, {}))
    }

    /**
     * A voice's tags as one line, for a tooltip.
     * @param voice - tagged voice row.
     * @returns Text such as `female · en-us`, or null.
     */
    function voiceTags (voice) {
      const parts = [voice?.gender, voice?.language, voice?.category].filter((part) => typeof part === 'string' && part !== '')
      return parts.length > 0 ? parts.join(' · ') : null
    }

    /** Format seconds as `m:ss`. */
    function clockOf (seconds) {
      const whole = Math.max(0, Math.round(Number(seconds) || 0))
      return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
    }

    /**
     * The player under the composer: chapter stepping, play/pause, a seek bar over
     * the whole reply, and the sentence now being read.
     * @param props - composed slot props.
     * @returns The player, or null when nothing is loaded.
     */
    function ReadingCaption ({ useTtsState, useTtsSettings, useTtsInfo, t, pause, resume, seek, skip, replay, dismiss, stop, changeRate }) {
      const state = useValue(useTtsState)
      const settings = useValue(useTtsSettings)
      const info = useValue(useTtsInfo)
      const [drag, setDrag] = React.useState(null)
      const active = state.status === 'playing' || state.status === 'loading' || state.status === 'paused'
      const failed = state.status === 'failed' && state.error !== null
      React.useEffect(() => { setDrag(null) }, [state.status])

      /* A failure clears itself after a while, so it cannot sit there forever. */
      React.useEffect(() => {
        if (!failed) return undefined
        const timer = window.setTimeout(() => dismiss(), 12000)
        return () => window.clearTimeout(timer)
      }, [failed, state.error?.message, dismiss])

      if (settings.highlight === false) return null
      if (failed) {
        return h('div', {
          className: 'dsh-tts-player dsh-tts-failed',
          'data-dsh-tts-ignore': '',
          role: 'status',
          'aria-live': 'polite',
        }, [
          h('span', { key: 'label', className: 'dsh-tts-failed-label' }, t('status.failed')),
          h('span', { key: 'text', className: 'dsh-tts-failed-text', title: state.error.message ?? '' },
            state.error.message === null || state.error.message === undefined
              ? t(`status.hint.${state.error.code ?? 'default'}`)
              : String(state.error.message)),
          h('button', {
            key: 'close',
            type: 'button',
            className: 'dsh-tts-close',
            'aria-label': t('player.dismiss'),
            title: t('player.dismiss'),
            onClick: () => dismiss(),
          }, h(primitives.IconCloseOutlineRegular, {})),
        ])
      }
      if (!active) return null

      const playing = state.status === 'playing' || state.status === 'loading'
      const duration = Math.max(0.1, state.duration)
      const value = drag ?? Math.min(state.position, duration)
      const button = (key, Icon, label, onClick) => h('button', {
        key,
        type: 'button',
        className: 'dsh-tts-pbtn',
        'aria-label': label,
        title: label,
        onClick,
      }, h(Icon, {}))
      const commit = () => {
        if (drag === null) return
        const target = drag
        setDrag(null)
        seek(target)
      }

      const selection = selectionOf(settings, info.value)
      const rates = selection.speeds
      const rate = selection.speed

      return h('div', {
        className: 'dsh-tts-player',
        'data-dsh-tts-ignore': '',
        title: state.sentence ?? t('caption.loading'),
      }, [
        h('div', { key: 'row', className: 'dsh-tts-player-row' }, [
          button('prev', primitives.IconChevronLeftOutlineRegular, t('player.prev'), () => skip(-1)),
          button('toggle', playing ? primitives.IconPauseOutlineRegular : primitives.IconPlayOutlineRegular,
            playing ? t('player.pause') : t('player.resume'), () => { if (playing) pause(); else resume() }),
          button('next', primitives.IconChevronRightOutlineRegular, t('player.next'), () => skip(1)),
          h('input', {
            key: 'seek',
            className: 'dsh-tts-seek',
            type: 'range',
            min: 0,
            max: duration,
            step: 0.1,
            value,
            'aria-label': t('player.seek'),
            onInput: (event) => setDrag(Number(event.target.value)),
            onPointerUp: commit,
            onKeyUp: commit,
            onBlur: commit,
          }),
          state.voice !== null && state.voice !== undefined
            ? h('span', { key: 'voice', className: 'dsh-tts-voice', title: t('castVoice') }, state.voice)
            : null,
          h('select', {
            key: 'rate',
            className: 'dsh-tts-rate',
            title: t('player.speed'),
            'aria-label': t('player.speed'),
            value: String(rate),
            onChange: (event) => changeRate(Number(event.target.value)),
          }, rates.map((value) => h('option', { key: value, value: String(value) }, `${value}×`))),
          h('button', {
            key: 'time',
            type: 'button',
            className: 'dsh-tts-time',
            title: t('player.replay'),
            onClick: () => replay(),
          }, `${clockOf(value)} / ${clockOf(state.duration)}`),
          h('button', {
            key: 'close',
            type: 'button',
            className: 'dsh-tts-close',
            'aria-label': t('player.close'),
            title: t('player.close'),
            onClick: () => stop(),
          }, h(primitives.IconCloseOutlineRegular, {})),
        ]),
      ])
    }

    /**
     * Composer control: the Listen trigger and its settings panel.
     * @param props - composed slot props.
     * @returns The trigger plus, while open, the portalled panel.
     */
    function ReadControl (props) {
      const { t, readLast, watch, updateSettings, refresh, useTtsState, useTtsSettings, useTtsInfo } = props
      const sessionId = props.sessionId
      const state = useValue(useTtsState)
      const settings = useValue(useTtsSettings)
      const info = useValue(useTtsInfo)
      const [open, setOpen] = React.useState(false)
      const [position, setPosition] = React.useState(null)
      const triggerRef = React.useRef(null)
      const panelRef = React.useRef(null)
      const panelId = React.useId()
      /* Injected callbacks are recreated per composition; effects must not depend on their identity. */
      const watchRef = React.useRef(watch)
      const refreshRef = React.useRef(refresh)
      watchRef.current = watch
      refreshRef.current = refresh

      React.useEffect(() => {
        if (typeof sessionId === 'string') watchRef.current(sessionId)
      }, [sessionId])

      React.useLayoutEffect(() => {
        if (!open) {
          setPosition(null)
          return undefined
        }
        const place = () => {
          const anchor = triggerRef.current
          if (anchor === null) return
          const rect = anchor.getBoundingClientRect()
          const width = 304
          const margin = 12
          const left = Math.min(Math.max(margin, rect.left), Math.max(margin, window.innerWidth - width - margin))
          setPosition({ left, bottom: Math.max(margin, window.innerHeight - rect.top + 8) })
        }
        place()
        window.addEventListener('resize', place)
        window.addEventListener('scroll', place, true)
        return () => {
          window.removeEventListener('resize', place)
          window.removeEventListener('scroll', place, true)
        }
      }, [open])

      React.useEffect(() => {
        if (!open) return undefined
        refreshRef.current()
        const onPointerDown = (event) => {
          if (panelRef.current !== null && panelRef.current.contains(event.target)) return
          if (triggerRef.current !== null && triggerRef.current.contains(event.target)) return
          setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open])

      const selection = selectionOf(settings, info.value)
      const { servers, models, voices } = selection

      const status = (() => {
        if (state.error !== null) {
          if (state.error.code === 'blocked') return { tone: 'warn', text: t('status.blocked') }
          if (state.error.code === 'empty') return { tone: 'warn', text: t('status.empty') }
          if (state.error.code === 'server') return { tone: 'warn', text: state.error.message }
          return { tone: 'warn', text: t('status.empty') }
        }
        if (state.status === 'playing' || state.status === 'loading') {
          return { tone: null, text: t('status.playing', { index: Math.max(1, state.chunk + 1), total: state.total }) }
        }
        if (info.status === 'loading') return { tone: null, text: t('status.loading') }
        if (info.status === 'error') return { tone: 'warn', text: t('status.offline') }
        if (servers.length === 0) return { tone: 'warn', text: t('status.none') }
        return { tone: null, text: t('status.ready') }
      })()

      const chip = (label, active, onClick, key, tags) => h('button', {
        key,
        type: 'button',
        className: 'dsh-tts-chip',
        title: tags === null || tags === undefined ? label : `${label} — ${tags}`,
        'aria-pressed': active,
        'data-active': active ? '' : undefined,
        onClick,
      }, label)

      const panel = open && position !== null
        ? createPortal(h('div', {
          ref: panelRef,
          id: panelId,
          className: 'dsh-tts-panel',
          style: position,
          role: 'dialog',
          'aria-label': t('panel.aria'),
        }, [
          h('div', { key: 'title', className: 'dsh-tts-title' }, t('panel.title')),
          h('div', { key: 'autoplay', className: 'dsh-tts-row' }, [
            h('span', { key: 'label', className: 'dsh-tts-label' }, t('autoplay')),
            h(primitives.Switch, {
              key: 'switch',
              checked: settings.autoplay,
              label: t('autoplay'),
              onChange: (value) => updateSettings({ autoplay: value }),
            }),
          ]),
          h('div', { key: 'cast', className: 'dsh-tts-row' }, [
            h('span', { key: 'label', className: 'dsh-tts-label', title: t('castHint') }, t('cast')),
            h(primitives.Switch, {
              key: 'switch',
              checked: settings.cast === true,
              label: t('cast'),
              onChange: (value) => updateSettings({ cast: value }),
            }),
          ]),
          h('div', { key: 'highlight', className: 'dsh-tts-row' }, [
            h('span', { key: 'label', className: 'dsh-tts-label' }, t('highlight')),
            h(primitives.Switch, {
              key: 'switch',
              checked: settings.highlight !== false,
              label: t('highlight'),
              onChange: (value) => updateSettings({ highlight: value }),
            }),
          ]),
          servers.length > 1
            ? h('div', { key: 'servers', className: 'dsh-tts-field' }, [
              h('span', { key: 'label', className: 'dsh-tts-label' }, t('server')),
              h('div', { key: 'chips', className: 'dsh-tts-chips' }, servers.map((server) =>
                chip(server.name ?? server.id, server.id === selection.server?.id, () => updateSettings({ server: server.id, model: null, voice: null }), server.id))),
            ])
            : null,
          models.length > 1
            ? h('div', { key: 'models', className: 'dsh-tts-field' }, [
              h('span', { key: 'label', className: 'dsh-tts-label' }, t('model')),
              h('div', { key: 'chips', className: 'dsh-tts-chips' }, models.map((model) =>
                chip(model.label ?? model.id, model.id === selection.model?.id, () => updateSettings({ model: model.id, voice: null }), model.id))),
            ])
            : null,
          voices.length > 0
            ? h('div', { key: 'voices', className: 'dsh-tts-field' }, [
              h('span', { key: 'label', className: 'dsh-tts-label' }, t('voice')),
              h('div', { key: 'chips', className: 'dsh-tts-chips' }, voices.map((voice) =>
                chip(voice.label ?? voice.id, voice.id === selection.voice?.id, () => updateSettings({ voice: voice.id }), voice.id, voiceTags(voice)))),
            ])
            : null,
          h('button', {
            key: 'read',
            type: 'button',
            className: 'dsh-tts-read',
            onClick: () => readLast(sessionId),
          }, t('readLast')),
          h('div', { key: 'footer', className: 'dsh-tts-footer' }, [
            h('span', { key: 'status', className: 'dsh-tts-status', 'data-tone': status.tone ?? undefined }, status.text),
          ]),
          h('div', { key: 'hint', className: 'dsh-tts-status' }, t('hint')),
        ]), document.body)
        : null

      return h(React.Fragment, null, [
        h('button', {
          key: 'trigger',
          ref: triggerRef,
          type: 'button',
          className: 'dsh-tts-trigger',
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          'aria-controls': open ? panelId : undefined,
          'data-on': settings.autoplay ? '' : undefined,
          title: t('trigger'),
          onClick: () => setOpen(!open),
        }, [
          h(primitives.IconPlayOutlineRegular, { key: 'icon' }),
          h('span', { key: 'label', className: 'dsh-tts-trigger-label' }, t('trigger')),
          h(primitives.IconChevronDownOutlineRegular, { key: 'chevron' }),
        ]),
        panel,
      ])
    }

    /* ------------------------------------------------------------------ plugin */

    /** Required client services: slot registry, dictionaries, Session log access. */
    const inject = ['slots', 'locale', 'sessions']

    /**
     * Mount the read-aloud surfaces.
     * @param ctx - client root context.
     */
    function apply (ctx) {
      installCss()
      const settings = createSettingsStore()
      const info = createStore({ status: 'loading', value: null, error: null })
      /** Repeat suppression for noisy events, keyed by event and first detail. */
      const recent = new Map()
      const report = (level, event, detail) => {
        const payload = { level, event, detail }
        const key = `${event}|${JSON.stringify(detail ?? {}).slice(0, 96)}`
        const now = Date.now()
        const seen = recent.get(key)
        if (seen !== undefined && now - seen < 5000) return
        recent.set(key, now)
        if (recent.size > 64) recent.clear()
        if (level === 'error') console.warn('[tts]', event, detail)
        else console.debug('[tts]', event, detail)
        void fetch('/tts/log', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }).catch(() => {})
      }
      const reportMiss = (entry) => report('warn', 'highlight-miss', {
        reason: entry?.reason ?? 'unknown',
        scopeRows: entry?.scopeRows ?? 0,
        roots: entry?.roots ?? 'unknown',
        sentence: String(entry?.sentence ?? '').slice(0, 240),
        domTokens: entry?.domTokens ?? 0,
        wantedTokens: entry?.wantedTokens ?? 0,
        headFound: entry?.headFound ?? false,
        tailFound: entry?.tailFound ?? false,
        domStart: String(entry?.domStart ?? '').slice(0, 80),
      })
      const highlighter = createHighlighter(reportMiss)
      const engine = createEngine(settings, info, highlighter, report)

      /**
       * What one reply should sound like: plain prose, or a cast plan when the
       * experimental multi-voice mode is on and the reply has something to split.
       * @param sessionId - Session owning the message.
       * @param messageId - durable message identity.
       * @returns Prose, a chunk plan, or null when there is nothing to read.
       */
      const planFor = (sessionId, messageId) => {
        const text = readAssistantText(ctx, sessionId, messageId)
        if (text === '') return null
        if (settings.getSnapshot().cast !== true) return text
        const raw = readAssistantRaw(ctx, sessionId, messageId)
        const selection = selectionOf(settings.getSnapshot(), info.getSnapshot().value)
        const voices = Array.isArray(selection.model?.voices) ? selection.model.voices : []
        const built = buildCast(raw, voices, selection.voice?.id ?? null)
        if (built.chunks === null) {
          report('debug', 'cast-unavailable', { voices: voices.length })
          return text
        }
        report('debug', 'cast', { cast: built.cast })
        return built.chunks
      }

      /* Created after the planner so it can reuse it for autoplay. */
      const watcher = createWatcher(ctx, engine, settings, (sessionId, messageId) => planFor(sessionId, messageId))

      /** Read one message of one Session, highlighting inside its rendered turn. */
      const read = (sessionId, messageId, element) => {
        const plan = planFor(sessionId, messageId)
        if (plan === null) {
          engine.fail('empty')
          return
        }
        engine.speak(messageId, plan, { scope: renderingScope(element) })
      }

      /** Read whatever the Session answered last. */
      const readLast = (sessionId) => {
        const found = findLastAssistant(ctx, sessionId)
        const plan = found === null ? null : planFor(sessionId, found.id)
        if (plan === null) {
          engine.fail('empty')
          return
        }
        engine.speak(found.id, plan)
      }

      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-plugin-tts: dictionaries')
      ctx.effect(() => () => {
        watcher.dispose()
        engine.dispose()
        highlighter.dispose()
      }, 'dsh-plugin-tts: speech lifetime')
      /* A page load is a hard refresh: probe the providers again instead of
         serving whatever the Host cached before it restarted. */
      void refreshInfo(info, true)
      /* Tell the Host whether the experiment is on: it owns the prompt section. */
      const syncCast = (enabled) => {
        void fetch('/tts/cast', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: enabled === true }),
        }).catch(() => {})
      }
      syncCast(settings.getSnapshot().cast === true)

      const ttsState = { getSnapshot: engine.state.getSnapshot, subscribe: engine.state.subscribe }
      const ttsSettings = { getSnapshot: settings.getSnapshot, subscribe: settings.subscribe }
      const ttsInfo = { getSnapshot: info.getSnapshot, subscribe: info.subscribe }

      ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
        name: 'conversation.chat.assistant-actions',
        id: 'tts-listen',
        order: 5,
        locale: NS,
        inject: () => ({ hooks: { ttsState }, read, stop: () => engine.stop() }),
      }, ListenAction), 'dsh-plugin-tts: reply action')

      ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
        name: 'conversation.input.right',
        id: 'tts-read-aloud',
        order: 60,
        locale: NS,
        inject: () => ({
          hooks: { ttsState, ttsSettings, ttsInfo },
          readLast,
          watch: (sessionId) => watcher.bind(sessionId),
          updateSettings: (patch) => {
            settings.save(patch)
            if ('cast' in patch) syncCast(patch.cast)
          },
          refresh: () => refreshInfo(info),
        }),
      }, ReadControl), 'dsh-plugin-tts: composer control')

      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'tts-caption',
        order: 40,
        locale: NS,
        inject: () => ({
          hooks: { ttsState, ttsSettings, ttsInfo },
          changeRate: (value) => {
            settings.save({ speed: value })
            engine.setRate(value)
          },
          pause: () => engine.pause(),
          resume: () => engine.resume(),
          stop: () => engine.stop(),
          dismiss: () => engine.dismiss(),
          seek: (seconds) => engine.seek(seconds),
          skip: (delta) => engine.skip(delta),
          replay: () => engine.replay(),
        }),
      }, ReadingCaption), 'dsh-plugin-tts: reading caption')
    }

    exports.apply = apply
    exports.inject = inject
    exports.__internals = {
      apply,
      dictionaries: { en, zh },
      cleanForSpeech,
      createEngine,
      createHighlighter,
      createSettingsStore,
      createStore,
      buildCast,
      castSegments,
      findAnchorRange,
      findLastAssistant,
      readAssistantRaw,
      findTextRange,
      findTurnAnswer,
      readAssistantText,
      splitChunks,
    }
    return module.exports
  },
})
