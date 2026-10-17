import { diag, trace, type Voice, type VoiceMode } from './voiceCore'

/**
 * Which engine hears the user: Scribe if it works, the browser's own if not.
 *
 * Exactly one engine holds the microphone at any moment. A failed Scribe is
 * stopped before the browser engine is started, and the browser engine is
 * stopped before Scribe is tried again — two at once would hear every phrase
 * twice and answer it twice.
 *
 * Going back to Scribe is attempted every RETRY_MS, but only at a moment that
 * costs nothing: the loop is dormant (waiting for his name, or paused for
 * playback) and the engine is between phrases. The swap leaves the microphone
 * unattended for as long as Scribe takes to come up, so it is never done while
 * the user may be mid-sentence or in a conversation. The limit that follows: in
 * a conversation that never lets the loop go dormant, the browser engine stays
 * until it does.
 */

export const RETRY_MS = 60_000
/** How often a due retry looks again for a quiet moment. */
export const POLL_MS = 5_000

type Engine = Voice

export type SupervisorDeps = {
  mode: () => VoiceMode
  /** A fresh single-use token. Rejects when Scribe cannot be reached. */
  getToken: () => Promise<string>
  /** Open Scribe with `token`; reject if it cannot be brought up. `onFail` reports a later death. */
  startScribe: (token: string, onFail: (reason: string) => void) => Promise<Engine>
  /** The fallback. Starts synchronously and cannot fail to be returned. */
  startBrowser: () => Engine
  retryMs?: number
  pollMs?: number
  /** What the realtime engine is called in diagnostics. Default 'scribe'. */
  realtimeName?: string
}

export async function superviseVoice(d: SupervisorDeps): Promise<Voice> {
  const retryMs = d.retryMs ?? RETRY_MS
  const pollMs = d.pollMs ?? POLL_MS
  const realtimeName = d.realtimeName ?? 'scribe'

  let stopped = false
  let current: Engine | null = null
  let kind: 'scribe' | 'browser' = 'browser'
  /** Between engines: nothing is listening, but the loop is not dead. */
  let switching = false
  let timer: ReturnType<typeof setTimeout> | null = null
  /** Moves on every engine started, so a late failure report from an old one is ignored. */
  let epoch = 0

  const later = (ms: number) => {
    if (timer) clearTimeout(timer)
    timer = stopped ? null : setTimeout(restore, ms)
  }

  const toBrowser = (reason: string) => {
    if (stopped) return
    epoch++
    kind = 'browser'
    current = d.startBrowser()
    diag.engine = 'browser'
    trace('voice:engine', { engine: 'browser', reason: reason.slice(0, 40) })
    later(retryMs)
  }

  const onScribeFail = (mine: number) => (reason: string) => {
    if (stopped || mine !== epoch || kind !== 'scribe') return
    // The failed engine has already let go of the microphone and handed on
    // what it heard; stopping it again is harmless and makes that certain.
    current?.stop()
    toBrowser(reason)
  }

  /** The quiet moment a swap needs. */
  const safe = () => {
    const m = d.mode()
    return (m === 'wake' || m === 'deaf') && Boolean(current?.idle?.())
  }

  async function restore() {
    timer = null
    if (stopped || kind !== 'browser' || switching) return
    if (!safe()) return later(pollMs)
    switching = true
    try {
      // The token first, while the browser engine is still listening: if
      // Scribe cannot be reached the swap never starts.
      let token: string
      try {
        token = await d.getToken()
      } catch {
        trace('voice:retry-failed', { step: 'token' })
        return later(retryMs)
      }
      // Time passed while the token was fetched; the moment may be gone.
      if (stopped || !safe()) return later(pollMs)

      const old = current
      current = null
      old?.stop()
      const mine = ++epoch
      try {
        const scribe = await d.startScribe(token, onScribeFail(mine))
        if (stopped || mine !== epoch) {
          scribe.stop()
          return
        }
        current = scribe
        kind = 'scribe'
        diag.engine = realtimeName
        trace('voice:engine', { engine: realtimeName, reason: 'restored' })
      } catch {
        trace('voice:retry-failed', { step: 'session' })
        toBrowser('retry-failed')
      }
    } finally {
      switching = false
    }
  }

  // First start: Scribe, and the browser engine at once if it will not come up.
  try {
    const token = await d.getToken()
    const mine = ++epoch
    current = await d.startScribe(token, onScribeFail(mine))
    kind = 'scribe'
    diag.engine = realtimeName
    trace('voice:engine', { engine: realtimeName, reason: 'start' })
  } catch {
    toBrowser('start-failed')
  }

  return {
    ok: () => switching || Boolean(current?.ok()),
    live: () => Boolean(current?.live()),
    rearm: () => (current ? current.rearm() : Promise.resolve(false)),
    idle: () => Boolean(current?.idle?.()),
    stop: () => {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
      current?.stop()
      current = null
    },
  }
}
