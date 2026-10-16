import type { Phase } from '../store'

/** What the core at the centre of the HUD shows (ui/Hud.tsx). */
export type CoreMode = 'idle' | 'waking' | 'listening' | 'processing' | 'speaking' | 'error'

/**
 * The core's state from the phase and any error on screen.
 *
 * Kept apart from the voice and from the outside world: a failure of his own
 * — the microphone, a failed start — outranks the phase and is the thing to
 * read. Trouble outside him (the usage limit, the network, the bridge
 * reconnecting) is shown as its message only: the core goes on as it was,
 * since he is still listening and still answers what needs no model.
 */
export function coreMode(phase: Phase, error: string | null, errorKind: 'fault' | 'service' = 'fault'): CoreMode | null {
  // The start-up has its own screen; nothing of this belongs under it.
  if (phase === 'offline' || phase === 'boot') return null
  if (error && errorKind === 'fault') return 'error'
  switch (phase) {
    case 'dormant':
      return 'idle'
    case 'waking':
      return 'waking'
    case 'listening':
      return 'listening'
    case 'thinking':
    case 'tooling':
      return 'processing'
    case 'speaking':
      return 'speaking'
  }
  return null
}
