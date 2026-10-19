/**
 * JARVIS local bridge.
 *
 * Runs the Claude Agent SDK — Claude Code as a library — and exposes one turn
 * of conversation over a WebSocket. The browser stays the face and the voice;
 * this process is the brain and the hands.
 *
 * Two things this buys over calling the Claude API from the browser:
 *   1. No API key. It authenticates exactly the way `claude` does, off your
 *      existing login, and bills to that same account.
 *   2. Every MCP server in your Claude Code config is available, including the
 *      local stdio ones a browser could never reach — higgsfield, elevenlabs,
 *      android, playwright, palmier-pro and the rest.
 *
 *   node bridge/server.mjs
 */

import { WebSocketServer } from 'ws'
import { STT_PATH, createSttProxy, keyProblem } from './deepgramProxy.mjs'
import { createResumable, transcriptPath } from './resumable.mjs'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { chromeAvailable } from './chrome.mjs'
import { homedir, tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { defaultPiperVoice, piperSpeak, piperVoices, warmPiper } from './piper.mjs'
import { asidesFrom, createBlockJoin, formatAsides, withAside } from './turnText.mjs'
import { fallbackDownMessage, limitMidTurnMessage, noLoginFrame, resultFailures } from './failures.mjs'
import { createTurns } from './turns.mjs'
import { createAccounts } from './accounts.mjs'
import { createBudget, createFallback, fallbackConfig, fileStore } from './fallback.mjs'
import { createTurnLog, recordTrace } from './turnLog.mjs'
import { PROJECT_ROOT } from './computer.mjs'
import { createYandexMusic } from './yandexMusic.mjs'
import { MUSIC_PATH, musicRequest } from './http/music.mjs'
import { HEALTH_PATH, healthRequest } from './http/health.mjs'
import { SCRIBE_TOKEN_PATH, scribeTokenRequest } from './http/scribe-token.mjs'
import { TTS_PATH, ttsRequest } from './http/tts.mjs'
import { STT_HTTP_PATH, sttRequest } from './http/stt.mjs'
import { FILE_PATH_PREFIX, fileRequest, withinRootsOf } from './http/file.mjs'
import { IMG_PATH_PREFIX, MEDIA_PATH_PREFIX, imgRequest, mediaRequest } from './http/proxy.mjs'
import { PAGE_PATH_PREFIX, pageRequest } from './http/page.mjs'
import { createGoogleCalendar } from './googleCalendar.mjs'
import { CALENDAR_PATH, calendarRequest } from './http/calendar.mjs'
import { startKnowledge } from './knowledgeRoute.mjs'
import { KNOWLEDGE_ANSWER_PATH, knowledgeAnswer } from './http/knowledge.mjs'
import { agentEnv, installLogRedaction, redactSecrets, registerSecrets, secretValuesFrom, writesAllowed } from './secrets.mjs'
import { createToolPolicy } from './policy.mjs'
import { systemPromptFor } from './prompt.mjs'
import { createAccess } from './access.mjs'
import { createPageRequests } from './pageRequests.mjs'
import { createToolBadge } from './toolBadge.mjs'
import { latNew, latencyLine, ms } from './latency.mjs'
import { createTurnOutcome } from './turnResult.mjs'
import { createSocketState } from './socketState.mjs'
import { createSessionLifecycle, sessionOptions } from './sessionLifecycle.mjs'
import { createSessionStream } from './sessionStream.mjs'
import { createSessionInput } from './sessionInput.mjs'
import { sessionServers } from './sessionServers.mjs'
import { backupLoginDirs, configuredServers, createVoiceKeys, fileRoots, languageFrom, pcRoots } from './settings.mjs'

const PORT = Number(process.env.JARVIS_BRIDGE_PORT ?? 8787)
// Loopback only by default. Bound to every interface, the agent socket and the
// /fetch proxy are one open firewall away from the internet; on a server that
// is reached through an SSH tunnel to 127.0.0.1, loopback is all it needs.
const HOST = process.env.JARVIS_BRIDGE_HOST || '127.0.0.1'

/**
 * A crash here takes the whole assistant down mid-sentence, and most of what
 * can reject is out of our hands — a socket dying under a write, an upstream
 * fetch aborting. Log it and keep serving; the turn that failed will surface
 * its own error to the browser.
 */
process.on('unhandledRejection', (err) => {
  console.error('[jarvis] unhandled rejection:', err)
})

/**
 * The bridge's own keys, masked by value wherever they would be printed or
 * sent to the page — an SDK error carrying the CLI's stderr, an API error
 * echoing a header. See secrets.mjs.
 */
registerSecrets(secretValuesFrom(process.env))
installLogRedaction(console)

/**
 * Every log line carries the time. The log is the only record of what a turn
 * did, and without times a failed answer could not be matched to the voice
 * test it belonged to — three "turn failed" lines, and no way to say when.
 */
for (const level of ['log', 'warn', 'error']) {
  const write = console[level].bind(console)
  console[level] = (...args) => write(new Date().toLocaleTimeString('ru-RU', { hour12: false }), ...args)
}

// Who may talk to this bridge: the Origin and Host checks, read once from the
// environment (access.mjs).
const { originAllowed, hostAllowed, extraOrigins: EXTRA_ORIGINS, allowNoOrigin: ALLOW_NO_ORIGIN } = createAccess(process.env)

/**
 * Voice is a bad interface for a confirmation dialog: there is no window to
 * click and the model can't pause for one. So the bridge decides.
 *
 * Read-only and generative tools run freely. Anything that writes to disk,
 * runs a shell, or changes the world waits for JARVIS_ALLOW_WRITES=1. Start
 * without it, and turn it on once you trust what you're demoing.
 *
 * Never as root: the shell it opens would be the whole machine's. A bridge
 * running as root keeps writes off whatever the flag says — see writesAllowed.
 */
const WRITES = writesAllowed(process.env, { uid: process.getuid?.(), platform: process.platform })
const ALLOW_WRITES = WRITES.allowed
if (WRITES.refused === 'root') {
  console.warn('[jarvis] JARVIS_ALLOW_WRITES=1 refused: the bridge runs as root — writes stay off')
} else if (WRITES.refused === 'unknown-uid') {
  console.warn('[jarvis] JARVIS_ALLOW_WRITES=1 refused: the user this bridge runs as is unknown — writes stay off')
}

/**
 * The orchestrator model. Override with JARVIS_MODEL to trade quality for pace
 * — claude-sonnet-5 is noticeably snappier on camera if Opus feels slow.
 */
const MODEL = process.env.JARVIS_MODEL ?? 'claude-opus-5'

/**
 * How hard the model thinks before answering.
 *
 * This was 'low', on the reasoning that a voice assistant is judged on latency
 * — and that is true right up until the answer is thin. Low effort scopes the
 * work tightly to what was literally asked: fewer tool calls, less
 * cross-referencing, no second look. On a model of this tier that is leaving
 * most of it on the table.
 *
 * 'medium' is the compromise worth having here. It reasons and reaches for
 * tools noticeably more than 'low' while still answering inside the window a
 * spoken conversation tolerates. Raise it to 'high' or 'xhigh' when quality
 * matters more than pace; drop back to 'low' when filming and every second of
 * dead air shows.
 */
const EFFORT = process.env.JARVIS_EFFORT ?? 'medium'

/**
 * Effort is chosen per question unless JARVIS_EFFORT pins it — see effort.mjs.
 * 'high' on every turn was measured at 9.6 s to the first word of a bare
 * multiplication; the session's effort can be changed between turns, so a
 * short question that needs nothing looked up goes in on 'low' and a request
 * to analyse or plan on 'high'.
 */
const ROUTE_EFFORT = !process.env.JARVIS_EFFORT

/**
 * Which tools the agent may run: the built-in lists, the MCP policy and
 * decideTool, in bridge/policy.mjs (tests/policy.test.mjs). Built once from the
 * writes switch; DISALLOWED_BUILTINS goes to the SDK, decideTool to canUseTool
 * and the HUD's tool announcements.
 */
const { decideTool, canUseTool, disallowedBuiltins: DISALLOWED_BUILTINS } = createToolPolicy({ allowWrites: ALLOW_WRITES })

/**
 * The folders the jarvis_pc tools may see: the project, plus any listed in
 * JARVIS_PC_ROOTS (separated by ";"). Nothing outside them is listed, found or read.
 */
/**
 * Yandex Music (yandexMusic.mjs). One instance for the whole bridge: the page's
 * direct commands (/music) and the model's tools share its queue, so a click
 * from one cannot race a click from the other.
 */
const YM = createYandexMusic({ log: (line) => console.log(line) })
// The Windows media helper takes two seconds to start; pay it now, not on the
// first "что играет".
if (process.platform === 'win32') YM.warm()

/**
 * Google Calendar (googleCalendar.mjs). Its writes have their own switch,
 * JARVIS_CALENDAR_WRITES=1, so the calendar can be written to without opening
 * the shell and the file system with JARVIS_ALLOW_WRITES — and every write
 * still needs a spoken yes to its read-back in the page.
 */
const CAL = createGoogleCalendar({ log: (line) => console.log(line) })

/**
 * The local knowledge base (knowledge.mjs). Opened once; if it cannot be, the
 * bridge runs without it — every lookup is then a miss and every question goes
 * to Claude exactly as before. Read-only from the page: there is no route that
 * writes to it.
 */
const KNOWLEDGE = startKnowledge()
if (KNOWLEDGE.kb) console.log('[knowledge] ready')

// The usage limit, and how long a limited or refused login is held off:
// turnResult.mjs.

// The primary login's directory, as the agent finds it — never also a backup.
const PRIMARY_LOGIN_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
const ACCOUNTS = createAccounts({ backupDirs: backupLoginDirs(process.env, { primaryDir: PRIMARY_LOGIN_DIR }) })
if (ACCOUNTS.switchable()) console.log(`[jarvis] claude logins: ${ACCOUNTS.labels().join(', ')}`)

/**
 * The frame for a question no login takes now: the limit, for one login or all
 * of them at it; "unavailable" (kind 'service') when some are only set aside
 * (failures.mjs).
 */
const noLogin = (clock, blocked) => noLoginFrame({ clock, blocked, logins: ACCOUNTS.labels().length, lang: LANG })

// Where the computer tools may work (settings.mjs).
const PC_ROOTS = pcRoots(process.env, PROJECT_ROOT)

// Every MCP server Claude Code has configured, handed to each session because
// settingSources is off (settings.mjs).
const MCP_SERVERS = configuredServers(homedir)


// The language he answers in: JARVIS_LANG or VITE_LANG, Russian by default (settings.mjs).
const LANG = languageFrom(process.env)

/**
 * Diagnostics, both off by default.
 *
 * JARVIS_DRY_ASK=1 answers every question with a fixed line instead of handing
 * it to Claude, so the whole browser → bridge → browser → speech path can be
 * checked on the real socket without paying for a turn. VITE_TRACE=1 (shared
 * with the frontend through `npm start`) prints the page's trace frames and
 * each ask/interrupt as it arrives.
 */
const DRY_ASK = process.env.JARVIS_DRY_ASK === '1'
const TRACE = DRY_ASK || process.env.VITE_TRACE === '1'
// Page trace frames also go to logs/trace.jsonl (2 MB x 3 files, written off
// the hot path). Dialogue words stay out unless JARVIS_DIALOG_LOG=1.
const DIALOG_LOG = process.env.JARVIS_DIALOG_LOG === '1'
const TURN_LOG = TRACE ? createTurnLog({ dir: join(PROJECT_ROOT, 'logs'), dialog: DIALOG_LOG }) : null
// Long enough (about ten seconds aloud) to cut off mid-sentence, and free of
// every word in voice.ts's OVERRIDE list, or his own echo would interrupt it.
const DRY_REPLY =
  LANG === 'ru'
    ? 'Проверка связи, сэр. Мост получил команду и отвечает без обращения к модели. ' +
      'Этот ответ нарочно длинный, чтобы вы успели меня прервать. ' +
      'Если вы всё ещё слышите эту фразу, прерывание не сработало. ' +
      'Повторяю ещё раз: прерывание не сработало.'
    : 'Connection check, sir. The bridge received the command and is answering without the model. ' +
      'This reply is deliberately long, so that you have time to cut me off. ' +
      'If you can still hear this sentence, the interruption did not work. ' +
      'Once more: the interruption did not work.'

const SYSTEM_PROMPT = systemPromptFor(LANG)

// The voice keys — ElevenLabs (also from the elevenlabs MCP server's config)
// and Deepgram (environment only) — and the recognition engine they make,
// read afresh on every call (settings.mjs).
const { elevenKey, deepgramKey, sttEngine } = createVoiceKeys({ env: process.env, homedir })

/** Agent sessions a page may pick up again after its socket drops — see resumable.mjs. */
const RESUMABLE = createResumable()

const sttProxy = createSttProxy({
  key: deepgramKey,
  lang: LANG === 'ru' ? 'ru' : 'en',
  log: (m) => console.log(`[jarvis] ${m}`),
})

const VOICE_ID = process.env.JARVIS_VOICE_ID ?? 'JBFqnCBsd6RMkjVDRZzb'

/**
 * Where /file is permitted to read from, and how big a read may get.
 *
 * The roots are realpath'd once at boot so the containment check below compares
 * like with like — on macOS os.tmpdir() is a symlink into /private/var, and a
 * string prefix test against the unresolved form would reject every screenshot.
 */
const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  // .svg is deliberately absent. An SVG is a scriptable document, and this
  // endpoint serves it from the bridge's own origin — the one origin allowed
  // to open the agent socket. A picture is not worth that.
}

