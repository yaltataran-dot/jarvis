import { turnFailed } from './failures.mjs'

/**
 * One socket's agent session as it streams: the SDK's messages turned into
 * the page's frames — words as they come, tools announced, the turn's result
 * decided (turnResult.mjs) and handed to the turn queue, the session's id and
 * servers from init — and a stream that dies closing the socket so the page
 * reconnects. Moved out of server.mjs's connection handler unchanged; it
 * works on the socket's state (`s`), with what it called passed in.
 *
 * @param {{
 *   s: ReturnType<typeof import('./socketState.mjs').createSocketState>,
 *   turns: ReturnType<typeof import('./turns.mjs').createTurns>,
 *   send: (frame: object) => void,
 *   sendTurn: (frame: object) => unknown,
 *   blockJoin: (ev: object) => string | null,
 *   announceTool: (id: string, name: string) => void,
 *   settleTool: (id: string, failed: boolean) => void,
 *   turnOutcome: ReturnType<typeof import('./turnResult.mjs').createTurnOutcome>,
 *   latReport: (outcome: string) => void,
 *   clearTools: () => void,
 *   turnSeconds: () => string,
 *   resumable: ReturnType<typeof import('./resumable.mjs').createResumable>,
 *   owner: { close(): void },
 *   redact: (text: string) => string,
 *   closeSocket: () => void,
 * }} o
 * @returns {(q: AsyncIterable<any> & { close?(): void }, gen: number) => Promise<void>}
 */
