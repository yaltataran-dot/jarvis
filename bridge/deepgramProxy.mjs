import WebSocket from 'ws'
import { PAGE_CLOSE_RANGE, STT_CLOSE, STT_MESSAGES } from '../shared/protocol.mjs'

/**
 * Streaming speech-to-text through Deepgram, with the API key kept here.
 *
 * The browser opens a socket to the bridge and sends raw 16 kHz mono PCM16.
 * The bridge opens the Deepgram socket, authenticates it with the key (in a
 * header, never in a URL), and passes back only the few fields the page needs.
 * The key, Deepgram's request ids and error bodies never reach the page, and
 * neither the audio nor the transcripts are logged.
 *
 * What the page receives (all text frames, JSON):
 *   {t:'ready'}                           upstream accepted the session
 *   {t:'r', text, final, speech}          a Results message, reduced
 *   {t:'u'}                               UtteranceEnd
 *   {t:'err'}                             anything went wrong upstream
 */

export const STT_PATH = '/stt-stream'

/** Deepgram closes sessions after two hours; end ours a little before. */
export const MAX_SESSION_MS = 110 * 60 * 1000
/** No audio from the page for this long: the page is gone or stuck. */
export const IDLE_MS = 30_000
/** One frame is ~100 ms (3.2 kB); this is generous and still refuses a runaway. */
export const MAX_FRAME_BYTES = 64 * 1024
/** Roughly 16 kHz * 2 bytes * 3 h. A cap on a single session, not on the day. */
export const MAX_SESSION_BYTES = 350 * 1024 * 1024
/** Pages that may listen at once — a computer, a phone, a tablet. Each is a Deepgram stream. */
export const MAX_SESSIONS = 3
/** Frames held while the upstream socket is still connecting (~3 s). */
const MAX_QUEUED_FRAMES = 30
const KEEPALIVE_MS = 5_000
const CONNECT_TIMEOUT_MS = 5_000

const ENDPOINT = 'wss://api.deepgram.com/v1/listen'

/**
 * The query for a Russian command-and-conversation stream.
 *
 * `endpointing` is set on purpose: the default is 10 ms, which cuts a phrase at
 * every breath. 700 ms matches the pause the rest of the voice loop is tuned
 * for; the page's assembler decides when a thought is really finished.
 */
export function listenUrl(lang = 'ru', base = ENDPOINT) {
  const q = new URLSearchParams({
    model: 'nova-3',
    language: lang,
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    interim_results: 'true',
    endpointing: '700',
    utterance_end_ms: '1000',
  })
  return `${base}?${q}`
}

/**
 * What is wrong with the key as the environment gave it, or null when it can be
 * used. A Deepgram key is one printable token; spaces, quotes or letters
 * outside ASCII mean something else was pasted with it, or instead of it. Such
 * a value cannot even be put in a header: the socket constructor threw on it,
 * every session ended a fraction of a second after it began, and the page fell
 * back to the browser engine once a minute without a word in the log.
 */
