import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { ENERGY, smooth } from '../lib/bootTimeline'

/**
 * The energy of the start-up scene, drawn on one canvas behind the ring: the
 * streams of fire out to either side, the sparks round the ring and along the
 * streams, and the faint out-of-focus lights behind — all of it there and
 * moving from the very first frame. At the click the streams turn and start
 * drawing in; at the handover to the greeting screen they draw in further and
 * then run out again, calmer — never gone; at the exit the sparks drift away.
 * Every level is eased — nothing here flashes or pulses as a whole.
 *
 * One canvas, one requestAnimationFrame loop, additive blending and a pre-drawn
 * glow sprite — no blur filters, no shadowBlur, nothing that costs per pixel
 * beyond the strokes themselves. It reads the ring's place from the DOM each
 * frame, so it follows the ring as the layout moves it, and it never causes a
 * React render: the acts arrive as props, and are only copied to refs. The
 * loop starts once, with the component, and stops with it.
 */

type Particle = {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  max: number
  size: number
  hot: boolean
  /** A large, faint, out-of-focus light — the reference's bokeh. */
  soft?: boolean
}

/** A stream of light: a travelling wave, mirrored either side of the ring. */
type Ribbon = { amp: number; k: number; speed: number; phase: number; off: number; width: number; alpha: number }

const RIBBONS: Ribbon[] = [
  { amp: 0.34, k: 1.6, speed: 1.1, phase: 0.0, off: -0.04, width: 3.2, alpha: 1 },
  { amp: 0.22, k: 2.3, speed: 1.5, phase: 1.7, off: 0.05, width: 2.2, alpha: 0.9 },
  { amp: 0.46, k: 1.1, speed: 0.7, phase: 3.1, off: 0.0, width: 1.6, alpha: 0.75 },
  { amp: 0.14, k: 3.1, speed: 1.9, phase: 4.4, off: -0.1, width: 1.2, alpha: 0.75 },
  { amp: 0.28, k: 1.9, speed: 0.9, phase: 5.2, off: 0.12, width: 1.8, alpha: 0.7 },
  { amp: 0.1, k: 2.7, speed: 1.3, phase: 2.4, off: 0.02, width: 4.2, alpha: 0.55 },
  { amp: 0.52, k: 0.8, speed: 0.55, phase: 0.9, off: -0.06, width: 1.0, alpha: 0.55 },
  { amp: 0.38, k: 1.35, speed: 1.25, phase: 4.0, off: 0.08, width: 1.0, alpha: 0.6 },
]

/** Sparks per second, and how many are already in the air on the first frame. */
const RATE = 140
const SEED = 260
const MAX_PARTICLES = 1100

function sprite(inner: string, outer: string): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  grad.addColorStop(0, inner)
  grad.addColorStop(0.25, outer)
  grad.addColorStop(1, 'rgba(255, 90, 0, 0)')
  g.fillStyle = grad
  g.fillRect(0, 0, 64, 64)
  return c
}