const MAX_FILE_BYTES = 25 * 1024 * 1024

// Home, both temp folders and JARVIS_FILE_ROOTS, realpath'd once (settings.mjs).
const FILE_ROOTS = fileRoots(process.env, { homedir, tmpdir })

/** True when `real` sits inside one of the roots, after both are resolved. */
const withinRoots = withinRootsOf(FILE_ROOTS)

// ---------------------------------------------------------------------------

// Remote media — /img and /media, and the SSRF reasoning behind fetching it
// here rather than in the page — live in http/proxy.mjs.

// ---------------------------------------------------------------------------

/**
 * CORS, reflected rather than wildcarded.
 *
 * `*` on this origin means any page on the internet can read whatever the
 * bridge serves, so the same allowlist that guards the socket picks the
 * header. A request carrying an Origin we don't know is refused outright —
 * but a request with no Origin at all is served, because an <img src> load
 * (which is how panels fetch screenshots) never sends one.
 */
function corsFor(req) {
  const origin = req.headers.origin
  const headers = { vary: 'origin' }
  if (origin) {
    headers['access-control-allow-origin'] = origin
    headers['access-control-allow-headers'] = 'content-type'
  }
  return headers
}

// One HTTP server for both the speech proxy and the WebSocket upgrade.
const http = await import('node:http')

