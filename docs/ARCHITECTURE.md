# JARVIS architecture

How the code is divided, which way the dependencies point, and what the client
and the bridge say to each other. `tests/architecture.test.ts` checks the
module map and the dependency rules below on every `npm test`.

Two programs:

- **the page** (`src/`, React + Vite): the voice loop, the turn, the interface;
- **the bridge** (`bridge/`, Node): one Claude Agent SDK session per socket,
  the tools, speech services whose keys stay on the server, the knowledge base.

They share no code by import. What they share is the protocol (`shared/`,
"Contracts" below). In production the page is static files behind a reverse
proxy with Basic Auth; the bridge listens on loopback behind the same proxy.

## Page modules

Files stay in `src/lib/` for now; the module is logical. Moving them into
folders is the last step, once the boundaries hold.

| Module | Responsibility | Files |
|---|---|---|
| **config** | Build-time settings | `config.ts` |
| **state** | The UI store (zustand) | `store.ts` |
| **contracts** | Shapes the page and the bridge agree on | `shared/*` |
| **lang** | Word lists and text matching shared by voice and turn routing | `stopWords`, `echo` |
| **platform** | What this browser and this bridge can do; fault log; diagnostic breadcrumbs | `capabilities`, `faultLog`, `trace` |
| **voice** | Microphone, recognisers, phrase assembly, barge-in, speech synthesis, the voice loop's recovery | `voice`, `voiceCore`, `voiceSupervisor`, `voiceSlot`, `scribeVoice`, `deepgramVoice`, `browserVoice`, `pcm`, `pcmCapture`, `audio`, `audioStart`, `vad`, `bargeIn`, `ledger`, `micErrors`, `lifecycle`, `tts`, `kokoro`, `speechText`, `sentences`, `screenWake`, `sfx`, `clap`, `voiceWaves`, `fillers` |
| **core** | The turn: one question on the floor, routing, the connection to the bridge and its recovery | `brain`, `bridge`, `anthropic`, `redial`, `resume`, `linkStatus`, `floor`, `turnRoute`, `turnLog`, `aside`, `localAnswer` |
| **integrations** | Calendar, music, knowledge base client, camera and hand tracking | `calendarFlow`, `calendarIntent`, `calendarTime`, `calendarCheck`, `calendarClient`, `music`, `musicIntent`, `yandexMusic`, `knowledgeClient`, `knownFetch`, `camera`, `hands`, `oneEuro` |
| **ui** | HUD, scene, boot screen, status mapping | `src/ui/*`, `src/scene/*`, `coreMode`, `bootTimeline` |
| **app** | Composition root: wires the modules together | `App.tsx`, `main.tsx` |

### Dependency rules

```
app ──▶ ui ──▶ core, voice, integrations ──▶ lang, platform, config ──▶ contracts
         └──▶ state ──▶ contracts
```

- `core`, `voice` and `integrations` do not import each other, the store or the UI.
- `ui` may call into `core`, `voice` and `integrations`; nothing below imports `ui`.
- `contracts` import nothing.
- The page and the bridge never import each other.
- No import cycles at run time. (`scene/Core.tsx` and `scene/Particles.tsx`
  take a type from `scene/Scene.tsx`; type-only imports are erased and do not count.)

### Debts

Crossings that exist today and are to be removed; the test lists them and
fails if one is added or one is fixed without being struck off.

None today.

Paid:

- `voice.ts`, `knowledgeClient.ts` → `bridge.ts` (diagnostic breadcrumbs went
  through the transport). They now call `trace.ts`, whose sink the transport
  registers.
- `brain.ts`, `bridge.ts` → `store.ts` (the panel and blade shapes lived in the
  UI store). They are in `shared/ui.ts`; `store.ts` re-exports them.

`App.tsx` is the composition root and also, today, the place where the voice
events, the turn pipeline (`respond`) and the page lifecycle are wired. Those
are the largest remaining extraction (see the plan).

## Bridge modules

