/**
 * Where a turn's time went, on the monotonic clock: one `[latency]` line per
 * turn. Stages only — never the question, the answer or any tool's input.
 *
 *   recv     the ask arrived on the socket
 *   start    handed to the agent (after any interrupt settled)
 *   sent     the effort set and the message yielded to the SDK
 *   first    the model's first stream event (its response has begun)
 *   text     the first word of the answer
 *   tools    each tool call, from its block starting to its result
 *
 * Moved out of server.mjs unchanged. The turn's record itself (`lat`) stays
 * there: the session stream, the question's hand-over and the turn queue all
 * write to it.
 */

/** A new turn's record, its clock started now. */
export const latNew = (id) => ({ id, effort: null, recv: performance.now(), start: 0, sent: 0, first: 0, text: 0, tools: new Map(), toolMs: 0, toolCount: 0 })

/** Milliseconds from `a` to `b`, or '-' when either stage never happened. */
export const ms = (a, b) => (a && b ? `${Math.round(b - a)}` : '-')

/** The `[latency]` line for a turn that ended at `end` with `outcome`. */
export const latencyLine = (lat, outcome, end) =>
  `[latency] ask=${String(lat.id).slice(0, 12)} ${outcome} effort=${lat.effort ?? '-'}` +
  ` queue=${ms(lat.recv, lat.start)}ms prep=${ms(lat.start, lat.sent)}ms` +
  ` model-first=${ms(lat.sent, lat.first)}ms first-text=${ms(lat.sent, lat.text)}ms` +
  ` tools=${lat.toolCount}(${Math.round(lat.toolMs)}ms) total=${ms(lat.recv, end)}ms`