/** Minimum gap between realtime Scribe tokens: a loop of failed starts must not hammer the API. */
const SCRIBE_TOKEN_GAP_MS = 2000
let lastScribeToken = 0

const handleRequest = async (req, res) => {
  if (!hostAllowed(req.headers.host)) {
    console.warn(`[jarvis] refused http request for host ${req.headers.host ?? '(none)'}`)
    res.writeHead(403, { vary: 'origin' })
    return res.end('forbidden')
  }
  const origin = req.headers.origin
  if (origin && !originAllowed(origin)) {
    console.warn(`[jarvis] refused http request from origin ${origin}`)
    res.writeHead(403, { vary: 'origin' })
    return res.end('forbidden')
  }
  const cors = corsFor(req)

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors)
    return res.end()
  }

  // What the bridge can do for the page's voice, read at boot (http/health.mjs).
  if (req.method === 'GET' && req.url === HEALTH_PATH) {
    return healthRequest(req, res, { cors, lang: LANG, elevenKey, sttEngine, piperVoices, defaultPiperVoice })
  }

  // A single-use token for the browser's realtime Scribe socket. The API key
  // stays here: the page gets a short-lived credential that opens one
  // transcription session and nothing else. Neither the token nor the
  // upstream's error body is logged or passed on.
  if (req.method === 'GET' && req.url === SCRIBE_TOKEN_PATH) {
    return scribeTokenRequest(req, res, {
      cors,
      origin,
      originAllowed,
      elevenKey,
      gap: { ms: SCRIBE_TOKEN_GAP_MS, last: () => lastScribeToken, mark: (t) => void (lastScribeToken = t) },
    })
  }

  // Serve local image files to the page. Screenshots and generated art land on
  // disk as absolute paths, and a page served over http can't read file:// —
  // so the bridge, which can, hands them over.
  if (req.method === 'GET' && req.url?.startsWith(FILE_PATH_PREFIX)) {
    return fileRequest(req, res, { cors, imageTypes: IMAGE_TYPES, maxBytes: MAX_FILE_BYTES, withinRoots })
  }

  // Remote images, fetched here so the page never talks to the wider web
  // (http/proxy.mjs).
  if (req.method === 'GET' && req.url?.startsWith(IMG_PATH_PREFIX)) {
    return imgRequest(req, res, { cors, redact: redactSecrets })
  }

  // The same, for video and audio, with their own limits and Range (http/proxy.mjs).
  if (req.method === 'GET' && req.url?.startsWith(MEDIA_PATH_PREFIX)) {
    return mediaRequest(req, res, { cors, redact: redactSecrets })
  }

  // A whole web page, fetched here and served from this origin so it can be
  // framed; no Origin arrives on an iframe navigation, so it rides the same
  // checks as an <img> load (http/page.mjs).
  if (req.method === 'GET' && req.url?.startsWith(PAGE_PATH_PREFIX)) {
    return pageRequest(req, res, { cors, bridgeOrigin: `http://localhost:${PORT}` })
  }

  // Yandex Music, for the commands the page recognises itself ("пауза",
  // "следующий трек") — no model turn. Always answers 200 with a result
  // object; what happened is in its `code` (see yandexMusic.mjs).
  // Google Calendar, for the page's calendar flow (src/lib/calendarFlow.ts):
  // status, list, and the writes it sends only after a spoken yes. Always 200
  // with a result object; what happened is in its `code`.
  // (http/calendar.mjs)
  if (req.method === 'POST' && req.url === CALENDAR_PATH) {
    return calendarRequest(req, res, { cors, cal: CAL })
  }

  // A question the page asks before it asks Claude: is it one the user has
  // already told JARVIS the answer to? (http/knowledge.mjs)
  if (req.method === 'POST' && req.url === KNOWLEDGE_ANSWER_PATH) {
    return knowledgeAnswer(req, res, { cors, kb: KNOWLEDGE.kb, log: (line) => console.log(line), defer: setImmediate })
  }

  // Yandex Music commands the page recognises itself (http/music.mjs).
  if (req.method === 'POST' && req.url === MUSIC_PATH) {
    return musicRequest(req, res, { cors, ym: YM })
  }

  // Spoken answers: ElevenLabs streamed, or the local Piper voice (http/tts.mjs).
  if (req.method === 'POST' && req.url === TTS_PATH) {
    return ttsRequest(req, res, { cors, lang: LANG, voiceId: VOICE_ID, elevenKey, piperVoices, piperSpeak, redact: redactSecrets })
  }

  // Speech to text. The browser captures one spoken segment as a compressed
  // audio blob and posts the raw bytes here; the bridge hands them to
  // ElevenLabs Scribe and returns the transcript. This is what replaced the
  // browser's own SpeechRecognition — that API dies silently under always-on
  // use, and a server-side transcriber cannot. Detecting that the user is
  // speaking at all is done locally with voice-activity detection, which never
  // touches this endpoint; this is only for the words.
  // (http/stt.mjs)
  if (req.method === 'POST' && req.url === STT_HTTP_PATH) {
    return sttRequest(req, res, { cors, lang: LANG, elevenKey, redact: redactSecrets })
  }

  res.writeHead(404, cors)
  res.end()
}

