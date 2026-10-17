/**
 * Microphone samples to what the recogniser wants: 16 kHz, mono, 16-bit, in
 * frames of about 100 ms. Pure functions and two small stateful helpers, so the
 * numbers can be tested without an AudioContext.
 */

export const PCM_RATE = 16_000
/** 100 ms at 16 kHz. */
export const FRAME_SAMPLES = 1600

/** Float samples in [-1, 1] to signed 16-bit, clipped rather than wrapped. */
export function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const x = Math.max(-1, Math.min(1, input[i]))
    out[i] = x < 0 ? Math.round(x * 0x8000) : Math.round(x * 0x7fff)
  }
  return out
}

/**
 * Lower the sample rate by averaging each output sample's span of input, which
 * is also the low-pass that stops the folded-over highs. Keeps its position
 * between calls, so the blocks the audio thread delivers join without a seam.
 * Any ratio works; 48000 -> 16000 is exactly three inputs per output.
 */
export function createDownsampler(inRate: number, outRate = PCM_RATE) {
  if (!(inRate >= outRate)) throw new Error('cannot upsample')
  const ratio = inRate / outRate
  let acc = 0
  let n = 0
  let pos = 0
  return {
    push(input: Float32Array): Float32Array {
      const out: number[] = []
      for (let i = 0; i < input.length; i++) {
        acc += input[i]
        n++
        pos += 1
        if (pos >= ratio - 1e-9) {
          out.push(acc / n)
          acc = 0
          n = 0
          pos -= ratio
          if (pos < 0) pos = 0
        }
      }
      return Float32Array.from(out)
    },
  }
}

/** Collect samples and hand back whole frames; the remainder waits for the next push. */
export function createFramer(size = FRAME_SAMPLES) {
  let buf = new Int16Array(0)
  return {
    push(samples: Int16Array): Int16Array[] {
      const joined = new Int16Array(buf.length + samples.length)
      joined.set(buf)
      joined.set(samples, buf.length)
      const frames: Int16Array[] = []
      let at = 0
      while (joined.length - at >= size) {
        frames.push(joined.slice(at, at + size))
        at += size
      }
      buf = joined.slice(at)
      return frames
    },
    pending: () => buf.length,
  }
}
