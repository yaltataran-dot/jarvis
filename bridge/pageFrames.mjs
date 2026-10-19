import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { transcriptPath } from './resumable.mjs'
import { asidesFrom } from './turnText.mjs'
import { latNew } from './latency.mjs'
import { recordTrace } from './turnLog.mjs'

/**
 * The page's frames on one agent socket, as they arrive: a trace breadcrumb
 * logged, a ping answered, a question handed to the turn queue (or, in DRY
 * mode, answered without the model), a resume of a session this bridge handed
 * out checked and started, a reply to the bridge's own request, an interrupt.
 * Moved out of server.mjs's connection handler unchanged; it works on the
 * socket's state (`s`), with what it called passed in.
 *
 * @param {{
 *   s: ReturnType<typeof import('./socketState.mjs').createSocketState>,
 *   send: (frame: object) => void,
 *   turns: ReturnType<typeof import('./turns.mjs').createTurns>,
 *   replace: (resume: string | null) => number,
 *   replied: (msg: object) => void,
 *   owner: { close(): void },
 *   resumable: ReturnType<typeof import('./resumable.mjs').createResumable>,
 *   accounts: ReturnType<typeof import('./accounts.mjs').createAccounts>,
 *   agentEnv: Record<string, string>,
 *   trace: boolean,
 *   dialogLog: boolean,
 *   turnLog: unknown,
 *   dryAsk: boolean,
 *   dryReply: string,
 * }} o
 * @returns {(raw: { toString(): string }) => void}
 */
export function createPageFrames({ s, send, turns, replace, replied, owner, resumable, accounts, agentEnv, trace, dialogLog, turnLog, dryAsk, dryReply }) {
  return (raw) => {
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
      recordTrace(msg, { on: trace, dialog: dialogLog, turnLog })
      return
    }

    // The page asking whether this socket still reaches us: after a VPN or
    // network switch it can be open in name only (src/lib/redial.ts).
    if (msg.type === 'ping') {
      send({ type: 'pong' })
      return
    }

    if (msg.type === 'ask' && typeof msg.text === 'string' && trace) {
      console.log(
        `[jarvis] ask ${String(msg.id).slice(0, 12)} received (${msg.text.length} chars)` +
          (dryAsk ? ' — DRY, Claude not called' : ''),
      )
    }

    // The same frames a real turn produces, minus the model.
    if (msg.type === 'ask' && typeof msg.text === 'string' && dryAsk) {
      const id = typeof msg.id === 'string' ? msg.id : null
      setTimeout(() => {
        send({ type: 'text', delta: dryReply, ask: id })
        send({ type: 'done', text: dryReply, costUsd: 0, ask: id })
      }, 1500)
      return
    }

    // The page is back after its socket dropped and wants its conversation.
    // Only before anything is asked here, and only a session this bridge
    // handed out, to this login, within its time (resumable.mjs). Otherwise
    // the fresh session stays and the page is told so — nothing is replayed.
    if (msg.type === 'resume') {
      let verdict = s.asked ? { ok: false, reason: 'already-asking' } : resumable.check(msg.id, s.account)
      // Claude Code resumes from the transcript on disk; without it there is nothing to resume.
      if (verdict.ok) {
        const dir = accounts.env(s.account, { ...agentEnv }).CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
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
      resumable.issue(wanted, s.account, owner)
      // Said only once the resumed session has actually started. If it will not
      // (a transcript that does not load), the page gets a fresh session and is
      // told so — unless a question has meanwhile gone into this one, which then
      // fails on its own and says why.
      void Promise.resolve(s.session?.initializationResult?.()).then(
        () => {
          if (s.closed || gen !== s.sessionGen) return
          console.log(`[jarvis] conversation resumed after reconnect${accounts.switchable() ? ` (${s.account})` : ''}`)
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
      if (s.sessionId) resumable.issue(s.sessionId, s.account, owner)
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
      if (trace) console.log('[jarvis] interrupt received')
      // Stops the turn on the floor, primary or fallback, and drops any
      // question still waiting behind it.
      turns.interrupt()
    }
  }
}
