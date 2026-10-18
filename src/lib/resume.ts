/**
 * The page's side of picking the conversation up again after a reconnect.
 *
 * The bridge names the agent session once it has one (`session`). If the socket
 * drops and comes back, the first thing sent on the new one is a request to
 * resume that session, and the reconnect is reported as `resumed` or as a fresh
 * start once the bridge answers (`resumed`, ok or not). A bridge from before
 * this never answers, so after a short wait it counts as a fresh start.
 *
 * Nothing is asked again: a question that was in flight when the socket died
 * failed with it (bridge.ts), and the report says it may not have finished.
 * The id is held in memory only — a reload starts a new conversation, as before.
 */

export type ReconnectReport = { resumed: boolean; interrupted: boolean }

type Timers = {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (t: unknown) => void
}

/**
 * How long to wait for the bridge's answer before counting the reconnect as a
 * fresh start. The bridge answers once the resumed session has actually
 * started (about a second, more with a long transcript), so this is generous;
 * a bridge from before this never answers, and only then is it reached.
 */
export const RESUME_WAIT_MS = 8000

export function createResumeClient(d: {
  send: (frame: { type: 'resume'; id: string }) => void
  report: (r: ReconnectReport) => void
  timers?: Timers
  waitMs?: number
}) {
  const timers = d.timers ?? (globalThis as unknown as Timers)
  const waitMs = d.waitMs ?? RESUME_WAIT_MS
  let session: string | null = null
  let interrupted = false
  let waiting: unknown = null

  const settle = (resumed: boolean) => {
    if (waiting === null) return
    timers.clearTimeout(waiting)
    waiting = null
    if (!resumed) session = null
    const wasInterrupted = interrupted
    interrupted = false
    d.report({ resumed, interrupted: wasInterrupted })
  }

  return {
    /** The bridge named the session this socket is on. */
    onSession(id: unknown) {
      if (typeof id === 'string' && id) session = id
    },
    /** The socket died; `asking` if a question was still in flight on it. */
    onLost(asking: boolean) {
      if (asking) interrupted = true
      if (waiting !== null) settle(false)
    },
    /** A socket opened. On a reconnect with a session to go back to, ask for it. */
    onOpen(reconnect: boolean) {
      if (!reconnect) return
      if (!session) {
        const wasInterrupted = interrupted
        interrupted = false
        d.report({ resumed: false, interrupted: wasInterrupted })
        return
      }
      waiting = timers.setTimeout(() => settle(false), waitMs)
      d.send({ type: 'resume', id: session })
    },
    /** The bridge's answer to the request. */
    onResumed(ok: unknown) {
      settle(ok === true)
    },
    current: () => session,
  }
}
