/**
 * The page's side of "has the user already told JARVIS this?" — the request,
 * with no imports so it can be tested without the browser's environment.
 * knowledgeClient.ts wires it to the bridge address and the trace.
 *
 * This sits in front of the model, so it must never be the reason a question
 * is slow or fails: a short deadline, and every failure — bridge down, no
 * database, timeout, a malformed reply — is the same as "no answer here" and
 * the question goes to Claude as it always did. It never throws.
 */
export const KNOWN_DEADLINE_MS = 350

export type KnownTrace = (step: string, info: Record<string, string | number | boolean>) => void

export async function fetchKnown(
  said: string,
  o: { url: string; fetcher?: typeof fetch; trace?: KnownTrace; deadlineMs?: number; now?: () => number },
): Promise<string | null> {
  const { url, fetcher = fetch, trace = () => {}, deadlineMs = KNOWN_DEADLINE_MS, now = () => performance.now() } = o
  const t0 = now()
  const done = (answer: string | null, why: string): string | null => {
    trace('kb:lookup', { hit: answer !== null, why, ms: Math.round(now() - t0) })
    return answer
  }
  try {
    const res = await fetcher(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: said }),
      signal: AbortSignal.timeout(deadlineMs),
    })
    if (!res.ok) return done(null, `http-${res.status}`)
    const r = (await res.json()) as { hit?: unknown; answer?: unknown; reason?: unknown } | null
    if (r?.hit === true && typeof r.answer === 'string' && r.answer.trim()) return done(r.answer, 'hit')
    return done(null, typeof r?.reason === 'string' ? r.reason.slice(0, 30) : 'miss')
  } catch (err) {
    const timedOut = err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')
    return done(null, timedOut ? 'timeout' : 'unreachable')
  }
}
