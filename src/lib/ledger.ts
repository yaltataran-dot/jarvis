import { norm } from './echo'

/**
 * What the browser recogniser has handed back that has not been dealt with yet.
 *
 * Chrome's recogniser keeps one list of results for the life of a session, and
 * a result is revised in place until it is final. The voice loop sends a phrase
 * 900 ms after the last change — often while that phrase is still interim —
 * and Chrome finalises it a moment later, under the same index. That final used
 * to read as new speech: it started a second utterance with the same words, the
 * question went to the bridge twice ("turn interrupted after 1.0 s", a new turn
 * the same second) and the dialog showed the phrase twice.
 *
 * Matching the text against the last phrase sent could not settle it, because
 * the final rarely spells the phrase the way the interim did. The index can:
 * once a phrase is sent, the results it came from are spent, and a later
 * version of one of them contributes only the words it adds at the end. A
 * genuine repeat — the user saying the same thing again — is a new result with
 * a new index, so it still comes through.
 */
export type Ledger = {
  /**
   * Read one recogniser event: the results from `from` on. Returns the words
   * nobody has dealt with yet, final and interim apart.
   */
  read: (results: ArrayLike<Result>, from: number) => { fresh: string; interim: string }
  /** Everything read so far has been dealt with — sent, or deliberately dropped. */
  commit: () => void
  /** A new session: its indices start again from 0. */
  clear: () => void
}

export type Result = { transcript: string; isFinal: boolean }

export function makeLedger(): Ledger {
  /** The latest transcript of each result, by index. */
  let seen: string[] = []
  /** The transcript of each result as it stood when it was dealt with. */
  let spent: (string | undefined)[] = []

  return {
    read(results, from) {
      let fresh = ''
      let interim = ''
      for (let i = from; i < results.length; i++) {
        const { transcript, isFinal } = results[i]
        seen[i] = transcript
        const text = unspent(transcript, spent[i])
        if (isFinal) {
          fresh += text
          // A final never changes again, so a second delivery of it is the
          // same words, not more of them.
          spent[i] = transcript
        } else {
          interim += text
        }
      }
      return { fresh, interim }
    },
    commit() {
      spent = seen.slice()
    },
    clear() {
      seen = []
      spent = []
    },
  }
}

/**
 * The part of `now` that was not already there in `before`.
 *
 * The words already dealt with, compared normalised — Chrome capitalises and
 * punctuates the final but not the interim. If the recogniser has kept them and
 * added more, the addition is new speech. If it has rewritten them ("блок нот"
 * into "блокнот") it is the same audio heard better, and nothing in it is new.
 */
function unspent(now: string, before: string | undefined): string {
  if (before === undefined) return now
  const had = norm(before).split(' ').filter(Boolean)
  const words = norm(now).split(' ').filter(Boolean)
  if (words.length <= had.length) return ''
  for (let i = 0; i < had.length; i++) {
    if (words[i] !== had[i]) return ''
  }
  return ` ${words.slice(had.length).join(' ')}`
}
