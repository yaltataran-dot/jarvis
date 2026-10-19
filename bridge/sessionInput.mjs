import { effortFor } from './effort.mjs'
import { formatAsides, withAside } from './turnText.mjs'
import { asksToSee } from './visual.mjs'
import { formatNotes, notesFor } from './knowledgeRoute.mjs'

/**
 * What goes into one socket's agent session: its questions, read from the
 * session's inbox as `next() ?? await wait()` and handed to the SDK one at a
 * time — each with the asides the session has not had yet and the knowledge
 * base's notes, the turn's effort set first, a line when the user's Chrome is
 * down, and the page told how the question was sorted. Moved out of
 * server.mjs's connection handler unchanged; it works on the socket's state
 * (`s`), with what it called passed in.
 *
 * @param {{
 *   s: ReturnType<typeof import('./socketState.mjs').createSocketState>,
 *   sendTurn: (frame: object) => unknown,
 *   knowledge: { kb: unknown },
 *   lang: string,
 *   routeEffort: boolean,
 *   trace: boolean,
 *   chromeAvailable: () => Promise<boolean>,
 * }} o
 * @returns {(ch: ReturnType<typeof import('./inbox.mjs').createInbox>) => AsyncGenerator<object, void>}
 */
export function createSessionInput({ s, sendTurn, knowledge, lang, routeEffort, trace, chromeAvailable }) {
  /** Set this turn's effort before the question goes in. Never fatal. */
  const tuneFor = async (text) => {
    if (!routeEffort) return
    const want = effortFor(text)
    if (want === s.sessionEffort) return
    try {
      await s.session.applyFlagSettings({ effortLevel: want })
      s.sessionEffort = want
      if (trace) console.log(`[jarvis] effort ${want}`)
    } catch (err) {
      console.warn(`[jarvis] could not set effort ${want}: ${err?.message ?? err}`)
    }
  }

  /**
   * A line for the model, appended to the question, when the user's Chrome is
   * not reachable. The prompt sends every browsing task to the chrome_* tools
   * first; with the extension down each of those is a failed call and a whole
   * extra round trip before the search that actually answers.
   */
  const browserNote = async () =>
    (await chromeAvailable().catch(() => false))
      ? ''
      : lang === 'ru'
        ? '\n\n(Служебно, не озвучивать: браузер пользователя сейчас недоступен — chrome_* не вызывай, для фактов используй WebSearch.)'
        : "\n\n(System note, not to be spoken: the user's browser is unavailable right now — do not call chrome_*; use WebSearch for facts.)"

  return async function* userMessages(ch) {
    while (!s.closed && !ch.closed) {
      const item = ch.next() ?? (await ch.wait())
      if (s.closed || ch.closed || item == null) return
      // The question, and what the page answered by itself before it (aside.ts
      // in the page). Effort is sorted on the question alone: the note is long
      // and says nothing about how hard this one is.
      const { text } = item
      // Only the exchanges this session has not been handed yet. A turn that
      // reached the model and then failed leaves the page holding its asides,
      // and the page sends them again with the next question; the session
      // already has them, so they are not said twice. New exchanges have new
      // ids and always go in.
      const fresh = s.asideLedger.fresh(item.asides ?? [])
      if (item.asides?.length && fresh.length < item.asides.length) {
        console.log(`[jarvis] asides: ${fresh.length} new, ${item.asides.length - fresh.length} already in the session`)
      }
      // What the local knowledge base holds on this question goes to Claude as
      // labelled notes — data to weigh, never instructions. The page asks the
      // base before it gets here, so reaching this point is a fallback.
      const kn = notesFor(knowledge.kb, text)
      console.log(
        `[knowledge] claude_fallback notes=${kn.notes.length} search=${kn.ms}ms${knowledge.kb ? '' : ' (no knowledge base)'}${kn.error ? ` error="${kn.error}"` : ''}`,
      )
      const context = [fresh.length ? formatAsides(fresh, lang) : null, formatNotes(kn.notes, lang)].filter(Boolean).join('\n\n') || null
      s.turnMayShow = asksToSee(text)
      await tuneFor(text)
      const note = await browserNote()
      if (s.lat) {
        s.lat.effort = s.sessionEffort
        s.lat.sent = performance.now()
      }
      // Tells the page how this question was sorted, so it can say a word at
      // once when a long wait is likely (App.tsx) instead of seconds later.
      sendTurn({ type: 'effort', level: routeEffort ? effortFor(text) : s.sessionEffort })
      // Recorded at the hand-over and not before: a question superseded in the
      // queue never gets here, so its asides are still fresh for the next one.
      s.asideLedger.delivered(fresh)
      yield {
        type: 'user',
        message: { role: 'user', content: withAside(text, context) + note },
        parent_tool_use_id: null,
      }
    }
  }
}
