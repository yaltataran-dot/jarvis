import { L, OVERRIDE, R, STOP_ONLY, STOP_TAIL } from './stopWords'
import { isEcho, norm } from './echo'
import { isBargeIn } from './bargeIn'
import { makeLedger, type Result } from './ledger'
import {
  LATE_FINAL_MS,
  READY_MS,
  SELF_GUARD_MS,
  WAKE,
  WAKE_DEBOUNCE,
  afterWake,
  deadVoice,
  diag,
  drop,
  makeAssembler,
  nextUtteranceId,
  trace,
  type Voice,
  type VoiceHandlers,
} from './voiceCore'

/** "нет"/"no" cut through his speech, but inside the rest of a question ("нет ли дождя") they are just words. */
const PLAIN_NO = new RegExp(`${L}(?:нет|no)${R}`, 'giu')
/** ...but a rest that ends on a bare "нет" may be the user's own answer, so it is not swallowed. */
const NO_TAIL = new RegExp(`${L}(?:нет|no)${R}[\\s,.!?]*$`, 'iu')

/**
 * What the speech output knows about his own voice — tts.ts in the page, a
 * stand-in in the tests.
 */
export type SpeechState = {
  /** When the current sentence started, or 0 if nothing is being spoken. */
  speakingSince: () => number
  /** Speaking, or within the audible guard of having stopped. */
  speechActive: () => boolean
  /** When his last sound ended. */
  lastSoundEnded: () => number
  /** What the microphone is likely hearing from the speakers right now. */
  speakingNow: () => string
}

/**
 * What Chrome reports as an error in normal running: its silence timeout, and
 * a session we aborted ourselves.
 */
const ROUTINE = new Set(['no-speech', 'aborted'])

/** The longest wait before starting again after a session failed. */
const RETRY_MAX_MS = 5000

export type BrowserVoiceDeps = {
  /** The browser's SpeechRecognition constructor, or null where there is none. */
  Ctor: any
  /** 'ru' or 'en'. */
  lang: string
  speech: SpeechState
}

/* -------------------------------------------------------------------------- */
/* Browser fallback: SpeechRecognition                                        */
/* -------------------------------------------------------------------------- */

/**
 * The keyless path. Uses the browser's own SpeechRecognition for both detection
 * and transcription, so a student who has configured nothing still gets voice.
 *
 * It is the flakier engine — Chrome throttles it and it can go silent with no
 * event to catch — so a heartbeat watches it and forces a fresh session
 * whenever it stops showing signs of life. That single guard is the difference
 * between "the wake word stopped working halfway through the lesson" and an
 * assistant that keeps listening.
 */
