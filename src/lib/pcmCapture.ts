import { getMic } from './audio'
import { startContext, within } from './audioStart'
import { FRAME_SAMPLES, PCM_RATE, createDownsampler, createFramer, floatToPcm16 } from './pcm'

/**
 * The shared microphone as 100 ms frames of 16 kHz PCM16.
 *
 * The stream comes from getMic() — the one the level meter, the VAD and the
 * clap detector already use. A second getUserMedia makes Chrome drop the
 * first stream, so this never opens one.
 */

/**
 * A context made and resumed inside the user's own touch, for the next capture.
 *
 * The capture's context used to be made only once the recogniser's session was
 * up — a second or more after the touch, after the awaits for the microphone
 * and the socket — and every automatic restart (the page coming back, the
 * swap back from the browser's recogniser) made one with no touch at all. A
 * phone would not start those, and the loop sat deaf. Made here, synchronously
 * in the touch, the context is started while the browser still counts the
 * gesture; the next capture takes it.
 */
let primed: AudioContext | null = null

/** Call synchronously from a user gesture (the start button, the tap restart). */
export function primeCapture(): void {
  try {
    if (!primed || primed.state === 'closed') primed = new AudioContext()
    void primed.resume().catch(() => {})
  } catch {
    primed = null
  }
}

/** The primed context, once: a capture owns (and closes) the context it takes. */
function takeContext(): AudioContext {
  const p = primed
  primed = null
  return p && p.state !== 'closed' ? p : new AudioContext()
}

/** For the diagnostics: what the last capture's context said when it started or failed. */
export const captureDiag = { lastState: '', primedUsed: false, stall: '' }

/** No audio from a running capture for this long, and it is looked at. */
export const STALL_MS = 4000

/** Why a running capture gave up: the audio is held (a touch is needed), or the microphone stopped feeding it. */
export type CaptureStall = 'audio-blocked' | 'audio-stalled'

/**
 * `onStall` is called once if the capture stops delivering mid-session: the
 * system suspended its context and it will not resume (`audio-blocked`), or
 * the microphone's track ended — a call, another app — and what reaches the
 * recogniser is silence it would wait on for ever (`audio-stalled`).
 */
export async function startPcmCapture(onFrame: (frame: ArrayBuffer) => void, onStall?: (why: CaptureStall) => void): Promise<{ stop: () => void }> {
  const stream = await getMic()
  captureDiag.primedUsed = primed !== null && primed.state !== 'closed'
  const ctx = takeContext()
  try {
    // Both bounded: either could wait for ever, and the session would sit open
    // and deaf with nothing reported — see audioStart.ts.
    await within(ctx.audioWorklet.addModule('/pcm-worklet.js'), 'worklet')
    await startContext(ctx)
  } catch (err) {
    captureDiag.lastState = ctx.state
    void ctx.close()
    throw err
  }
  captureDiag.lastState = ctx.state
  const source = ctx.createMediaStreamSource(stream)
  const tap = new AudioWorkletNode(ctx, 'pcm-tap', { numberOfOutputs: 1, outputChannelCount: [1] })
  // A worklet that feeds nothing may not be run; a silent sink keeps it pulled.
  const sink = ctx.createGain()
  sink.gain.value = 0
  const down = createDownsampler(ctx.sampleRate, PCM_RATE)
  const framer = createFramer(FRAME_SAMPLES)
  let lastAudio = Date.now()
  tap.port.onmessage = (e: MessageEvent<Float32Array>) => {
    lastAudio = Date.now()
    for (const f of framer.push(floatToPcm16(down.push(e.data)))) {
      const bytes = new ArrayBuffer(f.byteLength)
      new Int16Array(bytes).set(f)
      onFrame(bytes)
    }
  }
  source.connect(tap)
  tap.connect(sink)
  sink.connect(ctx.destination)

  // The watch over a running capture. Silence still arrives as frames, so no
  // frames means the context stopped; an ended track means the microphone did.
  let stopped = false
  let checking = false
  const giveUp = (why: CaptureStall) => {
    if (stopped) return
    clearInterval(watch)
    captureDiag.lastState = ctx.state
    captureDiag.stall = why
    onStall?.(why)
  }
  const watch = setInterval(() => {
    if (stopped || checking) return
    if (stream.getAudioTracks().every((t) => t.readyState !== 'live')) return giveUp('audio-stalled')
    if (Date.now() - lastAudio < STALL_MS) return
    checking = true
    // Suspended by the system (the audio taken for a moment, the page coming
    // back): asked once to resume, bounded; held, it is the touch's to start.
    startContext(ctx).then(
      () => {
        const since = lastAudio
        setTimeout(() => {
          checking = false
          if (lastAudio === since && Date.now() - lastAudio >= STALL_MS) giveUp('audio-stalled')
        }, STALL_MS)
      },
      () => giveUp('audio-blocked'),
    )
  }, 1000)

  return {
    stop: () => {
      stopped = true
      clearInterval(watch)
      tap.port.onmessage = null
      try {
        source.disconnect()
        tap.disconnect()
        sink.disconnect()
      } catch {
        /* already disconnected */
      }
      // Closes this context only; the shared stream and its tracks stay open.
      void ctx.close()
    },
  }
}
