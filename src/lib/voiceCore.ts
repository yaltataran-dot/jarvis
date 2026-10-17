import { L, OVERRIDE, R } from './stopWords'

/**
 * The parts of the voice loop that are the same for both engines — the wake
 * phrase, the assembler that turns segments into one utterance, and the
 * diagnostics — kept free of the browser config so the tests can run them.
 * The engines themselves are in voice.ts (VAD + Scribe) and browserVoice.ts.
 */

export type VoiceMode =
  /** Powered down. Only his name matters. */
  | 'wake'
  /** He is expecting you to speak. Everything is a command. */
  | 'command'
  /** He is thinking or talking. Anything you say is an interruption. */
  | 'guard'
  /** Something is playing that must not be transcribed at all. */
  | 'deaf'

export type VoiceHandlers = {
  /** Read fresh on every result, so the app never has to re-subscribe. */
  mode: () => VoiceMode
  /** Fired on his name. `trailing` is whatever followed it, so "Jarvis,
   *  what's the weather" is one breath rather than two turns. */
  onWake: (trailing: string) => void
  /** The user has genuinely started talking. This is the barge-in trigger. */
  onSpeechStart: () => void
  /** Live transcript, for the caption under the reactor. */
  onPartial: (text: string) => void
  /**
   * A complete, endpointed utterance. `id` is unique to it for the life of the
   * page: the same utterance delivered twice carries the same id, and the app
   * answers it once.
   */
  onUtterance: (text: string, id: number) => void
  /** The recogniser is unusable. Distinct from the user saying nothing. */
  onError: (message: string) => void
}

export type Voice = {
  stop: () => void
  /** True while a recogniser is actually running. */
  live: () => boolean
  /**
   * False when the loop cannot hear at all — no microphone, permission
   * refused, no recogniser in this browser. Such a loop is dead for good, and
   * the app offers to start a new one.
   */
  ok: () => boolean
  /**
   * He has finished speaking and the user is about to be invited to talk.
   * Resolves once a recogniser that has not heard him is capturing — true —
   * or false if none came up in time. See browserVoice.ts.
   */
  rearm: () => Promise<boolean>
  /**
   * Between phrases: nothing half-heard, nothing held back by the assembler.
   * Only then can the loop be replaced by another engine without losing words.
   * Absent on engines that cannot tell.
   */
  idle?: () => boolean
}

/** A loop that never started. */
export const deadVoice = (): Voice => ({ stop: () => {}, live: () => false, ok: () => false, rearm: async () => false })

/** One id per utterance handed to the app, across both engines. */
let utteranceSeq = 0
export const nextUtteranceId = () => ++utteranceSeq

/**
 * The trace hook. voice.ts points it at the bridge's trace(); in the tests it
 * stays silent, or records.
 */
let traceFn: (step: string, info?: Record<string, string | number | boolean>) => void = () => {}
export function setVoiceTrace(fn: typeof traceFn) {
  traceFn = fn
}
export const trace = (step: string, info: Record<string, string | number | boolean> = {}) => traceFn(step, info)

// ---------------------------------------------------------------------------
// Endpointing
// ---------------------------------------------------------------------------

/** One utterance often produces several partials containing his name. */
export const WAKE_DEBOUNCE = 1500

/**
 * His name, and the only wake phrase.
 *
 * The optional prefix is genuinely optional: addressing him by name alone is
 * correct, and during an answer "Jarvis" on its own is the natural way to cut
 * in. The negative lookahead keeps possessives ("Jarvis's job") from waking him.
 *
 * The alternates are not padding. "Jarvis" is not in a general dictation
 * model's high-frequency vocabulary, and Chrome routinely returns Travis,
 * Jervis, Jarvys or Java's for a perfectly clear utterance — every one of which
 * used to be silently discarded, so the wake word "just didn't work" with no
 * indication why. Better a rare false wake than a name that does not answer.
 *
 * Russian recognition does the same to "Джарвис" — Джервис, Жарвис, Джарвиз —
 * and still hands back the Latin spelling now and then, so both alphabets are
 * accepted in both modes.
 *
 * `\b` only knows ASCII letters, so it never matches next to Cyrillic. The
 * boundaries here are Unicode lookarounds instead (`u` flag on every regex
 * built from them).
 */
export const NAME_PREFIX = '(?:hey|hi|ok|okay|yo|эй|хей|хэй|привет|окей|ок|слушай)'
export const NAME =
  "(?:jarvis's|jarvis|jarvys|jervis|travis|jarviss|java's|jarv|" +
  'джарвис|джарвиз|джарвес|джервис|жарвис|чарвис|джарви)'
