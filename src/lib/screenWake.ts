/**
 * The screen stays on while he is answering, and only then.
 *
 * A phone dims and locks on its own timer, and an answer of a minute was cut
 * off by the lock screen halfway through. The Screen Wake Lock is held by each
 * answer from the moment it is asked for until the whole answer has been said
 * (or stopped) — including the wait for the first word and the pauses between
 * sentences, which can be long while the model searches. It used to be taken
 * at the first sound and let go after 2.5 s of silence; the first word came up
 * to 24 s after the question (the bridge's latency log), so on a 15–30 s screen
 * timer the screen went off before he said anything, Android froze the page
 * and the socket died with the answer. Every hold carries a cap, so a speaker
 * that never finishes is let go all the same.
 *
 * Every speaker is an owner; the lock is held while any owner holds it and let
 * go when the last one leaves. The browser drops the lock itself when the page
 * is hidden; if an owner still holds it when the page comes back it is taken
 * again. Where the API does not exist (or refuses) nothing happens and speech
 * goes on exactly as before: it only asks the screen to stay on, it cannot
 * keep a locked phone or a closed tab awake.
 */

type Sentinel = {
  release: () => Promise<void>
  addEventListener: (type: 'release', fn: () => void) => void
  released?: boolean
}

type Listenable = {
  addEventListener: (type: string, fn: () => void) => void
  removeEventListener: (type: string, fn: () => void) => void
}

type Timers = {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (t: unknown) => void
}

/** What the page can say about the lock, for the diagnostics. Never claims a lock the browser did not grant. */
export type WakeState = { supported: boolean; held: boolean; owners: number; lastError: string }

export function createScreenWake(d: {
  /** navigator.wakeLock.request('screen'), or null where there is none. */
  request: (() => Promise<Sentinel>) | null
  doc: Listenable & { visibilityState: string }
  timers?: Timers
}) {
  const timers = d.timers ?? (globalThis as unknown as Timers)
  /** Owners holding the screen, each with the timer that will let it go, if one is running. */
  const owners = new Map<object, unknown>()
  let sentinel: Sentinel | null = null
  let pending = false
  let lastError = ''

  const wanted = () => owners.size > 0

  const acquire = () => {
    if (!d.request || sentinel || pending || !wanted() || d.doc.visibilityState !== 'visible') return
    pending = true
    d.request().then(
      (s) => {
        pending = false
        lastError = ''
        // Every owner left while the browser was answering: give it straight back.
        if (!wanted()) {
          void s.release().catch(() => {})
          return
        }
        sentinel = s
        s.addEventListener('release', () => {
          if (sentinel === s) sentinel = null
        })
      },
      (err: unknown) => {
        // Refused (battery saver, policy, hidden): speech is unaffected.
        pending = false
        lastError = String((err as { name?: string })?.name ?? 'refused')
      },
    )
  }

  const releaseIfUnwanted = () => {
    if (wanted()) return
    const s = sentinel
    sentinel = null
    void s?.release().catch(() => {})
  }

  const leave = (owner: object) => {
    const t = owners.get(owner)
    if (t !== undefined && t !== null) timers.clearTimeout(t)
    owners.delete(owner)
    releaseIfUnwanted()
  }

  const onVisibility = () => {
    if (d.doc.visibilityState === 'visible') acquire()
  }
  d.doc.addEventListener('visibilitychange', onVisibility)

  return {
    /**
     * `owner` needs the screen: keep it on until it lets go — and, with `capMs`,
     * for at most that long unless held again, so an owner that never lets go
     * (a sound whose end never fires) cannot keep the screen on for good.
     */
    hold(owner: object, capMs = 0) {
      const t = owners.get(owner)
      if (t !== undefined && t !== null) timers.clearTimeout(t)
      owners.set(owner, capMs > 0 ? timers.setTimeout(() => leave(owner), capMs) : null)
      // A lock the browser has already dropped is not held, whatever we kept.
      if (sentinel?.released) sentinel = null
      acquire()
    },
    /** `owner` is done: let go after `ms`, or now with 0 (a stop). A later hold() cancels it. */
    letGo(owner: object, ms = 0) {
      if (!owners.has(owner)) return
      const t = owners.get(owner)
      if (t !== undefined && t !== null) timers.clearTimeout(t)
      if (ms <= 0) leave(owner)
      else owners.set(owner, timers.setTimeout(() => leave(owner), ms))
    },
    /** Whether the page holds a lock the browser granted. */
    held: () => sentinel !== null && !sentinel.released,
    state: (): WakeState => ({ supported: Boolean(d.request), held: sentinel !== null && !sentinel.released, owners: owners.size, lastError }),
    dispose() {
      for (const t of owners.values()) if (t !== undefined && t !== null) timers.clearTimeout(t)
      owners.clear()
      releaseIfUnwanted()
      d.doc.removeEventListener('visibilitychange', onVisibility)
    },
  }
}

const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<Sentinel> } }) : null
const noDoc: Listenable & { visibilityState: string } = {
  visibilityState: 'hidden',
  addEventListener: () => {},
  removeEventListener: () => {},
}

/** The page's one screen lock, driven by tts.ts. */
export const screenWake = createScreenWake({
  request: nav?.wakeLock ? () => nav.wakeLock!.request('screen') : null,
  doc: typeof document !== 'undefined' ? (document as unknown as Listenable & { visibilityState: string }) : noDoc,
})

// For a check on the phone: `__wake()` in the console says whether the
// browser granted the lock. Nothing about the user is in it.
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__wake = screenWake.state
}
