import type { ScribeHooks, ScribeLink } from './scribeVoice'

/**
 * Deepgram recognition as the hooks scribeVoice.ts already speaks.
 *
 * Everything that decides what a phrase may do — stop, barge-in, the assembler,
 * the duplicate guard — lives in that engine and is unchanged. This file only
 * turns the bridge's reduced messages into partials and committed phrases.
 * The page never holds a key and never talks to Deepgram: it talks to the
 * bridge, which does (see bridge/deepgramProxy.mjs).
 */

/** What the bridge sends. Anything else is ignored. */
export type SttMessage =
  | { t: 'ready' }
  | { t: 'r'; text: string; final: boolean; speech: boolean }
  | { t: 'u' }
  | { t: 'err' }

const join = (a: string, b: string) => (a && b ? `${a} ${b}` : a || b)

/**
 * Turn the message stream into partials and commits.
 *
 * A phrase is a run of `final` pieces ended by `speech_final`; speech_final
 * alone is not the whole phrase when it is long. So the finals are held, every
 * partial shows them plus the interim tail so the caption never shrinks, and
 * the phrase is committed exactly once: by speech_final, or — if that never
 * comes — by UtteranceEnd. Whichever comes second finds nothing to commit.
 */
export function createDeepgramParser(hooks: ScribeHooks) {
  let held = ''
  let started = false

  const commit = () => {
    const text = held.trim()
    held = ''
    if (text) hooks.onCommitted(text)
  }

  return {
    handle(raw: string) {
      let m: SttMessage
      try {
        m = JSON.parse(raw) as SttMessage
      } catch {
        return
      }
      if (!m || typeof m !== 'object') return
      if (m.t === 'ready') {
        if (started) return
        started = true
        hooks.onStarted()
      } else if (m.t === 'r') {
        const text = typeof m.text === 'string' ? m.text.trim() : ''
        if (m.final) {
          held = join(held, text)
          if (m.speech) commit()
          else if (held) hooks.onPartial(held)
        } else if (text) {
          hooks.onPartial(join(held, text))
        }
      } else if (m.t === 'u') {
        commit()
      } else if (m.t === 'err') {
        held = ''
        hooks.onError('deepgram')
      }
    },
    /** Words held back because no pause has closed them yet. */
    pending: () => held,
  }
}

/** The pieces connectDeepgram needs from the browser, so a test can supply fakes. */
export type DeepgramDeps = {
  url: string
  WebSocketCtor?: typeof WebSocket
  capture: (onFrame: (frame: ArrayBuffer) => void) => Promise<{ stop: () => void }>
}

/** Frames are dropped, not queued, when the socket cannot keep up: late audio is worse than lost audio. */
const MAX_BUFFERED = 512 * 1024

/**
 * Open the bridge socket and, once the bridge says the upstream session is up,
 * start sending the shared microphone. Resolves when the socket is open; the
 * engine's own start timer judges whether `ready` follows in time.
 */
export async function connectDeepgram(hooks: ScribeHooks, d: DeepgramDeps): Promise<ScribeLink> {
  const Ctor = d.WebSocketCtor ?? WebSocket
  const ws = new Ctor(d.url)
  ws.binaryType = 'arraybuffer'
  let capture: { stop: () => void } | null = null
  let closed = false

  const stopCapture = () => {
    const c = capture
    capture = null
    try {
      c?.stop()
    } catch {
      /* already stopped */
    }
  }

  const parser = createDeepgramParser({
    ...hooks,
    onStarted: () => {
      hooks.onStarted()
      d.capture((frame) => {
        if (ws.readyState === ws.OPEN && ws.bufferedAmount < MAX_BUFFERED) ws.send(frame)
      }).then(
        (c) => {
          if (closed) c.stop()
          else capture = c
        },
        () => {
          if (!closed) hooks.onError('capture')
        },
      )
    },
  })

  ws.onmessage = (e: MessageEvent) => {
    if (typeof e.data === 'string') parser.handle(e.data)
  }
  ws.onclose = () => {
    stopCapture()
    if (!closed) hooks.onClose()
  }

  await new Promise<void>((ok, fail) => {
    ws.onopen = () => ok()
    ws.onerror = () => fail(new Error('socket'))
  })

  return {
    close: () => {
      if (closed) return
      closed = true
      stopCapture()
      try {
        ws.close(1000)
      } catch {
        /* already gone */
      }
    },
  }
}
