/**
 * The page–bridge protocol: the names and numbers both sides must agree on.
 *
 * Plain JavaScript so the bridge (Node, no build step) imports it at run time
 * and the page (Vite) bundles it; the types are in protocol.d.mts. Every value
 * here is what was already on the wire — this file names them, it does not
 * change them. tests/protocol.test.ts checks what the bridge really sends and
 * what the page really reads against it.
 *
 * Two sockets on the bridge's port:
 *   `/`            the agent socket: one Claude Agent SDK session per socket,
 *                  JSON frames `{type, ...}` both ways;
 *   `/stt-stream`  recognition: binary 16 kHz mono PCM16 up, JSON `{t, ...}` down.
 */

/** Frames the page sends on the agent socket. */
export const PAGE_FRAMES = Object.freeze({
  ASK: 'ask',
  INTERRUPT: 'interrupt',
  /** The answer to a bridge request (`capture`), by its id. */
  REPLY: 'reply',
  RESUME: 'resume',
  PING: 'ping',
  TRACE: 'trace',
})

/** Frames the bridge sends on the agent socket. */
export const BRIDGE_FRAMES = Object.freeze({
  READY: 'ready',
  SESSION: 'session',
  RESUMED: 'resumed',
  TEXT: 'text',
  TOOL: 'tool',
  EFFORT: 'effort',
  DONE: 'done',
  ERROR: 'error',
  RETRY: 'retry',
  PANEL: 'panel',
  BLADE: 'blade',
  UI: 'ui',
  /** The one request the bridge makes of the page; answered with `reply`. */
  CAPTURE: 'capture',
  PONG: 'pong',
})

/** `kind` on an `error` frame: why a turn failed, when it is not a fault of his own. */
export const ERROR_KINDS = Object.freeze({
  /** The usage limit; `resetAt` says when it lifts. */
  RATE: 'rate',
  /** Trouble outside JARVIS: the network, a VPN, the service. */
  SERVICE: 'service',
})

/** Messages the bridge sends on `/stt-stream` (`t`). */
export const STT_MESSAGES = Object.freeze({
  READY: 'ready',
  /** A Deepgram Results message, reduced to `{text, final, speech}`. */
  RESULT: 'r',
  UTTERANCE_END: 'u',
  ERROR: 'err',
})

/** Close codes on `/stt-stream`. */
export const STT_CLOSE = Object.freeze({
  NORMAL: 1000,
  /** The bridge: a frame, or the session's audio in all, was too large. */
  TOO_LARGE: 1009,
  /** The page's socket errored. */
  CLIENT_ERROR: 1011,
  /** The bridge: the session reached its time limit. */
  SESSION_LIMIT: 4000,
  /** The bridge: a newer session replaced this one (at most three at once). */
  REPLACED: 4001,
  /** The page: the browser would not start the audio. */
  AUDIO_BLOCKED: 4010,
  /** The page: the capture could not be started. */
  CAPTURE_FAILED: 4011,
  /** The page: the capture's worklet did not load in time. */
  WORKLET_STALLED: 4012,
  /** The page: a running capture stopped delivering. */
  AUDIO_STALLED: 4013,
  /** The bridge: no audio for too long. */
  IDLE: 4408,
  /** The bridge: Deepgram could not be reached, failed, or closed the session. */
  UPSTREAM: 4502,
  /** The bridge: no usable Deepgram key, so nothing is dialled. */
  NO_KEY: 4503,
})

/** A close code in this range is the page saying why; the bridge logs it as given, anything else as NORMAL. */
export const PAGE_CLOSE_RANGE = Object.freeze({ MIN: 4000, MAX: 4099 })
