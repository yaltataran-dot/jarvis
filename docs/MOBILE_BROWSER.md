# The page on a phone

The web page in mobile Chrome is a full interface to JARVIS and stays one. A
native Android app is planned as an additional interface, not a replacement:
both use the same bridge, protocol (`shared/protocol.mjs`), tools and
knowledge base. This document records which parts of the page exist for
mobile browsers and why they stay, what was removed as no longer needed, and
what the app will do itself.

## Where it came from

The page had no mobile-specific code before the voice-recovery work of
2026-10-17/18 (commit `edb6a70`): no `Android`, `wakeLock`, `visibilitychange`
or `pageshow` anywhere in earlier history. The responsive layout is older
(900 px breakpoint since `a6eac92`, 600 px since `b5f32b0`) and is part of the
design, not a phone workaround. Keyword hits such as "micro**phone**", "touch"
as in "change", or the `android` MCP server in `fillers.ts`/`config.ts` are not
mobile code.

## Removed: no longer needed

- **Restart on the microphone track ending** (`onEnded` in `createMicKeeper`
  and the `onMicEnded` export, `src/lib/audio.ts`; removed 2026-10-19). The
  first attempt at a page that stopped hearing after a phone's screen locked:
  the voice loop restarted whenever the track ended. It killed a working
  fallback recogniser and looped, so the page stopped subscribing to it
  (`tests/lifecycle.test.ts` keeps that check); the mechanism had no caller
  left. Recovery reads whether the stream still hears (`alive()`, `micAlive`)
  when the page comes back, which stays. Its test became one that checks an
  old stream ending does not touch the one in use.

## Phone-browser specific — stays

These exist for Chrome on Android and are what make the page work there. They
change nothing on the computer.

### Screen wake lock during an answer

- **What:** keeps a phone screen on while JARVIS answers; a locked screen took
  the microphone and the audio away from the page.
- **Code:** `src/lib/screenWake.ts`; in `src/lib/tts.ts` the `screenWake`
  import, `QUIET_SPEAKER_MS`, `wakeOwner`, `screenWake.hold(…)`/`letGo(…)`.
- **Tests:** `tests/screenWake.test.ts`, `tests/speakerWake.test.mjs`.

### No browser recogniser fallback on Android

- **What:** Chrome's recogniser on Android cannot open a microphone the page
  already holds, so there the page asks for a touch instead of falling back to
  it (on the computer it falls back as before).
- **Code:** `browserFallbackWorks()` and `fallback: browserFallbackWorks()` in
  `src/lib/voice.ts`.
- **Tests:** `tests/voiceCycle.test.ts`.

### The Android wording for a refused browser recogniser

- **What:** "the microphone is allowed, but the browser's recogniser could not
  get it" — the Android case of `not-allowed` with the permission granted.
- **Code:** the `permission === 'granted'` branch of `speechRefusalMessage` in
  `src/lib/micErrors.ts`, called from `src/lib/browserVoice.ts`.
- **Tests:** `tests/micErrors.test.ts`.

### Touch

- **What:** the microphone restarts on a tap counted on `pointerup` (a finger
  is a user gesture only when lifted), and a pinch or a pan is not a tap.
- **Code:** `armTapOnce`, `TAP_EVENT`, `TAP_SLOP_PX` in `src/lib/lifecycle.ts`.
- **Tests:** `tests/lifecycle.test.ts`.

### Layout

- Dialog frame rules (`svh`) and the link status position in the ≤900 px
  block of `src/index.css`; `tests/dialogLayout.test.ts`.

## General fixes — stay

Written after phone failures, but general: the computer uses them too, and
their server side serves the Android app as well.

