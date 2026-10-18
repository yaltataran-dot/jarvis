/**
 * Starting an AudioContext without waiting on it for ever.
 *
 * A browser that has not been given a touch it accepts (or that has the audio
 * taken by something else) does not reject `resume()`: the Web Audio spec has
 * it hold the promise until the context is allowed to start. On a phone that
 * was the whole failure — the recogniser's session opened, the capture waited
 * on a resume that never came, no audio and no error reached anyone, and the
 * bridge closed the session as idle 30 s later (`stt session ended (4408)`).
 * Desktop never showed it: a mouse press is a gesture the browser accepts on
 * the spot.
 *
 * So the start is bounded. If the context is not running by then, the caller
 * gets an error it can name, and the page asks for a touch — the one thing
 * that lets the browser start the audio.
 */

/** How long a context may take to start before it counts as refused. */
export const AUDIO_START_MS = 2500

/** The browser would not start the audio: a touch on the page is needed. */
export class AudioBlockedError extends Error {
  step: 'resume' | 'worklet'
  constructor(step: 'resume' | 'worklet') {
    super(step === 'worklet' ? 'audio worklet did not load' : 'audio context did not start')
    this.name = 'AudioBlockedError'
    this.step = step
  }
}

type Timers = {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (t: unknown) => void
}

type Startable = {
  state: string
  resume: () => Promise<void>
}

/** `work` within `ms`, or an AudioBlockedError for `step`. A late result is dropped. */
export function within<T>(work: Promise<T>, step: 'resume' | 'worklet', ms = AUDIO_START_MS, timers: Timers = globalThis as unknown as Timers): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = timers.setTimeout(() => reject(new AudioBlockedError(step)), ms)
    work.then(
      (v) => {
        timers.clearTimeout(t)
        resolve(v)
      },
      (err: unknown) => {
        timers.clearTimeout(t)
        reject(err)
      },
    )
  })
}

/**
 * Resume `ctx` and make sure it runs. Resolves once it does; rejects with
 * AudioBlockedError if the browser holds it suspended past `ms`.
 */
export async function startContext(ctx: Startable, ms = AUDIO_START_MS, timers?: Timers): Promise<void> {
  if (ctx.state === 'running') return
  try {
    await within(ctx.resume(), 'resume', ms, timers)
  } catch (err) {
    if (err instanceof AudioBlockedError) throw err
    // A rejected resume (an old engine, a closed context) is a refusal too.
    throw new AudioBlockedError('resume')
  }
  if (ctx.state !== 'running') throw new AudioBlockedError('resume')
}
