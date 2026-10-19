import { createInbox } from './inbox.mjs'
import { createAsideLedger } from './turnText.mjs'
import { ACCOUNT_DOWN_MS } from './turnResult.mjs'

/**
 * One agent socket's session: how it is opened, and how it is started,
 * moved to another login, restarted after a turn that will not end, and
 * replaced to resume a conversation. Moved out of server.mjs's connection
 * handler unchanged; each works on the socket's state (`s`, socketState.mjs),
 * as it did there, with what it called passed in.
 */

/**
 * The options an agent session is opened with. The values are the bridge's
 * (server.mjs builds them for each session); what is fixed, and why, is here.
 *
 * @param {{
 *   resume: string | null,
 *   mcpServers: object,
 *   disallowedTools: string[],
 *   systemPrompt: string,
 *   cwd: string,
 *   model: string,
 *   effort: string,
 *   env: Record<string, string>,
 *   canUseTool: Function,
 * }} o
 */
export function sessionOptions({ resume, mcpServers, disallowedTools, systemPrompt, cwd, model, effort, env, canUseTool }) {
  return {
    ...(resume ? { resume } : {}),
    // Everything Claude Code has configured, plus the bridge's own servers on
    // this socket — built per connection (sessionServers.mjs).
    mcpServers,
    disallowedTools,
    // A plain system prompt, not the claude_code preset. The preset is
    // tuned for a coding agent — verbose, file-oriented, and a large chunk
    // of input tokens on every turn. Replacing it makes the persona stick,
    // keeps answers short enough to speak, and cuts cost per turn.
    systemPrompt,
    // Run from the home directory so project-scoped MCP servers don't shadow
    // the global ones, and so file tools have a sane root.
    cwd,
    // No filesystem settings at all. Left to its default the SDK loads
    // ~/.claude/settings.json and settings.local.json exactly as the CLI
    // does — which on a working machine means a bypassPermissions default
    // and a pile of allow-rules for Bash. Allow-rules are matched before the
    // permission callback, so decideTool below would never even be asked
    // about the tools it most needs to refuse. Empty makes this bridge the
    // only authority. It also stops the global CLAUDE.md riding along on
    // every voice turn, carrying instructions written for a coding agent
    // into a conversation that is meant to be two sentences long.
    //
    // The cost is that MCP servers stop being discovered too, which is why
    // mcpServers above passes them in by hand.
    settingSources: [],
    // Stated explicitly, and it has to be.
    //
    // With no `model` here the SDK falls back to its own default, which on
    // this machine resolved to claude-opus-4-8[1m] — not what src/config.ts
    // declares for the browser-direct path, and not anything anyone chose.
    // Normally your own `/model` preference would decide, but that lives in
    // the settings files `settingSources: []` deliberately stops loading, so
    // without this line nothing in the project has a say at all.
    model,
    effort,
    // Every tool schema up front (ENABLE_TOOL_SEARCH 'false' in env). Left to
    // defer them, Claude Code made the model call ToolSearch to load WebSearch
    // before it could search — a whole extra round trip on the first lookup of
    // every session, measured in the 20 s it took to answer "what's the
    // weather". This set of tools is small enough that deferring them saves
    // nothing. The backup login adds only its own config directory.
    env,
    maxTurns: 24,
    permissionMode: 'default',
    // Without this the SDK only emits whole assistant messages, and JARVIS
    // would sit silent until the entire answer was written. Partial events
    // are what let speech start on the first finished sentence.
    includePartialMessages: true,
    // The last gate, the same decideTool (policy.mjs).
    canUseTool,
  }
}

/**
 * @param {{
 *   s: ReturnType<typeof import('./socketState.mjs').createSocketState>,
 *   open: (resume: string | null) => any,
 *   pump: (q: any, gen: number) => Promise<void>,
 *   accounts: ReturnType<typeof import('./accounts.mjs').createAccounts>,
 *   effort: string,
 *   waitCapMs: number,
 *   endStuckTurn: () => void,
 * }} o
 *   `open` opens an agent session (query() with the bridge's options);
 *   `pump` reads its stream; `endStuckTurn` reports and resets the turn a
 *   restart leaves behind, at the point the restart always did.
 */
