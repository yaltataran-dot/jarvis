/**
 * A single shared microphone stream plus an analyser, so the reactor can pulse
 * with the user's voice. Opening the mic more than once causes Chrome to drop
 * the earlier stream, so everything that needs audio goes through here.
 */

/** The part of a MediaStream the microphone keeper looks at; tests pass fakes. */
type MicTrack = { readyState: string; stop: () => void }
type MicStream = { getAudioTracks: () => MicTrack[] }

/**
 * The one microphone stream, kept alive.
 *
 * It used to be opened once and handed out for the life of the page. A phone
 * ends the stream's tracks when the screen locks or the browser goes to the
 * background, and the dead stream was handed out from then on: the recogniser
 * was fed silence and he stopped hearing anything until the page was reloaded.
 * So a stream is handed out only while one of its tracks is live; a dead one
 * is let go and the next request opens a fresh one. Two requests at once share
 * one getUserMedia — two would make Chrome drop the first stream.
 */
export function createMicKeeper<S extends MicStream>(request: () => Promise<S>) {
  let stream: S | null = null
  let pending: Promise<S> | null = null

  const live = (s: S | null) => Boolean(s?.getAudioTracks().some((t) => t.readyState === 'live'))

  const release = () => {
    const s = stream
    stream = null
    for (const t of s?.getAudioTracks() ?? []) t.stop()
  }

  const get = (): Promise<S> => {
    if (live(stream)) return Promise.resolve(stream!)
    if (pending) return pending
    release()
    pending = request()
      .then((s) => {
        stream = s
        return s
      })
      .finally(() => {
        pending = null
      })
    return pending
  }

  return {
    get,
    /** Whether the stream being handed out can still hear. */
    alive: () => live(stream),
    /** Stop the tracks and forget the stream; the next get() opens a new one. */
    release,
    current: () => stream,
  }
}

const mic = createMicKeeper(() =>
  navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  }),
)

export const getMic = (): Promise<MediaStream> => mic.get()
export const micAlive = mic.alive
export const releaseMic = mic.release

let ctx: AudioContext | null = null
let analyser: AnalyserNode | null = null
let buf: Uint8Array | null = null
/** The stream the analyser listens to, so a replaced stream gets a new one. */
let analysed: MediaStream | null = null

export async function startAnalyser(): Promise<void> {
  const s = await getMic()
  if (analyser && analysed === s) return
  void ctx?.close()
  ctx = new AudioContext()
  const src = ctx.createMediaStreamSource(s)
  analyser = ctx.createAnalyser()
  analyser.fftSize = 512
  analyser.smoothingTimeConstant = 0.75
  src.connect(analyser)
  buf = new Uint8Array(analyser.frequencyBinCount)
  analysed = s
}

/** 0..1 loudness. Returns 0 before the analyser is up. */
export function micLevel(): number {
  if (!analyser || !buf) return 0
  analyser.getByteFrequencyData(buf as Uint8Array<ArrayBuffer>)
  let sum = 0
  // Skip the lowest bins — they're mostly rumble and mains hum.
  for (let i = 4; i < buf.length; i++) sum += buf[i]
  const avg = sum / (buf.length - 4) / 255
  // Voice sits low in this range; stretch it so the visuals actually move.
  return Math.min(1, avg * 3.2)
}

/** Analyser fed from an <audio> element, so the orb reacts while JARVIS talks. */
export function attachOutputAnalyser(el: HTMLAudioElement): () => number {
  const c = new AudioContext()
  const src = c.createMediaElementSource(el)
  const a = c.createAnalyser()
  a.fftSize = 512
  a.smoothingTimeConstant = 0.7
  src.connect(a)
  a.connect(c.destination)
  const b = new Uint8Array(a.frequencyBinCount)
  return () => {
    a.getByteFrequencyData(b as Uint8Array<ArrayBuffer>)
    let sum = 0
    for (let i = 2; i < b.length; i++) sum += b[i]
    return Math.min(1, sum / (b.length - 2) / 255 * 3)
  }
}
