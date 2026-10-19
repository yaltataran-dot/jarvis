/**
 * POST /stt — speech to text for one recorded segment. The browser captures a
 * spoken segment as a compressed audio blob and posts the raw bytes here; the
 * bridge hands them to ElevenLabs Scribe and returns the transcript as
 * `{text}`. (The page's realtime path, Deepgram over /stt-stream, does not
 * come here.)
 *
 * Moved out of server.mjs unchanged. What stays there and is passed in: the
 * key (`elevenKey`), the language and the secrets redaction (`redact`).
 * `fetch` defaults to the real one; tests pass their own. A failure while
 * reading the request is not caught here: it reaches the bridge's request
 * handler, which answers 500. server.mjs also does everything that comes
 * before any route — the Host and Origin checks, OPTIONS, the CORS headers —
 * and hands this handler the `cors` headers it built.
 */

/** Not STT_PATH: that name is the realtime socket's path (`/stt-stream`, deepgramProxy.mjs). */
export const STT_HTTP_PATH = '/stt'
export const SCRIBE_URL = 'https://api.elevenlabs.io/v1/speech-to-text'

/** A few seconds of Opus is well under a megabyte; this still refuses a runaway stream. */
export const MAX_AUDIO = 25 * 1024 * 1024

/** Under this many bytes a segment is silence or a click, answered without asking Scribe. */
export const MIN_AUDIO = 1200

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{
 *   cors: Record<string, string>,
 *   lang: string,
 *   elevenKey: () => string | null,
 *   redact: (s: string) => string,
 *   fetch?: typeof fetch,
 * }} d
 */
export async function sttRequest(req, res, { cors, lang, elevenKey, redact, fetch: fetchFn = fetch }) {
  const key = elevenKey()
  if (!key) {
    res.writeHead(503, cors)
    return res.end('no elevenlabs key')
  }

  const type = req.headers['content-type'] || 'audio/webm'
  const chunks = []
  let size = 0
  let overflowed = false
  // A few seconds of Opus is well under a megabyte; 25 MB is a generous
  // ceiling that still refuses a runaway stream before it eats the heap.
  for await (const chunk of req) {
    chunks.push(chunk)
    size += chunk.length
    if (size > MAX_AUDIO) {
      overflowed = true
      break
    }
  }
  if (overflowed) {
    req.destroy()
    res.writeHead(413, cors)
    return res.end('audio too large')
  }
  // Silence, or a click. Nothing to transcribe, and calling out to the API
  // for it would only add latency to a non-answer.
  if (size < MIN_AUDIO) {
    res.writeHead(200, { ...cors, 'content-type': 'application/json' })
    return res.end(JSON.stringify({ text: '' }))
  }

  try {
    // The filename extension is the only hint Scribe gets about the codec, so
    // derive it from the content-type the MediaRecorder reported rather than
    // hard-coding one.
    const ext = type.includes('ogg')
      ? 'ogg'
      : type.includes('mp4') || type.includes('mpeg')
        ? 'mp4'
        : type.includes('wav')
          ? 'wav'
          : 'webm'
    const form = new FormData()
    form.append('model_id', 'scribe_v1')
    // Without it Scribe detects the language per segment, and a two-word
    // Russian command is short enough to come back as English or transliteration.
    form.append('language_code', lang)
    form.append(
      'file',
      new Blob([Buffer.concat(chunks)], { type }),
      `speech.${ext}`,
    )

    const upstream = await fetchFn(SCRIBE_URL, {
      method: 'POST',
      headers: { 'xi-api-key': key },
      body: form,
    })
    if (!upstream.ok) {
      res.writeHead(upstream.status, cors)
      return res.end(await upstream.text())
    }
    const data = await upstream.json()
    res.writeHead(200, { ...cors, 'content-type': 'application/json' })
    return res.end(JSON.stringify({ text: (data.text ?? '').trim() }))
  } catch (err) {
    res.writeHead(502, cors)
    return res.end(redact(String(err?.message ?? err)))
  }
}
