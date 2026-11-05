---
description: "Listen instead of reading: text-to-speech for the DSH Web GUI, synthesized by the local audio.cpp (Kokoro) server."
kind: "package-bundle"
---

# dsh-plugin-tts

Reads assistant replies aloud in the DSH Web GUI. Speech is synthesized by the
local `audio.cpp` server on the host — the audio never leaves the machine and no
cloud TTS is involved.

## What you get

- **A Listen control on every finalized reply** — play/stop, in the assistant
  action row next to Copy and Branch.
- **Autoplay** — new completed turns are read as they arrive (on by default,
  toggle in the composer control).
- **Voice, with tags** — every voice the selected model announces, kept as
  `{id, label, gender, language, category, default}`. Tags come from the engine's
  own `server.json` catalog when one is configured, and otherwise from the id for
  Kokoro-style names (`af_bella` → Bella · female · en-us). A stored bare name
  (`bella`) still resolves to its tagged id, and the engine's declared default
  wins over list position.
- **Rate in the player** — a small dropdown (0.75 / 1 / 1.25 / 1.5 / 2) beside the
  clock. It sets the audio element's `playbackRate` (pitch preserved), so a change
  is heard instantly, costs no synthesis, and never restarts the sentence.
- **Composer control** — a `Listen` chip in the composer tool row with the
  autoplay switch, voice chips, a "Read the last reply" button, and the
  speech-server status.

## Requirements

The `audio.cpp` speech server from `~/stacks/ai/docker-compose.yml` (service
`audio-cpp`) listening on the host loopback:

```sh
curl -s http://127.0.0.1:8080/health
```

It ships four TTS models; this plugin defaults to `kokoro`, which on the RX 6600
XT is the only one fast enough to feel interactive (~0.15 real-time factor —
5 s of speech in <1 s). `qwen-cv` and `omnivoice` work but run slower than
real time, so audio for a long sentence can lag the text.

The plugin talks to the engine from its **host half**, not from the browser: the
page calls `/tts/*` on the DSH origin, which proxies to `127.0.0.1:8080`. That
keeps the engine bound to loopback, avoids CORS, and works from any browser that
can open the GUI — including one that cannot reach the host's port 8080.

## Install

The package must be resolvable from the profile and listed in the profile
patch. pnpm is not installed in this container, so the profile links the
checkout directly:

```sh
# 1. Make the package resolvable from the web profile.
mkdir -p ~/.dsh/profiles/web/node_modules
ln -sfn /home/agent/workspace/dsh/tts-plugin \
        ~/.dsh/profiles/web/node_modules/dsh-plugin-tts

# 2. Declare it in the profile manifest (dependencies block).
#    "dsh-plugin-tts": "link:/home/agent/workspace/dsh/tts-plugin"

# 3. Add the row to ~/.dsh/profiles/web/cordis.patch.yml.
```

```yaml
- insert:
    - id: tts
      name: dsh-plugin-tts
```

The web profile runs under HMR: saving `cordis.patch.yml` recomposes the profile
in place, so the `/tts` routes appear and the open page loads the browser half
without restarting `dsh web`. Verify with:

```sh
curl -s http://127.0.0.1:3080/tts/info
```

## Discovery

