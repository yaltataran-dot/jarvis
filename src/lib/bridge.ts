import type { AskHandlers } from './anthropic'
import type { AsideItem } from './aside'
import type { Blade, Panel } from '../store'
import { BRIDGE_WS_URL, LANG } from '../config'
import { makeTurnLog } from './turnLog'
import { createResumeClient } from './resume'
import { createLink } from './redial'
import { setTraceSink } from './trace'

/** The page's own failure sentences, in the language he answers in. */
const SAY =
  LANG === 'ru'
    ? {
        quiet: 'Мост замолчал — ответ потерян. Повторите вопрос.',
        tooLong: 'Ответ так и не пришёл за три минуты. Запрос остановлен.',
        reported: 'Мост сообщил об ошибке.',
        closed: 'Связь с мостом прервалась посреди ответа.',
        failed: 'Не удалось связаться с мостом.',
      }
    : {
        quiet: 'The bridge went quiet — that turn was lost, sir.',
        tooLong: 'No answer came in three minutes. The turn was stopped.',
        reported: 'The bridge reported an error.',
        closed: 'The bridge disconnected mid-answer — that session is gone.',
        failed: 'The connection to the bridge failed.',
      }

/**
 * Client for the local bridge (see bridge/server.mjs).
 *
 * Same `ask()` shape as the browser-direct path, so App.tsx doesn't care which
 * brain is behind it. The difference is what's reachable: this one runs on your
 * machine, so every MCP server in your Claude Code config is in play.
 *
 * The socket is the session. The bridge holds one Claude Agent SDK query per
 * connection and the whole conversation lives inside it, so a dropped socket
 * silently wipes JARVIS's memory of the exchange while the transcript on screen
 * still shows it. That is why the reconnect below is loud rather than
 * invisible: `watchConnection` exists so the HUD can say so.
 */

const TRACE = import.meta.env.VITE_TRACE === '1'

/**
 * A diagnostic breadcrumb, off unless VITE_TRACE=1. Goes to the console and,
 * over the open socket, into the bridge's own log, so a silent drop shows up
 * in the terminal. Callers pass step names, lengths and short prefixes only.
 */
export function trace(step: string, info: Record<string, string | number | boolean> = {}): void {
  if (!TRACE) return
  turnLog.event(step, info)
}

const DIALOG_LOG = import.meta.env.VITE_DIALOG_LOG === '1'

/**
 * Stamps each step with its turn id and delay, and checks the stream for
 * duplicates, hung asks and missed stops (turnLog.ts). Dialogue words are
 * stripped unless VITE_DIALOG_LOG=1. Ready on `window.__turnlog`.
 */
const turnLog = makeTurnLog({
  dialog: DIALOG_LOG,
  out: (e) => {
    const info = { tid: e.tid, dt: e.dt, ...e.info }
    console.info('[jarvis:trace]', e.step, info)
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'trace', step: e.step, info, at: e.t }))
    }
  },
})
if (TRACE && typeof window !== 'undefined') (window as unknown as { __turnlog?: unknown }).__turnlog = turnLog
// Breadcrumbs from modules that do not import the transport (trace.ts) come here too.
setTraceSink(trace)

/** Anything the bridge sends. Deliberately loose — a frame from a future
 *  bridge build should be ignored, not crash the turn. */
type Frame = {
  type?: string
  delta?: string
  name?: string
  text?: string
  message?: string
  panel?: Panel
  blade?: Blade
  op?: string
  args?: unknown
  id?: string
  ask?: string
  reason?: string
  mode?: string
  seconds?: number
  when?: string
  servers?: Array<string | { name?: string }>
  attempt?: number
  status?: number | null
  level?: string
  /** On an error: 'rate' for the usage limit, 'service' for another cause
   *  outside JARVIS (network, VPN, the service); absent for a fault. */
  kind?: string
  /** On a usage-limit error: when it lifts, as wall-clock "22:50". */
  resetAt?: string | null
  /** On `resumed`: whether the bridge gave the conversation back. */
  ok?: boolean
}

/**
 * A turn that failed for a reason outside JARVIS — the usage limit, the
 * network, the service — rather than a fault of his own. The page shows the
 * message but does not put the core into its error state for it.
 *
 * 'link' is the connection itself going under the question — a VPN or network
 * switch — after the page had been connected: the socket is being redialled
 * already, so it is shown as part of the reconnect (linkStatus.ts), not as a
 * failure.
 */
