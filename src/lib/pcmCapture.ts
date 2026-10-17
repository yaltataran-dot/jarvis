import { getMic } from './audio'
import { FRAME_SAMPLES, PCM_RATE, createDownsampler, createFramer, floatToPcm16 } from './pcm'

/**
 * The shared microphone as 100 ms frames of 16 kHz PCM16.
 *
 * The stream comes from getMic() — the one the level meter, the VAD and the
 * clap detector already use. A second getUserMedia makes Chrome drop the
 * first stream, so this never opens one.
 */
export async function startPcmCapture(onFrame: (frame: ArrayBuffer) => void): Promise<{ stop: () => void }> {
  const stream = await getMic()
  const ctx = new AudioContext()
  try {
    await ctx.audioWorklet.addModule('/pcm-worklet.js')
    if (ctx.state === 'suspended') await ctx.resume()
  } catch (err) {
    void ctx.close()
    throw err
  }
  const source = ctx.createMediaStreamSource(stream)
  const tap = new AudioWorkletNode(ctx, 'pcm-tap', { numberOfOutputs: 1, outputChannelCount: [1] })
  // A worklet that feeds nothing may not be run; a silent sink keeps it pulled.
  const sink = ctx.createGain()
  sink.gain.value = 0
  const down = createDownsampler(ctx.sampleRate, PCM_RATE)
  const framer = createFramer(FRAME_SAMPLES)
  tap.port.onmessage = (e: MessageEvent<Float32Array>) => {
    for (const f of framer.push(floatToPcm16(down.push(e.data)))) {
      const bytes = new ArrayBuffer(f.byteLength)
      new Int16Array(bytes).set(f)
      onFrame(bytes)
    }
  }
  source.connect(tap)
  tap.connect(sink)
  sink.connect(ctx.destination)
  return {
    stop: () => {
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