export function keyProblem(raw) {
  const v = typeof raw === 'string' ? raw.trim() : ''
  if (!v) return 'missing'
  if (/[^\x21-\x7e]|["']/.test(v)) return 'unusable'
  return null
}

/** The key as the environment gave it, or null when it is missing, blank or unusable. */
export function cleanKey(raw) {
  return keyProblem(raw) ? null : raw.trim()
}

/**
 * One raw Deepgram message reduced to what the page may see, or null.
 * Anything not listed here is dropped, including Metadata and its request id.
 */
export function slim(raw) {
  let m
  try {
    m = JSON.parse(raw)
  } catch {
    return null
  }
  if (m?.type === 'Results') {
    const text = m.channel?.alternatives?.[0]?.transcript
    return {
      t: STT_MESSAGES.RESULT,
      text: typeof text === 'string' ? text : '',
      final: m.is_final === true,
      speech: m.speech_final === true,
    }
  }
  if (m?.type === 'UtteranceEnd') return { t: STT_MESSAGES.UTTERANCE_END }
  if (m?.type === 'Error') return { t: STT_MESSAGES.ERROR }
  return null
}

/**
 * Create the proxy. `key` is read per session, so a key set later is picked up
 * without a restart of this module. `connectUpstream` exists for the tests.
 */
/** The page's reasons for starting its voice loop (voice.ts). Anything else is logged as 'other'. */
const START_REASONS = new Set(['boot', 'tap', 'retry', 'recover', 'restore', 'start'])

/** The start reason from the page's /stt-stream?why=…, as one known word. */
export function startReason(raw) {
  return START_REASONS.has(raw) ? raw : 'other'
}

export function createSttProxy({
  key,
  lang = 'ru',
  url = listenUrl(lang),
  log = () => {},
  idleMs = IDLE_MS,
  maxSessionMs = MAX_SESSION_MS,
  maxBytes = MAX_SESSION_BYTES,
  keepAliveMs = KEEPALIVE_MS,
  maxSessions = MAX_SESSIONS,
  connectUpstream = (u, headers) => new WebSocket(u, { headers, handshakeTimeout: CONNECT_TIMEOUT_MS }),
}) {
  /**
   * The live sessions, oldest first. It used to be one: a phone opening the
   * page replaced the computer's session and the computer's retry replaced the
   * phone's, each falling back to the browser engine in turn — which on
   * Android cannot share the microphone and reported it as "refused". A few
   * pages may listen at once now; past that the oldest goes, so a half-open old
   * socket still cannot lock the user out.
   */
  const sessions = []

  /** Take over a client socket that connected to STT_PATH. `why` is the page's start reason, for the log. */
  function accept(client, why) {
    const apiKey = cleanKey(key())
    if (!apiKey) {
      client.close(STT_CLOSE.NO_KEY, 'no key')
      return
    }
    while (sessions.length >= maxSessions) sessions[0].end(STT_CLOSE.REPLACED, 'replaced')

    let upstream = null
    let ready = false
    let ended = false
    let bytes = 0
    const queue = []
    const timers = []

    const sendClient = (obj) => {
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(obj))
    }

    let idle = null
    const session = {
      end(code, reason) {
        if (ended) return
        ended = true
        if (idle) clearTimeout(idle)
        // Timeouts and intervals share one clear in Node.
        for (const t of timers) clearTimeout(t)
        const at = sessions.indexOf(session)
        if (at !== -1) sessions.splice(at, 1)
        try {
          if (upstream?.readyState === WebSocket.OPEN) {
            upstream.send(JSON.stringify({ type: 'CloseStream' }))
            upstream.close()
          } else {
            upstream?.terminate()
          }
        } catch {
          /* already gone */
        }
        try {
          if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
            client.close(code, reason)
          }
        } catch {
          /* already gone */
        }
        log(`stt session ended (${code})`)
      },
    }
    sessions.push(session)

    const touch = () => {
      if (idle) clearTimeout(idle)
      idle = setTimeout(() => session.end(STT_CLOSE.IDLE, 'idle'), idleMs)
    }
    touch()
    timers.push(setTimeout(() => session.end(STT_CLOSE.SESSION_LIMIT, 'session limit'), maxSessionMs))
    // Which start of the page's voice loop this is (voice.ts), so a session
    // that later idles out or is closed as blocked can be matched to it.
    if (why !== undefined) log(`stt session started (${startReason(why)})`)

    try {
      upstream = connectUpstream(url, { Authorization: `Token ${apiKey}` })
    } catch (err) {
      // The code only (ERR_INVALID_CHAR and the like): a message could quote the header.
      log(`stt upstream could not be opened (${err?.code ?? err?.name ?? 'error'})`)
      sendClient({ t: STT_MESSAGES.ERROR })
      session.end(STT_CLOSE.UPSTREAM, 'upstream')
      return
    }

    upstream.on('open', () => {
      if (ended) return
      ready = true
      for (const f of queue.splice(0)) upstream.send(f)
      timers.push(
        setInterval(() => {
          // Audio keeps the stream alive; this covers a page that went quiet.
          if (upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify({ type: 'KeepAlive' }))
        }, keepAliveMs),
      )
      sendClient({ t: STT_MESSAGES.READY })
    })
    upstream.on('message', (data, isBinary) => {
      if (isBinary) return
      const out = slim(data.toString())
      if (out) sendClient(out)
    })
    // Only the status goes to the log: the body of a refusal is Deepgram's, not ours.
    upstream.on('unexpected-response', (_req, res) => {
      log(`stt upstream refused the session (${res.statusCode})`)
      sendClient({ t: STT_MESSAGES.ERROR })
      session.end(STT_CLOSE.UPSTREAM, 'upstream')
    })
    upstream.on('error', (err) => {
      if (!ended) {
        log(`stt upstream socket error (${err?.code ?? err?.name ?? 'error'})`)
        sendClient({ t: STT_MESSAGES.ERROR })
        session.end(STT_CLOSE.UPSTREAM, 'upstream')
      }
    })
    upstream.on('close', (code, reason) => {
      // Deepgram says why in the close frame (NET-0001, DATA-0000, …). Logged
      // only when it closed a live session, as printable text, short.
      if (!ended) {
        const why = String(reason ?? '').replace(/[^\x20-\x7e]/g, '').slice(0, 80)
        log(`stt upstream closed (${code}${why ? `, ${why}` : ''})`)
      }
      session.end(STT_CLOSE.UPSTREAM, 'upstream closed')
    })

    client.on('message', (data, isBinary) => {
      if (ended) return
      // Audio only. Text from the page is ignored: it is not a way to talk to Deepgram.
      if (!isBinary) return
      const frame = Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)])
      if (frame.length === 0) return
      if (frame.length > MAX_FRAME_BYTES) return session.end(STT_CLOSE.TOO_LARGE, 'frame too large')
      bytes += frame.length
      if (bytes > maxBytes) return session.end(STT_CLOSE.TOO_LARGE, 'too much audio')
      touch()
      if (ready) upstream.send(frame)
      else if (queue.length < MAX_QUEUED_FRAMES) queue.push(frame)
    })
    // The page's own reason (4000–4099, e.g. 4010: the phone would not start
    // the audio) is kept for the log line; anything else is a plain close.
    client.on('close', (code) => session.end(code >= PAGE_CLOSE_RANGE.MIN && code <= PAGE_CLOSE_RANGE.MAX ? code : STT_CLOSE.NORMAL, 'client closed'))
    client.on('error', () => session.end(STT_CLOSE.CLIENT_ERROR, 'client error'))
  }

  return { accept, active: () => sessions.length > 0, count: () => sessions.length }
}
