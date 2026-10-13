/**
 * Cutting streamed text into the pieces that are spoken one at a time.
 *
 * Text is cut at sentence boundaries as it streams in, so JARVIS starts
 * talking while Claude is still writing. Each piece is one synthesis request,
 * and each request ends in a pause — so a cut in the wrong place is an audible
 * gap in the middle of a phrase. Moved out of tts.ts unchanged in intent so the
 * tests can run it; kept free of imports for the same reason.
 */

/** Sentence end, allowing a closing quote or bracket — curly ones included,
 *  since models emit typographic punctuation far more often than ASCII. */
const SENTENCE_END = /([.!?]["'')\]”’]?\s)|(\n\n)/

/** Full stops that are not sentence ends. Cutting on these puts an audible
 *  gap inside "Mr. Stark" and reads as a stutter. The single Russian letters
 *  are the halves of "т. е.", "и т. д.", "в т. ч." — none of them is a word. */
const ABBREVIATION =
  /(?:^|\s)(mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|e\.g|i\.e|approx|inc|ltd|co|no|vol|fig|dept|est|min|max|hr|hrs|a\.m|p\.m|u\.s|u\.k|no|т\.е|т\.д|т\.п|т\.к|др|пр|г|гг|ул|руб|тыс|млн|млрд|напр|см|стр|т|д|п|к|е|ч|кв|сек|км|кг|мм)\.$/iu

/** An initial — "А. С. Пушкин". Case-sensitive, so "это я." still ends a sentence. */
const INITIAL = /(?:^|\s)\p{Lu}\.$/u

/**
 * A full stop that does not end a sentence: an abbreviation, an initial, or a
 * fragment with no words in it at all — "1." heading a list item was spoken on
 * its own as "один", then the item after a pause.
 */
const notASentenceEnd = (candidate: string) => {
  const c = candidate.trimEnd()
  return ABBREVIATION.test(c) || INITIAL.test(c) || !/\p{L}{2}/u.test(c)
}

/**
 * Nobody punctuates forever, but a model occasionally writes a long clause
 * with no terminator at all — and while it does, nothing is spoken. Past this
 * many characters, cut and start talking.
 */
export const MAX_UNSPOKEN = 220

/** Where to break an over-long run with no full stop: a clause boundary if there is one. */
function breakPoint(text: string, limit: number): number {
  const head = text.slice(0, limit)
  const clause = Math.max(head.lastIndexOf(', '), head.lastIndexOf('; '), head.lastIndexOf(': '), head.lastIndexOf(' — '))
  // A clause boundary in the back half keeps the pieces long enough to sound
  // like phrases. Before, the cut fell on the last space, mid-phrase.
  if (clause > limit / 2) return clause + 1
  return head.lastIndexOf(' ')
}

/**
 * Every complete sentence in `buffer`, and what is left over.
 *
 * "Mr. Stark" is not two sentences, and "А. С. Пушкин" is not three: this
 * steps past every false boundary to the first one that ends something. It
 * used to fold forward by exactly one boundary without checking it, so a
 * second initial still cut the name in half.
 */
export function takeSentences(buffer: string): { sentences: string[]; rest: string } {
  const sentences: string[] = []
  for (;;) {
    let cut = -1
    for (let from = 0; ; ) {
      const m = SENTENCE_END.exec(buffer.slice(from))
      if (!m) break
      const end = from + m.index + m[0].length
      if (!notASentenceEnd(buffer.slice(0, end))) {
        cut = end
        break
      }
      from = end
    }
    // No real end yet — wait for more text.
    if (cut < 0) break
    sentences.push(buffer.slice(0, cut))
    buffer = buffer.slice(cut)
  }

  // Unpunctuated prose would otherwise sit here silently until the answer
  // ended, defeating the whole point of streaming.
  if (buffer.length > MAX_UNSPOKEN) {
    const cut = breakPoint(buffer, MAX_UNSPOKEN)
    if (cut > 40) {
      sentences.push(buffer.slice(0, cut))
      buffer = buffer.slice(cut)
    }
  }
  return { sentences, rest: buffer }
}
