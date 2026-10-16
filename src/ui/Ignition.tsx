import { useEffect } from 'react'
import { useStore } from '../store'
import { LANG } from '../config'
import { clapLevel } from '../lib/clap'

/**
 * The start gate.
 *
 * Browsers refuse to play audio or start speech synthesis until the user has
 * interacted with the page, so something has to be clicked before he can make
 * a sound. What you see is the splash (Boot.tsx — the start-up scene's first
 * act, on screen from the moment the page opens); this is the button over
 * it, the whole screen wide, that starts the system — by a click anywhere or
 * a clap, which App.tsx listens for while this is up. There is no spoken
 * command here: nothing is listening for words until he has started.
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
 * A plain conditional cannot strand anything. Now that the button draws
 * nothing itself, there is no fade to want anyway.
 */

/**
 * No words on screen — the ring and the logo are the whole gate. The label is
 * still there for a screen reader, which cannot see that the screen is a button.
 */
const LABEL = LANG === 'ru' ? 'Запустить систему' : 'Start the system'

export function Ignition({ onStart }: { onStart: () => void }) {
  const phase = useStore((s) => s.phase)

  // The ring glows with what the microphone hears — the same meter the clap
  // detector reads — so a clap visibly lands before the system answers it.
  // Written straight to a CSS variable on the splash: a re-render sixty times
  // a second for one number would be waste.
  useEffect(() => {
    if (phase !== 'offline') return
    let raf = 0
    let shown = 0
    let scene: HTMLElement | null = null
    const tick = () => {
      // Speech sits around 0.02–0.08 RMS, a clap peaks well above; stretch it
      // and ease the fall so the glow reads as a response, not a flicker.
      const target = Math.min(1, clapLevel() * 9)
      shown = target > shown ? target : shown + (target - shown) * 0.08
      scene ??= document.querySelector<HTMLElement>('.ut-boot')
      scene?.style.setProperty('--level', shown.toFixed(3))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      scene?.style.setProperty('--level', '0')
    }
  }, [phase])

  if (phase !== 'offline') return null

  return <button className="ignition" onClick={onStart} aria-label={LABEL} />
}