/** Ends a name, Unicode-aware — for callers building their own patterns. */
export const NAME_END = R

export const WAKE = new RegExp(`${L}(?:${NAME_PREFIX}[\\s,]*)?${NAME}${R}(?!'s)`, 'iu')

/** Everything after the wake phrase, which is usually the actual command. */
export function afterWake(text: string): string {
  const m = WAKE.exec(text)
  if (!m) return ''
  return text
    .slice(m.index + m[0].length)
    .replace(/^[\s,.:;!?-]+/, '')
    .trim()
}

// ---------------------------------------------------------------------------
// Assembling one utterance out of several segments
// ---------------------------------------------------------------------------

/**
 * Why this exists.
 *
 * The voice-activity detector is an energy gate, and energy is a fact about the
 * room rather than about the sentence. It ends a segment after a fixed quiet
 * gap, so "what's the weather in — " *pause* " — London" is two segments, two
 * transcripts and, before this, two turns: the first one asking the model a
 * truncated question, the second arriving as a bare noun with no question left
 * to attach it to. People pause. They pause to think of the word, to look at
 * something, mid-list, before the important part. An assistant that treats the
 * first gap as the end of the thought is one you have to talk to carefully, and
 * having to talk carefully is the whole failure.
 *
 * So the segment is no longer the turn. Transcripts accumulate here, and the
 * turn fires only when the text looks finished AND the room has gone quiet.
 *
 * Crucially this costs nothing in the common case. A complete sentence with no
 * one speaking fires immediately — `holdFor` returns 0 — so the latency of an
 * ordinary question is exactly what it was. The waiting only happens when there
 * is a reason to wait.
 */

/**
 * Ending on one of these means the sentence is not over, whatever the silence
 * says. Function words only: they are closed-class, so the list is complete in
 * a way a content-word list could never be, and none of them is a plausible
 * last word of a real request.
 */
const CONTINUES = new RegExp(
  `${L}(?:and|or|but|so|because|since|if|when|while|that|which|who|whose|to|of|in|on|at|by|for|with|from|about|into|onto|over|under|between|through|the|a|an|my|your|his|her|its|our|their|is|are|was|were|be|been|do|does|did|have|has|had|can|could|would|should|will|shall|might|must|like|than|then|as|very|really|just|some|any|all|both|either|neither|` +
    // The Russian closed class: conjunctions, prepositions, possessives.
    `и|или|а|но|что|чтобы|потому|поэтому|если|когда|пока|который|которая|которое|которые|в|во|на|о|об|обо|про|с|со|к|ко|по|за|из|от|до|для|у|при|над|под|между|через|без|мой|моя|моё|мое|мои|твой|ваш|ваша|наш|наша|их|его|её|ее|как|чем|же|ли|очень|самый|самая|самое)$`,
  'iu',
)

/** Trailing punctuation a transcriber emits mid-thought. */
const TRAILS = /[,;:–—-]$/

/**
 * A barge-in this soon after he starts a sentence is him, not you.
 *
 * Echo cancellation and the raised guard threshold stop most of his playback
 * reaching the detector, but the attack of the very first syllable is the
 * loudest, least-cancelled thing in the whole answer — it arrives before the
 * canceller has adapted to it. Without this, a long answer could interrupt
 * itself on its own first word, which reads as JARVIS refusing to speak.
 *
 * Kept short deliberately. This is the one window where a genuine interruption
 * is also least likely: the user has not yet heard enough to want to stop him.
 */
export const SELF_GUARD_MS = 350

/**
 * How long rearm() waits for a fresh recogniser session to start capturing.
 * Chrome usually takes a few hundred ms; past this the user is invited anyway
 * and told the recogniser is not up.
 */
export const READY_MS = 2000

/** How long after sending a phrase its own late final result is recognised as such. */
export const LATE_FINAL_MS = 5000

/**
 * A quiet gap this long with a finished-looking sentence ends the turn.
 *
 * Small on purpose: by the time a transcript reaches the assembler the detector
 * has already sat through SILENCE_MS of quiet and the transcriber has taken its
 * own few hundred milliseconds, so roughly a second of real silence has passed
 * already. All this window has to catch is someone drawing breath to add one
 * more clause. Making it generous here is what would make every ordinary
 * question feel slow.
 */
const SETTLE_MS = 250
/** ...and this long when the sentence is plainly unfinished. */
const CONTINUE_MS = 1600
/**
 * Nothing is held longer than this in total. A ceiling rather than a timer:
 * without it, someone who ends every clause on "and" could hold a turn open
 * for ever, and the assistant would look like it had stopped listening.
 */