const server = http.createServer((req, res) => {
  // The handler is async, so anything it throws would otherwise become an
  // unhandled rejection and leave the browser waiting on a socket that is
  // never going to answer.
  handleRequest(req, res).catch((err) => {
    console.error('[jarvis] request failed:', err)
    if (!res.headersSent) res.writeHead(500)
    res.end()
  })
})

const wss = new WebSocketServer({
  server,
  // The handshake is the only place a page can be turned away, so it happens
  // here rather than after the socket is open. Rejections are logged loudly:
  // the likeliest cause is a dev server on an unexpected port, and a silent
  // 403 would look like the bridge simply isn't running.
  verifyClient: ({ origin, req }, done) => {
    const path = (req.url ?? '/').split('?')[0]
    if (path !== '/' && path !== '/ws' && path !== STT_PATH) {
      console.warn(`[jarvis] rejected websocket on path ${path}`)
      return done(false, 403, 'Forbidden')
    }
    if (!hostAllowed(req.headers.host)) {
      console.warn(`[jarvis] rejected websocket for host ${req.headers.host ?? '(none)'}`)
      return done(false, 403, 'Forbidden')
    }
    if (!originAllowed(origin)) {
      console.warn(
        `[jarvis] rejected websocket from origin ${origin ?? '(none)'}` +
          ' — set JARVIS_ALLOWED_ORIGINS to permit it',
      )
      return done(false, 403, 'Forbidden')
    }
    done(true)
  },
})
server.listen(PORT, HOST)

