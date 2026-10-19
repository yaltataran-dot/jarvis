import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { latNew, latencyLine, ms } from '../bridge/latency.mjs'

/**
 * The `[latency]` line (bridge/latency.mjs), moved out of server.mjs unchanged.
 * Written after the move: the line is printed only at the end of a model turn,
 * which a running bridge in DRY mode never has. The expected lines are worked
 * out by hand from the format as it was.
 */

test('a full turn: every stage, rounded to whole milliseconds, the id cut to 12 characters', () => {
  const lat = { id: 'ask-1234567890abc', effort: 'low', recv: 100, start: 150.4, sent: 400, first: 900, text: 1200.6, tools: new Map(), toolMs: 333.3, toolCount: 2 }
  assert.equal(
    latencyLine(lat, 'ok', 2100),
    '[latency] ask=ask-12345678 ok effort=low queue=50ms prep=250ms model-first=500ms first-text=801ms tools=2(333ms) total=2000ms',
  )
})

test('stages that never happened read "-", as does an effort never set', () => {
  const lat = { id: 7, effort: null, recv: 100, start: 0, sent: 0, first: 0, text: 0, tools: new Map(), toolMs: 0, toolCount: 0 }
  assert.equal(
    latencyLine(lat, 'stuck', 600),
    '[latency] ask=7 stuck effort=- queue=-ms prep=-ms model-first=-ms first-text=-ms tools=0(0ms) total=500ms',
  )
})

test('ms: whole milliseconds between two stages, "-" when either is missing', () => {
  assert.equal(ms(1, 2.5), '2')
  assert.equal(ms(10, 10.4), '0')
  assert.equal(ms(0, 5), '-')
  assert.equal(ms(5, 0), '-')
})

test('latNew: a fresh record on the monotonic clock, nothing else started', () => {
  const before = performance.now()
  const lat = latNew('q')
  assert.ok(lat.recv >= before && lat.recv <= performance.now())
  assert.deepEqual({ ...lat, recv: 0, tools: null }, { id: 'q', effort: null, recv: 0, start: 0, sent: 0, first: 0, text: 0, tools: null, toolMs: 0, toolCount: 0 })
  assert.ok(lat.tools instanceof Map && lat.tools.size === 0)
  assert.notEqual(latNew('q').tools, lat.tools, 'its own map each time')
})

test('server.mjs keeps the record and prints the line once per turn', () => {
  const server = readFileSync(new URL('../bridge/server.mjs', import.meta.url), 'utf8').replace(/\r/g, '')
  assert.match(server, /const latReport = \(outcome\) => \{\n {4}if \(!s\.lat\) return\n {4}const end = performance\.now\(\)\n {4}console\.log\(latencyLine\(s\.lat, outcome, end\)\)\n {4}s\.lat = null\n {2}\}/)
  // Started where the page's question is handed to the turn queue (pageFrames.mjs).
  const frames = readFileSync(new URL('../bridge/pageFrames.mjs', import.meta.url), 'utf8').replace(/\r/g, '')
  assert.match(frames, /turns\.ask\(id, \{ text: msg\.text, asides: asidesFrom\(msg\.asides\), lat: latNew\(id\) \}\)/)
  assert.equal(frames.match(/latNew\(/g)?.length, 1)
  assert.doesNotMatch(server, /latNew\(/)
})
