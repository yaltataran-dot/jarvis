import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WIN, exitReason } from '../scripts/exitReason.mjs'

test('the codes seen when JARVIS stopped, each said as what it is', () => {
  // "bridge exited (3221225786)": Ctrl+C, or the console window closed.
  assert.equal(WIN.CONTROL_C, 3221225786)
  assert.deepEqual(exitReason(3221225786, null), { text: 'Ctrl+C or the console window was closed (code 3221225786 / 0xC000013A)', stop: true })
  // "bridge exited (null)": the launcher itself stopped it.
  assert.deepEqual(exitReason(null, 'SIGTERM'), { text: 'stopped by the launcher (SIGTERM)', stop: true })
  // "bridge exited (4294967295)" in the background log: Stop-Process / Task Manager.
  assert.equal(WIN.KILLED, 4294967295)
  assert.equal(exitReason(4294967295, null).stop, true)
  assert.match(exitReason(4294967295, null).text, /Stop-Process or Task Manager/)
  // The same code as a signed number, as some APIs report it.
  assert.equal(exitReason(-1073741510, null).stop, true)
  assert.equal(exitReason(-1, null).stop, true)
})

test('a real failure stays a failure', () => {
  // "face exited (1)" on its own: a failure — unless a stop is already under way (start.mjs decides that).
  assert.deepEqual(exitReason(1, null), { text: 'failed (code 1) — see its messages above', stop: false })
  assert.equal(exitReason(0xc0000005, null).stop, false)
  assert.match(exitReason(0xc0000005, null).text, /crashed — Windows status \/ 0xC0000005/)
  assert.deepEqual(exitReason(0, null), { text: 'finished (code 0)', stop: true })
})
