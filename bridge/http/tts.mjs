/**
 * POST /tts — the page's spoken answers: ElevenLabs when there is a key
 * (streamed mp3), otherwise the local Piper voice (a whole WAV). ElevenLabs
 * refusing or failing before it starts falls back to Piper when a Piper voice
 * is installed.
 *
 * Moved out of server.mjs unchanged. What stays there and is passed in: the
 * key (`elevenKey`), the Piper lookups and synthesis (`piperVoices`,
 * `piperSpeak`), the language, the ElevenLabs voice (`voiceId`) and the
 * secrets redaction (`redact`). `fetch` and `log` default to the real ones;
 * tests pass their own. server.mjs also does everything that comes before any
 * route — the Host and Origin checks, OPTIONS, the CORS headers — and hands
 * this handler the `cors` headers it built.
 */

export const TTS_PATH = '/tts'

/** A spoken line is a few hundred bytes; a body this long is not a sentence. */
export const MAX_BODY = 64 * 1024

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{
 *   cors: Record<string, string>,
 *   lang: string,
 *   voiceId: string,
 *   elevenKey: () => string | null,
 *   piperVoices: (lang: string) => string[],
 *   piperSpeak: (text: string, lang: string, voice: string | null, style: string) => Promise<Buffer>,
 *   redact: (s: string) => string,
 *   fetch?: typeof fetch,
 *   log?: (line: string) => void,
 * }} d
 */
export async function ttsRequest(req, res, { cors, lang, voiceId, elevenKey, piperVoices, piperSpeak, redact, fetch: fetchFn = fetch, log = (line) => console.error(line) }) {
  const key = elevenKey()
  const piperReady = piperVoices(lang).length > 0
  if (!key && !piperReady) {
    res.writeHead(503, cors)
    return res.end('no speech engine: no elevenlabs key and no piper voice')
  }
  // A spoken line is a few hundred bytes. Anything approaching this is not a
  // sentence, and buffering it unbounded would let one request eat the heap.
  let body = ''
  let overflowed = false
  for await (const chunk of req) {
    body += chunk
    if (body.length > MAX_BODY) {
      overflowed = true
      break
    }
  }
  if (overflowed) {
    req.destroy()
    res.writeHead(400, cors)
    return res.end('body too large')
  }
  // Inside a try: this handler is async with nothing catching its rejection,
  // so a malformed body used to take the entire bridge down with it.
  let text
  let voice
  // 'announce' for the start-up greeting; anything else is an answer.
  let style
  try {
    ;({ text, voice, style } = JSON.parse(body || '{}'))
  } catch {
    res.writeHead(400, cors)
    return res.end('bad json')
  }
  if (!text || typeof text !== 'string') {
    res.writeHead(400, cors)
    return res.end('no text')
  }

  // The local voice. Whole WAV rather than a stream: piper writes the file
  // only once the sentence is done, and a sentence is a few hundred ms.
  const speakLocally = async () => {
    try {
      const wav = await piperSpeak(
        text,
        lang,
        typeof voice === 'string' ? voice : null,
        typeof style === 'string' ? style : 'normal',
      )
      res.writeHead(200, {
        ...cors,
        'content-type': 'audio/wav',
        'content-length': wav.length,
        'cache-control': 'no-cache',
      })
      return res.end(wav)
    } catch (err) {
      log(`[jarvis] piper failed: ${err?.message ?? err}`)
      res.writeHead(502, cors)
      return res.end(redact(String(err?.message ?? err)))
    }
  }
  if (!key) return speakLocally()

  try {
    const upstream = await fetchFn(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream` +
        // 22kHz mono is half the bytes of 44kHz and indistinguishable through
        // a laptop speaker; optimize_streaming_latency=3 trades a little
        // prosody for a much earlier first byte.
        `?output_format=mp3_22050_32&optimize_streaming_latency=3`,
      {
        method: 'POST',
        headers: { 'xi-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({
          text,
          // Flash is the low-latency model — a conversation needs speed more
          // than it needs the last few percent of quality.
          model_id: 'eleven_flash_v2_5',
          // Stated, not detected. Left to guess, Flash reads a short Russian
          // line like "Готово, сэр." with English phonetics.
          language_code: lang,
          voice_settings: {
            stability: 0.4,
            similarity_boost: 0.75,
            speed: 1.05,
          },
        }),
      },
    )
    if (!upstream.ok) {
      // Out of credit, or the key was revoked: a local voice beats the
      // browser's, so use it when there is one.
      if (piperReady) return speakLocally()
      res.writeHead(upstream.status, cors)
      return res.end(await upstream.text())
    }

    // Pipe it through rather than buffering. Waiting for the whole file here
    // would throw away everything the streaming endpoint just bought us.
    res.writeHead(200, {
      ...cors,
      'content-type': 'audio/mpeg',
      'cache-control': 'no-cache',
    })
    for await (const chunk of upstream.body) res.write(Buffer.from(chunk))
    return res.end()
  } catch (err) {
    if (res.headersSent) return res.destroy()
    if (piperReady) return speakLocally()
    res.writeHead(502, cors)
    return res.end(redact(String(err?.message ?? err)))
  }
}
