/**
 * What the page answered by itself, for the model to hear about.
 *
 * The time, the date, the calendar and the music are answered on the page,
 * with no model turn (turnRoute.ts) — so on the bridge, where the conversation
 * lives in the agent session, the model never heard them. Measured: after
 * "Включи Queen" (played by the page), "А что это за группа?" went to the model
 * cold; it called the music tool and a search, 19 s, and talked about whatever
 * the player happened to show. A follow-up to a calendar read-back went the
 * same way.
 *
 * So each exchange the page had alone is kept here and handed to the next
 * model turn as a note, then dropped once that turn has gone in. Bounded: only
 * the last few, each cut short — enough to resolve "а это что?", not a log.
 *
 * Each has an id, and that is what keeps it from being said twice. The page
 * cannot tell a turn that failed before the model from one that failed after
 * it, so after a failure it keeps them and sends them again; the bridge knows
 * which ids its session was already handed and passes on only the rest
 * (createAsideLedger in bridge/turnText.mjs). A new exchange is a new id, so a
 * question asked twice on purpose is two exchanges, not a repeat.
 */

export type Aside = { id: string; said: string; reply: string; at: number }
/** What travels to the bridge. */
export type AsideItem = Pick<Aside, 'id' | 'said' | 'reply'>

/** How many page-answered exchanges are carried into the next model turn. */
export const ASIDE_MAX = 4
/** Each side of an exchange is cut to this many characters. */
export const ASIDE_CHARS = 240
/** An exchange older than this belongs to an earlier conversation, not this one. */
export const ASIDE_TTL_MS = 10 * 60_000

const cut = (t: string) => {
  const s = t.replace(/\s+/g, ' ').trim()
  return s.length > ASIDE_CHARS ? `${s.slice(0, ASIDE_CHARS - 1)}…` : s
}

export function createAsides(lang: 'ru' | 'en' = 'ru', now: () => number = Date.now) {
  let log: Aside[] = []
  /** Unique for the life of the page; the time in it keeps a reload's apart. */
  let seq = 0
  const epoch = now().toString(36)
  const live = () => {
    const t = now()
    log = log.filter((a) => t - a.at < ASIDE_TTL_MS)
    return log
  }
  return {
    /** An exchange the page answered and spoke itself. */
    add(said: string, reply: string) {
      if (!said.trim() || !reply.trim()) return
      log.push({ id: `${epoch}-${++seq}`, said: cut(said), reply: cut(reply), at: now() })
      if (log.length > ASIDE_MAX) log = log.slice(-ASIDE_MAX)
    },
    /** What goes with the next model turn, oldest first; empty when nothing. */
    pending(): AsideItem[] {
      return live().map(({ id, said, reply }) => ({ id, said, reply }))
    },
    /** The same, as the note the model reads (the direct path formats its own). */
    note(): string | null {
      const items = live()
      return items.length ? formatAsides(items, lang) : null
    },
    /**
     * These went in with a model turn that came back: forget them. Only these —
     * one added meanwhile (the turn was superseded by a question the page
     * answered itself) is still to be handed over. A turn that failed calls
     * nothing, and the bridge recognises any it had already received.
     */
    drop(ids: string[]) {
      const gone = new Set(ids)
      log = log.filter((a) => !gone.has(a.id))
    },
    size: () => log.length,
  }
}

export type Asides = ReturnType<typeof createAsides>

/** The note as the model reads it: marked as not to be spoken, oldest first. */
export function formatAsides(log: Array<Pick<Aside, 'said' | 'reply'>>, lang: 'ru' | 'en' = 'ru'): string {
  if (lang === 'ru') {
    return (
      '(Служебно, не озвучивать. Перед этим вопросом интерфейс сам, без тебя, ответил пользователю — это часть разговора:\n' +
      log.map((a) => `— Пользователь: «${a.said}». Ты: «${a.reply}».`).join('\n') +
      ')'
    )
  }
  return (
    '(System note, not to be spoken. Before this question the interface answered the user itself, without you — this is part of the conversation:\n' +
    log.map((a) => `— User: "${a.said}". You: "${a.reply}".`).join('\n') +
    ')'
  )
}
