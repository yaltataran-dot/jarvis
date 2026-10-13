import { memo, useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useStore, type BootStep, type BootStepId } from '../store'

/**
 * The start-up screen, in the ЮГ-ТРАНСФЕР livery.
 *
 * One full-frame overlay for the boot phase: the name in an angular frame with
 * a segmented bar beneath it, a ring core around the company logo, the start-up
 * checklist on the left and a field of lights receding below. Everything moving
 * is CSS on transform and opacity (the stroke-dash pulses aside), so it runs on
 * the compositor rather than in JavaScript; the only clock is the bar's, a few
 * ticks a second.
 *
 * The checklist and the bar report what App.tsx's ignite has actually done —
 * see BootStepState in the store. Nothing is marked OK that was not checked,
 * and the bar never runs ahead of the checklist.
 *
 * The exit is AnimatePresence's: the overlay stays mounted while it fades out,
 * so the hand-off to the assistant is a dissolve, not a cut.
 */

/** How long ignite holds the boot phase open. Keep in step with App.tsx. */
const BOOT_MS = 9200

const STEPS: Array<[BootStepId, string]> = [
  ['modules', 'ЗАГРУЗКА МОДУЛЕЙ'],
  ['system', 'ИНИЦИАЛИЗАЦИЯ СИСТЕМЫ'],
  ['voice', 'ПОДКЛЮЧЕНИЕ ГОЛОСОВОГО МОДУЛЯ'],
  ['mic', 'ПРОВЕРКА МИКРОФОНА'],
  ['database', 'ЗАГРУЗКА БАЗЫ ДАННЫХ'],
  ['services', 'ПОДКЛЮЧЕНИЕ К СЕРВИСАМ'],
  ['launch', 'ЗАПУСК ЮГ-ТРАНСФЕР'],
]

const SEGMENTS = 24