export class ServiceError extends Error {
  readonly kind: 'rate' | 'service' | 'link'
  readonly resetAt: string | null

  constructor(message: string, kind: 'rate' | 'service' | 'link', resetAt: string | null = null) {
    super(message)
    this.name = 'ServiceError'
    this.kind = kind
    this.resetAt = resetAt
  }
}

/** Every question gets an id so its answer can be told from anyone else's. */
let askSeq = 0

/** The live socket, kept in step with the link below (redial.ts). */
let socket: WebSocket | null = null

/** Server names reported by the bridge, for the HUD readout. */
let servers: string[] = []
export const bridgeServers = () => servers

/** The list arrives twice — once from config, once with live status — so the
 *  HUD subscribes rather than reading it a single time at boot. */
let onServers: ((s: string[]) => void) | null = null
export function watchServers(fn: (s: string[]) => void) {
  onServers = fn
}

/** Panels arrive out of band — they're pushed while a turn is in flight,
 *  not returned by it. */
let onPanel: ((panel: Panel) => void) | null = null
export function watchPanels(fn: (panel: Panel) => void) {
  onPanel = fn
}

/**
 * The one request the bridge makes of us rather than the other way round.
 *
 * Everything else on this socket is pushed at the browser and needs no answer.
 * A camera frame has to travel back, so this handler is registered by the app
 * and its result is returned against the request's id.
 */
export type CaptureRequest = {
  /** 'look' for a single frame, 'watch' for a grid over time. */
  mode: 'look' | 'watch'
  reason: string
  seconds: number
  /** 'now' records forward; 'past' reads the rolling buffer. */
  when: 'now' | 'past'
}
export type CaptureResult = { data?: string; mimeType?: string; error?: string }

let onCapture: ((req: CaptureRequest) => Promise<CaptureResult>) | null = null
export function watchCapture(fn: (req: CaptureRequest) => Promise<CaptureResult>) {
  onCapture = fn
}

/** Blades arrive the same way panels do — pushed mid-turn, so the article is
 *  already open as he starts the sentence about it. */
let onBlade: ((blade: Blade) => void) | null = null
export function watchBlades(fn: (blade: Blade) => void) {
  onBlade = fn
}

/** Commands that redress the interface — theme, reactor, orbits, effects. Same
 *  out-of-band route as panels: JARVIS issues them while he is still mid-answer
 *  so the change is on screen as he says it, which means they cannot ride back
 *  on the turn's result. The op/args pair stays untyped here on purpose — this
 *  module is a transport, and the store is where the shape is decided. */
let onUi: ((op: string, args: any) => void) | null = null
export function watchUi(fn: (op: string, args: any) => void) {
  onUi = fn
}

/**
 * Connection state, for the UI.
 *
 *   'open'        — first connection of the page.
 *   'lost'        — the socket died.
 *   'resumed'     — we're back, and the bridge gave the conversation back
 *                   (resume.ts): he remembers what was said.
 *   'reconnected' — we're back, on a fresh session with no memory of the above.
 *   'down'        — the quick retries ran out and it is still not back. A page
 *                   on screen keeps trying now and then (redial.ts).
 *
 * With 'resumed' and 'reconnected', `interrupted` says a question was in
 * flight when the socket died: it was not asked again, and may not have
 * finished.
 */
export type ConnectionState = 'open' | 'lost' | 'resumed' | 'reconnected' | 'down'
export type ConnectionDetail = { interrupted: boolean }
let onConnection: ((state: ConnectionState, detail?: ConnectionDetail) => void) | null = null
export function watchConnection(fn: (state: ConnectionState, detail?: ConnectionDetail) => void) {
  onConnection = fn
}

/** Asks for the conversation back on a reconnect — see resume.ts. */
const resumer = createResumeClient({
  send: (frame) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame))
  },
  report: ({ resumed, interrupted }) => onConnection?.(resumed ? 'resumed' : 'reconnected', { interrupted }),
})

