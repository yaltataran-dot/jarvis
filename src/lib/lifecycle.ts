/**
 * The page going away and coming back, as the voice loop needs to hear of it.
 *
 * A phone takes the microphone away when the screen locks or the browser goes
 * to the background, and gives nothing back on return: the loop kept running
 * on a stream that heard nothing, and he never heard his name again until the
 * page was reloaded. Nothing listened for the page coming back at all.
 *
 * Deliberately not done on hide: on a computer a hidden tab keeps its
 * microphone, and people talk to him from another window. So hiding changes
 * nothing; coming back checks, and repairs only what is actually broken. Only
 * `pagehide` — the page being unloaded or frozen into the back-forward cache —
 * lets go of the microphone, because a frozen page cannot use it.
 *
 * Pure apart from the listeners, which are added to what it is given, so the
 * tests drive it with fakes.
 */

/**
 * Not the microphone's own `ended`. A track can end because the recogniser
 * fell back to the browser's SpeechRecognition, which takes the microphone for
 * itself; restarting the loop on that killed a working fallback and started a
 * session that could fall over again — stop, release, start, around and
 * around, deaf for a second or two each time. Coming back to the screen is
 * what follows a lock screen, and that is when the stream is checked.
 */
export type ShowReason = 'visible' | 'pageshow' | 'online'
export type HideReason = 'pagehide'

type Listenable = {
  addEventListener: (type: string, fn: (e: Event) => void) => void
  removeEventListener: (type: string, fn: (e: Event) => void) => void
}

export type LifecycleDeps = {
  doc: Listenable & { visibilityState: string }
  win: Listenable
  onShow: (reason: ShowReason) => void
  onHide: (reason: HideReason) => void
}

/** Wire the page events; returns the function that unwires them all. */
export function watchLifecycle(d: LifecycleDeps): () => void {
  let hidden = d.doc.visibilityState === 'hidden'

  const onVisibility = () => {
    const nowHidden = d.doc.visibilityState === 'hidden'
    // Only the change back to visible matters, and only once per change.
    if (hidden && !nowHidden) d.onShow('visible')
    hidden = nowHidden
  }
  const onPageShow = (e: Event) => {
    // A fresh load is the boot's business; only a page restored from the
    // back-forward cache comes back with its old, released microphone.
    if ((e as PageTransitionEvent).persisted) d.onShow('pageshow')
  }
  const onPageHide = () => d.onHide('pagehide')
  const onOnline = () => d.onShow('online')

  d.doc.addEventListener('visibilitychange', onVisibility)
  d.win.addEventListener('pageshow', onPageShow)
  d.win.addEventListener('pagehide', onPageHide)
  d.win.addEventListener('online', onOnline)
  return () => {
    d.doc.removeEventListener('visibilitychange', onVisibility)
    d.win.removeEventListener('pageshow', onPageShow)
    d.win.removeEventListener('pagehide', onPageHide)
    d.win.removeEventListener('online', onOnline)
  }
}

export type MicPermission = 'granted' | 'prompt' | 'denied' | 'unknown'

export type RecoveryState = {
  /** The page is on screen. A hidden page waits: a phone will not give it the microphone. */
  visible: boolean
  /** The microphone stream in use can still hear. */
  micAlive: boolean
  /** The voice loop says it works. It can say so while fed a dead stream. */
  voiceOk: boolean
  permission: MicPermission
  /** Times the loop was restarted on its own within the recent window. */
  recentRestarts: number
}

/** Automatic restarts allowed within RESTART_WINDOW_MS before a touch is asked for. */
export const MAX_AUTO_RESTARTS = 3
export const RESTART_WINDOW_MS = 120_000

/**
 * What to do when the page comes back: nothing, restart the loop, wait until
 * the page is on screen, or ask for a touch.
 *
 * A restart opens the microphone again, which is only done unprompted where
 * the browser has said it is allowed (`granted`). Anywhere else — a browser
 * that cannot say, a permission that would prompt — the user touches the
 * screen first, so the request comes from them. And restarts are counted: a
 * microphone that dies again at once is not reopened in a loop.
 */
export function planRecovery(s: RecoveryState): 'none' | 'wait' | 'restart' | 'tap' {
  if (s.micAlive && s.voiceOk) return 'none'
  if (!s.visible) return 'wait'
  if (s.permission !== 'granted') return 'tap'
  if (s.recentRestarts >= MAX_AUTO_RESTARTS) return 'tap'
  return 'restart'
}

/** Restarts within the window ending now, oldest dropped. */
export function recentCount(stamps: number[], now: number, windowMs = RESTART_WINDOW_MS): number {
  while (stamps.length && now - stamps[0] > windowMs) stamps.shift()
  return stamps.length
}

/** How long events keep arriving after one return: unlock fires visible, then online, often pageshow. */
export const SETTLE_MS = 1500

type Timers = {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (t: unknown) => void
}

/**
 * One recovery for a burst of returns.
 *
 * Unlocking a phone delivers `visibilitychange`, then `online` as the radio
 * comes back, and a restored page `pageshow` as well — each of which used to
 * start its own recovery. The burst now waits until it has been quiet for
 * `settleMs` and runs once, with every reason it carried. A return during a
 * run is not dropped: one more run follows when this one ends.
 */
