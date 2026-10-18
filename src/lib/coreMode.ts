import type { Phase } from '../store'

/** What the core at the centre of the HUD shows (ui/Hud.tsx). */
export type CoreMode = 'idle' | 'waking' | 'listening' | 'processing' | 'speaking' | 'recovering' | 'error'

/** The realtime recogniser's state, as the store keeps it. */
export type VoiceHealthState = 'ok' | 'recovering' | 'down'

/** Phases in which the user is expected to talk: there, a recogniser that is not hearing outranks the phase. */
const HEARING: Phase[] = ['dormant', 'waking', 'listening']

/**
 * The core's state from the phase and any error on screen.
 *
 * Kept apart from the voice and from the outside world: a failure of his own
 * — the microphone, a failed start — outranks the phase and is the thing to
 * read. Trouble outside him (the usage limit, the network, the bridge
 * reconnecting) is shown as its message only: the core goes on as it was,
 * since he is still listening and still answers what needs no model.
 */
export function coreMode(
  phase: Phase,
  error: string | null,
  errorKind: 'fault' | 'service' = 'fault',
  health: VoiceHealthState = 'ok',
): CoreMode | null {
  // The start-up has its own screen; nothing of this belongs under it.
  if (phase === 'offline' || phase === 'boot') return null
  if (error && errorKind === 'fault') return 'error'
  // Waiting for his name with nothing listening is not waiting: say so.
  if (HEARING.includes(phase) && health === 'down') return 'error'
  if (HEARING.includes(phase) && health === 'recovering') return 'recovering'
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

/**
 * The status line for a phase in which the user is expected to talk, when the
 * recogniser is not hearing; null when the phase's own text stands.
 */
export function hearingStatus(phase: Phase, health: VoiceHealthState, ru: boolean): string | null {
  if (!HEARING.includes(phase) || health === 'ok') return null
  if (health === 'recovering') return ru ? 'ВОССТАНОВЛЕНИЕ РАСПОЗНАВАНИЯ…' : 'RECOVERING SPEECH RECOGNITION…'
  return ru ? 'РАСПОЗНАВАНИЕ ОСТАНОВЛЕНО — КОСНИТЕСЬ ЭКРАНА' : 'RECOGNITION STOPPED — TAP THE SCREEN'
}