export function isConnected(): boolean {
  return socket?.readyState === WebSocket.OPEN
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** Resolved by the socket-level dispatcher on the first `ready` of the current
 *  connection. Re-armed per connection so a reconnect re-announces. */
let firstReady = deferred()

let everConnected = false

/**
 * Make sure the connection is alive: dial now, with a fresh set of retries, if
 * there is no live socket, or ask an open one for a sign of life.
 *
 * For the page coming back to the screen or the network coming back: a phone
 * that was out of signal for longer than the backoff had given up, and stayed
 * disconnected until the next question. And a socket can be open in name
 * only — a VPN switched on under it — so an open one is checked rather than
 * trusted (redial.ts). Does nothing while a dial is already under way.
 */
export function reconnectNow(): void {
  link.check()
}

/**
 * One message listener per socket, owning everything that isn't part of a
 * turn. It used to live inside warmBridge, bound to that one socket: after any
 * reconnect the SYSTEM rail froze for the life of the page, and every extra
 * warmBridge() call leaked another listener onto the same socket.
 */
function dispatch(ws: WebSocket) {
  ws.addEventListener('message', (e: MessageEvent) => {
    let msg: Frame
    try {
      msg = JSON.parse(e.data as string)
    } catch {
      link.heard(ws)
      return
    }
    // Any frame is a sign of life; a pong is also the bridge saying it answers pings.
    link.heard(ws, msg.type === 'pong')

    if (msg.type === 'ready') {
      // The bridge announces immediately on connect from Claude Code's config,
      // then again with live status once the agent initialises. Keep listening
      // so the later, more accurate list wins.
      servers = (msg.servers ?? [])
        .map((s) => (typeof s === 'string' ? s : (s.name ?? '')))
        .filter(Boolean)
      onServers?.(servers)
      firstReady.resolve()
    } else if (msg.type === 'session') {
      resumer.onSession(msg.id)
    } else if (msg.type === 'resumed') {
      resumer.onResumed(msg.ok)
    } else if (msg.type === 'panel' && msg.panel) {
      onPanel?.(msg.panel)
    } else if (msg.type === 'blade' && msg.blade) {
      onBlade?.(msg.blade)
    } else if (msg.type === 'capture' && msg.id) {
      const id = msg.id
      const reply = (payload: Record<string, unknown>) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'reply', id, ...payload }))
        }
      }
      if (!onCapture) {
        reply({ error: 'The interface has no camera handler.' })
      } else {
        // Always answers, even on failure: the bridge is holding a turn open
        // waiting for this, and a rejection that never arrives is a turn that
        // hangs until the idle timer notices.
        onCapture({
          mode: msg.mode === 'watch' ? 'watch' : 'look',
          reason: msg.reason ?? '',
          seconds: Math.max(2, Math.min(15, Number(msg.seconds) || 6)),
          when: msg.when === 'past' ? 'past' : 'now',
        })
          .then(reply)
          .catch((err) => reply({ error: String(err?.message ?? err) }))
      }
    } else if (msg.type === 'ui' && msg.op) {
      // A `ui` frame with no args is normal — reset and clear take none — so an
      // absent args object is an empty one, not a reason to drop the command.
      onUi?.(msg.op, (msg.args ?? {}) as Record<string, unknown>)
    }
  })
}

/**
 * One dial at a time, and the automatic re-dial after a drop or a failed dial
 * — see redial.ts. The re-dial used to stop after its first failure.
 */
const link = createLink<WebSocket>({
  make: () => new WebSocket(BRIDGE_WS_URL),
  opened: (ws) => {
    socket = ws
    // Re-armed per connection so a reconnect re-announces.
    firstReady = deferred()
    dispatch(ws)
    // A reconnect is reported once the bridge has said whether the conversation came back.
    if (everConnected) resumer.onOpen(true)
    else onConnection?.('open')
    everConnected = true
  },
  lost: (ws) => {
    if (socket === ws) socket = null
    // Read before the turn's own close handler clears it: was a question in flight?
    resumer.onLost(Boolean(pending))
    onConnection?.('lost')
    // A socket dropped for silence may never fire its close: the question on
    // it fails now, as it would on a close, instead of waiting out its timer.
    if (pending?.ws === ws) pending.lost?.()
  },
  ping: (ws) => ws.send(JSON.stringify({ type: 'ping' })),
  visible: () => document.visibilityState !== 'hidden',
  gaveUp: () => onConnection?.('down'),
  failure: (why) => {
    if (why === 'timeout') return new Error('Bridge not responding — is `npm run bridge` running?')
    if (why === 'closed') return new Error('The bridge closed the connection.')
    /**
     * The browser will not tell us why.
     *
     * A refused handshake and a rejected Origin arrive here identically — no
     * status, no reason, just `error` — and the two have completely different
     * fixes. The old message named only one of them, and confidently: it said
     * to start the bridge. When the real cause was the page being served on a
     * port outside the range the bridge trusts, that advice sent everyone to
     * inspect a process that was running perfectly the whole time.
     *
     * So say both, and put the actual port in front of them, since that is
     * the fact that distinguishes the two cases at a glance.
     */
    return new Error(
      `Cannot reach the bridge at ${BRIDGE_WS_URL}. Either it is not ` +
        'running (start it with `npm start`), or this page is on a port it ' +
        `refuses — it accepts localhost:5173-5199 and 4173-4199, and this ` +
        `page is on ${location.port || '80'}.`,
    )
  },
})

