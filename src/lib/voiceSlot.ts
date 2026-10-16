/**
 * The one voice loop of the page.
 *
 * Starting a loop opens the microphone and a recogniser, and two of them hear
 * every phrase twice. The boot starts it once; a microphone that failed is
 * started again on request; the page coming down stops it. All three go
 * through here so that none of them can leave a second loop running: a start
 * while one is already starting gets that one, a start while a working one
 * runs gets the running one, and a stop while one is still starting stops it
 * the moment it arrives.
 */

export type SlotVoice = { stop: () => void; ok: () => boolean }

export type VoiceSlot<V extends SlotVoice> = {
  /** The running loop if it works; otherwise a new one, replacing a dead one. */
  start: () => Promise<V>
  stop: () => void
  current: () => V | null
}

export function makeVoiceSlot<V extends SlotVoice>(
  launch: () => Promise<V>,
  log: (step: string, info?: Record<string, string | number | boolean>) => void = () => {},
): VoiceSlot<V> {
  let current: V | null = null
  let starting: Promise<V> | null = null
  /** Moves on every stop, so a start that was under way knows it is unwanted. */
  let generation = 0
  let startingGeneration = -1

  const start = (): Promise<V> => {
    if (current?.ok()) return Promise.resolve(current)
    if (starting) {
      // One already on its way for us; or one a stop has written off, which
      // is let finish (and stop itself) before ours starts.
      return startingGeneration === generation ? starting : starting.then(start, start)
    }
    const mine = generation
    startingGeneration = mine
    const dead = current
    current = null
    dead?.stop()
    log('voice:start', { replacing: Boolean(dead) })
    starting = launch()
      .then((v) => {
        if (mine !== generation) {
          // Stopped while it was starting: the page that wanted it is gone.
          log('voice:discarded')
          v.stop()
          return v
        }
        current = v
        log('voice:started', { ok: v.ok() })
        return v
      })
      .finally(() => {
        starting = null
      })
    return starting
  }

  return {
    start,
    stop: () => {
      generation++
      const v = current
      current = null
      if (v) log('voice:stop')
      v?.stop()
    },
    current: () => current,
  }
}