export function EnergyField({
  engaged,
  greet,
  exiting,
  coreRef,
}: {
  /** The start has landed (click or clap). */
  engaged: boolean
  greet: boolean
  exiting: boolean
  coreRef: RefObject<HTMLDivElement | null>
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const engageAt = useRef(0)
  const greetAt = useRef(0)
  const exitAt = useRef(0)

  useEffect(() => {
    if (engaged && !engageAt.current) engageAt.current = performance.now()
  }, [engaged])

  useEffect(() => {
    if (greet && !greetAt.current) greetAt.current = performance.now()
  }, [greet])

  useEffect(() => {
    if (exiting && !exitAt.current) exitAt.current = performance.now()
  }, [exiting])

  // A layout effect, and the first frame drawn in it: the streams and the
  // sparks are on the canvas before the page is first painted, not a frame
  // after.
  useLayoutEffect(() => {
    const el = canvas.current
    if (!el) return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const ctx = el.getContext('2d')
    if (!ctx) return

    const hot = sprite('rgba(255, 246, 225, 1)', 'rgba(255, 196, 110, 0.75)')
    const ember = sprite('rgba(255, 200, 120, 1)', 'rgba(255, 122, 0, 0.6)')
    const pool: Particle[] = []
    let seeded = false
    let pullDone = false
    let exitBurstDone = false
    let carry = 0
    let raf = 0
    let last = performance.now()
    let w = 0
    let h = 0
    // The streams' travel, integrated rather than read off the clock, so their
    // direction can turn — outwards on the splash, inwards from the click —
    // without the waves jumping.
    let flow = performance.now() / 1000
    let flowDir = 1
    const dpr = Math.min(1.5, window.devicePixelRatio || 1)

    const add = (p: Particle) => {
      if (pool.length < MAX_PARTICLES) pool.push(p)
    }
    const rnd = (a: number, b: number) => a + Math.random() * (b - a)

    /** The height of ribbon `rb` at horizontal distance `d` from the centre. */
    const ribbonY = (rb: Ribbon, i: number, d: number, R: number, reach: number, t: number, f: number) => {
      const env = smooth(R * 0.8, R * 1.45, d) * (1 - smooth(reach * 0.86, reach, d))
      // Each stream's amplitude breathes on its own slow cycle — never all
      // together.
      const breathe = 0.6 + 0.4 * Math.sin(t * (0.5 + i * 0.07) + i * 1.3)
      // A second, quicker ripple on top: the flicker of fire rather than the
      // swing of a rope.
      const flicker = 0.12 * Math.sin((d / R) * rb.k * 3.7 - t * rb.speed * 5 + rb.phase * 2)
      return rb.off * R + rb.amp * R * (Math.sin((d / R) * rb.k - f * rb.speed * 2.2 + rb.phase) + flicker) * env * breathe
    }

    /** One spark, born where the scene makes them: along the streams, round
     *  the ring, or (rarely) a bokeh light anywhere. `age` starts it part-way
     *  through its life — the seeding on the first frame. */
    const spawn = (cx: number, cy: number, R: number, reach: number, t: number, age: number) => {
      const roll = Math.random()
      if (roll < 0.06) {
        const max = rnd(2.5, 5)
        add({ x: rnd(0, w), y: rnd(h * 0.05, h * 0.8), vx: rnd(-12, 12), vy: rnd(-14, 4), life: max * age, max, size: rnd(5, 13), hot: false, soft: true })
      } else if (roll < 0.64) {
        const side = Math.random() < 0.5 ? -1 : 1
        const d = rnd(R * 1.1, reach * 0.98)
        const rb = RIBBONS[Math.floor(Math.random() * RIBBONS.length)]
        // Most close to the strands, some thrown well clear of them: the
        // spray round the fire in the reference.
        const spread = Math.random() < 0.7 ? R * 0.14 : R * 0.45
        const max = rnd(0.9, 2.4)
        add({
          x: cx + side * d,
          y: cy + ribbonY(rb, 0, d, R, reach, t, flow) + rnd(-spread, spread),
          // Along the streams' own travel: outwards, then in to the ring.
          vx: side * rnd(40, 190) * (flowDir > 0 ? 1 : -0.8),
          vy: rnd(-40, 25),
          life: max * age,
          max,
          size: rnd(0.7, 2.8),
          hot: Math.random() < 0.25,
        })
      } else {
        const a = Math.random() * Math.PI * 2
        const r0 = R * rnd(0.92, 1.12)
        const swirl = rnd(60, 170)
        const outward = rnd(15, 70)
        const max = rnd(0.8, 2.2)
        add({
          x: cx + Math.cos(a) * r0,
          y: cy + Math.sin(a) * r0,
          vx: -Math.sin(a) * swirl + Math.cos(a) * outward,
          vy: Math.cos(a) * swirl + Math.sin(a) * outward,
          life: max * age,
          max,
          size: rnd(0.8, 3),
          hot: Math.random() < 0.3,
        })
      }
    }

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now

      if (el.clientWidth !== w || el.clientHeight !== h) {
        w = el.clientWidth
        h = el.clientHeight
        el.width = Math.round(w * dpr)
        el.height = Math.round(h * dpr)
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.globalCompositeOperation = 'source-over'
      ctx.clearRect(0, 0, w, h)

      const box = coreRef.current?.getBoundingClientRect()
      if (!box || !box.width) return
      const cx = box.left + box.width / 2
      const cy = box.top + box.height / 2
      const R = box.width * 0.42
      const sinceEngage = engageAt.current ? now - engageAt.current : -1
      const sinceGreet = greetAt.current ? now - greetAt.current : -1
      const out = exitAt.current > 0
      const sinceExit = out ? now - exitAt.current : -1
      const fadeOut = out ? 1 - smooth(0, 1000, sinceExit) : 1
      const t = now / 1000

      // The click: the streams turn and start drawing in. The handover: they
      // draw in further (never all the way), then run out again, calmer,
      // behind the greeting screen.
      const engage = sinceEngage >= 0 ? smooth(0, 1400, sinceEngage) : 0
      const inward = sinceGreet >= 0 ? smooth(0, 900, sinceGreet) : 0
      const back = sinceGreet >= 0 ? smooth(900, 2600, sinceGreet) : 0
      const soften = sinceGreet >= 0 ? smooth(0, 1200, sinceGreet) : 0
      const pull = Math.max(engage * ENERGY.engagePull, inward * ENERGY.greetPull) * (1 - back)
      flowDir += ((engage > 0 && back < 0.5 ? -0.8 : 1) - flowDir) * Math.min(1, dt * 1.6)
      flow += dt * flowDir

      const full = Math.max(w * 0.56, R * 2)
      const reach = full - (full - R) * pull - full * 0.12 * back

      ctx.globalCompositeOperation = 'lighter'

      // -- the bloom behind the ring: steady, a touch more at the click,
      // softer on the greeting screen — eased, never pulsed ----------------
      const bloom = 0.32 * (1 + 0.15 * engage * (1 - soften)) * (1 - 0.2 * soften) + (out ? 0.1 * (1 - smooth(300, 1200, sinceExit)) : 0)
      const g = ctx.createRadialGradient(cx, cy, R * 0.6, cx, cy, R * 2.3)
      g.addColorStop(0, `rgba(255, 140, 40, ${bloom})`)
      g.addColorStop(0.45, `rgba(255, 100, 0, ${bloom * 0.35})`)
      g.addColorStop(1, 'rgba(255, 80, 0, 0)')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, w, h)

      // -- the streams of fire, out across the screen -----------------------
      const intensity = (1 + 0.12 * pull) * (1 - (1 - ENERGY.calmStreams) * back) * fadeOut
      for (const side of [-1, 1]) {
        const grad = ctx.createLinearGradient(cx, 0, cx + side * reach, 0)
        grad.addColorStop(0, 'rgba(255, 236, 200, 1)')
        grad.addColorStop(0.22, 'rgba(255, 170, 60, 1)')
        grad.addColorStop(0.7, 'rgba(255, 115, 0, 0.85)')
        grad.addColorStop(1, 'rgba(255, 80, 0, 0.1)')
        ctx.strokeStyle = grad
        ctx.lineCap = 'round'
        const trace = (rb: Ribbon, i: number) => {
          ctx.beginPath()
          const start = R * 0.82
          for (let d = start; d <= reach; d += 7) {
            const x = cx + side * d
            const y = cy + ribbonY(rb, i, d, R, reach, t, flow)
            if (d === start) ctx.moveTo(x, y)
            else ctx.lineTo(x, y)
          }
        }
        // The body of the fire: a few broad, soft bands under the strands,
        // so the streams read as plasma rather than wire.
        for (const [i, width, alpha] of [[2, 0.62, 0.035], [0, 0.32, 0.07], [4, 0.2, 0.08], [1, 0.1, 0.12]] as const) {
          trace(RIBBONS[i], i)
          ctx.lineWidth = R * width
          ctx.globalAlpha = alpha * intensity
          ctx.stroke()
        }
        RIBBONS.forEach((rb, i) => {
          trace(rb, i)
          for (const [scale, alpha] of [[11, 0.05], [4, 0.15], [1, 0.9]] as const) {
            ctx.lineWidth = rb.width * scale
            ctx.globalAlpha = alpha * rb.alpha * intensity
            ctx.stroke()
          }
        })
        ctx.globalAlpha = 1
      }

      // -- the first frame: the air already full of sparks ------------------
      if (!seeded) {
        seeded = true
        for (let i = 0; i < SEED; i++) spawn(cx, cy, R, reach, t, Math.random() * 0.85)
        // And moved on by their age, so they are spread, not in a line.
        for (const p of pool) {
          p.x += p.vx * p.life * 0.6
          p.y += p.vy * p.life * 0.6
        }
      }

      // -- the handover: sparks near the streams follow them in -------------
      if (sinceGreet >= 0 && !pullDone) {
        pullDone = true
        for (const p of pool) {
          // The bokeh is far behind the fire; it stays where it is.
          if (p.soft) continue
          const dx = cx - p.x
          const dy = cy - p.y
          const d = Math.hypot(dx, dy) || 1
          p.vx = p.vx * 0.4 + (dx / d) * Math.min(260, d * 0.5)
          p.vy = p.vy * 0.4 + (dy / d) * Math.min(260, d * 0.5)
        }
      }

      // -- the exit: the sparks drift out and away as the rings open --------
      if (out && !exitBurstDone) {
        exitBurstDone = true
        for (const p of pool) {
          const dx = p.x - cx
          const dy = p.y - cy
          const d = Math.hypot(dx, dy) || 1
          p.vx += (dx / d) * 160
          p.vy += (dy / d) * 160
          p.max = Math.min(p.max, p.life + 1.3)
        }
      }

      // -- new sparks, all the time until the exit --------------------------
      if (!out) {
        carry += RATE * dt
        while (carry >= 1) {
          carry -= 1
          spawn(cx, cy, R, reach, t, 0)
        }
      }

      for (let i = pool.length - 1; i >= 0; i--) {
        const p = pool[i]
        p.life += dt
        if (p.life >= p.max) {
          pool[i] = pool[pool.length - 1]
          pool.pop()
          continue
        }
        const drag = 1 - 0.9 * dt
        p.vx *= drag
        p.vy *= drag
        p.x += p.vx * dt
        p.y += p.vy * dt
        const k = p.life / p.max
        const a = (k < 0.12 ? k / 0.12 : 1 - (k - 0.12) / 0.88) * fadeOut * (p.soft ? 0.22 : 1)
        const s = p.size * 6
        ctx.globalAlpha = Math.max(0, a)
        ctx.drawImage(p.hot ? hot : ember, p.x - s / 2, p.y - s / 2, s, s)
      }
      ctx.globalAlpha = 1
    }
    frame(performance.now())
    return () => cancelAnimationFrame(raf)
  }, [coreRef])

  return <canvas ref={canvas} className="ut-energy" aria-hidden />
}
