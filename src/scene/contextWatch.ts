/**
 * WebGL context loss, watched from outside the renderer.
 *
 * The browser may drop a context at any time (GPU reset, too many contexts,
 * a backgrounded tab). Two rules decide whether it can come back:
 *  - `webglcontextlost` must be `preventDefault()`ed, otherwise the browser
 *    treats the loss as final and never fires `webglcontextrestored`;
 *  - after a restore, three.js re-initialises its own state (it listens for the
 *    same event), so this does not touch the renderer — it only asks for a new
 *    frame.
 * If the context has not come back within `graceMs`, the scene is given up on:
 * `onGiveUp` is called so the caller can fail loudly into the scene boundary,
 * whose retry mounts a fresh Canvas (and so a fresh context).
 */
export interface ContextWatchHandlers {
  onLost: () => void
  onRestored: () => void
  onGiveUp: () => void
}

export interface Timers {
  set: (fn: () => void, ms: number) => unknown
  clear: (id: unknown) => void
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
}

export const CONTEXT_GRACE_MS = 4000

export function watchContext(
  canvas: EventTarget,
  handlers: ContextWatchHandlers,
  graceMs = CONTEXT_GRACE_MS,
  timers: Timers = realTimers,
): () => void {
  let timer: unknown = null

  const stopTimer = () => {
    if (timer !== null) timers.clear(timer)
    timer = null
  }

  const lost = (e: Event) => {
    e.preventDefault()
    handlers.onLost()
    stopTimer()
    timer = timers.set(() => {
      timer = null
      handlers.onGiveUp()
    }, graceMs)
  }

  const restored = () => {
    stopTimer()
    handlers.onRestored()
  }

  canvas.addEventListener('webglcontextlost', lost)
  canvas.addEventListener('webglcontextrestored', restored)
  return () => {
    stopTimer()
    canvas.removeEventListener('webglcontextlost', lost)
    canvas.removeEventListener('webglcontextrestored', restored)
  }
}
