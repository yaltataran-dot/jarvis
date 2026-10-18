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
| **platform** | What this browser and this bridge can do; fault log | `capabilities`, `faultLog` |
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

1. `brain.ts`, `bridge.ts` → `store.ts`: the panel and blade shapes live in the
   UI store. They belong in contracts.
2. `voice.ts`, `knowledgeClient.ts` → `bridge.ts`: diagnostic breadcrumbs go
   through the transport. A small trace sink that the transport registers with
   removes the dependency.

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

`server.mjs` is the bridge's composition root and still holds the HTTP routes,
the tool permission policy and the session protocol; splitting those out is a
later step.

## Contracts (page ↔ bridge)

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

### Recognition socket (`/stt-stream?why=…`)

Page → bridge: binary frames of 16 kHz mono PCM16. Bridge → page: JSON
`{t:'ready'}`, `{t:'r', text, final, speech}`, `{t:'u'}`, `{t:'err'}`. Close
codes from the bridge: `4000` session time limit, `4001` replaced (at most
three sessions), `4408` idle. From the page (logged by the bridge): `4010`
audio blocked, `4011` capture failed, `4012` worklet stalled, `4013` capture
stalled.

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
no Origin is refused unless explicitly allowed. Writes (shell, files, devices)
are off unless enabled, never as root; calendar writes have their own switch.
Secrets stay on the bridge and are redacted from its logs.
