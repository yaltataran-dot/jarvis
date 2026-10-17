import { OVERRIDE, STOP_ONLY, STOP_TAIL } from './stopWords'
import { isEcho, norm } from './echo'
import { isBargeIn } from './bargeIn'
import type { SpeechState } from './browserVoice'
import {
  SELF_GUARD_MS,
  WAKE,
  WAKE_DEBOUNCE,
  afterWake,
  diag,
  drop,
  makeAssembler,
  nextUtteranceId,
  trace,
  type Voice,
  type VoiceHandlers,
} from './voiceCore'

/**
 * ElevenLabs realtime Scribe (scribe_v2_realtime).
 *
 * One WebSocket for the life of the engine, fed by the microphone inside the
 * SDK. Scribe sends the words as they are spoken (partials) and the settled
 * phrase when its own voice-activity detector hears a pause (committed). The
 * rules for what those words may do are the browser engine's, because the
 * hazards are the same: his voice comes back through the microphone, so while
 * he is audible nothing but a stop gets through; a phrase is not a turn until
 * the assembler says so; a stop must work on the first syllable.
 *
 * This file knows nothing about the SDK. voice.ts hands in `connect`, so the
 * engine can be driven by a fake in the tests, and the SDK stays out of the
 * bundle until Scribe is actually wanted.
 *
 * It does not recover from a failure itself. A dead socket is reported once,
 * through `onFail`, and voiceSupervisor.ts moves the loop to the browser engine:
 * two engines holding the microphone at once would hear every phrase twice.
 */

/** What the SDK adapter calls. Text only — no audio ever passes through here. */
export type ScribeHooks = {
  /** The server accepted the session; audio is flowing. */
  onStarted: () => void
  /** The phrase so far, not yet settled. Each one replaces the last. */
  onPartial: (text: string) => void
  /** The phrase, settled. Arrives once per phrase. */
  onCommitted: (text: string) => void
  /** A failure the session cannot continue after. */
  onError: (reason: string) => void
  /** The socket closed. Expected only after our own close(). */
  onClose: () => void
}

export type ScribeLink = { close: () => void }

export type ScribeVoiceDeps = {
  /** Open a session with a single-use token. May reject; must not throw later. */
  connect: (token: string, hooks: ScribeHooks) => Promise<ScribeLink>
  speech: SpeechState
  /** The session died after it had started. Called once. */
  onFail: (reason: string) => void
  /** How long to wait for the server to accept the session. */
  startTimeoutMs?: number
}

/** The loop, plus whether it is between phrases — the only time it can be swapped. */
export type ScribeVoice = Voice & { idle: () => boolean }

export const SCRIBE_START_MS = 6000

/** The same words twice this close together are one commit delivered twice. */
const DUPLICATE_MS = 1500

const clean = (s: string) => s.replace(/\s+/g, ' ').trim()

/**
 * Open a Scribe session with `token` and resolve once it is running. Rejects —
 * with the microphone already released — if it cannot be brought up in time.
 */