export function createSessionStream({ s, turns, send, sendTurn, blockJoin, announceTool, settleTool, turnOutcome, latReport, clearTools, turnSeconds, resumable, owner, redact, closeSocket }) {
  // Pump a session's output stream to the browser for as long as it is the live one.
  return async function pump(q, gen) {
    try {
      for await (const msg of q) {
        // A replaced session's stream: none of it is for the page any more.
        if (gen !== s.sessionGen) break
        if (process.env.JARVIS_DEBUG === '1') {
          console.log('[msg]', msg.type, msg.event?.type ?? '')
        }

        switch (msg.type) {
          // Raw Anthropic stream events, surfaced by includePartialMessages.
          // This is the ONLY place spoken text arrives: there is no top-level
          // text_delta message in the SDK union and the 'assistant' message
          // carries no deltas either. Turn includePartialMessages off and
          // JARVIS goes completely mute.
          case 'stream_event': {
            // A turn stopped before it was running is running now, so this
            // time the interrupt lands — see turns.mjs.
            turns.streaming()
            const ev = msg.event
            if (s.lat && !s.lat.first) s.lat.first = performance.now()
            if (
              ev?.type === 'content_block_delta' &&
              ev.delta?.type === 'text_delta' &&
              ev.delta.text
            ) {
              if (s.lat && !s.lat.text) s.lat.text = performance.now()
              sendTurn({ type: 'text', delta: ev.delta.text })
            }
            // A text block that ends before a tool: its last sentence goes now,
            // not after the tool has run — see turnText.mjs.
            const gap = blockJoin(ev)
            if (gap) sendTurn({ type: 'text', delta: gap })
            if (
              ev?.type === 'content_block_start' &&
              ev.content_block?.type === 'tool_use'
            ) {
              if (s.lat && ev.content_block.id && !s.lat.tools.has(ev.content_block.id)) {
                s.lat.tools.set(ev.content_block.id, performance.now())
                s.lat.toolCount++
              }
              // From here the turn may have changed something, so it is not
              // handed to the fallback if the limit cuts it off.
              turns.acted()
              announceTool(ev.content_block.id, ev.content_block.name)
            }
            break
          }

          case 'assistant': {
            // An API failure can arrive as an assistant message carrying an
            // error kind instead of an answer — remembered for the result.
            if (msg.error) {
              s.turnApiError = msg.error
              console.warn(`[jarvis] API error on the turn: ${msg.error}`)
            }
            // Fallback for builds that emit whole assistant messages rather
            // than partial events. Deduped against the stream_event path.
            for (const block of msg.content ?? msg.message?.content ?? []) {
              if (block.type === 'tool_use') {
                turns.acted()
                announceTool(block.id, block.name)
              }
            }
            break
          }

          case 'user': {
            // Tool results come back as a user message. This is the only place
            // a held announcement can be resolved: a refused tool arrives with
            // is_error set and stays off the HUD, anything else ran.
            const blocks = msg.message?.content
            if (!Array.isArray(blocks)) break
            for (const block of blocks) {
              if (block?.type === 'tool_result') {
                const began = s.lat?.tools.get(block.tool_use_id)
                if (began) {
                  s.lat.toolMs += performance.now() - began
                  s.lat.tools.delete(block.tool_use_id)
                }
                settleTool(block.tool_use_id, block.is_error === true)
              }
            }
            break
          }

          case 'result': {
            // What the result means — see turnResult.mjs. The page stopped this
            // turn when turns.mjs says so; its frame is handed to turns.mjs.
            const turnInterrupted = turns.interrupted()
            const outcome = turnOutcome(msg, {
              apiError: s.turnApiError,
              interrupted: turnInterrupted,
              account: s.account,
              seconds: turnSeconds,
              tools: s.turnTools,
            })
            latReport(
              !turnFailed(msg, s.turnApiError) ? 'ok' : turnInterrupted ? 'interrupted' : `failed:${msg.subtype}`,
            )
            s.turnStartedAt = 0
            s.turnTools = []
            s.turnApiError = null
            // One turn's tool ids are never referred to again, and these
            // otherwise grow for as long as the socket is open.
            clearTools()
            // Last, because it may hand the next question over at once, and
            // that turn's state is set fresh in primary.hand below. This is
            // the only place a primary turn is genuinely over.
            turns.primaryEnded(outcome)
            break
          }

          case 'system':
            // Claude Code retrying a failed API call. Silent before, so a turn
            // stuck in retries looked exactly like a slow one. Logged, and a
            // frame to the page so its wait knows the bridge is still alive.
            if (msg.subtype === 'api_retry') {
              console.warn(
                `[jarvis] API retry ${msg.attempt}/${msg.max_retries} in ${msg.retry_delay_ms} ms` +
                  ` · status=${msg.error_status ?? 'no response'} · ${msg.error}`,
              )
              sendTurn({ type: 'retry', attempt: msg.attempt, max: msg.max_retries, status: msg.error_status ?? null })
              break
            }
            if (msg.subtype === 'init') {
              if (typeof msg.session_id === 'string') {
                s.sessionId = msg.session_id
                // The page keeps this to ask for the conversation back after a drop.
                resumable.issue(s.sessionId, s.account, owner)
                send({ type: 'session', id: s.sessionId })
              }
              // Servers report 'pending' until first use — they connect
              // lazily — so only drop the ones that are actually unusable.
              const usable = (msg.mcp_servers ?? [])
                .filter((q) => q.status !== 'needs-auth' && q.status !== 'failed')
                .map((q) => q.name)
              send({ type: 'ready', servers: usable })
              console.log(`[jarvis] ${usable.length} MCP servers available`)
            }
            break
        }
      }
      // The live session's stream ended without a word: the same as a failure,
      // or the turn on the floor would wait on a result that cannot come.
      if (gen === s.sessionGen && !s.closed) throw new Error('the agent session ended')
    } catch (err) {
      // A replaced session dying is the expected end of it.
      if (gen !== s.sessionGen) return
      console.error('[jarvis] session error:', err)
      send({ type: 'error', message: redact(String(err?.message ?? err)) })
      // The stream is finished either way — nothing will ever be read from it
      // again. Leaving the socket open would leave the client believing it has
      // a working bridge, and every later question would hang for ever waiting
      // on a pump that has already stopped. Close it so it reconnects.
      s.closed = true
      turns.close()
      s.chan.close()
      q.close?.()
      closeSocket()
    }
  }
}
