import { BRIDGE_HTTP_URL, BRIDGE_WS_URL, LANG } from '../config'
import { getMic } from './audio'
import { lastSoundEnded, speakingNow, speakingSince, speechActive } from './tts'
import { startVad, type Vad } from './vad'
import { caps } from './capabilities'
import { trace } from './bridge'
import { isEcho } from './echo'
import { startBrowserVoice } from './browserVoice'
import { connectDeepgram } from './deepgramVoice'
import { startPcmCapture } from './pcmCapture'
import { SCRIBE_START_MS, startScribeVoice, type ScribeHooks, type ScribeLink } from './scribeVoice'
import { superviseVoice } from './voiceSupervisor'
import {
  SELF_GUARD_MS,
  WAKE,
  WAKE_DEBOUNCE,
  afterWake,
  deadVoice,
  diag,
  drop,
  makeAssembler,
  nextUtteranceId,
  setVoiceTrace,
  type Voice,
  type VoiceHandlers,
} from './voiceCore'

export { NAME, NAME_END, NAME_PREFIX, diag } from './voiceCore'
export type { Voice, VoiceHandlers, VoiceMode } from './voiceCore'

setVoiceTrace(trace)

/**
 * The voice loop.
 *
 * One recogniser, running for the life of the page. It is never torn down for
 * a turn, and that single fact is most of what separates this from a kiosk:
 * the microphone is still open while JARVIS is talking, so you can cut him off
 * the way you would cut off a person.
 *
 * The obvious design — one recogniser hunting for the wake word, a second one
 * capturing the command, stopping the first to start the second because the
 * browser only hands out one at a time — is what this replaces. It works, but
 * nothing is listening during an answer, so barge-in is impossible, and every
 * restart leaves a quarter-second of deafness that eats whole wake words.
 *
 * Keeping the mic open costs one thing: JARVIS hears himself through the
 * speakers. That is handled here in text rather than in acoustics — see
 * `isEcho` — because the browser gives SpeechRecognition its own capture and
 * won't let us put a canceller in front of it.
 *
 * What both engines share — the wake phrase, the assembler, the diagnostics —
 * is in voiceCore.ts; the browser engine is in browserVoice.ts.
 */

/**
 * Pick the voice engine and start it.
 *
 * Two engines, chosen by what the bridge reported at boot (see capabilities.ts):
 *   - ElevenLabs available -> local voice-activity detection for instant
 *     barge-in, and ElevenLabs Scribe for the words. The reliable path.
 *   - nothing configured -> the browser's own SpeechRecognition, so a student
 *     with no keys still has a working assistant. Less robust, but free and
 *     zero-setup, and guarded by a heartbeat so its silent death is recovered.
 *
 * The microphone is opened once here so a denied permission is reported loudly
 * rather than surfacing later as an unexplained deafness, whichever engine runs.
 */
