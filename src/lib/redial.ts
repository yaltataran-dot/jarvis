/**
 * The page's one socket to the bridge: dialled once at a time, re-dialled on
 * its own when it drops, until it is back or the retries run out.
 *
 * The automatic re-dial used to stop after its first failure. Only a socket
 * that had opened and then closed scheduled the next attempt; a dial that
 * failed — the bridge still down, the phone still out of signal — rejected
 * into a `catch` that did nothing, so one retry was made and none after it.
 * A bridge that failed on boot was never retried at all. Now every failed
 * dial, whoever made it, schedules the next one.
 *
 * A socket can also die without closing. Turning a VPN on, or the phone
 * moving from Wi-Fi to mobile data, changes the route under an open
 * connection: nothing arrives any more, but the browser may go on calling it
 * open for minutes, and a dial is never made because one "is" open. So the
 * socket is asked for a sign of life (a `ping` the bridge answers with
 * `pong`) when the page comes back and every so often while it is on screen;
 * one that stays silent is dropped at once, without waiting for the close the
 * browser may never deliver, and the re-dial takes over. A bridge from before
 * this never answers a ping, so a socket is only ever dropped for silence
 * once its bridge has shown that it does answer.
 *
 * Kept free of the browser and of config.ts so the tests drive it with fake
 * sockets and timers; bridge.ts gives it `new WebSocket(...)`.
 */

/** What is used of a WebSocket. The events themselves are never read, so any handler fits. */
export type SocketLike = {
  readyState: number
  onopen: ((e: never) => void) | null
  onerror: ((e: never) => void) | null
  onclose: ((e: never) => void) | null
  close: () => void
}

const OPEN = 1

type Timers = {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (t: unknown) => void
}

/**
 * The waits before each automatic re-dial, in order. After the last one the
 * quick retries stop (`gaveUp`): a page on screen then tries once every
 * CHECK_EVERY_MS, a hidden one not at all. It starts again, from the first
 * wait, when the page comes back to the screen or the network comes back
 * (`check`), and a question dials on its own.
 */
export const REDIAL_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 8000]

/** A dial that has not opened in this long is given up on, and counts as failed. */
export const DIAL_TIMEOUT_MS = 6000

/** How often a page on screen checks its socket — or, with none, dials once. */
export const CHECK_EVERY_MS = 25_000

/** How long a socket has to show a sign of life once asked. */
export const PONG_WAIT_MS = 5000

export type DialFailure = 'error' | 'closed' | 'timeout'

