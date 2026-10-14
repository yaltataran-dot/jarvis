import { OVERRIDE } from './stopWords'

/**
 * Does what the browser recogniser has heard, while he is thinking or working
 * on a tool, count as the user cutting in?
 *
 * Only what the recogniser has committed to. Its interim results are guesses,
 * revised as it goes and often withdrawn entirely — a cough, a voice in the
 * next room or the television comes through as "да так" and then as nothing.
 * Counting those cancelled the question in flight: the bridge logged "turn
 * interrupted" one to three seconds in, the guess was withdrawn so no new
 * question ever followed, and the user was left with no answer at all.
 *
 * So two words of final text are needed. A stop word is the exception and
 * still counts from its first interim syllable — a stop that waits for the
 * recogniser to finish is not a stop.
 *
 * Applies only while he is not audible; while he speaks, voice.ts accepts
 * nothing but a standalone stop phrase.
 */
export function isBargeIn(settled: string, interim: string): boolean {
  if (OVERRIDE.test(`${settled} ${interim}`)) return true
  return settled.trim().split(/\s+/).filter(Boolean).length >= 2
}