console.log(`[jarvis] bridge listening on ws://${HOST}:${PORT}`)
console.log(`[jarvis] language ${LANG === 'ru' ? 'ru (Russian answers)' : 'en'}`)
if (DRY_ASK) console.log('[jarvis] DRY mode — questions get a fixed reply, Claude is never called')
if (TRACE) console.log('[jarvis] trace on — page steps print as [trace]')
{
  // Loaded now rather than on the first sentence, which would otherwise pay
  // the second or so a model takes to load.
  const piperVoice = elevenKey() ? null : warmPiper(LANG)
  console.log(
    `[jarvis] speech ${
      elevenKey()
        ? 'via ElevenLabs (key from MCP config)'
        : piperVoice
          ? `via local Piper voice ${piperVoice}`
          : 'using browser fallback voice (no ElevenLabs key, no Piper voice installed)'
    }`,
  )
}
console.log(`[jarvis] recognition ${sttEngine() ?? 'browser engine (no Deepgram or ElevenLabs key)'}`)
if (keyProblem(process.env.DEEPGRAM_API_KEY) === 'unusable') {
  console.warn(
    '[jarvis] DEEPGRAM_API_KEY is set but unusable (spaces, quotes or non-ASCII characters) — ' +
      'Deepgram is off until the bare key from the Deepgram console is put in .env.bridge',
  )
}
console.log(`[jarvis] model ${MODEL} · effort ${EFFORT}`)
console.log(
  `[jarvis] writes ${ALLOW_WRITES ? 'ENABLED' : 'disabled'}` +
    (ALLOW_WRITES ? '' : ' — set JARVIS_ALLOW_WRITES=1 to permit shell/file/device actions'),
)
console.log(`[jarvis] computer tools in: ${PC_ROOTS.join('; ')}`)
void CAL.status().then((s) =>
  console.log(
    `[jarvis] google calendar ${s.connected ? `connected (${s.timeZone})` : 'not connected — npm run calendar:connect'}` +
      `, writes ${s.writes ? 'enabled' : 'disabled — set JARVIS_CALENDAR_WRITES=1 to allow'}`,
  ),
)
// Asynchronous, so it lands a beat after the rest of the banner. Worth printing
// at all because an extension that is simply not running is indistinguishable
// at the tool boundary from one that is broken, and this is the one place the
// difference can be stated before anybody asks a question that depends on it.
void chromeAvailable().then((ok) => {
  console.log(
    ok
      ? `[jarvis] browser control ready${ALLOW_WRITES ? '' : ' (reading only — clicking and typing need JARVIS_ALLOW_WRITES=1)'}`
      : '[jarvis] browser control unavailable — open Chrome with the Claude extension enabled',
  )
})

console.log(
  '[jarvis] accepting local dev origins' +
    (EXTRA_ORIGINS.size ? ` plus ${[...EXTRA_ORIGINS].join(', ')}` : '') +
    (ALLOW_NO_ORIGIN ? ' and clients that send no origin' : ''),
)

/** What to tell the browser when a turn ends badly, by result subtype (failures.mjs). */
const RESULT_FAILURES = resultFailures(LANG)

/** What a turn's result means, for every socket (turnResult.mjs). */
const turnOutcome = createTurnOutcome({ accounts: ACCOUNTS, lang: LANG, failures: RESULT_FAILURES, noLogin })

/**
 * The fallback channel for the usage limit — see fallback.mjs. Null unless it
 * is configured in full; one budget for the whole bridge, like the limit.
 */
