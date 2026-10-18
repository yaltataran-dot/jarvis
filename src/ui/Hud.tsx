import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useStore, accentFor, type Phase, type Turn } from '../store'
import { Suggestions } from './Suggestions'
import { BladeSweep, Blades } from './Blades'
import { Effects } from './Effects'
import { Pointer } from './Pointer'
import { GestureGuide } from './GestureGuide'
import { LANG } from '../config'
import { HUD_IN } from '../lib/bootTimeline'
import { coreMode, hearingStatus, type CoreMode } from '../lib/coreMode'
import { reconnectNow } from '../lib/bridge'

const ru = LANG === 'ru'

/** The root's variables: the phase colour, and when it comes up after the
 *  start-up scene (HUD_IN). */
const HUD_VARS = (accent: string) =>
  ({
    '--accent': accent,
    '--hud-in-delay': `${HUD_IN.DELAY_MS}ms`,
    '--hud-in': `${HUD_IN.FADE_MS}ms`,
  }) as CSSProperties

/** The interface's own words, in the language he speaks. */
const t = {
  sub: ru ? 'Голосовой помощник' : 'Voice assistant',
  systems: ru ? 'Системы' : 'Systems',
  noneLinked: ru ? 'нет подключений' : 'none linked',
  web: ru ? 'Веб' : 'Web',
  signal: ru ? 'Сигнал' : 'Signal',
  accessing: ru ? 'обращение' : 'accessing',
  you: ru ? 'Вы' : 'You',
  dialog: ru ? 'Диалог' : 'Dialogue',
  him: ru ? 'Юг-Трансфер' : 'Assistant',
  cameraOn: ru ? 'Камера включена · G — выключить' : 'Camera on · G to stop',
  looking: ru ? 'Смотрю' : 'Looking',
}

const statusText: Record<Phase, string> = ru
  ? {
      offline: 'НЕ В СЕТИ',
      boot: 'ЗАПУСК',
      dormant: 'ОЖИДАНИЕ — СКАЖИТЕ «ДЖАРВИС»',
      waking: 'АКТИВАЦИЯ',
      listening: 'СЛУШАЮ',
      thinking: 'ОБРАБОТКА ЗАПРОСА',
      tooling: 'ОБРАЩЕНИЕ К СЕРВИСАМ',
      speaking: 'ОТВЕТ',
    }
  : {
      offline: 'OFFLINE',
      boot: 'INITIALISING',
      dormant: 'STANDBY — SAY “HEY JARVIS”',
      waking: 'ONLINE',
      listening: 'LISTENING',
      thinking: 'PROCESSING',
      tooling: 'ACCESSING SYSTEMS',
      speaking: 'RESPONDING',
    }

/* ------------------------------------------------------------ centre state */

/**
 * What the centre indicator shows. Five states the user has to be able to tell
 * apart at a glance — waiting, listening, working, answering, failed — and
 * because the phase colours are all one brand orange, each has its own motion
 * and its own label rather than relying on hue.
 */

const coreLabel: Record<CoreMode, string> = ru
  ? {
      idle: 'Ожидание',
      waking: 'Активация',
      listening: 'Слушаю',
      processing: 'Обработка',
      speaking: 'Ответ',
      recovering: 'Восстановление',
      error: 'Ошибка',
    }
  : {
      idle: 'Standby',
      waking: 'Online',
      listening: 'Listening',
      processing: 'Processing',
      speaking: 'Responding',
      recovering: 'Recovering',
      error: 'Error',
    }

/**
 * The company logo at the centre of the reactor, ringed by an indicator that
 * moves differently in each state and swells with the voice — the user's while
 * listening, his while answering (`level` already follows whichever is live).
 * Pure CSS motion, keyed by data-mode; only --level changes per frame.
 */
function CoreState({ mode, level }: { mode: CoreMode; level: number }) {
  return (
    <div
      className="core-state"
      data-mode={mode}
      style={{ ['--level' as string]: level.toFixed(3) }}
      role="status"
      aria-live="polite"
    >
      <div className="cs-glow" />
      <svg className="cs-rings" viewBox="-100 -100 200 200" aria-hidden>
        <circle r="96" className="cs-ring" />
        <circle r="96" className="cs-arc" />
        <circle r="88" className="cs-dash" />
      </svg>
      <img className="cs-logo" src="/ug-transfer-logo.png" alt="" draggable={false} />
      <div className="cs-label">{coreLabel[mode]}</div>
    </div>
  )
}

