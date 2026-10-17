import WebSocket from 'ws'

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

/** The key as the environment gave it, or null when it is missing or blank. */
export function cleanKey(raw) {
  if (typeof raw !== 'string') return null
  const v = raw.trim()
  return v ? v : null
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
      t: 'r',
      text: typeof text === 'string' ? text : '',
      final: m.is_final === true,
      speech: m.speech_final === true,
    }
  }
  if (m?.type === 'UtteranceEnd') return { t: 'u' }
  if (m?.type === 'Error') return { t: 'err' }
  return null
}

/**
 * Create the proxy. `key` is read per session, so a key set later is picked up
 * without a restart of this module. `connectUpstream` exists for the tests.
 */
export function createSttProxy({
  key,
  lang = 'ru',
  url = listenUrl(lang),
  log = () => {},
  idleMs = IDLE_MS,
  maxSessionMs = MAX_SESSION_MS,
  maxBytes = MAX_SESSION_BYTES,
  keepAliveMs = KEEPALIVE_MS,
  connectUpstream = (u, headers) => new WebSocket(u, { headers, handshakeTimeout: CONNECT_TIMEOUT_MS }),
}) {
  /** The one live session. A newer one replaces it: a half-open old socket must not lock the user out. */
  let active = null

  /** Take over a client socket that connected to STT_PATH. */
  function accept(client) {
    const apiKey = cleanKey(key())
    if (!apiKey) {
      client.close(4503, 'no key')
      return
    }
    if (active) active.end(4001, 'replaced')

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
        if (active === session) active = null
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
    active = session

    const touch = () => {
      if (idle) clearTimeout(idle)
      idle = setTimeout(() => session.end(4408, 'idle'), idleMs)
    }
    touch()
    timers.push(setTimeout(() => session.end(4000, 'session limit'), maxSessionMs))

    try {
      upstream = connectUpstream(url, { Authorization: `Token ${apiKey}` })
    } catch {
      sendClient({ t: 'err' })
      session.end(4502, 'upstream')
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
      sendClient({ t: 'ready' })
    })
    upstream.on('message', (data, isBinary) => {
      if (isBinary) return
      const out = slim(data.toString())
      if (out) sendClient(out)
    })
    // Only the status goes to the log: the body of a refusal is Deepgram's, not ours.
    upstream.on('unexpected-response', (_req, res) => {
      log(`stt upstream refused the session (${res.statusCode})`)
      sendClient({ t: 'err' })
      session.end(4502, 'upstream')
    })
    upstream.on('error', () => {
      if (!ended) {
        log('stt upstream socket error')
        sendClient({ t: 'err' })
        session.end(4502, 'upstream')
      }
    })
    upstream.on('close', () => session.end(4502, 'upstream closed'))

    client.on('message', (data, isBinary) => {
      if (ended) return
      // Audio only. Text from the page is ignored: it is not a way to talk to Deepgram.
      if (!isBinary) return
      const frame = Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)])
      if (frame.length === 0) return
      if (frame.length > MAX_FRAME_BYTES) return session.end(1009, 'frame too large')
      bytes += frame.length
      if (bytes > maxBytes) return session.end(1009, 'too much audio')
      touch()
      if (ready) upstream.send(frame)
      else if (queue.length < MAX_QUEUED_FRAMES) queue.push(frame)
    })
    client.on('close', () => session.end(1000, 'client closed'))
    client.on('error', () => session.end(1011, 'client error'))
  }

  return { accept, active: () => active !== null }
}