const FALLBACK = (() => {
  const conf = fallbackConfig()
  if (!conf.ok) {
    if (conf.reason) console.warn(`[jarvis] fallback channel off: ${conf.reason}`)
    return null
  }
  const { cfg } = conf
  const note =
    LANG === 'ru'
      ? '\n\nСейчас ты отвечаешь через резервный канал: инструментов нет — ни поиска, ни экрана, ни браузера, ни календаря, ни компьютера. Ничего не делай и не говори, что сделал. Если для ответа нужно действие или свежие данные, скажи одной фразой, что сейчас это недоступно.'
      : '\n\nYou are answering through the fallback channel: you have no tools — no search, no screen, no browser, no calendar, no computer. Do nothing and never say you did. If the answer needs an action or fresh data, say in one line that it is unavailable right now.'
  const channel = createFallback({
    cfg,
    system: SYSTEM_PROMPT + note,
    budget: createBudget({ limitUsd: cfg.budgetUsd, store: fileStore(join(homedir(), '.jarvis', 'fallback-spend.json')) }),
    log: (line) => console.log(line),
  })
  console.log(`[jarvis] fallback channel on: ${cfg.model}, up to $${cfg.budgetUsd} a day, text only`)
  return channel
})()

/**
 * The agent's environment: what Claude Code needs and nothing of the
 * bridge's — no Deepgram or ElevenLabs key, no fallback key, no JARVIS_*
 * setting. A list of what is passed rather than of what is held back, so a key
 * added later stays here by default. See secrets.mjs.
 */
const AGENT_ENV = agentEnv(process.env)

