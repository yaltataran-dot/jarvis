/**
 * Types for protocol.mjs — the page–bridge protocol. See that file.
 */
import type { Blade, Panel } from './ui'

export declare const PAGE_FRAMES: Readonly<{
  ASK: 'ask'
  INTERRUPT: 'interrupt'
  REPLY: 'reply'
  RESUME: 'resume'
  PING: 'ping'
  TRACE: 'trace'
}>

export declare const BRIDGE_FRAMES: Readonly<{
  READY: 'ready'
  SESSION: 'session'
  RESUMED: 'resumed'
  TEXT: 'text'
  TOOL: 'tool'
  EFFORT: 'effort'
  DONE: 'done'
  ERROR: 'error'
  RETRY: 'retry'
  PANEL: 'panel'
  BLADE: 'blade'
  UI: 'ui'
  CAPTURE: 'capture'
  PONG: 'pong'
}>

export declare const ERROR_KINDS: Readonly<{ RATE: 'rate'; SERVICE: 'service' }>

export declare const STT_MESSAGES: Readonly<{ READY: 'ready'; RESULT: 'r'; UTTERANCE_END: 'u'; ERROR: 'err' }>

export declare const STT_CLOSE: Readonly<{
  NORMAL: 1000
  TOO_LARGE: 1009
  CLIENT_ERROR: 1011
  SESSION_LIMIT: 4000
  REPLACED: 4001
  AUDIO_BLOCKED: 4010
  CAPTURE_FAILED: 4011
  WORKLET_STALLED: 4012
  AUDIO_STALLED: 4013
  IDLE: 4408
  UPSTREAM: 4502
  NO_KEY: 4503
}>

export declare const PAGE_CLOSE_RANGE: Readonly<{ MIN: 4000; MAX: 4099 }>

export type PageFrameType = (typeof PAGE_FRAMES)[keyof typeof PAGE_FRAMES]
export type BridgeFrameType = (typeof BRIDGE_FRAMES)[keyof typeof BRIDGE_FRAMES]
export type ErrorKind = (typeof ERROR_KINDS)[keyof typeof ERROR_KINDS]

/**
 * Anything the bridge sends on the agent socket. Deliberately loose — a frame
 * from a future bridge build should be ignored, not crash the turn. (Moved
 * from src/lib/bridge.ts, where it was `Frame`.)
 *
 * `type` is typed as the known names so the compiler rejects a comparison with
 * a misspelt one; at run time an unknown name still arrives, matches nothing
 * and is ignored, as before.
 */
export type BridgeFrame = {
  type?: BridgeFrameType
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

/** What the bridge sends on `/stt-stream`. Anything else is ignored. (Moved from src/lib/deepgramVoice.ts.) */
export type SttMessage =
  | { t: 'ready' }
  | { t: 'r'; text: string; final: boolean; speech: boolean }
  | { t: 'u' }
  | { t: 'err' }
