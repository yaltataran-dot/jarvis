/**
 * The first fault, kept whole.
 *
 * A React error that nothing catches unmounts the entire tree, and what is left
 * is a black page with a console line that scrolls away. Every later error is
 * usually a consequence of the first (`removeChild` on a node the first failure
 * already tore out), so the one worth keeping is the first, with its full stack
 * and React's component stack.
 *
 * Nothing here swallows an exception: boundaries and window listeners call
 * `recordFault` and the error still reaches the console by the normal route
 * (React logs caught errors itself, the browser logs uncaught ones). This only
 * remembers them, so the recovery screen can show them and they can be read
 * back from `window.__jarvisFaults` after the fact.
 */

export type FaultSource = 'ui' | 'scene' | 'window' | 'promise' | 'webgl'

export interface Fault {
  source: FaultSource
  at: string
  name: string
  message: string
  stack: string
  componentStack: string
}

const MAX_KEPT = 20
const MAX_TEXT = 8000

const faults: Fault[] = []

const clip = (s: string): string => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s)

/** Normalise whatever was thrown — it is not always an Error. */
export function toFault(source: FaultSource, thrown: unknown, componentStack = ''): Fault {
  const err = thrown instanceof Error ? thrown : null
  return {
    source,
    at: new Date().toISOString(),
    name: err?.name ?? typeof thrown,
    message: clip(err ? err.message : String(thrown)),
    stack: clip(err?.stack ?? '(no stack: a non-Error value was thrown)'),
    componentStack: clip(componentStack),
  }
}

export function recordFault(source: FaultSource, thrown: unknown, componentStack = ''): Fault {
  const fault = toFault(source, thrown, componentStack)
  if (faults.length < MAX_KEPT) faults.push(fault)
  return fault
}

/** The earliest fault of this page load, or null. */
export const firstFault = (): Fault | null => faults[0] ?? null

export const allFaults = (): readonly Fault[] => faults

export function resetFaults(): void {
  faults.length = 0
}

export function formatFault(f: Fault): string {
  return [
    `[${f.at}] ${f.source}: ${f.name}: ${f.message}`,
    f.stack,
    f.componentStack ? `Component stack:${f.componentStack}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Remember errors nothing else caught. Listeners only observe: no
 * preventDefault, so the browser still reports them as usual.
 */
export function installFaultLog(target: Window & typeof globalThis = window): () => void {
  const onError = (e: ErrorEvent) => {
    recordFault('window', e.error ?? e.message)
  }
  const onRejection = (e: PromiseRejectionEvent) => {
    recordFault('promise', e.reason)
  }
  target.addEventListener('error', onError)
  target.addEventListener('unhandledrejection', onRejection)
  Object.defineProperty(target, '__jarvisFaults', {
    configurable: true,
    get: () => allFaults(),
  })
  return () => {
    target.removeEventListener('error', onError)
    target.removeEventListener('unhandledrejection', onRejection)
  }
}