wss.on('connection', (socket, req) => {
  // Streaming recognition shares the port and the Origin check, not the agent.
  if ((req.url ?? '/').split('?')[0] === STT_PATH) {
    return sttProxy.accept(socket, new URL(req.url ?? '/', 'http://bridge').searchParams.get('why') ?? '')
  }
  console.log('[jarvis] client connected')

  // Answer the HUD straight away rather than making it wait for the agent's
  // first turn. Refined later by the real init message.
  socket.send(
    JSON.stringify({ type: 'ready', servers: Object.keys(MCP_SERVERS) }),
  )

  /**
   * This connection's state: its session, the turn in flight and what the
   * page has been told — one object per socket, read and written by every
   * part of the handler below (socketState.mjs).
   */
  const s = createSocketState({ effort: EFFORT, account: ACCOUNTS.pick() ?? 'primary' })




  const send = (msg) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg))
  }

  /**
   * A frame for the question the agent is answering, tagged with its id.
   *
   * The stream carries no notion of a turn, so without the tag the client
   * cannot tell the tail of an abandoned answer from the start of the new one.
   * Echoing the id the client sent lets it ignore anything that is not its
   * own. turns.mjs owns which question that is, and drops frames that belong
   * to none — an untagged frame is read by whichever listener is attached.
   */
  const sendTurn = (msg) => turns.frame(msg)

  /**
   * Asking the browser for something and waiting for the answer — the camera's
   * frame, correlated by id and timed out (pageRequests.mjs).
   */
  const { ask, reply: replied } = createPageRequests({ socket, send })

  /** Closes each text block of an answer with a space — see turnText.mjs. */
  const blockJoin = createBlockJoin()

  /**
   * How long a stopped turn may take to report its `result` before the session
   * is replaced. Waiting on session.interrupt() alone is not enough — it
   * resolves when the agent has been told to stop, not when it has — and while
   * the session is still starting up interrupt() does not stop the turn at all.
   * Measured both ways: the abandoned answer's tail landed on the next
   * question. So the next question waits for the result, and a turn that never
   * reports one costs a session restart, never a wedged conversation.
   */
  const TURN_WAIT_CAP_MS = 30_000

  const turnSeconds = () => (s.turnStartedAt ? ((Date.now() - s.turnStartedAt) / 1000).toFixed(1) : '?')

  const latReport = (outcome) => {
    if (!s.lat) return
    const end = performance.now()
    console.log(latencyLine(s.lat, outcome, end))
    s.lat = null
  }

  /**
   * Announcing a tool on the HUD, once, and only if it actually runs
   * (toolBadge.mjs). The names also go on the turn's log line.
   */
  const { announceTool, settleTool, clear: clearTools } = createToolBadge({
    decideTool,
    show: (name) => sendTurn({ type: 'tool', name }),
    called: (name) => s.turnTools.push(name),
  })

  /** This connection, as resumable.mjs knows it: ended if another socket resumes its session. */
  const owner = { close: () => socket.close(4002, 'resumed elsewhere') }

  // What goes into the session with each question — the question with the
  // asides and notes it carries, its effort set first (sessionInput.mjs).
  const userMessages = createSessionInput({
    s,
    sendTurn,
    knowledge: KNOWLEDGE,
    lang: LANG,
    routeEffort: ROUTE_EFFORT,
    trace: TRACE,
    chromeAvailable,
  })

  // The session itself — opened, started, moved to another login, restarted,
  // replaced to resume — on this socket's state (sessionLifecycle.mjs). How it
  // is opened is the bridge's: its servers, prompt, model and login.
  const {
    startSession,
    switchTo,
    restart: restartSession,
    replace,
  } = createSessionLifecycle({
    s,
    open: (resume) =>
      query({
        prompt: userMessages(s.chan),
        options: sessionOptions({
          resume,
          mcpServers: sessionServers({
            configured: MCP_SERVERS,
            send,
            // Drawn only for a turn still wanted; a panel only when this question asked to see.
            live: () => turns.live(),
            mayShow: () => s.turnMayShow,
            ask,
            allowWrites: ALLOW_WRITES,
            pcRoots: PC_ROOTS,
            ym: YM,
            cal: CAL,
          }),
          disallowedTools: DISALLOWED_BUILTINS,
          systemPrompt: SYSTEM_PROMPT,
          cwd: homedir(),
          model: MODEL,
          effort: EFFORT,
          env: ACCOUNTS.env(s.account, { ...AGENT_ENV, ENABLE_TOOL_SEARCH: 'false' }),
          canUseTool,
        }),
      }),
    pump: (q, gen) => pump(q, gen),
    accounts: ACCOUNTS,
    effort: EFFORT,
    waitCapMs: TURN_WAIT_CAP_MS,
    // What a restart leaves behind of the stuck turn: reported, and reset.
    endStuckTurn: () => {
      latReport('stuck')
      s.turnStartedAt = 0
      s.turnTools = []
      s.turnApiError = null
      clearTools()
    },
  })

  /**
   * The turn queue — see turns.mjs. `primary` is this connection's agent
   * session; the fallback, when there is one, is shared by the whole bridge.
   */
  const turns = createTurns({
    send,
    say: {
      // Worded as the frame it goes in: not "the limit" on the frame for logins set aside.
      fallbackDown: (kind, frame) => fallbackDownMessage(kind, LANG, { limited: frame?.kind !== 'service' }),
      limitMidTurn: () => limitMidTurnMessage(LANG),
    },
    waitCapMs: TURN_WAIT_CAP_MS,
    // One more try per other login, never on one the question has been on (turns.mjs).
    maxSwitches: ACCOUNTS.labels().length - 1,
    primary: {
      hand(turn) {
        const { text, asides, lat: received } = turn.item
        s.lat = received
        s.lat.start = performance.now()
        s.turnStartedAt = Date.now()
        s.turnTools = []
        s.turnApiError = null
        s.chan.put({ text, asides })
      },
      interrupt: () => s.session?.interrupt?.(),
      /**
       * The stopped turn never ended. Its session is closed and its stream
       * ignored from here on (sessionGen), and a new session picks the
       * conversation up from the transcript, so nothing of the stuck turn can
       * reach the next question.
       */
      restart: () => restartSession(),
      // Between turns: the first login not held off — the primary again once its time is up.
      atBoundary() {
        const to = ACCOUNTS.pick()
        if (to && to !== s.account) switchTo(to, ACCOUNTS.held(s.account) ? `${s.account} held off` : `${to} back`)
      },
      // The login this connection's session is on, for the turn's list of logins tried.
      account: () => s.account,
      // After a limit: the next login that is free and this question has not been on.
      switchAccount(tried) {
        const to = ACCOUNTS.pick(Date.now(), tried)
        if (!to || to === s.account) return false
        switchTo(to, `${s.account} limited`)
        return to
      },
      // Every login held off — at its limit, or set aside — and none back yet: no request against them.
      pausedFrame() {
        const blocked = ACCOUNTS.blocked()
        if (!blocked) return null
        console.log(
          `[jarvis] ${blocked.limited ? 'usage limit' : 'no login free'} until ${new Date(blocked.until).toLocaleTimeString()}` +
            (ACCOUNTS.switchable() ? ' on every login' : '') +
            (FALLBACK ? ' — question goes to the fallback' : ' — question not sent'),
        )
        return noLogin(blocked.clock, blocked)
      },
    },
    fallback: FALLBACK && {
      ready: () => FALLBACK.ready(),
      // The fallback has no session, so it is given every aside the page sent.
      answer: ({ item, ...rest }) =>
        FALLBACK.answer({
          prompt: withAside(item.text, item.asides?.length ? formatAsides(item.asides, LANG) : null),
          ...rest,
        }),
    },
    log(event, turn, detail) {
      const id = String(turn?.id).slice(0, 12)
      if (event === 'superseded') {
        if (TRACE) console.log(`[jarvis] ask ${id} superseded while waiting — not sent`)
        const recv = turn.item?.lat?.recv
        console.log(`[latency] ask=${id} superseded effort=- queue=${ms(recv, performance.now())}ms total=${ms(recv, performance.now())}ms`)
      } else if (event === 'account-switch') {
        console.log(`[jarvis] ask ${id} asked again on login ${s.account}`)
      } else if (event === 'fallback') {
        console.log(`[jarvis] ask ${id} → fallback channel (${FALLBACK?.model})`)
      } else if (event === 'fallback-skipped' || event === 'fallback-failed') {
        console.warn(`[jarvis] ask ${id}: fallback ${event === 'fallback-skipped' ? 'not used' : 'failed'} (${detail})`)
      } else if (event === 'stuck') {
        console.warn(`[jarvis] ask ${id} did not end after it was stopped`)
      } else if (event === 'stale-result' && TRACE) {
        console.log('[jarvis] result with no turn on the floor — dropped')
      }
    },
  })

  // Pump a session's output stream to the browser for as long as it is the live
  // one (sessionStream.mjs). Made once the turn queue exists; sessions are only
  // started after that.
  const pump = createSessionStream({
    s,
    turns,
    send,
    sendTurn,
    blockJoin,
    announceTool,
    settleTool,
    turnOutcome,
    latReport,
    clearTools,
    turnSeconds,
    resumable: RESUMABLE,
    owner,
    redact: redactSecrets,
    closeSocket: () => socket.close(),
  })

  startSession()

  socket.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }

    // A diagnostic breadcrumb from the page. Whitelisted shape, every field
    // truncated, so nothing the page sends can flood or forge the log.
    // (turnLog.mjs)
    if (msg.type === 'trace') {
      recordTrace(msg, { on: TRACE, dialog: DIALOG_LOG, turnLog: TURN_LOG })
      return
    }

    // The page asking whether this socket still reaches us: after a VPN or
    // network switch it can be open in name only (src/lib/redial.ts).
    if (msg.type === 'ping') {
      send({ type: 'pong' })
      return
    }

    if (msg.type === 'ask' && typeof msg.text === 'string' && TRACE) {
      console.log(
        `[jarvis] ask ${String(msg.id).slice(0, 12)} received (${msg.text.length} chars)` +
          (DRY_ASK ? ' — DRY, Claude not called' : ''),
      )
    }

    // The same frames a real turn produces, minus the model.
    if (msg.type === 'ask' && typeof msg.text === 'string' && DRY_ASK) {
      const id = typeof msg.id === 'string' ? msg.id : null
      setTimeout(() => {
        send({ type: 'text', delta: DRY_REPLY, ask: id })
        send({ type: 'done', text: DRY_REPLY, costUsd: 0, ask: id })
      }, 1500)
      return
    }

    // The page is back after its socket dropped and wants its conversation.
    // Only before anything is asked here, and only a session this bridge
    // handed out, to this login, within its time (resumable.mjs). Otherwise
    // the fresh session stays and the page is told so — nothing is replayed.
    if (msg.type === 'resume') {
      let verdict = s.asked ? { ok: false, reason: 'already-asking' } : RESUMABLE.check(msg.id, s.account)
      // Claude Code resumes from the transcript on disk; without it there is nothing to resume.
      if (verdict.ok) {
        const dir = ACCOUNTS.env(s.account, { ...AGENT_ENV }).CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
        if (!existsSync(transcriptPath(dir, homedir(), msg.id))) verdict = { ok: false, reason: 'no-transcript' }
      }
      if (!verdict.ok) {
        console.log(`[jarvis] resume refused (${verdict.reason}) — new conversation`)
        send({ type: 'resumed', ok: false })
        return
      }
      // The old socket the server has not yet seen die: end it, so two sockets never share one session.
      if (verdict.holder && verdict.holder !== owner) verdict.holder.close()
      const wanted = msg.id
      const gen = replace(wanted)
      RESUMABLE.issue(wanted, s.account, owner)
      // Said only once the resumed session has actually started. If it will not
      // (a transcript that does not load), the page gets a fresh session and is
      // told so — unless a question has meanwhile gone into this one, which then
      // fails on its own and says why.
      void Promise.resolve(s.session?.initializationResult?.()).then(
        () => {
          if (s.closed || gen !== s.sessionGen) return
          console.log(`[jarvis] conversation resumed after reconnect${ACCOUNTS.switchable() ? ` (${s.account})` : ''}`)
          send({ type: 'resumed', ok: true })
        },
        (err) => {
          if (s.closed || gen !== s.sessionGen) return
          console.warn(`[jarvis] resume failed (${String(err?.message ?? err).slice(0, 80)}) — new conversation`)
          if (!s.asked) replace(null)
          send({ type: 'resumed', ok: false })
        },
      )
      return
    }

    if (msg.type === 'ask' && typeof msg.text === 'string') {
      s.asked = true
      // Each question keeps the session resumable for another thirty minutes.
      if (s.sessionId) RESUMABLE.issue(s.sessionId, s.account, owner)
      // Waits for the floor in turns.mjs: the turn before it is stopped and
      // has to report its end first, or its last tokens land on this one.
      // Measured before that wait existed: ask "one", interrupt, ask "two",
      // and the answer to "two" came back as "One."
      const id = typeof msg.id === 'string' ? msg.id : null
      turns.ask(id, { text: msg.text, asides: asidesFrom(msg.asides), lat: latNew(id) })
    }

    if (msg.type === 'reply' && typeof msg.id === 'string') {
      replied(msg)
    }

    if (msg.type === 'interrupt') {
      if (TRACE) console.log('[jarvis] interrupt received')
      // Stops the turn on the floor, primary or fallback, and drops any
      // question still waiting behind it.
      turns.interrupt()
    }
  })

  // The code says who ended it: 1001 is the page reloading or closing, 1006 a
  // connection lost without a goodbye, 1000 a deliberate close.
  socket.on('close', (code) => {
    console.log(`[jarvis] client disconnected (code ${code})`)
    s.closed = true
    // The conversation stays resumable for a while: a phone whose screen went off comes back.
    if (s.sessionId) RESUMABLE.release(s.sessionId, owner)
    // Aborts a fallback answer in flight: nobody is left to hear it.
    turns.close()
    s.chan.close()
    s.session?.close?.()
  })
})
