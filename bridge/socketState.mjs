import { createInbox } from './inbox.mjs'
import { createAsideLedger } from './turnText.mjs'

/**
 * One agent socket's state, as server.mjs's connection handler keeps it: one
 * object per connection, so nothing of one page's session can reach another's.
 * These were the handler's own `let` variables; they are the same values,
 * started the same way, and every part of the handler reads and writes them
 * here instead.
 *
 * @param {{ effort: string, account: string }} o
 *   The bridge's effort level, and the login a new connection starts on
 *   (accounts.mjs: the first not held off).
 */
export function createSocketState({ effort, account }) {
  return {
    /** The socket has closed: nothing more is sent, and no session is started. */
    closed: false,

    /** The questions for the agent session now running, one inbox per session (inbox.mjs). */
    chan: createInbox(),

    /** The effort the session is on now, so it is only changed when it differs. */
    sessionEffort: effort,

    /** Whether this turn's question asked to see something — see visual.mjs. */
    turnMayShow: false,

    /**
     * Which of the page's asides this session has been handed, by id. Per
     * connection, because the socket is the session: a reconnect is a session
     * that has heard none of them, and gets them all.
     */
    asideLedger: createAsideLedger(),

    /** The turn in flight's latency record (latency.mjs), or null between turns. */
    lat: null,

    /**
     * The turn in flight, for the log: when it went in, the tools it called,
     * and any API error reported on an assistant message.
     */
    turnStartedAt: 0,
    turnTools: [],
    turnApiError: null,

    /** The agent session; replaced, with its history resumed, when a turn sticks. */
    session: null,
    /** Which session's stream is the live one; frames from an older one are dropped. */
    sessionGen: 0,
    /** From the init message, so a replacement session keeps the conversation. */
    sessionId: null,

    /** A question has been asked here: from then on this socket's session is its own, not to be swapped. */
    asked: false,

    /** The login this connection's session runs on — see accounts.mjs. */
    account,
  }
}
