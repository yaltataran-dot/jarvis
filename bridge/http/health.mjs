/**
 * GET /health — what the bridge can do for the page's voice, read once at boot
 * (src/lib/capabilities.ts) to choose the recogniser and the voice.
 *
 * Moved out of server.mjs unchanged. The credentials and engine choice stay
 * there — `elevenKey`, `sttEngine` read the bridge's environment — and are
 * passed in with the Piper voice lookups, called exactly as before: the voice
 * list only without an ElevenLabs key, the default voice only for Piper.
 * Nothing here is written, and no key is ever put in the answer. server.mjs
 * also does everything that comes before any route — the Host and Origin
 * checks, OPTIONS, the CORS headers — and hands this handler the `cors`.
 */

export const HEALTH_PATH = '/health'

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{
 *   cors: Record<string, string>,
 *   lang: string,
 *   elevenKey: () => string | null,
 *   sttEngine: () => 'deepgram' | 'elevenlabs' | null,
 *   piperVoices: (lang: string) => string[],
 *   defaultPiperVoice: (lang: string) => string | null,
 * }} d
 */
export function healthRequest(req, res, { cors, lang, elevenKey, sttEngine, piperVoices, defaultPiperVoice }) {
  // The browser reads this once at boot to decide which voice engine to use.
  // Both premium paths ride the same ElevenLabs key, so both flags track it:
  // with a key the app transcribes with Scribe and speaks with ElevenLabs;
  // without one it falls back to the browser's own recogniser and voice, so a
  // student with nothing configured still has a working assistant.
  //
  // Speech has a free middle tier: a local Piper voice, when one is
  // installed, replaces the browser voice without any key. Recognition does
  // not — Piper only speaks — so `stt` still tracks the key alone.
  const eleven = Boolean(elevenKey())
  const voices = eleven ? [] : piperVoices(lang)
  const ttsEngine = eleven ? 'elevenlabs' : voices.length ? 'piper' : null
  const realtime = sttEngine()
  res.writeHead(200, { ...cors, 'content-type': 'application/json' })
  return res.end(
    JSON.stringify({
      ok: true,
      tts: Boolean(ttsEngine),
      stt: eleven,
      sttRealtime: realtime !== null,
      sttEngine: realtime,
      ttsEngine,
      voices,
      voice: ttsEngine === 'piper' ? defaultPiperVoice(lang) : null,
    }),
  )
}