export function createRecoveryGate(
  run: (reasons: ShowReason[]) => Promise<void>,
  { settleMs = SETTLE_MS, timers = globalThis as unknown as Timers } = {},
) {
  let reasons = new Set<ShowReason>()
  let timer: unknown = null
  let running = false
  let again = false
  let closed = false

  const fire = async () => {
    timer = null
    if (closed) return
    if (running) {
      again = true
      return
    }
    const batch = [...reasons]
    reasons = new Set()
    running = true
    try {
      await run(batch)
    } finally {
      running = false
      if (again && !closed) {
        again = false
        void fire()
      }
    }
  }

  return {
    schedule(reason: ShowReason) {
      if (closed) return
      reasons.add(reason)
      if (timer !== null) timers.clearTimeout(timer)
      timer = timers.setTimeout(() => void fire(), settleMs)
    },
    close() {
      closed = true
      if (timer !== null) timers.clearTimeout(timer)
      timer = null
    },
  }
}

/** Taps on these are the user using the page, not asking for the microphone. */
export const INTERACTIVE = 'button, a, input, textarea, select, label, [role="button"], .dialog, .sysdock, .bl, .panels, .suggest'

/** Whether a tap landed on something that has its own job. */
export function isInteractive(target: unknown): boolean {
  const el = target as { closest?: (s: string) => unknown } | null
  return Boolean(el && typeof el.closest === 'function' && el.closest(INTERACTIVE))
}

/**
 * Wait for one tap on the page itself, then call `onTap` and stop waiting.
 * Taps on buttons, panels and dialogs go to them and keep it waiting. The tap
 * is what makes the microphone request the user's own, which is why a restart
 * that needs one is not done on its own.
 *
 * Listened for on `pointerup`, not `pointerdown`. A browser counts a mouse
 * press as the user's gesture on the way down, but a finger only on the way
 * up: a restart begun from a touch's pointerdown had no gesture behind it, so
 * on a phone the audio it started stayed suspended and nothing was heard,
 * while the same code worked with a mouse. One event, so one tap is one
 * restart; `click` is not used because iOS does not send it for taps on
 * plain page areas.
 *
 * Only a tap: one finger, put down and lifted where it was. Zooming the page
 * with two fingers delivers both to the page (a browser that does not take the
 * gesture over sends no pointercancel), and the first finger lifting used to
 * count as the tap — a pinch restarted the microphone. A pan is not a tap
 * either.
 */
export const TAP_EVENT = 'pointerup'

/** A finger that moved farther than this between down and up was a pan or a pinch, not a tap. */
export const TAP_SLOP_PX = 12

type PointerLike = { pointerId?: number; isPrimary?: boolean; clientX?: number; clientY?: number; target?: unknown }

export function armTapOnce(win: Listenable, onTap: () => void): () => void {
  let armed = true
  /** Fingers on the screen now, by pointer, with where each came down. */
  const down = new Map<number, { x: number; y: number }>()
  /** Two or more fingers have been down since the screen was last clear: a gesture, not a tap. */
  let multi = false

  const onDown = (e: Event) => {
    const p = e as PointerLike
    down.set(p.pointerId ?? 0, { x: p.clientX ?? 0, y: p.clientY ?? 0 })
    if (down.size > 1) multi = true
  }
  /** A finger leaves the screen; returns whether this was part of a gesture, and where it started. */
  const lift = (p: PointerLike) => {
    const start = down.get(p.pointerId ?? 0)
    down.delete(p.pointerId ?? 0)
    const gesture = multi
    if (down.size === 0) multi = false
    return { start, gesture }
  }
  const onCancel = (e: Event) => void lift(e as PointerLike)
  const handler = (e: Event) => {
    const p = e as PointerLike
    const { start, gesture } = lift(p)
    if (!armed || isInteractive(p.target)) return
    // Only the primary finger or button: a second finger lifting is not a second tap.
    if (p.isPrimary === false || gesture) return
    if (start && Math.hypot((p.clientX ?? 0) - start.x, (p.clientY ?? 0) - start.y) > TAP_SLOP_PX) return
    disarm()
    onTap()
  }
  const disarm = () => {
    if (!armed) return
    armed = false
    win.removeEventListener('pointerdown', onDown)
    win.removeEventListener('pointercancel', onCancel)
    win.removeEventListener(TAP_EVENT, handler)
  }
  win.addEventListener('pointerdown', onDown)
  win.addEventListener('pointercancel', onCancel)
  win.addEventListener(TAP_EVENT, handler)
  return disarm
}

/** What the browser says about the microphone, without ever prompting. */
export async function micPermission(): Promise<MicPermission> {
  try {
    const p = await navigator.permissions?.query({ name: 'microphone' as PermissionName })
    const state = p?.state
    return state === 'granted' || state === 'prompt' || state === 'denied' ? state : 'unknown'
  } catch {
    return 'unknown'
  }
}
