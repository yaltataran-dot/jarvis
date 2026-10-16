import { useEffect, useRef } from 'react'
import { useStore } from '../store'
import { follow, waveTarget, type WaveDrive } from '../lib/voiceWaves'

/**
 * Voice waves running out sideways from the ring on the working screen — the
 * storyboard's energy streams, kept on after the start-up and driven by the
 * voice: his while he speaks, yours while he listens (see lib/voiceWaves).
 *
 * One canvas behind the HUD, one requestAnimationFrame loop reading the store
 * directly — no React render per frame. When there is nothing to show it
 * clears once and draws nothing, so at rest it costs a store read a frame.
 */

/** The ring sits slightly above centre, as the instrument layer does. */
const CENTRE_Y = 0.48

const RIBBONS = [
  { amp: 1, k: 2.1, speed: 2.6, phase: 0, off: 0, width: 2.2, alpha: 1 },
  { amp: 0.65, k: 3.3, speed: 3.4, phase: 1.9, off: -0.012, width: 1.4, alpha: 0.8 },
  { amp: 0.45, k: 1.4, speed: 1.8, phase: 3.6, off: 0.014, width: 1.1, alpha: 0.65 },
  { amp: 0.3, k: 4.2, speed: 4.1, phase: 5.0, off: 0.004, width: 2.8, alpha: 0.45 },
]

export function VoiceWaves() {
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const el = canvas.current
    if (!el) return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const ctx = el.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(1.25, window.devicePixelRatio || 1)
    let w = 0
    let h = 0
    let raf = 0
    let last = performance.now()
    let shown: WaveDrive = { amp: 0, reach: 0 }
    let blank = false

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const { phase, level } = useStore.getState()
      shown = follow(shown, waveTarget(phase, level), dt)

      if (el.clientWidth !== w || el.clientHeight !== h) {
        w = el.clientWidth
        h = el.clientHeight
        el.width = Math.round(w * dpr)
        el.height = Math.round(h * dpr)
        blank = false
      }
      if (shown.amp < 0.004 || shown.reach < 0.01) {
        if (!blank) {
          ctx.setTransform(1, 0, 0, 1, 0, 0)
          ctx.clearRect(0, 0, el.width, el.height)
          blank = true
        }
        return
      }
      blank = false

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.globalCompositeOperation = 'source-over'
      ctx.clearRect(0, 0, w, h)
      ctx.globalCompositeOperation = 'lighter'

      const cx = w / 2
      const cy = h * CENTRE_Y
      // Just outside the ring, to the edge of the screen at full reach.
      const start = Math.min(w, h) * 0.3
      const reach = start + (w / 2 - start) * shown.reach
      const height = Math.min(w, h) * 0.075 * (0.25 + shown.amp * 1.6)
      const t = now / 1000

      for (const side of [-1, 1]) {
        const grad = ctx.createLinearGradient(cx + side * start, 0, cx + side * reach, 0)
        grad.addColorStop(0, 'rgba(255, 226, 180, 1)')
        grad.addColorStop(0.3, 'rgba(255, 150, 40, 1)')
        grad.addColorStop(1, 'rgba(255, 90, 0, 0)')
        ctx.strokeStyle = grad
        RIBBONS.forEach((rb) => {
          ctx.beginPath()
          for (let d = start; d <= reach; d += 6) {
            const u = (d - start) / Math.max(1, reach - start)
            // Rises out of the ring, tapers to nothing at the far end.
            const env = Math.sin(Math.min(1, u * 4) * (Math.PI / 2)) * (1 - u) ** 1.3
            const y = cy + rb.off * h + rb.amp * height * env * Math.sin((d / start) * rb.k * 2.4 - t * rb.speed + rb.phase)
            const x = cx + side * d
            if (d === start) ctx.moveTo(x, y)
            else ctx.lineTo(x, y)
          }
          for (const [scale, alpha] of [[7, 0.05], [2.6, 0.16], [1, 0.8]] as const) {
            ctx.lineWidth = rb.width * scale
            ctx.globalAlpha = alpha * rb.alpha * Math.min(1, 0.35 + shown.amp * 1.4)
            ctx.stroke()
          }
        })
      }
      ctx.globalAlpha = 1
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])

  return <canvas ref={canvas} className="voice-waves" aria-hidden />
}