export async function startScribeVoice(
  token: string,
  h: VoiceHandlers,
  d: ScribeVoiceDeps,
): Promise<ScribeVoice> {
  const { speakingSince, speechActive, speakingNow } = d.speech

  let stopped = false
  let failed = false
  let running = false
  let link: ScribeLink | null = null
  let startTimer: ReturnType<typeof setTimeout> | null = null
  let settleStart: { ok: () => void; fail: (e: Error) => void } | null = null

  /** The phrase being spoken now, as Scribe last heard it. */
  let interim = ''
  /** This phrase has been announced with onSpeechStart. */
  let started = false
  /** Some of this phrase was heard while he was audible, so it may be his own voice. */
  let tainted = false
  let lastWake = 0
  let lastCommit = ''
  let lastCommitAt = 0
  /** When a stop was last taken over him — once, until he speaks again. */
  let stopAt = 0

  const assemble = makeAssembler({
    emit: (text) => {
      diag.dropped = ''
      diag.accepted++
      diag.holding = ''
      h.onUtterance(text, nextUtteranceId())
    },
    partial: (text) => h.onPartial(text),
  })

  /** Speaking, or within the audible guard of having stopped. */
  const hearsHim = () => speakingSince() !== 0 || speechActive()

  const reset = () => {
    interim = ''
    started = false
    tainted = false
  }

  /**
   * A stop said over him, if this text holds one.
   *
   * A stop alone, or at the end of the newest words — the microphone hears his
   * voice and the user's as one phrase, so the stop is rarely alone in it. Not
   * when the word is his own, unless the phrase is settled: an interim "тихо"
   * may be him saying it, so it waits for the commit.
   */
  const stopOverHim = (text: string, settled: boolean): string | null => {
    if (stopAt && !(speakingSince() > stopAt)) return null
    const his = new Set(norm(speakingNow()).split(' '))
    if (STOP_ONLY.test(text)) {
      const echoed = norm(text)
        .split(' ')
        .some((w) => his.has(w))
      if (!echoed || settled) return text
    }
    const m = STOP_TAIL.exec(text)
    if (m) {
      const words = norm(m[1]).split(' ').filter(Boolean)
      if (!words.every((w) => his.has(w))) return m[1].trim()
    }
    return null
  }

  const takeStop = (word: string, how: 'partial' | 'committed') => {
    reset()
    // The rest of this phrase is the same stop, or his voice: not a command.
    tainted = true
    stopAt = Date.now()
    diag.heard = word
    diag.heardAt = Date.now()
    diag.accepted++
    diag.stops++
    diag.dropped = ''
    trace('voice:stop-heard', { how, len: word.length })
    h.onSpeechStart()
    h.onUtterance(word, nextUtteranceId())
  }

  /** Not in a barge-in: the first words must come from the user, not from him. */
  const bargesIn = (text: string): boolean => {
    if (OVERRIDE.test(text)) return true
    const since = speakingSince()
    if (since && Date.now() - since < SELF_GUARD_MS) {
      diag.selfGuarded++
      return false
    }
    return isBargeIn(text, '')
  }

  const onPartial = (raw: string) => {
    if (stopped || failed) return
    const text = clean(raw)
    if (!text) return
    const mode = h.mode()
    diag.mode = mode
    if (mode === 'deaf') return

    if (hearsHim()) {
      tainted = true
      if (mode !== 'wake') {
        const stop = stopOverHim(text, false)
        if (stop) takeStop(stop, 'partial')
      }
      return
    }
    if (isEcho(text, speakingNow())) return

    if (!interim) diag.sessions++
    interim = text
    // His name is acted on where any phrase is: at its end, with all of it.
    if (mode === 'wake') return

    if (!started) {
      if (mode === 'guard' && !bargesIn(text)) return
      started = true
      h.onSpeechStart()
    }
    diag.dropped = ''
    const carried = assemble.held()
    h.onPartial(carried ? `${carried} ${text}` : text)
  }

  const onCommitted = (raw: string) => {
    if (stopped || failed) return
    const text = clean(raw)
    const was = { started, tainted }
    reset()
    if (!text) return
    const now = Date.now()
    const key = norm(text)
    if (key && key === lastCommit && now - lastCommitAt < DUPLICATE_MS) {
      drop('the same phrase committed twice')
      return
    }
    lastCommit = key
    lastCommitAt = now

    const mode = h.mode()
    diag.mode = mode
    trace('voice:emit', { mode, len: text.length })
    if (mode === 'deaf') return

    if (hearsHim()) {
      const stop = mode === 'wake' ? null : stopOverHim(text, true)
      if (stop) return takeStop(stop, 'committed')
      drop('heard while he was speaking')
      return
    }
    if (was.tainted) {
      drop('began while he was speaking')
      return
    }
    if (isEcho(text, speakingNow())) {
      drop('echo of his own voice')
      return
    }
    diag.heard = text
    diag.heardAt = now

    if (mode === 'wake') {
      assemble.cancel()
      if (WAKE.test(text) && now - lastWake > WAKE_DEBOUNCE) {
        lastWake = now
        diag.wakes++
        diag.dropped = ''
        diag.accepted++
        h.onWake(afterWake(text))
      } else {
        drop(`heard "${text.slice(-40)}" — not his name`)
      }
      return
    }

    // A phrase that arrived whole, with no partial to announce it, is still
    // subject to the barge-in rules while he is thinking.
    if (!was.started) {
      if (mode === 'guard' && !bargesIn(text)) {
        drop('not an interruption')
        return
      }
      h.onSpeechStart()
    }
    diag.dropped = ''
    assemble.feed(text, false)
  }

  const release = () => {
    if (startTimer) clearTimeout(startTimer)
    startTimer = null
    running = false
    diag.running = false
    const l = link
    link = null
    try {
      l?.close()
    } catch {
      /* already gone */
    }
  }

  /** The session cannot go on. Whatever was heard is handed on before it ends. */
  const fail = (reason: string) => {
    if (stopped || failed) return
    failed = true
    diag.lastError = `scribe ${reason}`.slice(0, 80)
    diag.restarts++
    trace('scribe:fail', { reason: reason.slice(0, 40), started: running })
    // A command half-said is better sent as heard than lost with the socket.
    if (interim && started && !hearsHim() && h.mode() !== 'deaf') assemble.feed(interim, false)
    assemble.flush()
    reset()
    const wasRunning = running
    release()
    if (settleStart) {
      settleStart.fail(new Error(reason))
      settleStart = null
    } else if (wasRunning) d.onFail(reason)
  }

  const hooks: ScribeHooks = {
    onStarted: () => {
      if (stopped || failed) return
      running = true
      diag.running = true
      diag.lastError = ''
      if (startTimer) clearTimeout(startTimer)
      startTimer = null
      trace('scribe:started')
      settleStart?.ok()
      settleStart = null
    },
    onPartial,
    onCommitted,
    onError: (reason) => fail(reason),
    onClose: () => fail('closed'),
  }

  // Bring it up. A session that is not accepted in time is a failed one: the
  // caller falls back, and nothing is left holding the microphone.
  await new Promise<void>((ok, fail_) => {
    settleStart = { ok, fail: fail_ }
    startTimer = setTimeout(() => fail('start-timeout'), d.startTimeoutMs ?? SCRIBE_START_MS)
    d.connect(token, hooks).then(
      (l) => {
        // Stopped or failed while the SDK was loading: do not leave it open.
        if (stopped || failed) {
          try {
            l.close()
          } catch {
            /* already gone */
          }
          return
        }
        link = l
      },
      (err) => fail(`connect:${String((err as Error)?.name ?? 'error')}`),
    )
  })

  return {
    ok: () => !stopped && !failed,
    live: () => running && !failed && !stopped,
    // Scribe never stops listening for his speech — the guard rules above do
    // the work — so there is nothing to bring up when he finishes.
    rearm: async () => running && !failed && !stopped,
    idle: () => !interim && !started && !assemble.held(),
    stop: () => {
      if (stopped) return
      stopped = true
      assemble.cancel()
      settleStart?.fail(new Error('stopped'))
      settleStart = null
      release()
    },
  }
}
