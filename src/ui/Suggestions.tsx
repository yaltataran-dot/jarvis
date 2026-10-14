import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useStore } from '../store'
import { LANG } from '../config'

/**
 * Rotating example commands, shown only while idle.
 *
 * A voice interface has no menus — nothing tells you what it can do. This is
 * the affordance. It disappears the moment JARVIS is doing anything, so it
 * never competes with the answer.
 *
 * Each line is phrased the way you'd actually say it, not as a feature name.
 */
/** Russian mode: only things the assistant can actually do through its tools
 *  — searching the web is always there; mail and calendar only if connected,
 *  so they are left out. */
const EXAMPLES_RU = [
  'какая завтра погода в Краснодаре',
  'сколько ехать от Сочи до аэропорта Адлер',
  'что нового в мире ИИ на этой неделе',
  'найди ближайшую заправку',
  'какие главные новости сегодня',
  'какой курс доллара сегодня',
  'какое расстояние от Краснодара до Геленджика',
  'найди телефон автовокзала Краснодара',
]

const EXAMPLES_EN = [
  'what happened in AI this week',
  'generate an image of the Mark Seven suit',
  'take a screenshot of my phone',
  "what's on my calendar tomorrow",
  'search for the best coffee near me',
  'read me the top story on Hacker News',
  'open my GitHub notifications',
  "summarise what's in my inbox",
  'find me a loading animation',
  "what's the weather looking like",
]

const ru = LANG === 'ru'
const EXAMPLES = ru ? EXAMPLES_RU : EXAMPLES_EN

const ROTATE_MS = 4200

export function Suggestions() {
  const phase = useStore((s) => s.phase)
  const turns = useStore((s) => s.turns)
  const [i, setI] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setI((n) => (n + 1) % EXAMPLES.length), ROTATE_MS)
    return () => clearInterval(id)
  }, [])

  // Only while genuinely idle, and only until the first exchange — once the
  // user knows how it works, the prompt is just clutter.
  if (phase !== 'dormant' || turns.length > 0) return null

  return (
    <div className="suggest">
      <span className="suggest-lead">{ru ? 'попробуйте' : 'try'}</span>
      <AnimatePresence mode="wait">
        <motion.span
          key={i}
          className="suggest-text"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.35 }}
        >
          {ru ? `«Джарвис, ${EXAMPLES[i]}»` : `“hey jarvis, ${EXAMPLES[i]}”`}
        </motion.span>
      </AnimatePresence>
    </div>
  )
}
