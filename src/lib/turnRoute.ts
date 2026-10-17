import { STOP_ONLY } from './stopWords'

/** Where a phrase went — see routePhrase. */
export type Route = 'calendar' | 'music' | 'local' | 'known' | 'stop' | 'stale' | 'model'

/**
 * Who answers a phrase, before the model is asked.
 *
 * A calendar question waiting for its answer hears it first; then a music
 * command, which is an action with one meaning; then a calendar command. Only
 * what none of them took goes to the model.
 *
 * Except a stop. "Хватит" over a calendar read-back cut the read-back, as it
 * should — and then, the calendar not knowing the word as a refusal, went on
 * to the model as a question, and he started talking again about a word that
 * meant "be quiet". A stop that no question took as its answer is a stop: the
 * turn ends there and he listens. It is said only here, after every handler
 * had its chance, so a stop that IS an answer — "стоп" to a read-back, which
 * refuses the draft and says so — still is one.
 *
 * After the calendar and the music, a question the page can answer itself —
 * the time, the date, his name, his voice (see localAnswer.ts) — is answered
 * on the spot, with no model turn.
 *
 * Then a question the user has already told JARVIS the answer to (the local
 * knowledge base, via `known`). It comes after the stop on purpose: whatever
 * is stored there, a stop is a stop and a command is a command — the base only
 * ever answers what nothing else took, and only what it is certain of. When it
 * has nothing certain, or is slow, or is down, the phrase goes to the model
 * exactly as it would have without it.
 */
export async function routePhrase<M>(
  said: string,
  h: {
    calendarWaiting: () => boolean
    /** True if the calendar took the phrase (and answered it). */
    calendar: (said: string) => Promise<boolean>
    music: (said: string) => M | null
    playMusic: (command: M) => Promise<void>
    stale: () => boolean
    /** The page's own answer to the phrase, if it has one. */
    local?: (said: string) => string | null
    sayLocal?: (answer: string) => Promise<void>
    /** A verified answer from the knowledge base, or null. Must not throw. */
    known?: (said: string) => Promise<string | null>
    sayKnown?: (answer: string) => Promise<void>
  },
): Promise<Route> {
  if (h.calendarWaiting() && (await h.calendar(said))) return 'calendar'
  const command = h.music(said)
  if (command) {
    await h.playMusic(command)
    return 'music'
  }
  if (await h.calendar(said)) return 'calendar'
  if (h.stale()) return 'stale'
  const answer = h.local?.(said)
  if (answer && h.sayLocal) {
    await h.sayLocal(answer)
    return 'local'
  }
  if (STOP_ONLY.test(said)) return 'stop'
  if (h.known && h.sayKnown) {
    const stored = await h.known(said)
    // The user may have spoken again while the base was consulted.
    if (h.stale()) return 'stale'
    if (stored) {
      await h.sayKnown(stored)
      return 'known'
    }
  }
  return 'model'
}