function Corner({ at }: { at: 'tl' | 'tr' | 'bl' | 'br' }) {
  return <div className={`corner corner-${at}`} />
}

/* ------------------------------------------------------------------ decode */

/**
 * The glyphs the ghost is drawn from. Uppercase, digits and rules only: the
 * point is that the unresolved text reads as *machine*, so lowercase letters
 * and anything with a descender are left out — they look like badly rendered
 * words rather than an unfinished decode.
 */
const GLYPHS = '/\\|<>[]{}=+*#%&$0123456789ABCDEFGHJKLMNPQRSTUVWXYZ'

/** Characters of noise shown ahead of the resolved text. */
const GHOST = 22
/** Repaint interval for the scramble. ~24fps is plenty for glyph noise. */
const FRAME_MS = 42
/** Floor on the resolve rate, characters per second. */
const MIN_RATE = 110
/** The frontier is never allowed to trail the streamed text by longer. */
const MAX_LAG_MS = 420

function scramble(s: string, seed: number) {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    // Whitespace is left alone so word shapes and line breaks hold still while
    // the glyphs underneath churn.
    if (c === ' ' || c === '\n' || c === '\t') {
      out += c
      continue
    }
    out += GLYPHS[(seed * 7919 + i * 104729 + c.charCodeAt(0)) % GLYPHS.length]
  }
  return out
}

/**
 * JARVIS's lines, arriving the way a computer would produce them.
 *
 * The hard part is not the effect, it is that the text underneath is *live*.
 * The store appends a token at a time, so this component re-renders dozens of
 * times a second with a slightly longer string, and the naive implementation —
 * scramble the whole thing, resolve it over N milliseconds — restarts the
 * animation on every token and never finishes decoding anything.
 *
 * So the frontier is a ref and only ever moves forward. Everything behind it
 * has settled and is plain text that will never animate again; a short window
 * ahead of it is noise; the rest is present in the DOM but invisible, which
 * keeps the line wrapping identical to the finished paragraph and means the
 * accessibility tree always holds the real sentence. The rate scales with how
 * far behind the frontier has fallen, so a single token drips and a 300
 * character burst clears inside MAX_LAG_MS — the decode must never be the
 * reason the transcript trails the voice.
 *
 * The rAF loop repaints on a 42ms gate rather than every frame, and stops dead
 * the moment the frontier catches up.
 */
function DecodeText({ text }: { text: string }) {
  const reduced = useReducedMotion()
  const settled = useRef(0)
  const raf = useRef(0)
  const latest = useRef(text)
  const [tick, bump] = useState(0)

  useEffect(() => {
    // The running loop reads the length through this ref rather than through
    // its own closure, so a token landing mid-sweep simply extends the target
    // instead of leaving the loop chasing a length that is already stale.
    latest.current = text

    if (reduced) {
      settled.current = text.length
      return
    }
    if (raf.current || settled.current >= text.length) return

    let prev = performance.now()
    let painted = 0

    const step = (now: number) => {
      // Clamped so a backgrounded tab does not resolve the whole answer in one
      // enormous frame the moment it comes back.
      const dt = Math.min(now - prev, 120) / 1000
      prev = now

      const target = latest.current.length
      const rate = Math.max(MIN_RATE, (target - settled.current) / (MAX_LAG_MS / 1000))
      settled.current = Math.min(target, settled.current + rate * dt)

      if (now - painted >= FRAME_MS) {
        painted = now
        bump((n) => n + 1)
      }

      if (settled.current < latest.current.length) {
        raf.current = requestAnimationFrame(step)
      } else {
        raf.current = 0
        bump((n) => n + 1)
      }
    }
    raf.current = requestAnimationFrame(step)
  }, [text, reduced])

  useEffect(
    () => () => {
      if (raf.current) cancelAnimationFrame(raf.current)
      raf.current = 0
    },
    [],
  )

  const n = Math.floor(settled.current)
  if (reduced || n >= text.length) return <>{text}</>

  return (
    <>
      {text.slice(0, n)}
      <span className="decode-ghost">{scramble(text.slice(n, n + GHOST), tick)}</span>
      <span className="decode-veil">{text.slice(n + GHOST)}</span>
    </>
  )
}

/* ---------------------------------------------------------------- systems */

/**
 * The integrations, folded into a chip at the bottom of the screen.
 *
 * This was a rail at the left edge, always open — six lines of server names
 * standing beside the reactor for the whole session. Folded, it is a chip with
 * a count and a light; opened, the same list as before, nothing removed.
 *
 * The list is always mounted and shown with CSS (data-open), never mounted and
 * unmounted through AnimatePresence: an exit that does not finish leaves a
 * layer catching clicks, which is exactly what once happened to Ignition. When
 * closed it is visibility: hidden and takes no pointer events.
 *
 * The light means the bridge has reported its servers — that is the only
 * availability this app actually knows.
 */