function connect(): Promise<WebSocket> {
  return link.connect()
}

/** Open the socket early so the first "Hey Jarvis" isn't waiting on a handshake. */
export async function warmBridge(): Promise<void> {
  await connect()
  // Don't block startup if the bridge never announces — the dispatcher fills
  // the rail in whenever the list does turn up.
  await Promise.race([
    firstReady.promise,
    new Promise<void>((resolve) => setTimeout(resolve, 2500)),
  ])
}

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

/**
 * No frame of any kind for two minutes means the turn is never coming back.
 * Generous on purpose: a long agent run can sit silent through a slow tool,
 * and cutting a real answer off is worse than waiting. What this catches is
 * the case that used to hang forever — the bridge alive but the turn lost.
 */
const IDLE_TIMEOUT_MS = 120_000

/**
 * However lively the bridge, a turn with no end in three minutes is stopped.
 * API retries send a frame each, which keeps the idle timer above fed for as
 * long as Claude Code keeps retrying; this is the ceiling over that.
 */
const TURN_LIMIT_MS = 180_000

/** The turn in flight, so a barge-in can settle it locally. */
let pending: { finish: (fallback?: string) => void; ws?: WebSocket; lost?: () => void } | null = null

export async function ask(
  prompt: string,
  handlers: AskHandlers,
  /** What the page answered by itself (aside.ts) — sent apart from the
   *  question, so the bridge sorts its effort by what was actually asked, and
   *  with their ids, so the bridge can pass on only what its session lacks. */
  asides: AsideItem[] = [],
): Promise<{ text: string; tools: string[] }> {
  /**
   * A new question supersedes the one in flight.
   *
   * Two concurrent turns genuinely would corrupt each other — both listeners
   * see every delta, and the first 'done' resolves both with the other's text —
   * but refusing the new one was the wrong way to prevent that. It surfaced as
   * "JARVIS is already answering", which is a sentence about this module's
   * bookkeeping rather than about anything the user did, and it contradicts the
   * premise the whole app is built on: say something and it becomes the turn.
   *
   * It fired far more than it looked like it should, because the only thing
   * that cleared the slot was a barge-in — and a barge-in only fires in guard
   * mode. A transcript can arrive well after the speech that produced it: the
   * segment queue means several can be waiting, and their onsets happened while
   * the machine was still listening, when nothing interrupts. So the second
   * utterance of a normal sentence could land on a turn that was already
   * running and simply be refused.
   *
   * Cancelling settles the old promise synchronously, so by the time the code
   * below claims the slot there is nothing left to collide with. The abandoned
   * turn's caller sees its own `stale()` check and stands down quietly.
   */
  trace('ask:start', { len: prompt.length, open: socket?.readyState === WebSocket.OPEN })
  if (pending) cancel()

  // Claim the slot in this same tick. connect() below awaits, and two calls
  // made before it settles would otherwise both sail past the check above.
  let cancelledWhileDialling = false
  pending = {
    finish: () => {
      cancelledWhileDialling = true
    },
  }

  let ws: WebSocket
  try {
    ws = await connect()
  } catch (err) {
    pending = null
    trace('ask:connect-failed')
    // Never connected at all is a setup problem and stays one; a page that was
    // connected is between networks, and the redial is on it.
    throw everConnected ? new ServiceError(SAY.failed, 'link') : err
  }

  // Barged in on before the socket was even up. Nothing was ever asked.
  if (cancelledWhileDialling) {
    trace('ask:cancelled-while-dialling')
    pending = null
    return { text: '', tools: [] }
  }

  const id = `a${++askSeq}`
  const tools: string[] = []
  let text = ''

  return new Promise((resolve, reject) => {
    let done = false
    let timer = 0
    let limit = 0

    const cleanup = () => {
      done = true
      pending = null
      clearTimeout(timer)
      clearTimeout(limit)
      ws.removeEventListener('message', onMessage)
      ws.removeEventListener('close', onClose)
      ws.removeEventListener('error', onError)
    }

    const finish = (fallback = '') => {
      if (done) return
      cleanup()
      // Prefer the streamed text; fall back to the final result if this build
      // didn't emit deltas.
      resolve({ text: (text || fallback).trim(), tools })
    }

    const fail = (err: Error) => {
      if (done) return
      cleanup()
      reject(err)
    }

    const arm = () => {
      clearTimeout(timer)
      timer = window.setTimeout(() => {
        fail(new Error(SAY.quiet))
      }, IDLE_TIMEOUT_MS)
    }

    const onMessage = (e: MessageEvent) => {
      // Any frame at all is proof of life, including ones this turn ignores.
      arm()

      let msg: Frame
      try {
        msg = JSON.parse(e.data as string)
      } catch {
        // A frame we can't read is not a reason to abandon the turn. It used
        // to be: the parse threw inside the listener, nothing settled the
        // promise, and App's `busy` flag stayed true for the life of the page.
        return
      }

      /**
       * Somebody else's answer.
       *
       * A superseded turn keeps streaming for a moment after it is abandoned,
       * and this listener is attached to the socket rather than to a turn — so
       * without this check the tail of the old answer is read as the beginning
       * of the new one. Measured before it existed: ask for ALPHA, barge in,
       * ask for BRAVO, and BRAVO's answer came back as "ALPHA".
       */
      if (msg.ask && msg.ask !== id) return

      try {
        switch (msg.type) {
          case 'text':
            if (!text) trace('ask:first-delta')
            text += msg.delta ?? ''
            handlers.onText(msg.delta ?? '')
            break

          case 'tool':
            if (!msg.name) break
            tools.push(msg.name)
            handlers.onTool(prettyToolName(msg.name))
            break

          // How the bridge sorted the question — the page decides from it
          // whether a long wait deserves a word first.
          case 'effort':
            if (msg.level) handlers.onEffort?.(msg.level)
            break

          case 'done':
            finish(msg.text ?? '')
            break

          case 'error':
            fail(
              msg.kind === 'rate' || msg.kind === 'service'
                ? new ServiceError(msg.message ?? SAY.reported, msg.kind, msg.resetAt ?? null)
                : new Error(msg.message ?? SAY.reported),
            )
            break

          // Claude Code retrying a failed API call: nothing to show, but proof
          // the turn is alive — arm() above has already been fed by it.
          case 'retry':
            trace('ask:api-retry', { attempt: msg.attempt ?? 0, status: msg.status ?? 0 })
            break
        }
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)))
      }
    }

    const onClose = () => {
      fail(new ServiceError(SAY.closed, 'link'))
    }
    const onError = () => {
      fail(new ServiceError(SAY.failed, 'link'))
    }

    pending = { finish, ws, lost: onClose }
    ws.addEventListener('message', onMessage)
    ws.addEventListener('close', onClose)
    ws.addEventListener('error', onError)
    arm()
    limit = window.setTimeout(() => {
      // Stop it on the bridge too, so it isn't still paying for the answer.
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'interrupt' }))
      fail(new Error(SAY.tooLong))
    }, TURN_LIMIT_MS)

    try {
      trace('ask:sent', { id })
      ws.send(JSON.stringify({ type: 'ask', text: prompt, id, ...(asides.length ? { asides } : {}) }))
    } catch (err) {
      // The socket can go into CLOSING between connect() resolving and here.
      fail(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

/**
 * Cut JARVIS off mid-answer.
 *
 * Tells the bridge to stop, then settles the in-flight turn here rather than
 * waiting for a 'done' that a barge-in may never produce. Whatever he had
 * already said is returned, so the caller's await always comes back and the
 * transcript keeps the half-sentence the user actually heard.
 */
export function cancel(): void {
  trace('cancel', { pending: Boolean(pending) })
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'interrupt' }))
  }
  pending?.finish()
}

/** The older name for `cancel()`. */
export function interrupt(): void {
  cancel()
}

/** `mcp__higgsfield__generate_image` -> `higgsfield · generate image` */
function prettyToolName(raw: string): string {
  if (!raw.startsWith('mcp__')) return raw
  const [, server, ...rest] = raw.split('__')
  return `${server} · ${rest.join(' ').replace(/_/g, ' ')}`
}
