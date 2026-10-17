import { useEffect, useRef } from 'react'
import { Scene } from './scene/Scene'
import { Hud } from './ui/Hud'
import { Boot } from './ui/Boot'
import { Ignition } from './ui/Ignition'
import { Diagnostics } from './ui/Diagnostics'
import { VoiceWaves } from './ui/VoiceWaves'
import { useStore } from './store'
import {
  startVoice,
  NAME,
  NAME_END,
  NAME_PREFIX,
  type Voice,
  type VoiceMode,
} from './lib/voice'
import { createSpeaker, cycleVoice, currentVoiceName, diag as ttsDiag } from './lib/tts'
import { STOP_ONLY } from './lib/stopWords'
import * as sfx from './lib/sfx'
import * as music from './lib/music'
import * as hands from './lib/hands'
import { listenForClap } from './lib/clap'
import * as camera from './lib/camera'
import * as kokoro from './lib/kokoro'
import { LANG, TTS_ENGINE } from './config'
import { forTool, attention, checking, considering, STARTUP_GREETING } from './lib/fillers'
import { localAnswer, sayClock } from './lib/localAnswer'
import {
  ask,
  warm,
  interrupt,
  watchServers,
  watchPanels,
  watchBlades,
  watchCapture,
  watchUi,
  watchConnection,
  connectedLabels,
  usingBridge,
  isConnected,
  withContext,
  asideNote,
  type Msg,
} from './lib/brain'
import { getMic, startAnalyser, micLevel } from './lib/audio'
import { probeCapabilities } from './lib/capabilities'
import { ServiceError, trace } from './lib/bridge'
import { env } from './config'
import { musicReply, parseMusicCommand, parseYesNo, type MusicIntent, type MusicKind } from './lib/musicIntent'
import { runMusic } from './lib/yandexMusic'
import { createCalendarFlow, type CalendarFlow } from './lib/calendarFlow'
import { bridgeCalendar } from './lib/calendarClient'
import { createFloor, type Floor, type Turn } from './lib/floor'
import { makeVoiceSlot, type VoiceSlot } from './lib/voiceSlot'
import { routePhrase } from './lib/turnRoute'
import { createAsides, type Asides } from './lib/aside'
import { GREET_SCREEN_MS, HANDOVER_MS, SPLASH_AFTER_START_MS } from './lib/bootTimeline'

type Speaker = ReturnType<typeof createSpeaker>

/**
 * The conversation.
 *
 * This used to be a sequential loop — greet, await a capture, await an answer,
 * repeat — with the microphone opened and closed around each step. That shape
 * cannot be interrupted: while it is awaiting the answer, nothing is listening,
 * so there is no way for the user to get a word in.
 *
 * It is an event machine now. The voice loop runs continuously and pushes
 * events at us; every one of them is legal in every phase. Saying anything at
 * all stops him talking, and whatever you say next becomes the new turn.
 */

/** How long to wait for someone to start speaking after he wakes. Generous:
 *  people say his name and *then* think about what they wanted. */
const AWAIT_SPEECH_MS = 14000

/** After an answer, how long the mic stays open for a follow-up before he
 *  drops back to standby. Long enough that you don't have to say the name
 *  again to continue a thought. */
const FOLLOW_UP_MS = 11000

/**
 * How long a question the bridge sorted as slow — a lookup ('medium') or one
 * to think through ('high') — may go without a word before a short fixed line
 * is said. Measured on the bridge, an answer on 'low' starts in about 1.4–3 s;
 * these start in 4–13 s. A quick medium answer still beats the line.
 */
/**
 * The usage limit, as he says it. In full the first time — with the time it
 * lifts, in words, when the bridge knows it — and briefly after that. Claude
 * is written as it is said, for the synthesiser.
 */
function limitLine(resetAt: string | null, first: boolean): string {
  if (LANG !== 'ru') {
    if (!first) return 'The limit has not lifted yet.'
    return resetAt ? `The Claude usage limit is reached. It lifts at ${resetAt}.` : 'The Claude usage limit is reached. Try again a little later.'
  }
  if (!first) return 'Лимит ещё не восстановился, сэр.'
  const m = resetAt ? /^(\d{1,2}):(\d{2})$/.exec(resetAt) : null
  return m
    ? `Лимит запросов Клода исчерпан. Он восстановится в ${sayClock(Number(m[1]), Number(m[2]))}.`
    : 'Лимит запросов Клода исчерпан. Попробуйте чуть позже.'
}

const EARLY_WORD_MS = 1200
const EARLY_WORD_HIGH_MS = 700

/** How long a music question ("Какую песню включить?", "Включить?") waits for its answer. */
const MUSIC_ANSWER_MS = 30000

/** How long after a music command bare "продолжи", "дальше" still mean the music. */
const MUSIC_CONTEXT_MS = 30 * 60_000

/** A music question he has asked, and what its answer will mean. */
type MusicQuestion =
  /** "Какую песню / какой плейлист включить?" — the answer is the name. */
  | { ask: 'what'; kind: MusicKind; play: boolean }
  /** "Нашёл … . Включить?" — a yes runs `then`. */
  | { ask: 'confirm'; then: MusicIntent }
  /** "Нашёл несколько плейлистов: …" — the answer picks one. */
  | { ask: 'which'; options: string[] }

/** crypto.randomUUID needs a secure context, which a LAN address over plain
 *  http is not. Not worth failing a whole turn over an id. */
const newId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `id${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`

/** The same mishearings voice.ts accepts for the wake word — otherwise a turn
 *  that woke him as "travis" gets that word sent on to the model as a question. */