function SystemsDock({ connected }: { connected: string[] }) {
  const [open, setOpen] = useState(false)
  const items = [...connected, t.web]
  const live = connected.length > 0

  // Escape folds it too. App's own Escape — "stand down" — is untouched and
  // still runs alongside; this only adds the fold while the list is open.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <div className="sysdock" data-open={open ? '1' : '0'}>
      <div className="sysdock-panel" id="sysdock-list" aria-hidden={!open}>
        <div className="sysdock-head">
          <span>{t.systems}</span>
          <button
            type="button"
            className="sysdock-close"
            tabIndex={open ? 0 : -1}
            aria-label={ru ? 'Свернуть' : 'Collapse'}
            onClick={(e) => {
              setOpen(false)
              e.currentTarget.blur()
            }}
          >
            ×
          </button>
        </div>
        <ul className="sysdock-list">
          {items.map((c) => (
            <li key={c} className="sysdock-item">
              <span className="tick" />
              {c}
            </li>
          ))}
        </ul>
        {!live && <div className="sysdock-note">{t.noneLinked}</div>}
      </div>

      <button
        type="button"
        className="sysdock-chip"
        aria-expanded={open}
        aria-controls="sysdock-list"
        title={live ? (ru ? 'Мост сообщил о подключённых системах' : 'Bridge reported its systems') : t.noneLinked}
        // Space is "talk" everywhere in this app; a focused chip must not
        // swallow it as a click. Enter still toggles.
        onKeyDown={(e) => {
          if (e.key === ' ') e.preventDefault()
        }}
        onClick={(e) => {
          setOpen((o) => !o)
          // Off the button, so the next Space goes back to talking.
          e.currentTarget.blur()
        }}
      >
        <svg className="sysdock-icon" viewBox="0 0 16 16" aria-hidden>
          <rect x="1.5" y="1.5" width="5" height="5" rx="1" />
          <rect x="9.5" y="1.5" width="5" height="5" rx="1" />
          <rect x="1.5" y="9.5" width="5" height="5" rx="1" />
          <rect x="9.5" y="9.5" width="5" height="5" rx="1" />
        </svg>
        <span className="sysdock-label">{t.systems}</span>
        <span className="sysdock-count">{items.length}</span>
        <span className="sysdock-light" data-live={live ? '1' : '0'} />
        <span className="sysdock-caret" aria-hidden>
          ▴
        </span>
      </button>
    </div>
  )
}

/* ----------------------------------------------------------------- dialog */

/**
 * The conversation, in a compact window at the bottom right.
 *
 * It used to be a wide band across the bottom of the reactor showing the last
 * four lines, and it covered the ring. Now it is a corner window holding the
 * whole history the store keeps, scrolling inside itself, folding to a chip.
 * Same turns, same rendering — nothing about how lines arrive has changed.
 *
 * It follows the newest line as it streams in, unless the user has scrolled up
 * to read something, in which case it leaves them there until they scroll back
 * down. Folded, the chip counts lines that arrived since it was folded.
 *
 * Shown and hidden with CSS rather than mounted and unmounted, for the same
 * reason as SystemsDock: an unfinished exit must never leave a layer behind.
 */
