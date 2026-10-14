import { useEffect, useRef } from 'react'
import { useStore } from '../store'
import { LANG } from '../config'
import { clapLevel } from '../lib/clap'

/**
 * The start gate, in the ЮГ-ТРАНСФЕР livery.
 *
 * Browsers refuse to play audio or start speech synthesis until the user has
 * interacted with the page, so something has to be clicked before he can make
 * a sound. Rather than hide that behind a permissions banner, it's the cold
 * open: the system powered but idle, an energy ring charging round the logo,
 * waiting to be switched on — by a click anywhere (the ring is the obvious
 * place) or a clap, which App.tsx listens for while this is up. There is no
 * spoken command here: nothing is listening for words until he has started.
 *
 * Deliberately NOT wrapped in AnimatePresence, and the reason is worth keeping.
 *
 * It used to be, for the sake of a blur-and-fade on the way out, and the exit
 * never completed — the node reached opacity 0 and then stayed in the DOM for
 * the rest of the session. Which would be a cosmetic non-event, except this is
 * a `position: fixed; inset: 0` button: invisible, unremovable, and the topmost
 * hit-testable thing under every single point on the screen.
 *
 * Everything that aims by hit-testing died on it. Hand control resolves its
 * target with elementFromPoint, so every pinch — focus, grab, drag, close —
 * landed on an invisible button instead of a blade, silently, with no error and
 * nothing on screen to suggest why. It cost an entire evening of looking at the
 * gesture code, which was fine.
 *
 * Two attempted fixes failed and are worth recording so nobody re-attempts
 * them. Giving the child a `key` did not make the exit complete. Adding a
 * phase-dependent `pointerEvents` did not help either, because AnimatePresence
 * renders an exiting child from a frozen snapshot of its last props — inside
 * that copy the phase is forever 'offline', so a guard written in terms of it
 * can never fire.
 *
 * A plain conditional cannot strand anything. The fade-in survives because
 * mounting is not the dangerous direction; the fade-out is gone, and the boot
 * sequence takes the screen immediately anyway, so there is nothing to see.
 * All motion is CSS for the same reason — see .ig-* in index.css.
 */

/**
 * No words on screen — the ring and the logo are the whole gate. The label is
 * still there for a screen reader, which cannot see that the ring is a button.
 */
const LABEL = LANG === 'ru' ? 'Запустить систему' : 'Start the system'

export function Ignition({ onStart }: { onStart: () => void }) {
  const phase = useStore((s) => s.phase)
  const core = useRef<HTMLSpanElement>(null)

  // The ring glows with what the microphone hears — the same meter the clap
  // detector reads — so a clap visibly lands before the system answers it.
  // Written straight to a CSS variable: a re-render sixty times a second for
  // one number would be waste.
  useEffect(() => {
    if (phase !== 'offline') return
    let raf = 0
    let shown = 0
    const tick = () => {
      // Speech sits around 0.02–0.08 RMS, a clap peaks well above; stretch it
      // and ease the fall so the glow reads as a response, not a flicker.
      const target = Math.min(1, clapLevel() * 9)
      shown = target > shown ? target : shown + (target - shown) * 0.08
      core.current?.style.setProperty('--level', shown.toFixed(3))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [phase])

  if (phase !== 'offline') return null

  return (
    <button className="ignition" onClick={onStart} aria-label={LABEL}>
      <span className="ig-floor" aria-hidden />

      <span className="ig-core" ref={core} aria-hidden>
        <span className="ig-bloom" />
        <svg className="ig-rings" viewBox="-200 -200 400 400">
          <circle r="186" className="ig-dots" />
          <circle r="170" className="ig-track" />
          {/* Energy gathering round the ring, then released as a pulse. */}
          <circle r="170" className="ig-charge" />
          <circle r="150" className="ig-segments" />
          <circle r="136" className="ig-thin" />
          <circle r="136" className="ig-comet" />
          <circle r="124" className="ig-thin ig-thin-dashed" />
          <circle r="124" className="ig-comet ig-comet-rev" />
          <circle r="114" className="ig-disc" />
          <circle r="114" className="ig-pulse" />
        </svg>
        <img className="ig-logo" src="/ug-transfer-logo.png" alt="" draggable={false} />
      </span>
    </button>
  )
}