export async function startVoice(h: VoiceHandlers): Promise<Voice> {
  try {
    await getMic()
  } catch (err) {
    diag.lastError = 'mic'
    trace('voice:mic-failed', { name: (err as DOMException)?.name ?? 'unknown' })
    h.onError(
      err instanceof DOMException && err.name === 'NotAllowedError'
        ? 'Microphone access denied — voice input is unavailable.'
        : 'No microphone available.',
    )
    return deadVoice()
  }
  const speech = { speakingSince, speechActive, lastSoundEnded, speakingNow }
  const browser = () =>
    startBrowserVoice(h, {
      Ctor: (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition ?? null,
      lang: LANG,
      speech,
    })

  // Realtime recognition (Deepgram through the bridge, or Scribe), with the
  // browser's recogniser behind it. See voiceSupervisor.ts. Both feed the same
  // engine, so stop, barge-in, assembly and duplicate guards are shared.
  if (caps().sttRealtime) {
    const deepgram = caps().sttEngine === 'deepgram'
    const realtimeName = deepgram ? 'deepgram' : 'scribe'
    diag.engine = realtimeName
    return superviseVoice({
      mode: h.mode,
      realtimeName,
      // Deepgram needs no credential on the page: the bridge holds the key.
      getToken: deepgram ? async () => '' : fetchScribeToken,
      startScribe: (token, onFail) =>
        startScribeVoice(token, h, {
          connect: deepgram ? connectDeepgramLink : connectScribe,
          speech,
          onFail,
          startTimeoutMs: SCRIBE_START_MS,
        }),
      startBrowser: () => {
        diag.engine = 'browser'
        return browser()
      },
    })
  }

  diag.engine = caps().stt ? 'elevenlabs' : 'browser'
  return caps().stt ? startElevenVoice(h) : browser()
}

/**
 * A single-use Scribe token from the bridge, which holds the API key. The token
 * is handed straight to the SDK: never logged, stored or put in diagnostics.
 */
async function fetchScribeToken(): Promise<string> {
  const res = await fetch(`${BRIDGE_HTTP_URL}/scribe-token`, { signal: AbortSignal.timeout(6000) })
  if (!res.ok) throw new Error(`token ${res.status}`)
  const { token } = (await res.json()) as { token?: string }
  if (!token) throw new Error('token missing')
  return token
}

/** Deepgram through the bridge's /stt-stream, fed by the shared microphone. */
const connectDeepgramLink = (_token: string, hooks: ScribeHooks): Promise<ScribeLink> =>
  connectDeepgram(hooks, { url: `${BRIDGE_WS_URL}/stt-stream`, capture: startPcmCapture })

/** Errors that leave the session usable: Scribe refused one commit, not the stream. */
const SCRIBE_NON_FATAL = new Set(['commit_throttled', 'insufficient_audio_activity'])

/**
 * The SDK behind the ScribeHooks the engine speaks. Loaded on demand, so the
 * bundle only carries it for someone who has a key. Audio goes from the
 * microphone to ElevenLabs inside the SDK; nothing here records or keeps it.
 */
async function connectScribe(token: string, hooks: ScribeHooks): Promise<ScribeLink> {
  const { Scribe, RealtimeEvents, CommitStrategy } = await import('@elevenlabs/client')
  const c = Scribe.connect({
    token,
    modelId: 'scribe_v2_realtime',
    languageCode: LANG,
    commitStrategy: CommitStrategy.VAD,
    // Close to the browser engine's 900 ms endpoint; the assembler decides the rest.
    vadSilenceThresholdSecs: 0.7,
    microphone: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  })
  c.on(RealtimeEvents.SESSION_STARTED, () => hooks.onStarted())
  c.on(RealtimeEvents.PARTIAL_TRANSCRIPT, (m) => hooks.onPartial(m.text ?? ''))
  c.on(RealtimeEvents.COMMITTED_TRANSCRIPT, (m) => hooks.onCommitted(m.text ?? ''))
  c.on(RealtimeEvents.ERROR, (m) => {
    const kind = String((m as { message_type?: string })?.message_type ?? 'error')
    if (!SCRIBE_NON_FATAL.has(kind)) hooks.onError(kind)
  })
  c.on(RealtimeEvents.CLOSE, () => hooks.onClose())
  return { close: () => c.close() }
}

/** VAD + ElevenLabs Scribe. */
async function startElevenVoice(h: VoiceHandlers): Promise<Voice> {
  let lastWake = 0
  let vad: Vad | null = null

  /**
   * Segments waiting for the transcriber, oldest first.
   *
   * This was a boolean — `if (transcribing) return` — and that single line was
   * the worst bug in the pause story. Segments arrive faster than Scribe
   * answers whenever someone speaks in bursts, which is exactly what pausing
   * mid-sentence looks like, so the second half of the thought was not merely
   * mis-timed, it was silently discarded. Queue instead: nothing a person says
   * out loud gets thrown away because the network was busy.
   *
   * Order is preserved because the drain is single-flight, which matters —
   * "London" arriving before "what's the weather in" is worse than either.
   */
  const pendingAudio: Array<{ blob: Blob; his: boolean }> = []
  let draining = false
  /**
   * The segment being captured began in his own first syllable — the guard
   * below refused it as a barge-in. Its words are his, not the user's: let
   * through as a transcript they became the next question, and he answered
   * himself.
   */
  let segmentIsHis = false

  /**
   * Transcripts become turns here rather than one-per-segment.
   * See makeAssembler for why.
   */
  const assemble = makeAssembler({
    emit: (text) => {
      diag.dropped = ''
      diag.accepted++
      diag.holding = ''
      h.onUtterance(text, nextUtteranceId())
    },
    partial: (text) => h.onPartial(text),
  })

  /**
   * Send one captured segment to the bridge and act on the words.
   *
   * The mode is re-read here, not at capture time, because a barge-in flips the
   * machine from 'guard' to 'listening' between the segment starting and its
   * transcript arriving — and the transcript belongs to the mode the user is in
   * now, not the one they interrupted.
   */
  const transcribe = async ({ blob, his }: { blob: Blob; his: boolean }) => {
    const mode = h.mode()
    if (mode === 'deaf') return
    if (his) {
      drop('his own first syllable')
      return
    }
    const t0 = performance.now()
    try {
      const res = await fetch(`${BRIDGE_HTTP_URL}/stt`, {
        method: 'POST',
        headers: { 'content-type': blob.type || 'audio/webm' },
        body: blob,
      })
      diag.idleMs = Math.round(performance.now() - t0)
      if (!res.ok) {
        diag.restarts++
        diag.lastError = `stt ${res.status}`
        drop(`transcription failed (${res.status})`)
        return
      }
      const { text } = (await res.json()) as { text?: string }
      const said = (text ?? '').trim()
      diag.lastError = ''

      if (!said) {
        drop('nothing intelligible in the segment')
        return
      }

      // His own voice, come back through the microphone. The raised guard
      // threshold stops most of it at the door; this catches the rest.
      if (isEcho(said, speakingNow())) {
        drop('echo of his own voice')
        return
      }

      diag.heard = said
      diag.heardAt = Date.now()

      if (mode === 'wake') {
        if (WAKE.test(said) && Date.now() - lastWake > WAKE_DEBOUNCE) {
          lastWake = Date.now()
          diag.wakes++
          diag.dropped = ''
          diag.accepted++
          h.onWake(afterWake(said))
        } else {
          drop(`heard "${said.slice(-40)}" — not his name`)
        }
        return
      }

      // Not a turn yet — a piece of one. The assembler decides when the thought
      // is finished, reading the words and whether the room is still noisy.
      assemble.feed(said, vad?.meter().speaking ?? false)
    } catch (err) {
      diag.restarts++
      diag.lastError = String(err)
      drop('could not reach the speech service')
    }
  }

  /** One transcription at a time, in the order the segments were spoken. */
  const drain = async () => {
    if (draining) return
    draining = true
    try {
      while (pendingAudio.length) {
        await transcribe(pendingAudio.shift()!)
      }
    } finally {
      draining = false
    }
  }

  vad = await startVad({
    onStart: () => {
      const mode = h.mode()
      diag.mode = mode
      diag.sessions++
      segmentIsHis = false
      if (mode === 'deaf') return
      // Standing down mid-thought throws the thought away with it. Otherwise
      // held text would surface as the opening of the *next* conversation.
      if (mode === 'wake') assemble.cancel()
      // The barge-in. In guard mode the user has started talking over him, and
      // because the guard threshold is high this is a real interruption rather
      // than leaked playback — so cut him off now, do not wait for the words.
      if (mode === 'guard') {
        const since = speakingSince()
        if (since && Date.now() - since < SELF_GUARD_MS) {
          diag.selfGuarded++
          segmentIsHis = true
          return
        }
        h.onSpeechStart()
      }
    },
    onEnd: (blob) => {
      pendingAudio.push({ blob, his: segmentIsHis })
      segmentIsHis = false
      void drain()
    },
    onLevel: (v) => {
      // Only paint the live level while actually listening for a command, so a
      // dormant reactor stays calm and does not twitch at every room noise.
      const mode = h.mode()
      if (mode !== 'command') return
      // Never over the assembled text. This used to run unconditionally and
      // overwrote a half-built sentence with an ellipsis sixty times a second,
      // so a pause looked like the interface had forgotten what you just said.
      if (assemble.held()) return
      h.onPartial(v > 0.04 ? '…' : '')
    },
    onError: (message) => {
      diag.lastError = 'capture'
      diag.running = false
      h.onError(message)
    },
  })
  diag.running = vad.live()

  // Raise the trigger bar exactly while he speaks. The mode is polled rather
  // than pushed because nothing in the app pushes phase changes here, and a
  // 200ms lag on the echo gate is imperceptible.
  const guardPoll = setInterval(() => {
    const mode = h.mode()
    vad?.setGuard(mode === 'guard')
    // He has stood down — by Escape, by the idle timeout, or by dropping back
    // to the wake word. Anything half-said belonged to a conversation that is
    // over, and letting the hold expire later would open the next one with a
    // fragment of the last.
    if ((mode === 'wake' || mode === 'deaf') && assemble.held()) assemble.cancel()
  }, 200)

  return {
    ok: () => true,
    stop: () => {
      clearInterval(guardPoll)
      assemble.cancel()
      vad?.stop()
      diag.running = false
    },
    live: () => vad?.live() ?? false,
    // The detector never stops for his speech — echo cancellation and the
    // guard threshold handle it — so there is nothing to bring up.
    rearm: async () => vad?.live() ?? false,
  }
}