export function createLink<S extends SocketLike>(d: {
  /** Opens a new socket. May throw (a bad URL); that is a failed dial too. */
  make: () => S
  /** `ws` is now the live socket. */
  opened: (ws: S) => void
  /** The live socket `ws` is gone: closed, or dropped for silence. Not called for a dial that never opened. */
  lost: (ws: S) => void
  /** The error a failed dial rejects with. */
  failure: (why: DialFailure) => Error
  /** Asks `ws` for a sign of life. Without it the socket is never checked. */
  ping?: (ws: S) => void
  /** The page is on screen. A hidden page is not checked and does not dial on its own. */
  visible?: () => boolean
  /** The quick retries ran out; once per outage. */
  gaveUp?: () => void
  delays?: number[]
  timeoutMs?: number
  checkEveryMs?: number
  pongWaitMs?: number
  timers?: Timers
}) {
  const timers = d.timers ?? (globalThis as unknown as Timers)
  const delays = d.delays ?? REDIAL_DELAYS_MS
  const timeoutMs = d.timeoutMs ?? DIAL_TIMEOUT_MS
  const checkEveryMs = d.checkEveryMs ?? CHECK_EVERY_MS
  const pongWaitMs = d.pongWaitMs ?? PONG_WAIT_MS
  const visible = d.visible ?? (() => true)
  let live: S | null = null
  let connecting: Promise<S> | null = null
  /** Automatic re-dials made since the socket was last open. */
  let attempt = 0
  let waiting: unknown = null
  let reportedGiveUp = false
  /** The live socket's bridge has answered a ping: silence from it now means it is dead. */
  let answers = false
  /** Waiting for a sign of life from the live socket. */
  let asking: unknown = null
  let ticking = false

  const isOpen = () => live !== null && live.readyState === OPEN

  const cancel = () => {
    if (waiting !== null) timers.clearTimeout(waiting)
    waiting = null
  }

  const stopAsking = () => {
    if (asking !== null) timers.clearTimeout(asking)
    asking = null
  }

  /**
   * One wait, then one dial. Never more than one wait at a time, none while a
   * dial is under way (its own failure lands back here) or a socket is open,
   * and never a dial in the same tick, so a failure cannot spin.
   */
  const schedule = () => {
    if (waiting !== null || connecting || isOpen()) return
    if (attempt >= delays.length) {
      if (!reportedGiveUp) {
        reportedGiveUp = true
        d.gaveUp?.()
      }
      return
    }
    const ms = delays[attempt]
    attempt += 1
    waiting = timers.setTimeout(() => {
      waiting = null
      // A failure here is not swallowed: connect() schedules the next attempt itself.
      connect().catch(() => {})
    }, ms)
  }

  /** The live socket is gone, whether or not the browser has said so yet. */
  const drop = (ws: S) => {
    if (live !== ws) return
    live = null
    stopAsking()
    d.lost(ws)
    // Its close, whenever it comes, finds it no longer live and changes nothing.
    try {
      ws.close()
    } catch {
      // Already closed.
    }
    schedule()
  }

  /** Ask the live socket for a sign of life; drop it if a bridge that answers stays silent. */
  const probe = () => {
    const ws = live
    if (!ws || !isOpen() || !d.ping || asking !== null) return
    asking = timers.setTimeout(() => {
      asking = null
      if (live === ws && answers) drop(ws)
    }, pongWaitMs)
    try {
      d.ping(ws)
    } catch {
      // A send that throws is a socket already going; its close follows.
    }
  }

  /** Every CHECK_EVERY_MS for the life of the page, from its first dial. */
  const tick = () => {
    timers.setTimeout(() => {
      tick()
      if (!visible()) return
      if (isOpen()) probe()
      // The quick retries ran out: one dial now and then, without starting them again.
      else if (!connecting && waiting === null) connect().catch(() => {})
    }, checkEveryMs)
  }

  function connect(): Promise<S> {
    if (!ticking) {
      ticking = true
      tick()
    }
    if (isOpen()) return Promise.resolve(live as S)
    if (connecting) return connecting
    // A dial now stands in for a pending re-dial, never alongside it.
    cancel()

    let resolve!: (ws: S) => void
    let reject!: (err: Error) => void
    const dial = new Promise<S>((res, rej) => {
      resolve = res
      reject = rej
    })
    // Set before the socket is made: a constructor that throws settles at
    // once, and must not leave this pointing at a dead promise.
    connecting = dial
    let settled = false
    let timer: unknown = null

    /**
     * Every end of a dial runs through here. Clearing `connecting` is what
     * keeps one failed dial from being handed to every later caller; on a
     * failure the next attempt is scheduled, whoever asked for this one.
     */
    const settle = (ws: S | null, err: Error | null) => {
      if (settled) return
      settled = true
      if (timer !== null) timers.clearTimeout(timer)
      if (connecting === dial) connecting = null
      if (err) {
        reject(err)
        schedule()
      } else resolve(ws as S)
    }

    let ws: S
    try {
      ws = d.make()
    } catch {
      settle(null, d.failure('error'))
      return dial
    }

    timer = timers.setTimeout(() => {
      ws.close()
      settle(null, d.failure('timeout'))
    }, timeoutMs)

    ws.onopen = () => {
      // Given up on already (timed out): it must not become a second live socket.
      if (settled) {
        ws.close()
        return
      }
      // An old socket still closing when this one opened is gone now; its own
      // close, whenever it comes, no longer touches the live one.
      const old = live
      if (old !== null && old !== ws) {
        live = null
        d.lost(old)
      }
      live = ws
      attempt = 0
      reportedGiveUp = false
      answers = false
      stopAsking()
      cancel()
      d.opened(ws)
      settle(ws, null)
      // Learns at once whether this bridge answers, so a later silence can be read.
      probe()
    }
    ws.onerror = () => settle(null, d.failure('error'))
    ws.onclose = () => {
      // A close before open is a failed dial; after open, a lost session.
      settle(null, d.failure('closed'))
      if (live === ws) drop(ws)
    }
    return dial
  }

  const now = () => {
    if (isOpen() || connecting) return
    attempt = 0
    connect().catch(() => {})
  }

  return {
    /** The open socket, dialling if there is none. Concurrent calls share one dial. */
    connect,
    /** The live socket, open or closing; null when there is none. */
    socket: (): S | null => live,
    /**
     * Something arrived on `ws`; `pong` if it was the answer to a ping. Any
     * frame is a sign of life.
     */
    heard(ws: S, pong = false) {
      if (ws !== live) return
      if (pong) answers = true
      stopAsking()
    },
    /**
     * Dial now, with a fresh set of retries, if there is no live socket and no
     * dial under way.
     */
    now,
    /**
     * The page came back or the network changed: an open socket is asked for
     * a sign of life (it may have died under a VPN switch without closing),
     * and with none open a dial is made at once, with a fresh set of retries.
     */
    check() {
      if (isOpen()) probe()
      else now()
    },
    /** For the tests: whether a re-dial is waiting, and how many have been made. */
    waiting: () => waiting !== null,
    attempts: () => attempt,
  }
}
