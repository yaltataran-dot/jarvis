/** @jsxRuntime automatic */
/* The pragma lets the node test runner (tsx) compile this file the way Vite does;
   the root tsconfig carries no JSX setting for it to read. */
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { firstFault, formatFault, recordFault, type Fault, type FaultSource } from '../lib/faultLog'

interface Props {
  /** `ui` guards the whole interface; `scene` guards only the 3D canvas. */
  scope: Extract<FaultSource, 'ui' | 'scene'>
  children: ReactNode
}

interface State {
  fault: Fault | null
  /** Bumped on retry so the children mount fresh instead of resuming. */
  attempt: number
}

/**
 * A render error below this point shows a recovery screen instead of leaving
 * an empty page.
 *
 * Two of these are mounted, and they fail differently on purpose. The `ui`
 * boundary wraps the whole app; the `scene` boundary wraps only the <Canvas>,
 * so a WebGL failure costs the reactor picture and leaves the HUD, the
 * transcript and the voice loop running.
 *
 * React logs a caught error to the console itself, so this does not log it a
 * second time; it records it (with the component stack) for the recovery
 * screen and `window.__jarvisFaults`.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { fault: null, attempt: 0 }

  static getDerivedStateFromError(): Partial<State> {
    // The details are filled in by componentDidCatch, which is the only place
    // the component stack is available. Until then, a placeholder keeps the
    // fallback from rendering as "no fault".
    return { fault: PENDING }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const fault = recordFault(this.props.scope, error, info.componentStack ?? '')
    this.setState({ fault })
  }

  retry = (): void => {
    this.setState((s) => ({ fault: null, attempt: s.attempt + 1 }))
  }

  render(): ReactNode {
    const { fault, attempt } = this.state
    if (!fault) return <Fragmented key={attempt}>{this.props.children}</Fragmented>
    return this.props.scope === 'scene' ? (
      <SceneFallback fault={fault} onRetry={this.retry} />
    ) : (
      <RecoveryScreen fault={fault} onRetry={this.retry} />
    )
  }
}

const PENDING: Fault = {
  source: 'ui',
  at: '',
  name: 'Error',
  message: '',
  stack: '',
  componentStack: '',
}

/** A keyed pass-through, so a retry remounts the subtree. */
function Fragmented({ children }: { children: ReactNode }) {
  return <>{children}</>
}

export function SceneFallback({ fault, onRetry }: { fault: Fault; onRetry: () => void }) {
  return (
    <div className="scene fault-scene" role="alert" data-fault="scene">
      <div className="fault-scene-note">
        <span>3D-сцена остановлена · 3D scene stopped</span>
        <small>{fault.message || fault.name}</small>
        <button type="button" onClick={onRetry}>
          Перезапустить сцену · Restart scene
        </button>
      </div>
    </div>
  )
}

export function RecoveryScreen({ fault, onRetry }: { fault: Fault; onRetry: () => void }) {
  // The first fault is the cause; the one shown in the header may be a later
  // consequence of it (this boundary's own).
  const first = firstFault() ?? fault
  return (
    <div className="fault-screen" role="alert" data-fault="ui">
      <h1>Сбой интерфейса · Interface fault</h1>
      <p>
        Интерфейс остановился из-за ошибки. Голосовой движок остановлен вместе с ним.
        <br />
        The interface stopped on an error. The voice engine was stopped with it.
      </p>
      <p className="fault-msg">
        {first.name}: {first.message}
      </p>
      <div className="fault-actions">
        <button type="button" onClick={onRetry}>
          Повторить · Retry
        </button>
        <button type="button" onClick={() => window.location.reload()}>
          Перезагрузить страницу · Reload
        </button>
      </div>
      <details>
        <summary>Технические подробности · Details</summary>
        <pre>{formatFault(first)}</pre>
      </details>
    </div>
  )
}