| Code | Why it stays |
|---|---|
| `audioStart.ts`, `primeCapture()` in `pcmCapture.ts`/`App.tsx`, bounded `unlockAudio` in `sfx.ts` | Every browser requires a user gesture to start audio, desktop Chrome included |
| Capture watchdog in `pcmCapture.ts`; close codes 4010–4013 in `deepgramVoice.ts` | A capture also stops on the computer (headset unplugged, Bluetooth switch) |
| `createMicKeeper` in `audio.ts` (a live stream only; one `getUserMedia` for two requests) | A stream also dies on the computer when the device changes |
| `lifecycle.ts`: `watchLifecycle`, `planRecovery`, `createRecoveryGate`, `micPermission` | A laptop waking from sleep, a network change |
| `armTapOnce` with its multi-finger guard | A mouse click works the same; touch screens exist on computers |
| `voiceSupervisor.ts`, `scribeVoice.ts`, the Deepgram parser's `onPhraseEnd` | The voice loop's own recovery and phrase handling |
| `redial.ts`, `resume.ts`, `linkStatus.ts`, `bridge/resumable.mjs` | The connection, for every client |
| Dialog frame rules (`svh`) in the ≤900 px block, `tests/dialogLayout.test.ts` | Responsive layout |
| Bridge: three Deepgram sessions with replacement (`4001`), `?why=` start reason, page close codes 4000–4099 in the log | A computer and a phone at once; diagnosis |

## What the Android app will do itself

The server stays common: recognition through `/stt-stream`, turns through `/`,
speech through `/tts`, tools, knowledge base, sessions, all per
`shared/protocol.mjs`.

| Responsibility | Today on the page | In the app |
|---|---|---|
| Microphone permission | `getUserMedia`, `micErrors.ts` | `RECORD_AUDIO` at run time, an explanation on refusal |
| Capture | `pcmCapture.ts` + worklet → PCM16 16 kHz | `AudioRecord`, 16 kHz mono PCM16, binary frames on `/stt-stream` |
| Echo | the browser's `echoCancellation` | `VOICE_COMMUNICATION` source + `AcousticEchoCanceler` |
| Playback and "Стоп" | `tts.ts`, `interrupt` | a player for `/tts`, audio focus, `interrupt` on the socket and stop |
| Screen during an answer | `screenWake.ts` | `FLAG_KEEP_SCREEN_ON` |
| Returning, network changes | `lifecycle.ts` | Activity lifecycle, `ConnectivityManager.NetworkCallback` |
| Background | browser limits | a foreground service of type microphone, within Android 14+ rules |
| Reconnecting | `redial.ts` | the same algorithm (ping/pong, backoff, slow retry) on the protocol |
| A capture that stops | the capture watchdog | `AudioRecord` read errors, headset routing changes |
| Device token | — | Android Keystore (pairing protocol to be specified first) |

## Voice functions: shared logic or audio handling

The app must not copy JARVIS's logic into Kotlin without a separate
architectural decision (owner, 2026-10-19). This is where the line falls today:

**Audio handling — each client does its own** (device and platform):
capture (`pcmCapture.ts`, `pcm.ts`, the worklet, `audioStart.ts`), the
microphone stream and permission (`audio.ts`, `micErrors.ts`), the audio level
used for barge-in (`vad.ts`), playback and speech engines (`tts.ts`,
`kokoro.ts`, `sfx.ts`), the screen (`screenWake.ts`), page or app lifecycle
(`lifecycle.ts`), clap detection (`clap.ts`), the browser's own recogniser
(`browserVoice.ts`, browser only), and the recognition socket's client side
(`deepgramVoice.ts` — the protocol is shared, the socket code is per client).

**Shared logic — works on text, the same for every client:** his name
(`voiceCore.ts`: `WAKE`, `afterWake`), assembling phrases from recogniser
results (`makeAssembler`, the commit rules in `scribeVoice.ts` and the
Deepgram parser), stop words and barge-in decisions (`stopWords.ts`,
`bargeIn.ts`), telling his own voice from the user's by text (`echo.ts`,
`ledger.ts`), one question at a time (`floor.ts`), turn routing and the page's
own answers (`turnRoute.ts`, `localAnswer.ts`, `calendarFlow.ts`,
`musicIntent.ts`, `fillers.ts`).

The shared logic runs in the page today. For the app there are two ways,
to be decided before it is built: run it on the bridge for every client (the
recogniser's transcripts go to the bridge already), or keep it per client and
port it. The first avoids two implementations; it moves code that the voice
loop depends on and needs its own plan and tests.
