/**
 * GET /scribe-token — a single-use token for the browser's realtime Scribe
 * socket (src/lib/voice.ts). The API key stays on the bridge: the page gets a
 * short-lived credential from ElevenLabs that opens one transcription session
 * and nothing else. Single use and expiry are ElevenLabs' own; the bridge
 * neither stores nor checks tokens. Neither the token nor the upstream's error
 * body is logged or passed on.
 *
 * Moved out of server.mjs unchanged. What stays there and is passed in:
 *   - `origin` and `originAllowed` — this route is stricter than the others: a
 *     request with no Origin is refused unless JARVIS_ALLOW_NO_ORIGIN is set;
 *   - `elevenKey` — the key, read from the bridge's environment;
 *   - `gap` — the one shared "last token issued" time and the minimum gap
 *     (SCRIBE_TOKEN_GAP_MS), kept in server.mjs as before: `last()` reads it,
 *     `mark(t)` sets it.
 * `fetch` and `now` default to the real ones; tests pass their own.
 */

export const SCRIBE_TOKEN_PATH = '/scribe-token'
export const SCRIBE_TOKEN_URL = 'https://api.elevenlabs.io/v1/single-use-token/realtime_scribe'

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{
 *   cors: Record<string, string>,
 *   origin: string | undefined,
 *   originAllowed: (origin: string | undefined) => boolean,
 *   elevenKey: () => string | null,
 *   gap: { ms: number, last: () => number, mark: (t: number) => void },
 *   fetch?: typeof fetch,
 *   now?: () => number,
 *   log?: (line: string) => void,
 * }} d
 */
export async function scribeTokenRequest(req, res, { cors, origin, originAllowed, elevenKey, gap, fetch: fetchFn = fetch, now: clock = Date.now, log = (line) => console.warn(line) }) {
  // Stricter than the rest of this handler: a request with no Origin is
  // refused unless JARVIS_ALLOW_NO_ORIGIN is set. The <img> case that
  // excuses it elsewhere does not apply to a fetch for a credential.
  if (!originAllowed(origin)) {
    res.writeHead(403, { ...cors, 'cache-control': 'no-store' })
    return res.end('forbidden')
  }
  const key = elevenKey()
  if (!key) {
    res.writeHead(503, { ...cors, 'cache-control': 'no-store' })
    return res.end('no elevenlabs key')
  }
  const now = clock()
  if (now - gap.last() < gap.ms) {
    res.writeHead(429, { ...cors, 'cache-control': 'no-store', 'retry-after': '2' })
    return res.end('too many requests')
  }
  gap.mark(now)
  try {
    const upstream = await fetchFn(SCRIBE_TOKEN_URL, {
      method: 'POST',
      headers: { 'xi-api-key': key },
      signal: AbortSignal.timeout(5000),
    })
    if (!upstream.ok) {
      log(`[jarvis] scribe token refused by ElevenLabs (${upstream.status})`)
      res.writeHead(502, { ...cors, 'cache-control': 'no-store' })
      return res.end('token request failed')
    }
    const { token } = await upstream.json()
    if (typeof token !== 'string' || !token) {
      res.writeHead(502, { ...cors, 'cache-control': 'no-store' })
      return res.end('token request failed')
    }
    res.writeHead(200, { ...cors, 'cache-control': 'no-store', 'content-type': 'application/json' })
    return res.end(JSON.stringify({ token }))
  } catch {
    res.writeHead(502, { ...cors, 'cache-control': 'no-store' })
    return res.end('token request failed')
  }
}