export function Boot() {
  const phase = useStore((s) => s.phase)
  return (
    <AnimatePresence>
      {phase === 'boot' && (
        <motion.div
          key="ut-boot"
          className="ut-boot"
          initial={{ opacity: 1 }}
          exit={{ opacity: 0, scale: 1.04, filter: 'blur(8px)' }}
          transition={{ duration: 0.9, ease: 'easeInOut' }}
        >
          <Backdrop />
          <Header />
          <Core />
          <Checklist />
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/* ---------------------------------------------------------------- backdrop */

/** Depth: a vignette, a floor of lights moving towards the viewer, and the
 *  lit platform the core stands on. Static markup — memoised so the bar's
 *  clock never re-renders it. */
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

/* ------------------------------------------------------------------ header */

/** The frame's outline, shared by the stroke and the glints that run along it. */
const FRAME =
  'M48,44 L318,44 L352,12 L848,12 L882,44 L1152,44 L1188,80 L1152,116 L48,116 L12,80 Z'

function Header() {
  return (
    <div className="ut-header">
      <svg className="ut-frame" viewBox="0 0 1200 128" preserveAspectRatio="none" aria-hidden>
        <defs>
          <linearGradient id="utFrameStroke" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor="#ff7a00" stopOpacity="0.15" />
            <stop offset="0.18" stopColor="#ff8a1c" />
            <stop offset="0.5" stopColor="#ffd6a3" />
            <stop offset="0.82" stopColor="#ff8a1c" />
            <stop offset="1" stopColor="#ff7a00" stopOpacity="0.15" />
          </linearGradient>
          <linearGradient id="utFrameFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#1a1008" stopOpacity="0.9" />
            <stop offset="1" stopColor="#050505" stopOpacity="0.95" />
          </linearGradient>
        </defs>
        <path d={FRAME} fill="url(#utFrameFill)" />
        <path d={FRAME} className="ut-frame-line" stroke="url(#utFrameStroke)" />
        {/* Inner bevel of the name plate. */}
        <path d="M362,24 L838,24 L862,46 L338,46 Z" className="ut-frame-inner" />
        {/* Technical accents at the wing tips. */}
        <path d="M70,30 L250,30 M950,30 L1130,30" className="ut-frame-tick" />
        <path d="M1110,92 l8,-12 h7 l-8,12 z M1124,92 l8,-12 h7 l-8,12 z M1138,92 l8,-12 h7 l-8,12 z" className="ut-frame-slash" />
        <path d="M60,92 h70" className="ut-frame-graphite" />
        {/* Glints travelling round the contour. */}
        <path d={FRAME} pathLength={1000} className="ut-glint" />
        <path d={FRAME} pathLength={1000} className="ut-glint ut-glint-2" />
      </svg>
      <h1 className="ut-title">
        <span className="ut-title-ug">ЮГ</span>
        <span className="ut-title-tr">ТРАНСФЕР</span>
      </h1>
      <ProgressBar />
    </div>
  )
}

/** Steps that have finished, one way or another — anything but waiting or running. */
const settled = (s: BootStep) => s.state !== 'wait' && s.state !== 'run'

/**
 * The segmented bar. Paced by the boot sequence, but capped by the checklist:
 * it can show no more progress than steps actually settled, and only reaches
 * the end once the launch step itself has.
 */
function ProgressBar() {
  const steps = useStore((s) => s.bootSteps)
  const [elapsed, setElapsed] = useState(0)

  // Wall-clock, not requestAnimationFrame: rAF stalls in a background tab and
  // froze the old boot on its first beat. Four ticks a second is plenty for a
  // bar of two dozen cells.
  useEffect(() => {
    const start = Date.now()
    const id = setInterval(() => setElapsed(Date.now() - start), 250)
    return () => clearInterval(id)
  }, [])

  const all = STEPS.map(([id]) => steps[id])
  const done = steps.launch.state === 'ok'
  const real = all.filter(settled).length / all.length
  const progress = done ? 1 : Math.min(elapsed / BOOT_MS, real)
  const lit = Math.round(progress * SEGMENTS)

  return (
    <div className="ut-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
      {Array.from({ length: SEGMENTS }, (_, i) => (
        <span
          key={i}
          className="ut-bar-cell"
          data-on={i < lit ? '1' : '0'}
          data-next={!done && i === lit ? '1' : '0'}
        />
      ))}
      <span className="ut-bar-sheen" aria-hidden />
    </div>
  )
}

/* -------------------------------------------------------------------- core */

/** The ring core and the logo. Static markup, all motion in CSS — memoised. */
const Core = memo(function Core() {
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
    <div className="ut-core">
      <svg className="ut-rings" viewBox="-230 -230 460 460" aria-hidden>
        <defs>
          <radialGradient id="utDisc" r="0.5">
            <stop offset="0" stopColor="#0d0906" />
            <stop offset="0.82" stopColor="#060504" />
            <stop offset="1" stopColor="#2a1404" />
          </radialGradient>
          <linearGradient id="utComet" x1="0" x2="1">
            <stop offset="0" stopColor="#ff7a00" stopOpacity="0" />
            <stop offset="1" stopColor="#ffe2b8" />
          </linearGradient>
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

        {/* Orange rings carrying the pulses. */}
        <circle r="143" className="ut-ring ut-thin" />
        <circle r="143" className="ut-comet" />
        <circle r="133" className="ut-ring ut-thin ut-thin-dashed" />
        <circle r="133" className="ut-comet ut-comet-rev" />

        <circle r="126" fill="url(#utDisc)" className="ut-disc" />
        {/* A ring of light expanding out of the disc every few seconds. */}
        <circle r="126" className="ut-shock" />
      </svg>

      <div className="ut-logo-glow" aria-hidden />
      {/* The company's own logo, unaltered. The file carries transparent space
          above the mark; the shift centres the visible mark in the ring. */}
      <img className="ut-logo" src="/ug-transfer-logo.png" alt="Юг-Трансфер" draggable={false} />
    </div>
  )
})

/* --------------------------------------------------------------- checklist */

const STATUS_TEXT: Record<BootStep['state'], string> = {
  wait: '',
  run: '',
  ok: 'OK',
  warn: '',
  fail: 'ОШИБКА',
  // Nothing to check in this application — said plainly, never as OK.
  na: '—',
}

function Checklist() {
  const steps = useStore((s) => s.bootSteps)
  return (
    <ul className="ut-steps">
      {STEPS.map(([id, label], i) => {
        const st = steps[id]
        const text = st.note ?? STATUS_TEXT[st.state]
        return (
          <li
            key={id}
            className="ut-step"
            data-state={st.state}
            style={{ animationDelay: `${0.35 + i * 0.12}s` }}
          >
            <span className="ut-step-caret">&gt;</span>
            <span className="ut-step-label">{label}</span>
            <span className="ut-step-leader" />
            <span className="ut-step-status">
              {st.state === 'run' ? <span className="ut-step-running">···</span> : text}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