const MAX_HOLD_MS = 6000

/**
 * How long to keep waiting, given what has been said so far.
 * 0 means "this is a complete thought, send it now".
 */
function holdFor(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (!words.length) return CONTINUE_MS
  // An explicit terminator is the speaker telling us they are done.
  if (/[.!?]$/.test(text)) return 0
  if (TRAILS.test(text.trim())) return CONTINUE_MS
  if (CONTINUES.test(words[words.length - 1])) return CONTINUE_MS
  // One or two words is usually the start of something, not the whole of it —
  // except for the short commands that genuinely are complete.
  if (words.length <= 2 && !OVERRIDE.test(text)) return CONTINUE_MS
  return SETTLE_MS
}

export type Assembler = {
  /** Add a transcript. `active` is true if the user is audibly still going. */
  feed: (text: string, active: boolean) => void
  /** Send whatever is held right now, if anything. */
  flush: () => void
  /** Throw away whatever is held — used when he stands down. */
  cancel: () => void
  held: () => string
}

export function makeAssembler(h: {
  emit: (text: string) => void
  partial: (text: string) => void
}): Assembler {
  let held = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  let firstAt = 0

  const clear = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }

  const fire = () => {
    clear()
    const text = held.trim()
    held = ''
    firstAt = 0
    trace('voice:utterance', { len: text.length })
    if (text) h.emit(text)
  }

  return {
    feed(text, active) {
      if (!text.trim()) return
      held = `${held} ${text}`.replace(/\s+/g, ' ').trim()
      if (!firstAt) firstAt = Date.now()
      // The caption shows the whole thought as it assembles, not just the
      // fragment that happened to arrive last.
      h.partial(held)
      diag.holding = held
      clear()

      // Already talking again. Decide nothing now — the next transcript is
      // part of this same sentence and will bring more of it.
      if (active) {
        timer = setTimeout(fire, MAX_HOLD_MS)
        return
      }

      const wait = Math.min(
        holdFor(held),
        Math.max(0, MAX_HOLD_MS - (Date.now() - firstAt)),
      )
      diag.waitedMs = wait
      if (wait === 0) {
        fire()
        return
      }
      timer = setTimeout(fire, wait)
    },
    flush: fire,
    cancel() {
      clear()
      held = ''
      firstAt = 0
      diag.holding = ''
    },
    held: () => held,
  }
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * Live state of the voice loop, published on `window.__voice`.
 *
 * When someone says the wake word and nothing happens there are only a handful
 * of possible causes — the recogniser never started, it started and died, it is
 * running but hearing silence, or it is hearing you and transcribing the name
 * as something else. From outside the page those are indistinguishable, which
 * makes the failure impossible to report and impossible to fix. This tells them
 * apart in one glance.
 */
export const diag = {
  /** Which input engine is running: 'scribe' or 'deepgram' (realtime), 'elevenlabs' (VAD+batch Scribe) or 'browser'. */
  engine: 'browser',
  /** Whether the microphone pipeline is live. */
  running: false,
  /** Speech segments captured since load. */
  sessions: 0,
  /** The most recent transcript, whatever the mode. */
  heard: '',
  heardAt: 0,
  /** Last failure — a transcription error, or a capture error. */
  lastError: '',
  /** Browser sessions Chrome closed after hearing silence ('no-speech') — routine. */
  quiet: 0,
  /** Stops heard over his voice and handed on. */
  stops: 0,
  /** Times the wake word matched. */
  wakes: 0,
  /** Current mode, as the app last reported it. */
  mode: '',
  /** Why the last transcript was ignored — '' when it was accepted. */
  dropped: '',
  /** Transcripts accepted and passed to the app. */
  accepted: 0,
  /** Text assembled but not yet sent, because the thought looks unfinished. */
  holding: '',
  /** How long the assembler decided to wait before sending, in ms. */
  waitedMs: 0,
  /** Barge-ins suppressed because he had only just started the sentence. */
  selfGuarded: 0,
  /** Transcription failures (network, or the bridge speech proxy). */
  restarts: 0,
  /** Sessions restarted after he finished speaking, to drop late results. */
  resyncs: 0,
  /** Milliseconds the last transcription round-trip took. */
  idleMs: 0,
}

/** Record why a transcript went nowhere. Silence always has a reason; this is
 *  the difference between debugging it and speculating about it. */
export function drop(why: string) {
  diag.dropped = why
  trace('voice:drop', { why: why.slice(0, 60) })
}

if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__voice = diag
}