/** A bare vocative — "Jarvis", "эй, Джарвис" — with nothing asked. */
const BARE_NAME = new RegExp(`^(?:${NAME_PREFIX}[\\s,]*)?${NAME}[\\s,.!?]*$`, 'iu')
/** A leading vocative on a real command: "Джарвис, какая погода". */
const LEADING_NAME = new RegExp(
  `^(?:${NAME_PREFIX}[\\s,]*)?${NAME}${NAME_END}[\\s,.:!?-]*`,
  'iu',
)

export default function App() {
  const store = useStore
  const phase = useStore((s) => s.phase)
  const history = useRef<Msg[]>([])
  /** What the page answered without the model, for its next turn — see aside.ts. */
  const asides = useRef<Asides | null>(null)
  if (!asides.current) asides.current = createAsides(LANG)

  /**
   * Who is speaking and which turn is in flight — see floor.ts. Every speaker
   * is made through it and every turn begun through it, so a new turn ends
   * the old one, voice and question both. Every await in a turn checks
   * `stale()` on the way out: if it has moved, that turn was superseded and
   * must not touch the phase or the busy state on its way to the floor.
   */
  const floorRef = useRef<Floor<Speaker> | null>(null)
  if (!floorRef.current) floorRef.current = createFloor<Speaker>({ interrupt, trace })
  const floor = floorRef.current

  /** The one voice loop — see voiceSlot.ts. */
  const voiceSlot = useRef<VoiceSlot<Voice> | null>(null)
  const voice = () => voiceSlot.current?.current() ?? null
  /** The newest utterance answered, so one delivered twice is answered once. */
  const lastUtterance = useRef(0)
  /** Which usage limit (by its reset time) has been announced in full. */
  const limitSaid = useRef<string | null>(null)

  const booting = useRef(false)
  /** False once the page has come down: nothing may reopen the microphone then. */
  const mounted = useRef(false)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const voicePoll = useRef<ReturnType<typeof setInterval> | null>(null)
  /**
   * A music question waiting for its answer: after "Какую песню включить?" the
   * next phrase is the song; after "Нашёл …. Включить?" a yes plays it; after
   * "Нашёл несколько плейлистов: …" the next phrase picks one.
   */
  const musicAsked = useRef<{ q: MusicQuestion; until: number } | null>(null)
  /** When a music command last worked — while recent, "продолжи" means the music. */
  const musicAt = useRef(0)
  /**
   * The calendar conversation: its draft, its question, its yes. One for the
   * life of the page, so a read-back and its answer are one operation.
   */
  const calendar = useRef<CalendarFlow | null>(null)
  if (!calendar.current) calendar.current = createCalendarFlow({ api: bridgeCalendar })

  // -- helpers --------------------------------------------------------------

  const clearIdle = () => {
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = null
  }

  const goDormant = (reason = 'dormant') => {
    trace('app:dormant')
    clearIdle()
    // Standing down ends the turn in flight, its question to the brain
    // included: an answer nobody will hear must not go on running tools.
    floor.supersede(reason)
    // Standing down drops any calendar draft: a yes to his name later must not
    // write a meeting read back minutes ago.
    calendar.current?.cancel()
    const s = store.getState()
    s.setCaption('')
    s.setActiveTool(null)
    music.working(false)
    music.duck(false)
    sfx.duck(false)
    s.setPhase('dormant')
  }

  /** Open the mic and wait. `window` is how long before he gives up. */
  const listen = (window: number) => {
    clearIdle()
    // A rearm that was waiting when the page came down: no new idle timer.
    if (!mounted.current) return
    const s = store.getState()
    s.setCaption('')
    s.setPhase('listening')
    sfx.play('listen')
    idleTimer.current = setTimeout(() => goDormant('idle'), window)
  }

  /**
   * listen(), once he has finished speaking and the recogniser has been
   * brought up clean — see rearm in voice.ts. The cue is the user's signal to
   * start, so it must not sound while nothing is capturing. `still` is checked
   * after the wait: something else may have taken the floor meanwhile.
   */
  const listenWhenReady = async (window: number, still: () => boolean) => {
    const ok = (await voice()?.rearm()) ?? false
    if (!still()) return
    // A failed turn's own message matters more than this one.
    if (!ok && !store.getState().error) {
      trace('app:not-ready')
      store
        .getState()
        .setError(
          LANG === 'ru'
            ? 'Распознавание речи ещё не запустилось — начало фразы может не дойти.'
            : 'Speech recognition has not started yet — the start of what you say may be lost.',
        )
    }
    listen(window)
  }

  // -- one turn -------------------------------------------------------------

  const respond = async (said: string, source = 'utterance'): Promise<void> => {
    // Ends the turn in flight, if any: its voice is cut and its question
    // interrupted before this one says or asks anything.
    const t = floor.begin(source)
    const stale = t.stale
    trace('app:respond', { len: said.length, turn: t.id })

    clearIdle()
    const s = store.getState()
    // Trouble outside him that the last turn ran into (the usage limit, the
    // network) is not this turn's: if it persists, this turn says so again.
    if (s.error && s.errorKind === 'service') s.setError(null)
    // Last turn's panels and blades go now, before the new answer starts
    // putting its own up. Anything the model marked sticky survives.
    s.clearPanels()
    s.clearBlades()
    s.setCaption('')
    s.pushTurn({ id: newId(), role: 'user', text: said })
    s.setPhase('thinking')

    // A calendar question waiting for its answer hears it first, then music
    // commands, then calendar commands — no model turn for any of them. A stop
    // none of them took is a stop, not a question — see routePhrase.
    const route = await routePhrase(said, {
      calendarWaiting: () => calendar.current?.waiting() ?? false,
      calendar: (p) => calendarTurn(p, t),
      music: musicCommand,
      playMusic: (c) => musicTurn(c, t, said),
      stale,
      local: (p) =>
        localAnswer(p, { now: new Date(), voice: store.getState().voice, connected: !usingBridge || isConnected() }),
      sayLocal: (answer) => localTurn(answer, t, said),
    })
    if (route === 'stop') {
      t.done('stop')
      listen(FOLLOW_UP_MS)
      return
    }
    if (route !== 'model') return

    const spk = t.speaker(() => createSpeaker())
    sfx.duck(true)
    music.duck(true)

    const turnId = newId()
    let started = false
    let filled = false
    /**
     * A word at once when a long wait is likely. The bridge says how it sorted
     * the question before the model has begun; anything it did not put on
     * 'low' — a lookup, something to think through — is measured in seconds
     * to the first word (13.5 s for the weather, 12.5 s for a comparison), so
     * a short canned line goes out if nothing has started shortly after. Never
     * for a quick question, never twice, never over the answer, and no model
     * turn for it: the lines are fixed (fillers.ts).
     */
    let early = 0
    const stopEarly = () => window.clearTimeout(early)

    // What the page answered by itself since the model last heard from us.
    const sent = asides.current!.pending()

    try {
      const { text } = await t.ask(() => ask(said, history.current, {
        onEffort: (level) => {
          if (level === 'low' || filled || started) return
          stopEarly()
          early = window.setTimeout(
            () => {
              if (stale() || filled || started) return
              filled = true
              spk.say(level === 'high' ? considering() : checking())
            },
            level === 'high' ? EARLY_WORD_HIGH_MS : EARLY_WORD_MS,
          )
        },
        onText: (delta) => {
          if (stale()) return
          if (!started) {
            stopEarly()
            started = true
            store.getState().setPhase('speaking')
            // The answer arriving is what ends the tool phase — a timer would
            // clear the readout while a slow tool was still running.
            store.getState().setActiveTool(null)
            music.working(false)
            store.getState().pushTurn({ id: turnId, role: 'jarvis', text: '' })
          }
          store.getState().appendToLastTurn(delta)
          spk.push(delta)
        },
        onTool: (name) => {
          if (stale()) return
          // Only claim the tooling phase while he has nothing to say yet.
          // Setting it unconditionally pinned the machine in 'tooling' for the
          // rest of any answer that called a tool after it started talking,
          // which also broke the reactor's lip-sync for the remainder.
          if (!started) store.getState().setPhase('tooling')
          store.getState().setActiveTool(name)
          sfx.play('tool')
          music.working(true)
          // Say something the moment work starts — a tool can take ten seconds
          // and silence that long reads as a crash. Once per turn only; a
          // chain of five tools shouldn't produce five apologies.
          if (!filled && !started) {
            stopEarly()
            filled = true
            spk.say(forTool(name))
          }
        },
      }, sent))
      // They went in with this question: not to be handed over again. Only
      // these — one the page answered while this turn ran is still to go.
      asides.current!.drop(sent.map((a) => a.id))

      trace('app:answer', { len: text.length, stale: stale() })
      if (stale()) return

      // An answer that arrived whole, with no streamed deltas, was shown and
      // spoken by nothing above — the turn ended in silence. Say it now.
      if (!started && text) {
        started = true
        store.getState().setPhase('speaking')
        store.getState().setActiveTool(null)
        music.working(false)
        store.getState().pushTurn({ id: turnId, role: 'jarvis', text })
        spk.push(text)
      }

      // The bridge keeps conversation state in its own session, so history is
      // only threaded through on the direct path.
      if (!usingBridge) {
        history.current.push({ role: 'user', content: withContext(said, asideNote(sent)) })
        history.current.push({ role: 'assistant', content: text || '…' })
        if (history.current.length > 16) {
          history.current = history.current.slice(-16)
        }
      }

      await spk.end()
      if (stale()) return
      t.done('answered')
      sfx.play('done')
    } catch (err) {
      if (stale()) return
      t.done('failed')
      console.error(err)
      sfx.play('error')
      const service = err instanceof ServiceError
      store
        .getState()
        .setError(err instanceof Error ? err.message : 'Something went wrong.', service ? 'service' : 'fault')
      // The usage limit, said aloud — the user may not be looking at the
      // screen. Once in full for each limit, then briefly: the bridge
      // answers every question at once while it holds (see modelPause in
      // server.mjs), so this is one line per question, never a repeat.
      if (service && err.kind === 'rate') {
        stopEarly()
        const first = limitSaid.current !== (err.resetAt ?? 'unknown')
        limitSaid.current = err.resetAt ?? 'unknown'
        spk.say(limitLine(err.resetAt, first))
        await spk.end()
        if (stale()) return
      }
    } finally {
      stopEarly()
      if (!stale()) {
        t.release(spk)
        sfx.duck(false)
        music.duck(false)
        store.getState().setActiveTool(null)
        music.working(false)
        // Stay open. Having to say his name again to add one more sentence is
        // the difference between a conversation and a vending machine.
        void listenWhenReady(FOLLOW_UP_MS, () => !stale())
      }
    }
  }

  // -- music ------------------------------------------------------------------

  /**
   * The music command in a phrase, if it is one — including the answer to a
   * music question he has just asked. Anything else clears that question.
   */
  const musicCommand = (said: string): MusicIntent | null => {
    const asked = musicAsked.current
    musicAsked.current = null
    const direct = parseMusicCommand(said, { inMusic: Date.now() - musicAt.current < MUSIC_CONTEXT_MS })
    if (direct || !asked || Date.now() > asked.until) return direct
    const q = asked.q
    const yesNo = parseYesNo(said)
    if (q.ask === 'confirm') return yesNo === 'yes' ? q.then : null
    // A refusal is not a title, and nor is a stop: "хватит" is not a song.
    if (yesNo === 'no' || STOP_ONLY.test(said)) return null
    const answer = said.trim().replace(/[.!?]+$/, '')
    if (q.ask === 'which') {
      // "Второй" picks by position; anything else is the name itself.
      const nth = ['перв', 'втор', 'трет', 'четв', 'пят'].findIndex((p) => answer.toLowerCase().startsWith(p))
      return { action: 'playlist', name: q.options[nth] ?? answer, play: true }
    }
    if (q.kind === 'playlist') return { action: 'playlist', name: answer, play: q.play }
    // "Какую песню?" — "Группа крови".
    return { action: 'search', query: answer, kind: q.kind, play: q.play }
  }

  /**
   * Carry out a music command and say what actually happened. The reply comes
   * from the player's state as the bridge read it back, so "включаю" is only
   * said when the music did start.
   */
  const musicTurn = async (intent: MusicIntent, t: Turn<Speaker>, said: string): Promise<void> => {
    const stale = t.stale
    const r = intent.action === 'clarify' ? { code: 'ok' as const } : await runMusic(intent)
    if (stale()) return
    trace('app:music', { action: intent.action, code: r.code })
    const text = musicReply(intent, r)
    if (r.code === 'ok' || r.playing) musicAt.current = Date.now()
    const question: MusicQuestion | null =
      intent.action === 'clarify'
        ? { ask: 'what', kind: intent.kind, play: intent.play }
        : r.code === 'ambiguous' && r.options?.length
          ? { ask: 'which', options: r.options }
          : (intent.action === 'search' || intent.action === 'playlist') && !intent.play && r.code === 'ok' && r.found
            ? { ask: 'confirm', then: { ...intent, play: true } }
            : null
    const asking = !!question
    if (question) musicAsked.current = { q: question, until: Date.now() + MUSIC_ANSWER_MS }

    const s = store.getState()
    s.pushTurn({ id: newId(), role: 'jarvis', text })
    asides.current!.add(said, text)
    s.setPhase('speaking')
    const spk = t.speaker(() => createSpeaker(), 'music')
    spk.say(text)
    await spk.end()
    if (stale()) return
    t.release(spk)
    t.done('music')
    // Music now coming out of the speakers would be heard as the next
    // question, so he stands by for his name — unless he has just asked one.
    // The recogniser is brought up clean at once either way (see rearm), so
    // "Джарвис, пауза" right after he speaks is not lost to a restart.
    if (r.playing && !asking) {
      void voice()?.rearm()
      goDormant('music playing')
    } else void listenWhenReady(FOLLOW_UP_MS, () => !stale())
  }

  // -- the page's own answers --------------------------------------------------

  /**
   * Say an answer the page had itself — the time, the date, his name, his
   * voice (localAnswer.ts). No model turn, so nothing to interrupt; the
   * floor still owns the voice, so a newer turn cuts it like any other.
   */
  const localTurn = async (answer: string, t: Turn<Speaker>, said: string): Promise<void> => {
    const stale = t.stale
    trace('app:local', { len: answer.length })
    const s = store.getState()
    s.pushTurn({ id: newId(), role: 'jarvis', text: answer })
    asides.current!.add(said, answer)
    s.setPhase('speaking')
    const spk = t.speaker(() => createSpeaker(), 'local')
    spk.say(answer)
    await spk.end()
    if (stale()) return
    t.release(spk)
    t.done('local')
    void listenWhenReady(FOLLOW_UP_MS, () => !stale())
  }

  // -- calendar ----------------------------------------------------------------

  /**
   * Hand a phrase to the calendar flow. True if it was the calendar's — the
   * reply has been spoken — false if the phrase is for someone else.
   */
  const calendarTurn = async (said: string, t: Turn<Speaker>): Promise<boolean> => {
    const stale = t.stale
    const reply = await calendar.current!.handle(said)
    if (!reply) return false
    // Superseded while the calendar answered. Whatever it did is done — a
    // write is never repeated — but this turn says nothing more.
    if (stale()) {
      floor.log('calendar:stale-reply', { of: t.id })
      return true
    }
    trace('app:calendar', { asks: reply.expectAnswer })
    const s = store.getState()
    s.pushTurn({ id: newId(), role: 'jarvis', text: reply.say })
    asides.current!.add(said, reply.say)
    s.setPhase('speaking')
    const spk = t.speaker(() => createSpeaker(), 'calendar')
    // push, not say: a list of meetings is several sentences.
    spk.push(`${reply.say} `)
    await spk.end()
    // Cut off (someone spoke over it, a new turn began): not heard, so its
    // confirmation word will not be taken — the flow says it again first.
    if (stale()) return true
    if (reply.readBack) calendar.current?.heard(reply.readBack)
    t.release(spk)
    t.done('calendar')
    void listenWhenReady(FOLLOW_UP_MS, () => !stale())
    return true
  }

  // -- voice events ---------------------------------------------------------

  /** What the voice loop should do with what it hears, derived from phase. */
  const mode = (): VoiceMode => {
    switch (store.getState().phase) {
      case 'offline':
      case 'boot':
        return 'deaf'
      case 'dormant':
        return 'wake'
      case 'waking':
      case 'listening':
        return 'command'
      default:
        return 'guard' // thinking, tooling, speaking
    }
  }

  const onWake = (trailing: string) => {
    const phase = store.getState().phase
    trace('app:wake', { phase, trailing: trailing.length })
    if (phase === 'offline' || phase === 'boot') return

    store.getState().setError(null)
    sfx.play('wake')
    // The start-up greeting can still be playing when he is first woken; cut
    // it off rather than answer over it in a second voice.
    floor.silence('wake')

    // "Jarvis, what's happening in AI this week" in one breath. Waiting for a
    // greeting he didn't need is the most common way an assistant wastes time.
    if (trailing) {
      void respond(trailing, 'wake')
      return
    }

    store.getState().setPhase('waking')

    // Answer to his name. Deliberately NOT awaited any more: the microphone is
    // already open and the echo filter knows his voice, so the user can talk
    // straight over the greeting instead of waiting it out. Whatever the user
    // then says begins a turn, and beginning a turn cuts this off.
    const greeting = floor.claim(() => createSpeaker(), 'attention')
    greeting.say(attention())
    void greeting.end().then(() => floor.release(greeting))

    listen(AWAIT_SPEECH_MS)
  }

  /**
   * Someone started talking. This is the whole point of the rewrite: he stops,
   * immediately, whatever he was doing.
   */
  const onSpeechStart = () => {
    clearIdle()
    const phase = store.getState().phase
    trace('app:speech-start', { phase })
    if (phase === 'offline' || phase === 'boot' || phase === 'dormant') return

    const wasBusy =
      phase === 'thinking' || phase === 'tooling' || phase === 'speaking'

    if (wasBusy) {
      // Abandon the answer in flight: its voice cut, its question interrupted,
      // its turn stale. respond() would do the same for the turn that replaces
      // it; doing it here covers the case where nothing replaces it.
      floor.supersede('barge-in')
      store.getState().setActiveTool(null)
      music.working(false)
      sfx.duck(false)
      music.duck(false)
    } else {
      // "Да, сэр?" still going as the user starts: they have the floor now.
      floor.silence('speech-start')
    }
    store.getState().setPhase('listening')
  }

  const onUtterance = (text: string, id: number) => {
    const phase = store.getState().phase
    trace('app:utterance', { phase, len: text.length, id })
    // One utterance, one answer. A second delivery of the same one would begin
    // a second turn — interrupting the first, possibly after a tool has run.
    if (id <= lastUtterance.current) {
      floor.log('utterance:duplicate', { id })
      return
    }
    lastUtterance.current = id
    floor.log('utterance', { id, len: text.length, phase })
    if (phase === 'offline' || phase === 'boot' || phase === 'dormant') {
      trace('app:ignored', { reason: phase })
      return
    }

    // People keep using his name as a vocative once they're already talking to
    // him. Strip it rather than sending "jarvis" to the model as a question.
    if (BARE_NAME.test(text)) {
      trace('app:ignored', { reason: 'bare-name' })
      listen(AWAIT_SPEECH_MS)
      return
    }
    const said = text.replace(LEADING_NAME, '').trim()
    if (!said) {
      trace('app:ignored', { reason: 'empty-after-name' })
      listen(AWAIT_SPEECH_MS)
      return
    }
    // Stay open for the next question; listen() also re-arms the idle timer
    // that the barge-in cleared.
    if (STOP_ONLY.test(said)) {
      // The barge-in before this utterance did the cutting; this records what
      // it found — sound coming out or not, sentences thrown away — next to
      // the speak:cut and turn:superseded it produced.
      floor.log('stop', { word: said.slice(0, 20), playing: ttsDiag.lastCut.playing, dropped: ttsDiag.lastCut.dropped })
      // "Отмена" to a calendar read-back is its answer: let the flow refuse
      // the draft and say so, rather than leaving it to a later "да".
      if (calendar.current?.waiting()) {
        void respond(said)
        return
      }
      trace('app:ignored', { reason: 'stop' })
      listen(FOLLOW_UP_MS)
      return
    }

    void respond(said)
  }

  const onPartial = (text: string) => {
    store.getState().setCaption(text)
  }

  const onVoiceError = (message: string) => {
    floor.log('voice:error', { message: message.slice(0, 60) })
    store.getState().setError(message)
  }

  if (!voiceSlot.current) {
    voiceSlot.current = makeVoiceSlot(
      () => startVoice({ mode, onWake, onSpeechStart, onPartial, onUtterance, onError: onVoiceError }),
      floor.log,
    )
  }

  /** What to say when the microphone is not working, and what to do about it. */
  const RETRY_MIC =
    LANG === 'ru'
      ? 'Микрофон не работает. Нажмите пробел, чтобы запустить его снова.'
      : 'The microphone is not working. Press Space to start it again.'

  /**
   * Start the voice loop again after it could not start — permission refused,
   * no microphone. The slot replaces the dead loop; it never adds a second.
   */
  const retryVoice = async () => {
    store.getState().setError(null)
    const v = await voiceSlot.current!.start()
    if (!v.ok()) store.getState().setError(`${store.getState().error ?? ''} ${RETRY_MIC}`.trim())
    else void listenWhenReady(AWAIT_SPEECH_MS, () => store.getState().phase === 'dormant')
  }

  // -- power on -------------------------------------------------------------

  const powerOn = async () => {
    // The ignition button and the space bar can both land here, and the phase
    // only moves after the first await — so without this a double press boots
    // twice, arming two voice loops and two download polls.
    if (booting.current) return
    booting.current = true

    try {
      await ignite()
    } catch (err) {
      // The guard must not outlive a failed boot. Audio unlock can be refused,
      // the microphone prompt dismissed, the bridge unreachable at the wrong
      // moment — and with the flag still latched the ignition button was dead
      // for the rest of the page, recoverable only by reloading. Reset it and
      // put the button back so the user can simply press it again.
      booting.current = false
      console.error('[jarvis] power-up failed:', err)
      store.getState().setBootAct('splash')
      store.getState().setPhase('offline')
      store
        .getState()
        .setError(
          err instanceof Error
            ? `Power-up failed: ${err.message}`
            : 'Power-up failed. Click to try again.',
        )
    }
  }

  /**
   * The start-up greeting, spoken over the boot sequence where the recorded
   * intro used to play.
   *
   * The bridge is asked what it can speak with first: until it answers, a
   * speaker only knows the browser voice, and the greeting would come out of
   * Windows' Pavel rather than the Piper voice everything else uses. Not
   * awaited by the boot — the reactor comes up while he talks, as it did under
   * the recording. Waking him cuts it off (see onWake).
   *
   * Resolves true only if the greeting was heard to the end. Anything that
   * cuts it off — Escape, waking him — takes the floor from it first, so it
   * still holds the floor here only if it finished.
   */
  const greetOnStartup = async (text: string): Promise<boolean> => {
    await probeCapabilities()
    // Something else already has the floor — never two voices at once.
    if (floor.current()) return false
    // The announce style: livelier piper settings and a presence chain — see
    // SpeechStyle in tts.ts.
    const greeting = floor.claim(() => createSpeaker({ style: 'announce' }), 'startup-greeting')
    // push, not say: cut into sentences, the first is heard while the rest
    // are still being generated.
    greeting.push(`${text} `)
    await greeting.end()
    return floor.release(greeting)
  }

  const ignite = async () => {
    const s = store.getState()
    // The boot screen's checklist. Every step below is marked by the code that
    // does the work, so it shows only what has actually been checked.
    const step = s.setBootStep
    s.resetBootSteps()
    // The splash stays up for the start-up; the greeting screen comes later.
    s.setBootAct('splash')
    // Running this at all means the application's modules have loaded.
    step('modules', 'ok')
    step('system', 'run')

    // Must happen inside the click handler — browsers won't start an
    // AudioContext or speech synthesis without a user gesture.
    await sfx.unlockAudio()
    sfx.play('boot')
    // The score. Must be started from inside this click handler for the same
    // reason as the rest of the audio.
    music.enable()
    // The recorded intro is English; in Russian mode he greets in his own
    // voice instead (see STARTUP_GREETING in fillers.ts) — on the greeting
    // screen, further down, not over the splash.
    if (!STARTUP_GREETING) music.playBoot()
    music.startAmbient()

    s.setPhase('boot')

    // The checks that can run alongside the boot sequence. None of them
    // delays it; each only reports.
    //
    // There is no database in this application, so that line says so rather
    // than claiming a check that never ran.
    step('database', 'na')
    // The bridge says which voice it speaks with: Piper (or ElevenLabs) is
    // the real voice module; without it the browser's own voice is a fallback.
    step('voice', 'run')
    void probeCapabilities().then((c) =>
      c.ttsEngine ? step('voice', 'ok') : step('voice', 'warn', 'СИСТ. ГОЛОС'),
    )
    // The shared microphone stream — the same one the clap detector already
    // opened, so this asks for nothing new. A live audio track is the check.
    step('mic', 'run')
    void getMic().then(
      (m) =>
        m.getAudioTracks().some((t) => t.readyState === 'live')
          ? step('mic', 'ok')
          : step('mic', 'fail', 'НЕТ СИГНАЛА'),
      (err: unknown) =>
        step('mic', 'fail', (err as DOMException)?.name === 'NotAllowedError' ? 'НЕТ ДОСТУПА' : 'НЕ НАЙДЕН'),
    )

    watchServers((servers) => store.getState().setConnected(servers))
    watchPanels((panel) => store.getState().pushPanel(panel))
    watchBlades((blade) => store.getState().pushBlade(blade))

    /**
     * JARVIS asking to see something.
     *
     * Announced on screen for as long as it takes, with whatever he said he was
     * looking for. The camera's own light is on too, but a hardware light that
     * appears with no explanation is exactly the thing that makes people
     * distrust an assistant — so the interface says it before they have to ask.
     */
    watchCapture(async (req) => {
      const note =
        req.mode === 'watch'
          ? req.when === 'past'
            ? req.reason || 'reviewing the last few seconds'
            : `${req.reason || 'watching'} · ${req.seconds}s`
          : req.reason || 'taking a look'
      store.getState().setLooking(note)

      // The past is only available if something has been remembering it, and
      // that only happens while the camera is on screen. Answering plainly
      // beats opening the camera and recording the next few seconds instead,
      // which is a different question from the one that was asked.
      if (req.mode === 'watch' && req.when === 'past' && camera.bufferedSeconds() < 1) {
        store.getState().setLooking(null)
        return {
          error:
            'There is no recent footage — the camera has to be open on screen ' +
            'for me to remember what just happened. Ask me to open the camera, ' +
            'and I can watch from then on.',
        }
      }

      // Held for the whole capture. Without this the stream can be torn down by
      // whoever else was using it half way through a six-second watch.
      let held = false
      try {
        await camera.holdCamera()
        held = true
        if (req.mode === 'look') return camera.grabFrame()
        if (req.when === 'past') {
          const grid = camera.recentGrid(req.seconds, 9)
          return grid ?? { error: 'There is not enough recent footage to review.' }
        }
        return await camera.watchAhead(req.seconds, 9)
      } catch (err) {
        return {
          error:
            (err as DOMException)?.name === 'NotAllowedError'
              ? 'The camera is not permitted, so I cannot see anything.'
              : `The camera could not be read: ${(err as Error)?.message ?? err}`,
        }
      } finally {
        if (held) camera.releaseCamera()
        store.getState().setLooking(null)
      }
    })

    // The interface is JARVIS's to drive. These arrive out of band, pushed
    // mid-turn the way panels are, so a command can retint the reactor or put
    // something into orbit while he is still speaking the sentence about it.
    watchUi((op, args) => {
      const s = store.getState()
      const a = (args ?? {}) as Record<string, never>
      switch (op) {
        case 'patch':
          s.applyUi(args)
          break
        case 'orbit':
          if (a.action === 'add') s.addOrbit(args)
          else if (a.action === 'remove') s.removeOrbit(String(a.id))
          else s.clearOrbits()
          break
        case 'effect':
          s.fireEffect(a.kind)
          break
        case 'reset':
          s.resetUi()
          break
        case 'screen':
          s.clearScreen(a.what ?? 'all')
          break
        default:
          console.warn('[jarvis] unknown ui op:', op, args)
      }
    })
    // In bridge mode the conversation lives in the agent session, which is tied
    // to the socket — so a drop silently wipes his memory while the transcript
    // on screen still shows it. Better to say so than to let him quietly forget.
    watchConnection((state) => {
      floor.log(`ws:${state}`, { asking: floor.asking() })
      if (state === 'lost') {
        store.getState().setError('Bridge connection lost — reconnecting.', 'service')
      } else if (state === 'reconnected') {
        store
          .getState()
          .setError('Bridge reconnected. The previous conversation was not kept.', 'service')
      }
    })
    // Everything the boot itself sets up is registered by now.
    step('system', 'ok')
    // The bridge: the socket open and the agent session starting. The direct
    // backend has no services to connect to.
    step('services', usingBridge ? 'run' : 'na')
    step('launch', 'run')
    const warming = warm().then(
      () => {
        if (usingBridge) step('services', 'ok')
      },
      (err: Error) => {
        s.setError(err.message)
        step('services', 'fail', 'НЕТ СВЯЗИ')
      },
    )

    if (!usingBridge && !env.anthropicKey) {
      s.setError(
        'No Anthropic API key — copy .env.example to .env.local and set VITE_ANTHROPIC_API_KEY.',
      )
    }

    // Pull the neural voice down during the boot sequence so the first
    // "Hey Jarvis" isn't waiting on an 86MB download. Deliberately not awaited
    // — if it's slow, JARVIS comes up on the system voice and swaps over the
    // moment the model is ready.
    if (TTS_ENGINE === 'kokoro') {
      void kokoro.load()
      voicePoll.current = setInterval(() => {
        const p = kokoro.loadProgress()
        if (kokoro.isReady() || kokoro.isUnavailable()) {
          store.getState().setBootNote('')
          if (voicePoll.current) clearInterval(voicePoll.current)
          voicePoll.current = null
        } else if (p > 0 && p < 1) {
          store.getState().setBootNote(`voice ${Math.round(p * 100)}%`)
        }
      }, 200)
    }

    // The start-up scene in Boot.tsx, act by act — see lib/bootTimeline.ts.
    //
    // The splash hands over to the greeting screen once the answer to the
    // start has been seen for a moment and the bridge has said which voice it
    // speaks with — the greeting needs that answer, and a slow bridge keeps
    // the splash up rather than greeting in the wrong voice.
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    await Promise.all([sleep(SPLASH_AFTER_START_MS), probeCapabilities()])
    store.getState().setBootAct('greet')
    // He greets once the handover has played, never over it — and once only:
    // this is the one place the start-up greeting is started.
    const greeting = STARTUP_GREETING
    const greeted = greeting
      ? sleep(HANDOVER_MS).then(() =>
          // Not if the start-up screen has been stood down meanwhile (Escape).
          store.getState().phase === 'boot' ? greetOnStartup(greeting) : false,
        )
      : Promise.resolve(false)
    // The greeting screen holds while he speaks and the checklist resolves,
    // and the working screen comes once the start-up itself is done.
    await sleep(GREET_SCREEN_MS)
    await warming
    store.getState().setConnected(connectedLabels())
    store.getState().setVoice(currentVoiceName())

    // The analyser is what makes the reactor pulse with your voice. It needs a
    // getUserMedia stream; speech recognition does not, and gets its own. So a
    // failure here costs the animation and nothing else — saying "voice input
    // is unavailable" was both alarming and untrue.
    try {
      await startAnalyser()
    } catch {
      console.warn(
        '[jarvis] no microphone stream — the reactor will not pulse with your ' +
          'voice. Speech recognition is unaffected.',
      )
    }

    // Ask the bridge which speech engines exist before the loop starts, so the
    // first turn already uses ElevenLabs when a key is present and the browser
    // fallback when it is not — no flag, no reload.
    const voiceCaps = await probeCapabilities()
    // Again, now that the bridge has said whether it speaks: the label set
    // above could only name the browser voice.
    store.getState().setVoice(currentVoiceName())
    // And the checklist follows this answer — the one the voice loop runs on.
    if (voiceCaps.ttsEngine) step('voice', 'ok')
    else step('voice', 'warn', 'СИСТ. ГОЛОС')

    // One voice loop, started once, running until the page closes. A loop
    // that could not hear at all is said so, with the way to start it again.
    const loop = await voiceSlot.current!.start()
    if (!loop.ok()) store.getState().setError(`${store.getState().error ?? ''} ${RETRY_MIC}`.trim())

    // The voice loop is up: the start-up is done. Marked before the phase
    // changes, so the boot screen fades out showing it.
    step('launch', 'ok')
    store.getState().setPhase('dormant')

    // He has introduced himself, so the next move is the user's: once the
    // greeting has been heard to the end, open the microphone for them to
    // speak without his name, as after any answer. Not while it is still
    // playing — in command mode the microphone would take his own voice as the
    // question — and not if it was cut off, or if he has been woken some other
    // way in the meantime.
    const stillDormant = () => store.getState().phase === 'dormant'
    void greeted.then((finished) => {
      if (finished && stillDormant()) void listenWhenReady(AWAIT_SPEECH_MS, stillDormant)
    })
  }

  // -- clap to start --------------------------------------------------------

  /**
   * A clap brings him up, as an alternative to the button.
   *
   * Only while the ignition screen is showing, and torn down the moment he
   * boots — the microphone is about to belong to the voice loop, and two
   * analysers arguing over the same stream is how you get an assistant that
   * hears half of what you say.
   *
   * Deliberately silent about failure. If the microphone is refused, or has not
   * been granted yet, the button is still right there; announcing an error
   * about a feature nobody asked for would be worse than quietly doing without.
   */
  useEffect(() => {
    if (phase !== 'offline') return
    let live: { stop: () => void } | null = null
    let gone = false
    void listenForClap(() => {
      if (!gone) void powerOn()
    }).then((l) => {
      if (gone) l.stop()
      else live = l
    })
    return () => {
      gone = true
      live?.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  // -- level pump + keys ----------------------------------------------------

  useEffect(() => {
    let raf = 0
    mounted.current = true

    // The record of the conversation, in the console: every phase change with
    // the turn it belongs to, next to the floor's own events.
    const unsubscribe = useStore.subscribe((s, prev) => {
      if (s.phase !== prev.phase) floor.log('phase', { from: prev.phase, to: s.phase })
    })
    ;(window as unknown as Record<string, unknown>).__floor = {
      events: floor.events,
      stats: floor.stats,
      turn: floor.turn,
      asking: floor.asking,
      live: floor.live,
    }

    // Mounted again on a page that is already powered (a hot reload): the
    // unmount stopped the voice loop, so bring the one loop back.
    const powered = store.getState().phase
    if (powered !== 'offline' && powered !== 'boot') void voiceSlot.current?.start()

    const pump = () => {
      const st = store.getState()
      // While speaking, follow JARVIS's own output rather than the mic, so the
      // orb lip-syncs instead of reacting to room noise.
      const spk = floor.current()
      const lvl = st.phase === 'speaking' && spk ? spk.level() : micLevel()
      st.setLevel(lvl)
      raf = requestAnimationFrame(pump)
    }
    pump()

    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return

      // V auditions the next British voice installed on this machine. Which
      // ones exist varies per Mac, so hearing them beats trusting a ranking.
      // Bare V only — ⌘V and ⌃V are paste, and swallowing those was rude.
      if (
        e.key === 'v' &&
        !e.repeat &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        e.preventDefault()
        const name = cycleVoice()
        store.getState().setVoice(name)
        const demo = floor.claim(() => createSpeaker(), 'voice-demo')
        const shown = name.replace(/\(.*?\)/g, '').trim()
        demo.say(
          LANG === 'ru'
            ? `Голос: ${shown}. К вашим услугам, сэр.`
            : `Voice set to ${shown}. At your service, sir.`,
        )
        void demo.end().then(() => floor.release(demo))
        return
      }

      // G puts the camera on and starts tracking hands. Off by default and
      // never implicit: a webcam that turns itself on because an interface
      // thought it might be useful is not a trade anyone agreed to.
      if (e.key === 'g' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        const on = store.getState().gestures
        if (on) {
          hands.disableHands()
          store.getState().setGestures(false)
        } else {
          store.getState().setError(null)
          void hands
            .enableHands()
            .then(() => store.getState().setGestures(true))
            .catch((err: Error) => {
              store.getState().setGestures(false)
              store
                .getState()
                .setError(
                  err?.name === 'NotAllowedError'
                    ? 'Camera access denied — gesture control is unavailable.'
                    : `Gesture control failed to start: ${err?.message ?? err}`,
                )
            })
        }
        return
      }

      // T speaks a fixed line, bypassing the wake word, the recogniser and the
      // model entirely. When "I can't hear him" is the report, this is the one
      // keypress that separates a broken voice engine from a broken voice loop
      // — and it prints the verdict rather than making you infer it.
      if (e.key === 't' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        const t = floor.claim(() => createSpeaker(), 'audio-test')
        t.say(
          LANG === 'ru'
            ? 'Проверка звука. Если вы это слышите, синтез речи работает, сэр.'
            : 'Audio test. If you can hear this, speech output is working, sir.',
        )
        void t.end().then(() => {
          floor.release(t)
          const d = (window as unknown as Record<string, Record<string, unknown>>).__tts
          console.info('[jarvis] audio test →', d)
          if (d && d.started === 0 && d.rescued === 0) {
            store.getState().setError(
              `No sound produced. engine=${d.engine} voice=${d.voice} error=${d.lastError || 'none'}`,
            )
          }
        })
        return
      }

      // Escape stands the whole thing down — the one thing the old build had
      // no key for at all.
      if (e.key === 'Escape') {
        e.preventDefault()
        if (store.getState().phase !== 'offline') goDormant('escape')
        return
      }

      // Space starts a turn without the wake word. Worth using while filming so
      // a missed wake word doesn't cost a take.
      if (e.code !== 'Space' || e.repeat) return
      e.preventDefault()

      const phase = store.getState().phase
      if (phase === 'offline') {
        void powerOn()
      } else if (phase === 'boot') {
        /* ignore — the boot sequence owns the phase until it finishes */
      } else if (
        phase === 'thinking' ||
        phase === 'tooling' ||
        phase === 'speaking'
      ) {
        onSpeechStart()
        listen(AWAIT_SPEECH_MS)
      } else if (voice() && !voice()!.ok()) {
        // The microphone is down: Space starts it again rather than waking
        // him to a loop that cannot hear the answer.
        void retryVoice()
      } else {
        onWake('')
      }
    }
    window.addEventListener('keydown', onKey)

    return () => {
      mounted.current = false
      unsubscribe()
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKey)
      clearIdle()
      if (voicePoll.current) clearInterval(voicePoll.current)
      // The loop, the voice and any question in flight go with the page —
      // a loop still starting is stopped the moment it arrives.
      voiceSlot.current?.stop()
      floor.supersede('unmount')
      // The camera must not outlive the page that turned it on.
      hands.disableHands()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <>
      <Scene />
      <VoiceWaves />
      <Hud />
      <Boot />
      <Diagnostics />
      <Ignition onStart={() => void powerOn()} />
    </>
  )
}
