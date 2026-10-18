/**
 * Diagnostic breadcrumbs from any module, to wherever the app sends them.
 *
 * The transport (bridge.ts) registers the sink: off unless VITE_TRACE=1, and
 * then to the console and, over the open socket, into the bridge's log. The
 * voice loop and the knowledge client used to import the transport for this
 * alone, which tied them to it (docs/ARCHITECTURE.md, "Debts"). With nothing
 * registered a breadcrumb goes nowhere, as with tracing off.
 */

export type TraceInfo = Record<string, string | number | boolean>

let sink: (step: string, info: TraceInfo) => void = () => {}

export function setTraceSink(fn: (step: string, info: TraceInfo) => void): void {
  sink = fn
}

export function trace(step: string, info: TraceInfo = {}): void {
  sink(step, info)
}
