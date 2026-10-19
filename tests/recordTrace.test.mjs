import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { cleanInfo, recordTrace } from '../bridge/turnLog.mjs'

/**
 * A page's `trace` frame on the bridge (recordTrace, bridge/turnLog.mjs),
 * moved from server.mjs's frame dispatch unchanged. The running bridge's
 * `[trace]` line is checked in tests/bridgeSocket.test.mjs, before and after
 * the move.
 */

const sink = () => {
  const added = []
  return { added, add: (step, info, at) => added.push({ step, info, at }) }
}

test('tracing off, or no string step: nothing written, nothing printed', (t) => {
  const log = t.mock.method(console, 'log', () => {})
  const turnLog = sink()
  recordTrace({ step: 'x', info: { a: 1 } }, { on: false, dialog: false, turnLog })
  for (const step of [undefined, 3, null, { s: 1 }]) recordTrace({ step, info: {} }, { on: true, dialog: false, turnLog })
  assert.deepEqual(turnLog.added, [])
  assert.equal(log.mock.callCount(), 0)
})

test('on: the cleaned info written with its time, and one [trace] line with the step cut to 40', (t) => {
  const log = t.mock.method(console, 'log', () => {})
  const turnLog = sink()
  const info = { n: 3, ok: true, token: 'secret=abcdefgh12345678', said: 'привет' }
  const step = 'voice.' + 'x'.repeat(50)
  recordTrace({ step, at: 1234, info }, { on: true, dialog: false, turnLog })
  const cleaned = cleanInfo(info, false)
  assert.deepEqual(turnLog.added, [{ step, info: cleaned, at: 1234 }])
  const line = Object.entries(cleaned)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')
  assert.deepEqual(log.mock.calls[0].arguments, [`[trace] ${step.slice(0, 40)} ${line}`])
  assert.doesNotMatch(log.mock.calls[0].arguments[0], /abcdefgh12345678/)
})

test('no time from the page: now; no turn log: printed only', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 5000 })
  const log = t.mock.method(console, 'log', () => {})
  const turnLog = sink()
  recordTrace({ step: 's', at: 'later' }, { on: true, dialog: false, turnLog })
  assert.equal(turnLog.added[0].at, 5000)
  recordTrace({ step: 's' }, { on: true, dialog: false, turnLog: null })
  assert.equal(log.mock.callCount(), 2)
  assert.equal(log.mock.calls[1].arguments[0], '[trace] s ')
})

test('server.mjs hands every trace frame here, with its switches, and answers nothing', () => {
  const server = readFileSync(new URL('../bridge/server.mjs', import.meta.url), 'utf8').replace(/\r/g, '')
  // The page's frames are read in pageFrames.mjs, with the bridge's switches passed in.
  const frames = readFileSync(new URL('../bridge/pageFrames.mjs', import.meta.url), 'utf8').replace(/\r/g, '')
  assert.match(frames, /if \(msg\.type === 'trace'\) \{\n {6}recordTrace\(msg, \{ on: trace, dialog: dialogLog, turnLog \}\)\n {6}return\n {4}\}/)
  assert.match(server, /createPageFrames\(\{[^}]*\n {6}trace: TRACE,\n {6}dialogLog: DIALOG_LOG,\n {6}turnLog: TURN_LOG,\n/)
})