| Module | Files |
|---|---|
| **server** (composition, HTTP routes, socket handling, tool policy, sessions) | `server.mjs` |
| turns and failures | `turns.mjs`, `turnText.mjs`, `failures.mjs`, `effort.mjs`, `fallback.mjs`, `accounts.mjs`, `resumable.mjs`, `turnLog.mjs` |
| speech | `deepgramProxy.mjs`, `piper.mjs` |
| tools | `computer.mjs`, `pc.mjs`, `chrome.mjs`, `panels.mjs`, `ui.mjs`, `vision.mjs`, `visual.mjs`, `page.mjs`, `net.mjs`, `calendar.mjs`, `googleCalendar.mjs`, `music.mjs`, `yandexMusic.mjs` |
| knowledge | `knowledge.mjs`, `knowledgeRoute.mjs`, `knowledgeAdmin.mjs` |
| secrets | `secrets.mjs` (redaction, the agent's environment, the writes switch) |
| tool policy | `policy.mjs` (which tools the agent may run: built-in lists, MCP rules, `decideTool`; built once from the writes switch) |
| access | `access.mjs` (the Origin and Host checks: `createAccess(env)`, called once by `server.mjs` with `process.env`; its `originAllowed` and `hostAllowed` run before every HTTP route and in the WebSocket handshake; rules in `tests/access.test.mjs`, the running bridge in `tests/bridgeBind.test.mjs`) |
| system prompt | `prompt.mjs` (who JARVIS is and how he speaks: the English prompt, with the Russian head and tail for `ru`; `systemPromptFor(lang)`, the language decided in `server.mjs` from `LANG`; the text is pinned by SHA-256 per language in `tests/prompt.test.mjs`, so an edit to it is never silent) |
| HTTP routes | `http/page.mjs` (`GET /page`; a remote web page served from the bridge's origin so it can be framed — the fetch, both modes and the SSRF gate stay in `page.mjs` and `net.mjs`; `bridgeOrigin`, `http://localhost:` and the port, is built in `server.mjs` and passed in; failures are an HTML error page, not redacted), `http/proxy.mjs` (`GET /img`, `GET /media`; remote images, video and audio fetched by the bridge — the SSRF gate and the guarded clients stay in `net.mjs`, shared with `page.mjs`; redaction passed in), `http/file.mjs` (`GET /file`; local images only — the image types, the size limit and the roots stay in `server.mjs` and are passed in, the containment check is built there from `withinRootsOf`), `http/stt.mjs` (`POST /stt`, one recorded segment to ElevenLabs Scribe; not the realtime `/stt-stream` socket), `http/tts.mjs` (`POST /tts`; ElevenLabs streamed or Piper, with the fallbacks; key, voices, synthesis and redaction passed in), `http/health.mjs` (`GET /health`; the keys and the engine choice stay in `server.mjs` and are passed in), `http/scribe-token.mjs` (`GET /scribe-token`; strict Origin rule, key and the shared two-second gap stay in `server.mjs` and are passed in; tokens are ElevenLabs' single-use ones, never kept by the bridge), `http/knowledge.mjs` (`POST /knowledge/answer`), `http/calendar.mjs` (`POST /calendar`; what may be written stays with `googleCalendar.mjs`), `http/music.mjs` (`POST /music`; actions and player calls stay with `yandexMusic.mjs`) |

`server.mjs` is the bridge's composition root. It still holds the other HTTP
routes and the session protocol, and it keeps everything that comes before
any route — the Host and Origin checks, `OPTIONS`, the CORS headers — handing
a moved route only the `cors` headers it built. Routes move one at a time,
each with tests written against the code while it was still in `server.mjs`
(`tests/policy.test.mjs`, `tests/httpKnowledge.test.mjs`, `tests/httpCalendar.test.mjs`,
`tests/httpMusic.test.mjs`, `tests/httpHealth.test.mjs`, `tests/httpScribeToken.test.mjs`,
`tests/httpTts.test.mjs`, `tests/httpStt.test.mjs`, `tests/httpFile.test.mjs`; its symlink cases
need a system that lets the user make links — skipped on Windows without
Developer Mode, run on Linux; `tests/httpProxy.test.mjs`, whose running-bridge
cases cover only what the SSRF gate refuses without the network — what happens
after a target is accepted is tested on the moved handlers with a stand-in
`openRemote`, the real gate still in front of it; `tests/httpPage.test.mjs`, the
same split: the running bridge shows only the error page for what the gate
refuses, and the route around renderPage is tested with a stand-in `render` —
renderPage itself, both modes and the document's CSP, has no tests yet).

## Contracts (page ↔ bridge)

In code: `shared/protocol.mjs` (frame names, error kinds, recognition messages,
close codes; plain JavaScript, loaded by the bridge at run time and bundled by
the page) with its types in `shared/protocol.d.mts`, and `shared/ui.ts` (panel
and blade shapes, types only). `tests/protocol.test.ts` pins the values to
what was on the wire and checks both sides' real code against them;
`tests/uiContract.test.ts` does the same for panels and blades.

The page's frame type (`BridgeFrame`) types `type` as the known names, so the
compiler rejects a comparison with a misspelt one. The bridge's `server.mjs`
keeps its literals (it has no unit tests and starts the server on import); the
protocol test reads them from the source instead.

### Agent socket (`/`)

Page → bridge: `ask {text, id, asides?}`, `interrupt`, `reply {id, …}` (camera
frame), `resume {id}`, `ping`, `trace`.

Bridge → page: `ready {servers}`, `session {id}`, `resumed {ok}`, `text {delta, ask}`,
`tool {name}`, `done {text, ask}`, `error {message, kind?, resetAt?}`, `retry`,
`effort`, `panel`, `blade`, `ui {op, args}`, `capture {id, mode, reason, seconds, when}`, `pong`.

`capture` is the one request the bridge makes of the page (its `ask(kind, args)`
helper in `server.mjs`, used by the camera tool in `vision.mjs`); the page
answers with `reply {id, data?, mimeType?, error?}`.

One socket is one agent session and one conversation. Devices have separate
conversations. A dropped socket can ask for its session back (`resume`) within
the bridge's resume window.

On the running bridge, in DRY mode (`JARVIS_DRY_ASK=1`, Claude never asked),
`tests/bridgeSocket.test.mjs` pins what can be reached without a model: `ready`
first, `ping`/`pong`, a question's `text` then `done`, `trace`, `interrupt`, an
unasked `reply`, a refused `resume`, junk ignored, the close logged. A real
turn's frames are covered by `tests/turns.test.mjs` and, by source, by
`tests/protocol.test.ts`.

### Recognition socket (`/stt-stream?why=…`)

Page → bridge: binary frames of 16 kHz mono PCM16. Bridge → page: JSON
`{t:'ready'}`, `{t:'r', text, final, speech}`, `{t:'u'}`, `{t:'err'}`. Close
codes from the bridge: `1000` normal, `1009` frame or session audio too large,
`1011` the page's socket errored, `4000` session time limit, `4001` replaced
(at most three sessions), `4408` idle, `4502` Deepgram unreachable or failed,
`4503` no usable Deepgram key. From the page (logged by the bridge as given,
like any code in 4000–4099): `4010` audio blocked, `4011` capture failed,
`4012` worklet stalled, `4013` capture stalled.

### HTTP

`GET /health`, `GET /scribe-token`, `POST /tts`, `POST /stt`, `POST /calendar`,
`POST /knowledge/answer`, `POST /music`, `GET /file|/img|/media|/page`.

### Errors and connection state

- A turn fails with an `Error` (a fault: red core) or a `ServiceError` whose
  `kind` is `rate` (usage limit), `service` (outside trouble) or `link` (the
  connection went under the question; shown as part of the reconnect).
- Connection states: `open`, `lost`, `resumed`, `reconnected`, `down`
  (`bridge.ts`), shown through `linkStatus.ts` as `ok` / `reconnecting` / `down`.

### Access

The bridge accepts sockets only from allowed origins and hosts; a client with
no Origin is refused unless explicitly allowed (`access.mjs`). Writes (shell, files, devices)
are off unless enabled, never as root; calendar writes have their own switch.
Secrets stay on the bridge and are redacted from its logs.

## Releasing

A release set lists its files explicitly, so the shared layer has to be in it:

- `shared/` is imported by the page (bundled at build) and by the bridge at run
  time (`bridge/deepgramProxy.mjs` → `shared/protocol.mjs`). A release that
  carries files importing it must carry `shared/` too; without it the bridge
  does not start. The release check's import-resolution step catches a
  missing file (every relative import must resolve inside the release or on
  the server).
- Files added since the deployed release (mr5) that the bridge needs at run
  time: `shared/protocol.mjs` (with `shared/protocol.d.mts` and `shared/ui.ts`
  for the page build), `bridge/policy.mjs`, `bridge/http/knowledge.mjs`,
  `bridge/http/calendar.mjs`, `bridge/http/music.mjs`, `bridge/http/health.mjs`,
  `bridge/http/scribe-token.mjs`, `bridge/http/tts.mjs`, `bridge/http/stt.mjs`,
  `bridge/http/file.mjs`, `bridge/http/proxy.mjs`, `bridge/http/page.mjs`,
  `bridge/prompt.mjs`, `bridge/access.mjs`. `server.mjs` imports the last thirteen at start-up; without them it does not start.
  This list is not yet checked against the server: the local copy of production
  from 2026-10-17 also lacks `bridge/accounts.mjs`, `fallback.mjs`,
  `resumable.mjs`, `secrets.mjs` and `turns.mjs`, which `server.mjs` imports too.
- `shared/` and `bridge/http/` are new directories on the server. Installing
  new files must create their directories (`install -D -m 644`); the current
  deploy scripts install new files with `install -m 644`, which does not, and
  must be changed for the first release that carries them.
- A release that changes `bridge/` restarts the bridge; one that changes only
  the page and `shared/` types does not need to.
- Comments must not contain `from '<relative path>'`: the import-resolution
  step reads it as an import.