`GET /tts/info` walks every model provider the **profile configures** (the
adapter's shipped catalog on its own is not enough), resolves each endpoint from
its `baseURL` or the adapter's default, and then speaks the OpenAI protocol to
find out what it can do:

```
<llm.listConfigurableProviders()> + <settings.describe()>  →  configured providers
    → POST {baseURL}/audio/speech   body {}     capability: an audio route exists?
         404/405/501 → not a speech server, dropped
    → GET  {baseURL}/models         every model it lists, none filtered
    → GET  {baseURL}/audio/voices   voice listing? (absent on Ollama)
          → GET {baseURL}/audio/voices?model=<id>   per-model voices
```

The capability test sends an **empty** body and reads the refusal, so it costs
no GPU time. A probe that times out is treated as *unknown*, not as a refusal —
audio.cpp serves one model at a time, so a probe issued while it is generating
would otherwise delete the provider for five minutes. `?refresh=1` re-probes
everything, including providers that failed recently, and a page load asks for it.
It is deliberately about the route, not about metadata: Ollama's
`lfm3-omni` answers `/audio/speech` while declaring no `task` at all, so a
metadata filter would hide a working engine. Declared `task`/`family` only
decides **ordering** — declared speech models first, the rest after — which is
what makes a fresh browser default to a server that speaks.

A provider that fails its probe is not probed again for `failureTtlMs` (5 min);
successes are reused for `discoveryTtlMs` (15 s). `GET /tts/info?refresh=1`
re-probes immediately. Where a provider profile names `apiKeyEnv` and that
variable is set, discovery and synthesis send it as a bearer token; the value
never leaves the Host.

`POST /tts/speak` takes `{ text, server?, model?, voice?, speed? }`, resolves the
selection against the same table, and forwards to
`{baseURL}/audio/speech` (`model`, `input`, `voice`, `response_format: wav`,
`speed`).

## Experimental: multiple voices

A toggle in the player's panel (**Multiple voices (experimental)**) turns one reply
into a small cast:

- the reply is split at **headings** and at **`Name:` labels**; a reply with
  neither falls back to its paragraphs;
- each speaker keeps its own voice, assigned round-robin from the selected model's
  roster, so the same heading or name is always read by the same voice;
- the player shows the voice on the current part beside the clock, so you can see
  the cast working;
- it needs a model with at least two voices, and at least two parts — otherwise it
  falls back to a single voice and logs `cast-unavailable`.

Nothing about the normal path changes: with the toggle off, a reply is one voice
from end to end, and the Host still receives one `voice` per request either way.

### The instruction the model receives

Turning the toggle on mirrors to the Host (`POST /tts/cast`) and makes it register
one **system-prompt section** — never a change to your message:

> ## Reading aloud with several voices
> A text-to-speech experiment is active: this reply may be read by more than one voice.
> - Write as a small cast only when the content genuinely has several voices…
> - In a cast, put each speaker at the start of a line as `Name: sentence`…
> - Never label ordinary prose, code, or lists…

The section returns an empty string while the toggle is off, so the prompt is
byte-identical to a run without the plugin. The narrator — the first, unlabelled
part — keeps the **voice chosen in the settings**; the other speakers rotate the
rest of the roster.

## Diagnostics

Both halves write to one bounded event log on the Host — the last 200 entries,
graded `debug` / `info` / `warn` / `error`, readable without the browser console:

```sh
curl -s 'http://127.0.0.1:3080/tts/log?tail=20'
curl -s 'http://127.0.0.1:3080/tts/log?level=error'
curl -s -X DELETE 'http://127.0.0.1:3080/tts/log'   # cleared count
```

| event | level | carries |
|---|---|---|
| `ready` | info | endpoint, model, cache budget, discovery TTL |
| `discovered` | debug | provider:model-count list, how many were probed |
| `provider-unusable` | debug | provider id, endpoint, and why its capability probe refused |
| `provider-slow` | debug | a probe that timed out; the previous row is kept |
| `no-speech-model` | warn | the server/model a request asked for |
| `synthesis-failed` | error | provider, model, voice, characters, status, message |
| `synthesis-cache-hit` | debug | model and characters |
| `highlight-miss` | warn | reason, whether turn rows or the document were searched, the sentence |
| `autoplay-blocked` | warn | code and message from the browser |
| `speech-server-error` | error | code and message |
| `playback-failed` | error | code and message |

The same entries go to the Host logger as `[tts] <event> <json>`. The browser
deduplicates repeats for five seconds, so a stuck failure cannot flood the log.

## Configuration

Every key is optional; with none of them the plugin is purely discovery-driven.

| Key | Default | Meaning |
|---|---|---|
| `server` | first discovered (declared speech servers first) | Preferred server id (the provider key) |
| `model` | first discovered | Preferred model id |
| `voice` | first of the model | Preferred voice id |
| `speed` | `1` | Default rate, synthesized by the engine (pitch preserved) |
| `endpoints` | `[]` | Extra `{ id, name, baseURL }` servers not configured as providers |
| `speeds` | `[0.75, 1, 1.25, 1.5, 2]` | Rates offered by the GUI |
| `discoveryTtlMs` | `15000` | How long a discovery result is reused |
| `failureTtlMs` | `300000` | How long a provider that failed the capability probe is left alone |
| `voiceCatalog` | `[]` | Paths to engine `server.json` catalogs, used for voice tags; each is re-read at most once a minute |
| `maxChars` | `4000` | Largest single synthesis request |
| `cacheBytes` | `24 MiB` | Synthesized audio kept in memory for instant re-listening |
| `timeoutMs` | `120000` | One synthesis may take a while on a slow model |

The **bolded choice** is made in the panel, not in configuration: server, model,
voice, rate, and autoplay live in `localStorage` under `dsh.tts.settings.v1`. The
keys above only supply fallbacks for a fresh browser.

## How it works

```
browser                          host (dsh web)              speech server
  Listen click ──POST /tts/speak──▶ proxy ──POST /v1/audio/speech──▶ audio.cpp
                 ◀── audio/wav ────        ◀────── audio/wav ───────
```

- **Text source** — the browser half reads the reply out of the Session's durable
  event window (`ctx.sessions.binding(id).eventSource`), matched by the
  `messageId` the action slot carries. No DOM scraping and no re-render hooks.
- **Chunking** — markdown is flattened to prose (code fences dropped, links
  reduced to their label, bare URLs dropped), then split into sentence groups of
  at most 380 characters. The next group is requested while the current one
  plays, so speech starts after the first sentence rather than at the end.
- **Autoplay** — the browser half subscribes to each open Session's window and
  reads the answering message when a `turn/end` reports `completed`. History is
  never read on open; only newly completed turns.
- **Interrupted or tool-only messages** are not autoplay candidates; an explicit
  Listen click still reads whatever text exists.
- **Highlight** — each chunk is matched against the rendered turn twice: first
  as a whitespace-normalized substring, then by **word sequence**. The word run
  is matched with a bounded gap (24 tokens) and ranked by the tightest span,
  because the transcript renders words the engine never says — bare URLs, image
  alt text, table chrome — and a strict subsequence would fail on exactly the
  sentences that contain them. The range is painted with the CSS Custom
  Highlight API, which styles a `Range` without touching the DOM React owns;
  browsers without it get the containing block marked with
  `data-dsh-tts-reading`. A last **anchor** pass matches the chunk's first and
  last three words with a bounded gap, which is what survives the cleaning
  rewrites (`12.5` is spoken `12 point 5`). When the sentence still cannot be
  located, the message row itself is marked so the reading never goes dark, and
  the miss is reported (see Diagnostics).
- **Nothing is hardcoded** — server, model, and voice are discovered from the
  configured providers and chosen in the panel; a stale remembered voice silently
  falls back to one the selected model offers, and a model named without its
  server is looked up across every provider.
- **Rate is playback, not synthesis** — chunks are always synthesized at the
  engine's own speed and the player retimes them, so dragging the rate never
  invalidates the Host's audio cache.
- **One protocol** — every engine is driven through the OpenAI audio API, so a
  new provider needs no code: configure it, and it appears (or is dropped by the
  capability probe).
- **Stop is immediate** — pressing the control pauses the playing element at
  once; it does not wait for the current sentence to finish.
- The host proxy caches audio by `(model, voice, rate, text)`, so re-listening to
  a reply is instant and costs no GPU time.

## Tests

`test/` drives both halves without the GUI: the host routes are exercised against
the live speech server, and the browser half is loaded through the same
`window.__ModuleLoader__` contract the shell uses, rendered in jsdom, and run
against a fake transport.

```sh
cd /home/agent/workspace/dsh/tts-plugin
npm i --no-save react@18 react-dom@18 jsdom   # test-only, not part of the package
NODE_ENV=development node --test "test/*.test.mjs"
```

## Known limitations

- Speech starts after a network round trip (~0.5–1.5 s for the first sentence on
  Kokoro). There is no true streaming: `audio.cpp` supports no `stream: true`
  mode, so each chunk is a complete WAV.
- Autoplay can be blocked by the browser's audio policy on a page with no user
  gesture; the plugin reports it in the control and the Listen button always
  works.
- Only the loaded part of a Session can be read. A reply outside the event
  window has no text to speak until the conversation pages it back in.
- No per-sentence highlight, no word-level progress, and no browser-voice
  fallback: the `audio.cpp` server is required.
