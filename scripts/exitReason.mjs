/**
 * Why a child of the launcher (scripts/start.mjs) ended, in words.
 *
 * Windows reports how a process ended as a bare number, and the launcher used
 * to print it as one: "bridge exited (3221225786)" reads as a crash, when it
 * is 0xC000013A — the console's Ctrl+C or its window being closed. Saying
 * which it was is the difference between a stop and a fault.
 */

/** Exit codes Windows uses for a process that was stopped rather than failed. */
export const WIN = {
  /** STATUS_CONTROL_C_EXIT: Ctrl+C, Ctrl+Break, or the console window closed. */
  CONTROL_C: 0xc000013a,
  /** TerminateProcess(-1): Stop-Process, Task Manager's "End task", .NET Process.Kill(). */
  KILLED: 0xffffffff,
}

/**
 * @param {number|null} code   the child's exit code
 * @param {string|null} signal the signal Node reports (set when the launcher itself killed it)
 * @returns {{ text: string, stop: boolean }} `stop`: it was stopped, not a failure of its own
 */
export function exitReason(code, signal) {
  if (signal) return { text: `stopped by the launcher (${signal})`, stop: true }
  if (code === 0) return { text: 'finished (code 0)', stop: true }
  const u = code == null ? null : code >>> 0
  // Hex only where it means something: Windows status codes, not "1".
  const hex = u == null || u <= 0xff ? '' : ` / 0x${u.toString(16).toUpperCase().padStart(8, '0')}`
  if (u === WIN.CONTROL_C) return { text: `Ctrl+C or the console window was closed (code ${code}${hex})`, stop: true }
  if (u === WIN.KILLED) return { text: `ended from outside — Stop-Process or Task Manager (code ${code}${hex})`, stop: true }
  if (u != null && u >= 0xc0000000) return { text: `crashed — Windows status${hex} (code ${code})`, stop: false }
  return { text: `failed (code ${code}${hex}) — see its messages above`, stop: false }
}
