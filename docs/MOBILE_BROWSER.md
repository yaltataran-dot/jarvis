# The page on a phone, and what the Android app takes over

JARVIS on a phone runs today as the web page in mobile Chrome. A native
Android app is planned; the site on the phone stays as a fallback way in.
This document records which parts of the page exist only for mobile browsers,
which are general and stay, and what the app has to do itself.

Nothing here is removed yet. Category 1 is removed only after the app is in
use and checked (criteria below), and with the owner's separate approval.

## Where it came from

The page had no mobile-specific code before the voice-recovery work of
2026-10-17/18 (commit `edb6a70`): no `Android`, `wakeLock`, `visibilitychange`
or `pageshow` anywhere in earlier history. The responsive layout is older
(900 px breakpoint since `a6eac92`, 600 px since `b5f32b0`) and is part of the
design, not a phone workaround. Keyword hits such as "micro**phone**", "touch"
as in "change", or the `android` MCP server in `fillers.ts`/`config.ts` are not
mobile code.

## Category 1 — to remove after the app is in use

Only for Chrome on Android; nothing on the computer depends on them.

### 1a. Screen wake lock during an answer

- **What:** keeps a phone screen on while JARVIS answers, because a locked
  screen took the microphone and the audio away from the page.
- **Code:** `src/lib/screenWake.ts` (whole file: `createScreenWake`,
  `screenWake`, `WakeState`); in `src/lib/tts.ts`: the `screenWake` import,
  `QUIET_SPEAKER_MS`, `wakeOwner`, the two `screenWake.hold(…)` calls,
  `soundStarted`, `queueDry`'s `screenWake.letGo(…)`, and the
  `screenWake.letGo(wakeOwner, 0)` on stop.
- **Tests:** `tests/screenWake.test.ts` (19), `tests/speakerWake.test.mjs` (6).
- **Map:** `screenWake` in `tests/architecture.test.ts` and in the voice row of
  `docs/ARCHITECTURE.md`.
- **Care:** `tts.ts` is the speech queue; the edit must leave its timing
  (`BETWEEN_ANSWERS_MS`, the end of each answer, the stop) as it is. Check
  with the remaining speech tests and by voice on the computer.

### 1b. No browser recogniser fallback on Android

- **What:** on Android, Chrome's recogniser cannot open a microphone the page
  already holds, so after the realtime recogniser fails the page asks for a
  touch instead of falling back to it.
- **Code:** `src/lib/voice.ts`: `browserFallbackWorks()` and
  `fallback: browserFallbackWorks()` in the supervisor's options (the computer
  keeps `fallback: true`, today's behaviour there).
- **Tests:** the `fallback: browserFallbackWorks\(\)` check in
  `tests/voiceCycle.test.ts` (wiring test); the phone/computer recovery tests
  in the same file stay and must pass with `fallback: true`.

### 1c. The Android wording for a refused browser recogniser

- **What:** `speechRefusalMessage` in `src/lib/micErrors.ts` says "the
  microphone is allowed, but the browser's recogniser could not get it" when
  the permission is granted — the Android case. `classifyMicError`,
  `micFailureMessage`, `audioBlockedMessage` and `sttUnavailableMessage` are
  general and stay.
- **Code:** the `permission === 'granted'` branch of `speechRefusalMessage`;
  its caller in `src/lib/browserVoice.ts` stays.
- **Tests:** the `granted` case in `tests/micErrors.test.ts`.

### Criteria for removing category 1

All of these, then the owner's approval for the removal itself:

1. The Android app is in daily use on the phone.
2. Checked on a real phone with the app: the voice loop end to end, "Стоп",
   recovery after a VPN switch, a Wi-Fi/mobile switch and airplane mode, and
   behaviour on an unstable network.
3. The owner accepts that the site on the phone, kept as a fallback, then
   works without the screen wake lock (a long answer can be cut by the screen
   locking) and with the general wording for a refused recogniser.
4. Removed one item (1a, 1b, 1c) at a time, each with the full test run, type
   check, lint, build and a voice check on the computer; the release check of
   the deploy procedure passes for the resulting set.

## Category 2 — general, stays

These were written after phone failures but are general fixes; the computer
uses them, and their server side serves the Android app too.

| Code | Why it stays |
|---|---|
| `audioStart.ts`, `primeCapture()` in `pcmCapture.ts`/`App.tsx`, bounded `unlockAudio` in `sfx.ts` | Every browser requires a user gesture to start audio, desktop Chrome included |
| Capture watchdog in `pcmCapture.ts`; close codes 4010–4013 in `deepgramVoice.ts` | A capture also stops on the computer (headset unplugged, Bluetooth switch) |
| `createMicKeeper` in `audio.ts` | A stream also dies on the computer when the device changes |
| `lifecycle.ts`: `watchLifecycle`, `planRecovery`, `createRecoveryGate`, `micPermission` | A laptop waking from sleep, a network change |
| `armTapOnce` with its multi-finger guard | A mouse click works the same; touch screens exist on computers |
| `voiceSupervisor.ts`, `scribeVoice.ts`, the Deepgram parser's `onPhraseEnd` | The voice loop's own recovery and phrase handling |
| `redial.ts`, `resume.ts`, `linkStatus.ts`, `bridge/resumable.mjs` | The connection, for every client |
| Dialog frame rules (`svh`) in the ≤900 px block, `tests/dialogLayout.test.ts` | Responsive layout |
| Bridge: three Deepgram sessions with replacement (`4001`), `?why=` start reason, page close codes 4000–4099 in the log | A computer and a phone at once; diagnosis |

## Category 3 — what the Android app does itself

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
architectural decision. This is where the line falls today:

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