export function createSessionLifecycle({ s, open, pump, accounts, effort, waitCapMs, endStuckTurn }) {
  /** A new agent session, live from now on, resuming `resume` when given. */
  const startSession = (resume = null) => {
    const gen = ++s.sessionGen
    const q = open(resume)
    s.session = q
    // Bring the agent up now, while the page is still on its start-up screen,
    // rather than on the first question. Measured on a fresh connection: the
    // first question spent 1.1 s waiting for the session to start before it
    // could even be handed over. The initialize handshake is what it waited for.
    const t0 = performance.now()
    const on = s.account
    const label = accounts.switchable() ? ` (${on})` : ''
    void Promise.resolve(q.initializationResult?.())
      .then(() => console.log(`[jarvis] agent session ready in ${Math.round(performance.now() - t0)} ms${label}`))
      .catch((err) => {
        console.warn(`[jarvis] agent session warm-up failed${label}: ${err?.message ?? err}`)
        // A live session that would not start on the other login: leave that
        // login alone for a while, so the next turn does not open on it again.
        // A session closed under it (a switch, a page gone) is not its fault.
        // Not for a resumed session: a transcript that would not load is the
        // conversation's fault, not the login's (the resume handler falls back).
        if (accounts.switchable() && gen === s.sessionGen && !s.closed && !resume) {
          accounts.hold(on, Date.now() + ACCOUNT_DOWN_MS, null, 'down')
          console.warn(`[jarvis] login ${on} set aside for ${ACCOUNT_DOWN_MS / 60_000} min`)
        }
      })
    void pump(q, gen)
  }

  /**
   * Move this connection to the `to` login: a new session there, the old one
   * closed and its stream ignored (sessionGen). Logins keep their own
   * transcripts, so the new session starts without the conversation so far.
   * Only ever called between turns, or after a turn's result.
   */
  const switchTo = (to, why) => {
    console.log(`[jarvis] claude login ${s.account} -> ${to} (${why})`)
    const old = s.session
    s.chan.close()
    s.chan = createInbox()
    s.sessionGen++
    try {
      old?.close?.()
    } catch {
      // Already gone.
    }
    s.account = to
    s.sessionId = null
    s.sessionEffort = effort
    s.asideLedger = createAsideLedger()
    startSession(null)
  }

  /**
   * The stopped turn never ended. Its session is closed and its stream
   * ignored from here on (sessionGen), and a new session picks the
   * conversation up from the transcript, so nothing of the stuck turn can
   * reach the next question.
   */
  const restart = () => {
    console.warn(`[jarvis] turn still running ${waitCapMs / 1000} s after it was stopped — restarting the agent session`)
    const old = s.session
    s.chan.close()
    s.chan = createInbox()
    s.sessionGen++
    try {
      old?.close?.()
    } catch {
      // Already gone.
    }
    endStuckTurn()
    s.sessionEffort = effort
    // A fresh session has heard none of the asides; a resumed one has.
    if (!s.sessionId) s.asideLedger = createAsideLedger()
    startSession(s.sessionId)
  }

  /**
   * The resume handler's swap: the session now running closed and its stream
   * ignored, a new one started on `resume` (or a fresh one, for null). Returns
   * the new session's generation, so a late answer about it can be told from
   * one about a session since replaced.
   */
  const replace = (resume) => {
    const old = s.session
    s.chan.close()
    s.chan = createInbox()
    s.sessionGen++
    try {
      old?.close?.()
    } catch {
      // Already gone.
    }
    s.sessionId = resume
    s.sessionEffort = effort
    startSession(resume)
    return s.sessionGen
  }

  return { startSession, switchTo, restart, replace }
}