function DialogDock({ turns }: { turns: Turn[] }) {
  const [open, setOpen] = useState(true)
  const [seenAtFold, setSeenAtFold] = useState(0)
  const body = useRef<HTMLDivElement>(null)
  /** Following the newest line — false once the user scrolls up to read. */
  const following = useRef(true)

  const last = turns[turns.length - 1]
  const lastLength = last?.text.length ?? 0
  useLayoutEffect(() => {
    const el = body.current
    if (el && open && following.current) el.scrollTop = el.scrollHeight
  }, [turns.length, lastLength, open])

  const unread = open ? 0 : Math.max(0, turns.length - seenAtFold)
  const hasLines = turns.length > 0

  const toggle = (e: MouseEvent<HTMLButtonElement>) => {
    if (open) setSeenAtFold(turns.length)
    else following.current = true
    setOpen(!open)
    // Off the button, so the next Space goes back to talking.
    e.currentTarget.blur()
  }

  return (
    <div className="dialog" data-open={open && hasLines ? '1' : '0'}>
      <div className="dialog-panel" id="dialog-panel" aria-hidden={!(open && hasLines)}>
        <div
          className="dialog-body"
          ref={body}
          onScroll={(e) => {
            const el = e.currentTarget
            following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
          }}
        >
          <AnimatePresence initial={false}>
            {turns.map((turn) => (
              <motion.div
                key={turn.id}
                className={`log-line log-${turn.role}`}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ type: 'spring', stiffness: 320, damping: 32 }}
              >
                <span className="log-who">{turn.role === 'user' ? t.you : t.him}</span>
                {/* Only his half decodes. What the user said was never
                    transmitted from anywhere — dressing it up as machine
                    output would be a lie about where the words came from. */}
                <span className="log-text">
                  {turn.role === 'jarvis' ? <DecodeText text={turn.text} /> : turn.text}
                </span>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </div>

      <button
        type="button"
        className="dialog-chip"
        aria-expanded={open}
        aria-controls="dialog-panel"
        // Space is "talk" everywhere in this app; Enter still toggles.
        onKeyDown={(e) => {
          if (e.key === ' ') e.preventDefault()
        }}
        onClick={toggle}
      >
        <svg className="dialog-icon" viewBox="0 0 16 16" aria-hidden>
          <path d="M2 3.5h12v7H7l-3 2.5v-2.5H2z" />
        </svg>
        <span className="dialog-label">{t.dialog}</span>
        {unread > 0 && <span className="dialog-unread">{unread}</span>}
        <span className="dialog-caret" aria-hidden>
          ▾
        </span>
      </button>
    </div>
  )
}

/* --------------------------------------------------------------------- hud */

export function Hud() {
  const phase = useStore((s) => s.phase)
  const caption = useStore((s) => s.caption)
  const turns = useStore((s) => s.turns)
  const activeTool = useStore((s) => s.activeTool)
  const connected = useStore((s) => s.connected)
  const error = useStore((s) => s.error)
  const errorKind = useStore((s) => s.errorKind)
  const link = useStore((s) => s.link)
  const linkNote = useStore((s) => s.linkNote)
  const level = useStore((s) => s.level)
  const voice = useStore((s) => s.voice)
  const bootNote = useStore((s) => s.bootNote)
  const gestures = useStore((s) => s.gestures)
  const looking = useStore((s) => s.looking)
  const ui = useStore((s) => s.ui)

  // accentFor folds JARVIS's overrides in over the phase colour, so one
  // variable on the root carries a theme change into every .hud-* rule without
  // a single component knowing a theme exists.
  const colour = accentFor(phase, ui)
  const voiceHealth = useStore((s) => s.voiceHealth)
  const mode = coreMode(phase, error, errorKind, voiceHealth)

  useEffect(() => {
    // The ground has to be set on the document, not painted here: the HUD sits
    // above the 3D scene, so a background drawn inside it would cover the
    // reactor rather than sit behind it. --bg is what html, body, #root and the
    // boot screen all pin themselves to.
    const root = document.documentElement
    if (ui.background) root.style.setProperty('--bg', ui.background)
    else root.style.removeProperty('--bg')
  }, [ui.background])

  return (
    <div
      className="hud"
      // Hidden under the start-up scene, then brought up as it opens.
      data-live={phase === 'offline' || phase === 'boot' ? undefined : ''}
      style={HUD_VARS(colour)}
    >
      {/* First in the tree on purpose. Everything after it is positioned with
          `z-index: auto`, so paint order is document order and the sweep stays
          behind the transcript and the panels without a z-index war. */}
      <BladeSweep />

      <Corner at="tl" />
      <Corner at="tr" />
      <Corner at="bl" />
      <Corner at="br" />

      {/* Before the log, the blades and the effects, so all of them paint over
          it: it is the resting centre of the screen, never in the way. */}
      {mode && <CoreState mode={mode} level={level} />}

      <header className="hud-top">
        {ui.chrome.brand && (
          <div className="brand">
            <img className="brand-logo" src="/ug-transfer-logo.png" alt="Юг-Трансфер" draggable={false} />
            <span className="brand-sub">{t.sub}</span>
          </div>
        )}

        <div className="status">
          <span className="dot" />
          <span className="status-text">
            {/* bootNote is the voice-model download readout. It is only ever
                the right thing to show during boot — as a general fallback a
                note that never got cleared (a stuck 'voice 97%') sits over
                LISTENING and PROCESSING for the rest of the session. */}
            {phase === 'boot' && bootNote ? bootNote : (hearingStatus(phase, voiceHealth, ru) ?? statusText[phase])}
          </span>
        </div>
      </header>

      {/* Which integrations are live — a chip at the bottom, opened on demand. */}
      {ui.chrome.systems && <SystemsDock connected={connected} />}

      {/* Right rail: live telemetry, mostly for flavour */}
      <aside className="rail rail-right">
        <div className="rail-title">{t.signal}</div>
        <div className="meter">
          <div className="meter-fill" style={{ height: `${level * 100}%` }} />
        </div>
        <div className="rail-item mono">{(level * 100).toFixed(0).padStart(3, '0')}%</div>
      </aside>

      <AnimatePresence>
        {activeTool && ui.chrome.toolBadge && (
          <motion.div
            className="tool-badge"
            // Anchored to the TOP of the frame, not the middle. The old home was
            // viewport-centre plus a fixed drop, which on a tall or square
            // window landed the headline straight on top of the bottom
            // transcript — two elements pinned to different edges of the screen
            // were always going to meet somewhere. Up here it sits in its own
            // band with the rest of the status chrome and can never collide with
            // the log. Framer owns `transform` on an animated element, so the
            // centring (x: -50%) lives in these props, not the stylesheet.
            initial={{ opacity: 0, x: '-50%', y: -8, filter: 'blur(6px)' }}
            animate={{ opacity: 1, x: '-50%', y: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0, x: '-50%', y: -8, filter: 'blur(6px)' }}
            transition={{ type: 'spring', stiffness: 300, damping: 26 }}
          >
            <span className="tool-kicker">
              <span className="spinner" />
              {t.accessing}
            </span>
            <span className="tool-name">{activeTool.replace(/[_-]/g, ' ')}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Conversation log — a compact window in the bottom-right corner */}
      {ui.chrome.transcript && <DialogDock turns={turns} />}

      <AnimatePresence>
        {caption && (
          <motion.div
            className="caption"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            {caption}
          </motion.div>
        )}
      </AnimatePresence>

      {/* The one surface. Panels used to sit alongside this as a second place
          for things to appear, which meant two places to look and a decision
          the model had to make on grounds it could not know. Everything renders
          here now; Panels.tsx is unmounted rather than deleted so the design
          system it documents stays findable. */}
      <Blades />

      {ui.chrome.suggestions && <Suggestions />}

      {error && <div className="error">{error}</div>}

      {/* The connection (linkStatus.ts). A drop being mended is a quiet line,
          not the red plate — and only after a moment, so a blink of the
          network shows nothing at all. A lasting outage is said plainly, with
          a way to try now. A note about the last reconnect sits on the quiet
          line until the next question. */}
      {link === 'reconnecting' && (
        <div className={'link-status link-wait' + (error ? ' raised' : '')} role="status">
          {ru ? 'Переподключение…' : 'Reconnecting…'}
        </div>
      )}
      {link === 'down' && (
        <div className={'error link-down' + (error ? ' raised' : '')} role="alert">
          {ru ? 'Нет связи с мостом. Пробую снова раз в полминуты.' : 'No connection to the bridge. Trying again every half minute.'}{' '}
          <button type="button" className="link-retry" onClick={() => reconnectNow()}>
            {ru ? 'Подключиться' : 'Reconnect'}
          </button>
        </div>
      )}
      {link === 'ok' && linkNote && (
        <div className={'link-status' + (error ? ' raised' : '')} role="status">
          {linkNote}
        </div>
      )}

      <footer className="hud-bottom">
        <span className="hint">
          {ru ? (
            <>
              скажите <b>«Джарвис»</b> · <kbd>Пробел</kbd> — говорить · <kbd>G</kbd> — жесты
            </>
          ) : (
            <>
              say <b>“hey jarvis”</b> · <kbd>Space</kbd> to talk · <kbd>G</kbd> hands
            </>
          )}
          {voice && (
            <>
              {' · '}
              <kbd>V</kbd> {ru ? 'голос' : 'voice'}: {voice.replace(/\(.*?\)/g, '').trim()}
            </>
          )}
        </span>
      </footer>

      {/* Last, so a flash or a tear reads as being on the glass rather than
          underneath the chrome. It is pointer-events: none and unmounts the
          instant it finishes. */}
      <Effects />

      {/* Above even the effects: the reticle shows where a press will land, and
          a press that lands under a flourish is a press you cannot aim. */}
      <Pointer />
      {(gestures || looking) && (
        <div className="hands-live">
          {looking ? `${t.looking} — ${looking}` : t.cameraOn}
        </div>
      )}
      <GestureGuide live={gestures} />
    </div>
  )
}
