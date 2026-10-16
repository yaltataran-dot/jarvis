import { memo, useRef, type CSSProperties, type RefObject } from 'react'
import { AnimatePresence, motion, useIsPresent } from 'framer-motion'
import { useStore } from '../store'
import { ENERGY, EXIT, HANDOVER_MS } from '../lib/bootTimeline'
import { EnergyField } from './EnergyField'

/**
 * The start-up scene, in the ЮГ-ТРАНСФЕР livery: the splash, the greeting
 * screen and the way into the working screen as one scene (see
 * lib/bootTimeline.ts, which also sets every duration used here), so the
 * ring, the sparks and the floor are the same elements from the first frame
 * to the last — nothing is swapped out between them, so nothing can jump.
 *
 * Only the ring, the logo inside it, the streams of energy, the sparks, the
 * glow and the floor — no words anywhere. Everything is there, alive, from
 * the very first frame: the ring lit and turning, the streams moving, sparks
 * already in the air. The start gate (Ignition.tsx) is only the invisible
 * button over it. The click brightens the ring a little and starts drawing
 * the streams in; the handover to the greeting screen softens the glow and
 * calms the streams while he greets. The acts are flags on the root element
 * (data-engaged, data-greet, data-exiting) and the stylesheet does the rest;
 * the sparks and the streams are one canvas (EnergyField).
 *
 * The start-up checks still run and are still recorded (bootSteps in the
 * store) — they are just not drawn here.
 *
 * The exit is AnimatePresence's: the overlay stays mounted while the rings
 * open out to the size of the assistant's own ring and dissolve into it, and
 * the logo settles into the core's own logo, same place, same size — then the
 * layer fades off the working screen, prepared underneath all along. Its
 * instruments come up after (Hud.tsx), so nothing of it shows through before.
 */

export function Boot() {
  const phase = useStore((s) => s.phase)
  return (
    <AnimatePresence>
      {(phase === 'offline' || phase === 'boot') && (
        <motion.div
          key="ut-boot"
          className="ut-boot-layer"
          initial={{ opacity: 1 }}
          // The rings' own exit plays inside (BootScene) while this waits; the
          // layer then fades off the working screen.
          exit={{
            opacity: 0,
            transition: { duration: EXIT.FADE_MS / 1000, delay: EXIT.DELAY_MS / 1000, ease: 'easeInOut' },
          }}
        >
          <BootScene />
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/** The timeline's numbers, handed to the stylesheet. */
const SCENE_VARS = {
  '--ut-handover': `${HANDOVER_MS}ms`,
  '--ut-exit-rings': `${EXIT.RINGS_MS}ms`,
  '--ut-exit-logo': `${EXIT.LOGO_MS}ms`,
  '--ut-engage-brightness': String(ENERGY.engageBrightness),
  '--ut-greet-brightness': String(ENERGY.greetBrightness),
} as CSSProperties

function BootScene() {
  // Started: the click (or clap) has landed and the start-up is running.
  const engaged = useStore((s) => s.phase !== 'offline')
  const greet = useStore((s) => s.bootAct === 'greet')
  // False from the moment the boot phase ends: the exit.
  const exiting = !useIsPresent()
  const core = useRef<HTMLDivElement>(null)
  const on = (b: boolean) => (b ? '' : undefined)
  return (
    <div
      className="ut-boot"
      style={SCENE_VARS}
      data-engaged={on(engaged)}
      data-greet={on(greet)}
      data-exiting={on(exiting)}
    >
      <Backdrop />
      <EnergyField engaged={engaged} greet={greet} exiting={exiting} coreRef={core} />
      <Core coreRef={core} />
    </div>
  )
}

/* ---------------------------------------------------------------- backdrop */

/** Depth: a vignette, a floor of lights moving towards the viewer, and the
 *  lit platform the core stands on. Static markup — memoised. */
const Backdrop = memo(function Backdrop() {
  return (
    <>
      <div className="ut-vignette" />
      <div className="ut-floor" aria-hidden>
        <div className="ut-floor-plane" />
      </div>
      <div className="ut-platform" aria-hidden />
      <div className="ut-reflection" aria-hidden />
    </>
  )
})

/* -------------------------------------------------------------------- core */

/** The ring core and the logo. Static markup, all motion in CSS — memoised. */
const Core = memo(function Core({ coreRef }: { coreRef: RefObject<HTMLDivElement | null> }) {
  // Ticks round the outside, drawn once.
  const ticks = Array.from({ length: 72 }, (_, i) => {
    const a = (i / 72) * Math.PI * 2
    const r0 = i % 6 === 0 ? 206 : 210
    return (
      <line
        key={i}
        x1={Math.cos(a) * r0}
        y1={Math.sin(a) * r0}
        x2={Math.cos(a) * 216}
        y2={Math.sin(a) * 216}
      />
    )
  })

  return (
    <div className="ut-core" ref={coreRef}>
      {/* The steady glow round the ring — one level per act, eased between,
          never pulsing. */}
      <div className="ut-core-flare" aria-hidden />
      {/* The room's loudness before the start — a clap visibly lands before
          the system answers it. --level is written by Ignition.tsx. */}
      <div className="ut-clap" aria-hidden />
      {/* A slow turn of the whole ring on top of each ring's own. */}
      <div className="ut-rings-wake">
      <svg className="ut-rings" viewBox="-230 -230 460 460" aria-hidden>
        <defs>
          <radialGradient id="utDisc" r="0.5">
            <stop offset="0" stopColor="#0d0906" />
            <stop offset="0.82" stopColor="#060504" />
            <stop offset="1" stopColor="#2a1404" />
          </radialGradient>
        </defs>

        <g className="ut-ticks">{ticks}</g>

        {/* Outer dotted ring — the slowest thing on screen. */}
        <circle r="198" className="ut-ring ut-dots ut-spin-slow" />
        {/* Light segments running round the circumference. */}
        <circle r="188" className="ut-ring ut-runners ut-spin-rev" />

        {/* The two heavy arcs — white upper right, orange lower left — with a
            wide faint copy under each for glow (cheaper than a blur filter). */}
        <g className="ut-arcs ut-spin-mid">
          <circle r="172" className="ut-arc ut-arc-white ut-arc-halo" />
          <circle r="172" className="ut-arc ut-arc-orange ut-arc-halo" />
          <circle r="172" className="ut-arc ut-arc-white" />
          <circle r="172" className="ut-arc ut-arc-orange" />
        </g>

        {/* Graphite segment ring, with a lit run sweeping over it. */}
        <circle r="156" className="ut-ring ut-segments" />
        <circle r="156" className="ut-ring ut-segments-lit ut-spin-fast" />

        {/* Orange rings carrying the slow lights. */}
        <circle r="143" className="ut-ring ut-thin" />
        <circle r="143" className="ut-comet" />
        <circle r="133" className="ut-ring ut-thin ut-thin-dashed" />
        <circle r="133" className="ut-comet ut-comet-rev" />

        <circle r="126" fill="url(#utDisc)" className="ut-disc" />
      </svg>
      </div>

      <div className="ut-logo-glow" aria-hidden />
      {/* The company's own logo, unaltered — the only one on this screen. The
          file carries transparent space above the mark; the shift centres the
          visible mark in the ring. */}
      <img className="ut-logo" src="/ug-transfer-logo.png" alt="Юг-Трансфер" draggable={false} />
    </div>
  )
})
