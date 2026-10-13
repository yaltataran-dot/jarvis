/**
 * Hearing himself.
 *
 * The microphone stays open while he talks, so it hears every word he says.
 * voice.ts uses `isEcho` to recognise its own playback in what the recogniser
 * hands back, so his answer is not taken for a barge-in or a new question.
 * Moved here unchanged from voice.ts so the tests can run it without the
 * browser config; kept free of imports beyond the stop words for the same
 * reason.
 */

import { OVERRIDE } from './stopWords'

/** Letters of any alphabet survive. This was `[^a-z0-9' ]`, which turned every
 *  Russian sentence into an empty string — and an empty string counts as echo. */
export const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * Words too common to be evidence of anything.
 *
 * This set is the difference between a usable filter and an infuriating one.
 * "What about the second one?" is a perfectly ordinary follow-up, and every
 * word in it is likely to appear somewhere in the answer it follows — so a
 * naive bag-of-words match suppresses the user's real question as an echo.
 * Only distinctive words count as proof he is hearing himself.
 */
const STOP = new Set(
  ('a an the and or but so of to in on at by for with from is are was were be ' +
    'it its this that these those i you he she we they me him her them my your ' +
    'our their what which who how why when where do does did can could would ' +
    'should will shall not no yes if then than as about into over under out up ' +
    'down one two three first second third now here there just very really got ' +
    'get have has had say said tell me okay ok well right ' +
    // The same for Russian. Already normalised: lower case, ё folded to е.
    'и а но или в во на о об с со к по за из от до для у не ни да нет это этот ' +
    'эта эти тот та те я ты он она оно мы вы они меня тебя его ее нас вас их мне ' +
    'тебе ему ей нам вам им мой моя мои твой ваш наш что кто как где когда почему ' +
    'зачем какой какая какие ли же бы то так вот уже еще тут там здесь сейчас ' +
    'очень просто один два три первый второй ну хорошо ладно скажи покажи можно ' +
    'есть был была было были будет сэр').split(' '),
)

/**
 * Is this the microphone hearing the speakers?
 *
 * Compared as bags of words rather than by string distance: the recogniser
 * mangles its own playback badly enough that a substring match rarely holds,
 * but the *words* survive.
 */
export function isEcho(heard: string, spoken: string): boolean {
  if (!spoken) return false
  if (OVERRIDE.test(heard)) return false

  const all = norm(heard).split(' ').filter(Boolean)
  if (!all.length) return true

  const mine = new Set(norm(spoken).split(' '))
  const content = all.filter((w) => !STOP.has(w))

  // Nothing distinctive was said at all, so there is no strong evidence either
  // way. Demand a total match before discarding it — the cost of dropping a
  // real question is much higher than the cost of one stray echo getting in.
  if (content.length < 2) {
    if (all.length < 2) return false
    return all.every((w) => mine.has(w))
  }

  let hits = 0
  for (const w of content) if (mine.has(w)) hits++
  return hits / content.length >= 0.6
}
