/**
 * What the page shows about its connection to the bridge.
 *
 * A VPN switched on, or the phone moving between Wi-Fi and mobile data, drops
 * the socket for a few seconds and redial.ts brings it back on its own. Each
 * drop used to be put up as a failure — "connection lost", then "connection
 * restored", in the red plate kept for real faults — so an ordinary network
 * change read as a breakdown. Now a drop is a state, not an error:
 * `reconnecting`, shown quietly; back to `ok` when the socket is; and only an
 * outage that lasts (LONG_OUTAGE_MS, or the quick retries running out) becomes
 * `down`, which is said plainly, with a way to try again.
 *
 * A note — the reconnect started a new conversation, or a question was cut
 * off — is information, not an alarm, and goes on the quiet line too.
 *
 * Pure apart from its timer, which it is given, so the tests drive it.
 */

export type LinkState = 'ok' | 'reconnecting' | 'down'

type Timers = {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (t: unknown) => void
}

/** A drop still not mended after this long is an outage, and said so. */
export const LONG_OUTAGE_MS = 20_000

export function createLinkStatus(d: {
  onChange: (state: LinkState) => void
  timers?: Timers
  longMs?: number
}) {
  const timers = d.timers ?? (globalThis as unknown as Timers)
  const longMs = d.longMs ?? LONG_OUTAGE_MS
  let state: LinkState = 'ok'
  let long: unknown = null

  const stopClock = () => {
    if (long !== null) timers.clearTimeout(long)
    long = null
  }
  const set = (next: LinkState) => {
    if (next === state) return
    state = next
    d.onChange(next)
  }

  return {
    state: () => state,
    /** The socket dropped and is being redialled. Again and again is still one outage, with one clock. */
    lost() {
      if (state === 'down') return
      set('reconnecting')
      if (long === null) {
        long = timers.setTimeout(() => {
          long = null
          if (state === 'reconnecting') set('down')
        }, longMs)
      }
    },
    /** The quick retries ran out: no need to wait for the clock. */
    down() {
      stopClock()
      set('down')
    },
    /** The socket is open again (or for the first time). */
    restored() {
      stopClock()
      set('ok')
    },
    close() {
      stopClock()
    },
  }
}
