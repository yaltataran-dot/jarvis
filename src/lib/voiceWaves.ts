/**
 * What the voice waves either side of the ring should be doing (ui/VoiceWaves).
 *
 *   speaking   his voice, at its real loudness, across the whole width
 *   listening  yours, from the microphone, shorter — the ring is taking it in
 *   thinking   no voice either way: a low shimmer close to the ring
 *   otherwise  still
 *
 * `level` is the store's: the speaker's output while he speaks, the
 * microphone's otherwise (App.tsx's pump). A stop takes him out of
 * 'speaking', so the long waves go with his voice, in a tenth of a second.
 */
export type WaveDrive = {
  /** 0..1 — wave height. */
  amp: number
  /** 0..1 — how far across the screen the waves run. */
  reach: number
}

const clamp = (x: number) => Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0))

export function waveTarget(phase: string, level: number): WaveDrive {
  switch (phase) {
    case 'speaking':
      return { amp: clamp(level), reach: 1 }
    case 'waking':
    case 'listening':
      return { amp: clamp(level) * 0.7, reach: 0.42 }
    case 'thinking':
    case 'tooling':
      return { amp: 0.1, reach: 0.22 }
    default:
      return { amp: 0, reach: 0 }
  }
}

/** Rises quickly with the voice, falls a little slower — and still within a tenth of a second or so. */
export const RISE = 14
export const FALL = 10

/** One step of the shown drive towards the target. */
export function follow(shown: WaveDrive, target: WaveDrive, dt: number): WaveDrive {
  const step = (cur: number, want: number) => cur + (want - cur) * Math.min(1, dt * (want > cur ? RISE : FALL))
  return { amp: step(shown.amp, target.amp), reach: step(shown.reach, target.reach) }
}