export function startBrowserVoice(h: VoiceHandlers, d: BrowserVoiceDeps): Voice {
  const Ctor = d.Ctor
  if (!Ctor) {
    h.onError('This browser has no speech recognition — use Chrome or Edge, or add an ElevenLabs key.')
    return deadVoice()
  }
  const { speakingSince, speechActive, lastSoundEnded, speakingNow } = d.speech

  let stopped = false
  /** The microphone was refused: this loop will never hear anything. */
  let refused = false
  let running = false
  /**
   * The one live recogniser. Every handler checks it is still this one: an
   * aborted session goes on to fire its own `end`, and that stale `end` used
   * to null out its replacement and schedule another start — two recognisers
   * running at once, every phrase handled twice.
   */
  let rec: any = null
  /**
   * When the live session was created. A session created after his last sound
   * cannot hold any of it — see hearsHim.
   */
  let sessionAt = 0
  /** Which of the live session's results have already been dealt with. */
  const ledger = makeLedger()
  /** rearm() calls waiting for a session to start capturing. */
  let ready: ((ok: boolean) => void)[] = []
  const settleReady = (ok: boolean) => {
    const waiting = ready
    ready = []
    for (const r of waiting) r(ok)
  }
  let settled = ''
  let interim = ''
  let started = false
  let barged = false
  let lastWake = 0
  let lastAlive = Date.now()
  let silenceTimer: ReturnType<typeof setTimeout> | null = null
  /** The live session reported a real error — see onend. */
  let failed = false
  /** Sessions in a row that ended on one, with nothing heard. */
  let failures = 0

  /** Same assembly rules as the premium path — a pause is not a full stop. */
  const assemble = makeAssembler({
    emit: (text) => {
      diag.dropped = ''
      diag.accepted++
      diag.holding = ''
      h.onUtterance(text, nextUtteranceId())
    },
    partial: (text) => h.onPartial(text),
  })

  /** The last phrase handed on as speech, normalised, and when — see onResult. */
  let lastSent = ''
  let lastSentAt = 0
  /** ...and as it was heard, for a late final that finishes it. */
  let lastSentText = ''

  const touch = () => {
    lastAlive = Date.now()
  }

  const clearSilence = () => {
    if (silenceTimer) clearTimeout(silenceTimer)
    silenceTimer = null
  }

  /**
   * Is the live session hearing him?
   *
   * While he speaks, yes. In the AUDIBLE_GUARD_MS after, only if the session
   * was already running while he spoke: its pending results can still hold his
   * voice. A session started after he fell quiet — rearm() starts one the
   * moment he finishes — holds nothing of his, so holding it to the guard only
   * threw away the first words of the reply he had just invited.
   */
  const hearsHim = () =>
    speakingSince() !== 0 || (speechActive() && sessionAt <= lastSoundEnded())

  /** The first result of this phrase has been traced — see turnLog.ts. */
  let traced = false

  /** Everything heard so far is dealt with: sent, or deliberately dropped. */
  const reset = () => {
    traced = false
    clearSilence()
    settled = ''
    interim = ''
    started = false
    barged = false
    ledger.commit()
  }

  const emit = () => {
    const text = `${settled} ${interim}`.replace(/\s+/g, ' ').trim()
    const mode = h.mode()
    reset()
    trace('voice:emit', { mode, len: text.length, text: text.slice(0, 120) })
    if (!text || mode === 'deaf') return
    // Never a command while he is audible — see onResult.
    if (hearsHim()) {
      drop('heard while he was speaking')
      return
    }
    if (isEcho(text, speakingNow())) {
      drop('echo of his own voice')
      return
    }
    diag.heard = text
    diag.heardAt = Date.now()
    // Dealt with, whatever it turns out to be. Recorded before the wake branch
    // too: a phrase that wakes him starts a turn just as a command does, and
    // its own late final must not come back as a barge-in on that turn.
    lastSent = norm(text)
    lastSentAt = Date.now()
    lastSentText = text
    if (mode === 'wake') {
      assemble.cancel()
      if (WAKE.test(text) && Date.now() - lastWake > WAKE_DEBOUNCE) {
        lastWake = Date.now()
        diag.wakes++
        diag.dropped = ''
        diag.accepted++
        h.onWake(afterWake(text))
      } else {
        drop(`heard "${text.slice(-40)}" — not his name`)
      }
      return
    }
    // The recogniser has already endpointed on its own 900ms gap; the assembler
    // decides whether that gap actually ended the thought. `false` because a
    // result only reaches here once the recogniser has gone quiet.
    assemble.feed(text, false)
  }

  const bumpSilence = () => {
    clearSilence()
    // Endpoint on a short quiet gap; the ElevenLabs path tunes this more
    // finely, but a fixed window is plenty for the fallback.
    silenceTimer = setTimeout(emit, 900)
  }

  /** When a stop was last taken over him — see stopOverHim. */
  let stopAt = 0

  /**
   * A stop the user said over him, in this recogniser event, if there is one.
   *
   * It used to have to be the whole of what was heard — "стоп" and nothing
   * else — and while he speaks it almost never is: the microphone hears his
   * voice and the user's as one phrase, "сегодня в москве солнечно стоп".
   * Worse, when Chrome revised his words in the same breath ("солнечна" into
   * "солнечно стоп"), the ledger took the revision for the same phrase heard
   * better and the stop with it was thrown away. He went on talking.
   *
   * So: a stop alone, as before; or a stop at the end of the newest result,
   * read whole — the newest thing said is at its end, whatever his voice put
   * before it. Not when the word is his own: "на море тихо" from his answer is
   * not the user saying "тихо". And once only: after a stop is taken, nothing
   * more stops him until he has started speaking again, so the same word
   * coming back as he falls quiet is not a second stop.
   */
  const stopOverHim = (
    said: string,
    fresh: string,
    list: Result[],
    from: number,
  ): { word: string; how: 'alone' | 'tail' } | null => {
    if (stopAt && !(speakingSince() > stopAt)) return null
    const his = new Set(norm(speakingNow()).split(' '))
    if (said && STOP_ONLY.test(said)) {
      const echoed = norm(said)
        .split(' ')
        .some((w) => his.has(w))
      if (!echoed || fresh.trim()) return { word: said, how: 'alone' }
    }
    for (let i = list.length - 1; i >= from; i--) {
      const text = list[i]?.transcript ?? ''
      if (!text.trim()) continue
      const m = STOP_TAIL.exec(text)
      if (m) {
        const words = norm(m[1]).split(' ').filter(Boolean)
        if (!words.every((w) => his.has(w))) return { word: m[1].trim(), how: 'tail' }
      }
      // Only the newest result that holds words: older ones are already past.
      break
    }
    return null
  }

  const onResult = (e: any) => {
    touch()
    if (!traced) {
      traced = true
      trace('rec:start', { mode: h.mode() })
    }
    const mode = h.mode()
    diag.mode = mode
    // Only what has not been dealt with already — see ledger.ts. Read in every
    // mode, so whatever is dropped below is known to have been seen.
    const list: Result[] = []
    for (let i = e.resultIndex; i < e.results.length; i++) {
      list[i] = { transcript: e.results[i][0].transcript, isFinal: e.results[i].isFinal }
    }
    const read = ledger.read(list, e.resultIndex)
    const fresh = read.fresh
    interim = read.interim
    if (mode === 'deaf') {
      interim = ''
      return
    }
    const heard = `${settled}${fresh} ${interim}`.replace(/\s+/g, ' ').trim()
    // Nothing new — except that over his voice a revision with nothing new by
    // the ledger's reckoning can still end in a stop; see stopOverHim.
    if (!heard && !hearsHim()) return

    /**
     * He is audible, so the microphone is hearing the speakers.
     *
     * This engine has no echo cancellation against the page's own audio, and
     * the text match in isEcho is not enough on its own: the recogniser
     * garbles synthetic speech, his answer scored as new words, cut him off as
     * a barge-in, and was sent back to him as a question — he answered himself
     * in a loop. So while he speaks nothing he might be saying is a command.
     *
     * One thing gets through: a standalone stop ("стоп", "хватит, сэр"), the
     * whole phrase and nothing else. An interim one is taken at once so stop is
     * instant — unless he is saying that very word himself right now, when it
     * waits for the final. Everything else is discarded, along with whatever
     * had accumulated, and the session is restarted once he falls quiet (see
     * the resync below), so late results from his speech cannot surface either.
     */
    if (hearsHim()) {
      const said = `${fresh} ${interim}`.replace(/\s+/g, ' ').trim()
      const stop = mode === 'wake' ? null : stopOverHim(said, fresh, list, e.resultIndex)
      if (stop) {
        reset()
        stopAt = Date.now()
        lastSent = norm(stop.word)
        lastSentAt = Date.now()
        lastSentText = stop.word
        diag.heard = stop.word
        diag.heardAt = Date.now()
        diag.accepted++
        diag.stops++
        diag.dropped = ''
        trace('voice:stop-heard', { word: stop.word, how: stop.how })
        h.onSpeechStart()
        h.onUtterance(stop.word, nextUtteranceId())
        return
      }
      if (!heard) return
      reset()
      drop('heard while he was speaking')
      return
    }

    if (isEcho(`${fresh} ${interim}`, speakingNow())) {
      interim = ''
      return
    }
    // The recogniser finalising a phrase that has already been sent. Chrome's
    // final result can land after the 900ms endpoint fired, when he is already
    // thinking, and the repeat counted as a barge-in that cancelled the very
    // question it repeats. A stop word always gets through.
    if (mode === 'guard' && Date.now() - lastSentAt < LATE_FINAL_MS) {
      const now = norm(`${fresh} ${interim}`)
      if (now && lastSent.startsWith(now) && !OVERRIDE.test(now)) {
        interim = ''
        drop('late final of the question just sent')
        return
      }
      /**
       * The rest of the question just sent.
       *
       * The endpoint fires on 900 ms without a new result, and now and then
       * Chrome sits that long on an interim — "какая погода" — and then
       * finalises the same result with the rest: "какая погода в москве".
       * Those added words used to be taken on their own: two final words, so a
       * barge-in, and the turn on the half-question was replaced by a turn on
       * "в москве". One phrase, two turns, and neither of them the question.
       *
       * They are the same result, so they are the same phrase: the turn that
       * replaces the half-question is given all of it. Words in a result of
       * their own are the user going on, and stay a question of their own;
       * a stop word stays a stop.
       */
      if (fresh.trim() && ledger.extended() && !OVERRIDE.test(fresh.replace(PLAIN_NO, ' ')) && !NO_TAIL.test(fresh)) {
        trace('voice:late-rest', { len: fresh.length })
        settled = `${lastSentText} `
      }
    }

    if (mode === 'wake') {
      settled += fresh
      if (WAKE.test(heard)) {
        /**
         * His name — and quite possibly the start of a command.
         *
         * This used to wake him on the first interim that held the name, with
         * whatever that interim had after it as the command. Chrome's interim
         * is a few words behind the speaker, so "Джарвис, удали встречу в
         * четыре" went out as "удали", and the rest — finalised a moment later
         * under the same result — arrived as fresh words while he was already
         * thinking, passed as a barge-in, cancelled that turn and became a
         * second one. One phrase, two dialogues, the first of them answering
         * half a sentence. So the name is acted on where any phrase is: at the
         * end of it, once, with all of it.
         */
        bumpSilence()
      } else if (settled.length > 400) {
        settled = ''
      }
      return
    }

    settled += fresh
    const full = `${settled} ${interim}`.replace(/\s+/g, ' ').trim()
    if (!started || (mode === 'guard' && !barged)) {
      if (mode === 'guard') {
        // An override word cuts through everything below it — "stop" has to
        // work on the first syllable or it is not a stop button.
        if (!OVERRIDE.test(full)) {
          // His own first syllable, same as the premium path. This engine has
          // no energy gate, so without the clock the only defence is the word
          // count below, and a single clear word is exactly what leaks first.
          const since = speakingSince()
          if (since && Date.now() - since < SELF_GUARD_MS) {
            diag.selfGuarded++
            return
          }
          // Two words before this engine believes an interruption. The energy
          // path can be instant because it triggers on loudness the canceller
          // has already had a pass at; here the evidence is a transcript of
          // audio that includes his own playback, and one word of that is not
          // evidence of anything. And they must be final words: an interim
          // guess the recogniser later withdraws cancelled the question in
          // flight and left nothing to replace it — see bargeIn.ts.
          if (!isBargeIn(settled, interim)) return
        }
      }
      started = true
      if (mode === 'guard') barged = true
      h.onSpeechStart()
    }
    diag.dropped = ''
    // Show the whole thought, not just the fragment being spoken now — there
    // may be an earlier half of it held by the assembler.
    const carried = assemble.held()
    h.onPartial(carried ? `${carried} ${full}` : full)
    bumpSilence()
  }

  const spin = () => {
    // One recogniser at a time: `rec` is set from creation, not from `start`,
    // so a second call while the first is still starting does nothing.
    if (stopped || rec) return
    const r = new Ctor()
    rec = r
    sessionAt = Date.now()
    // A new session numbers its results from 0 again.
    ledger.clear()
    r.continuous = true
    r.interimResults = true
    r.lang = d.lang === 'ru' ? 'ru-RU' : 'en-GB'
    r.onstart = () => {
      if (r !== rec) return
      running = true
      diag.running = true
      diag.sessions++
      touch()
      trace('voice:session', { afterHim: sessionAt > lastSoundEnded() })
      // Capturing now: whoever was waiting to invite the user can.
      if (!hearsHim()) settleReady(true)
    }
    r.onresult = (e: any) => {
      if (r !== rec) return
      failures = 0
      onResult(e)
    }
    r.onerror = (ev: any) => {
      if (r !== rec) return
      const code = String(ev.error ?? '')
      // Chrome's own silence timeout: a continuous session that hears no
      // speech for some seconds reports 'no-speech' and ends, and is started
      // again below. Routine, every few seconds of a quiet room — counted, and
      // kept out of lastError, where the diagnostics showed it as a fault and
      // it overwrote whatever real error was there.
      if (ROUTINE.has(code)) {
        diag.quiet++
        trace('voice:quiet', { code })
        return
      }
      diag.lastError = code
      failed = true
      trace('voice:error', { error: code })
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        stopped = true
        refused = true
        diag.running = false
        settleReady(false)
        h.onError('Microphone access was refused — voice input is unavailable.')
      }
    }
    r.onend = () => {
      // A session we already replaced is not ours to restart.
      if (r !== rec) return
      running = false
      diag.running = false
      touch()
      rec = null
      /**
       * A session that ended on a real error — no network for Chrome's speech
       * service, the capture device gone — ends again the moment it starts,
       * and restarting it every 80 ms is a loop that never stops. Each one in
       * a row waits longer, up to RETRY_MAX_MS; anything heard resets it.
       */
      if (failed) failures++
      failed = false
      const wait = failures ? Math.min(RETRY_MAX_MS, 250 * 2 ** (failures - 1)) : 80
      if (failures) trace('voice:retry', { failures, wait })
      if (!stopped) setTimeout(spin, wait)
    }
    try {
      r.start()
    } catch {
      if (rec === r) rec = null
      running = false
      setTimeout(spin, 250)
    }
  }

  /**
   * Drop the live session — and every result it was still holding — and start
   * a fresh one. Its own `end` handler is replaced (see `rec`), so this is the
   * only thing that schedules the next start.
   *
   * The next session starts the moment the old one reports it has let go of
   * the microphone, rather than after a fixed beat: every millisecond here is
   * deafness at exactly the point he has just asked the user to speak. The
   * timer is only the fallback for an `end` that never comes; spin() starts
   * one session however many of them fire.
   */
  const restart = () => {
    const r = rec
    rec = null
    running = false
    diag.running = false
    touch()
    if (r) r.onend = () => spin()
    try {
      r?.abort()
    } catch {
      /* already gone */
    }
    setTimeout(spin, 150)
  }

  spin()

  // The heartbeat. If nothing has been heard from the engine for a while it has
  // gone quiet on us — tear it down and build a fresh one.
  const health = setInterval(() => {
    if (stopped) return
    const idle = Date.now() - lastAlive
    diag.idleMs = idle
    if (idle < 15000) return
    diag.restarts++
    restart()
  }, 5000)

  /**
   * Resync when he falls quiet. Chrome keeps finalising audio for a while after
   * hearing it, so a session that ran through his answer can still hand back a
   * piece of it after he stopped — which used to arrive as the next command.
   * When he stops being audible (his last sound plus a guard), anything
   * accumulated is thrown away and the session restarted from clean — unless
   * rearm() has already done that: a session started after his last sound has
   * nothing of his to drop, and what it holds is the user.
   */
  let wasAudible = false
  const resync = setInterval(() => {
    if (stopped) return
    const audible = hearsHim()
    if (audible && !wasAudible) reset()
    if (!audible && wasAudible && sessionAt <= lastSoundEnded()) {
      reset()
      diag.resyncs++
      trace('voice:resync')
      restart()
    }
    wasAudible = audible
  }, 100)

  return {
    ok: () => !refused,
    stop: () => {
      stopped = true
      clearInterval(health)
      clearInterval(resync)
      clearSilence()
      assemble.cancel()
      diag.running = false
      settleReady(false)
      try {
        rec?.abort()
      } catch {
        /* noop */
      }
    },
    live: () => running,
    idle: () => !settled && !interim && !started && !assemble.held() && !silenceTimer,
    /**
     * Have a session that has not heard him capturing before the user is
     * invited to speak.
     *
     * The old order: he finished, the app played the listening cue at once,
     * and the session that had heard him was held to the audible guard for
     * 700 ms, then aborted and replaced, and the replacement took its own time
     * to start — up to a second and a half of deafness straight after the cue,
     * which is when people start talking. The first words were simply lost.
     *
     * Now the session is replaced the moment he finishes — dropping his tail
     * just as the resync would have — and this resolves once the new one is
     * capturing, so the cue is a promise the microphone can keep. It never
     * starts a second recogniser: spin() refuses while one exists.
     */
    rearm: () =>
      new Promise<boolean>((resolve) => {
        if (stopped) return resolve(false)
        // He is still talking; there is nothing to rearm until he stops.
        if (speakingSince() !== 0) return resolve(running)
        if (rec && running && !hearsHim()) return resolve(true)
        const timer = setTimeout(() => {
          ready = ready.filter((r) => r !== done)
          trace('voice:rearm-timeout', { running })
          resolve(running && !hearsHim())
        }, READY_MS)
        const done = (ok: boolean) => {
          clearTimeout(timer)
          resolve(ok)
        }
        ready.push(done)
        // Otherwise a session is already on its way and will settle this.
        if (rec && sessionAt <= lastSoundEnded()) {
          reset()
          diag.resyncs++
          trace('voice:rearm')
          restart()
        }
      }),
  }
}
