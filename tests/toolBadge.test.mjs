import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createToolBadge } from '../bridge/toolBadge.mjs'

/**
 * The tool badge (bridge/toolBadge.mjs): which tool calls the page is told
 * about, and when. Moved out of server.mjs unchanged; written after the move —
 * a running bridge only calls tools in a model turn, which DRY mode never has.
 */

/** A badge with the given policy, recording what is shown and what is logged. */
const badge = (allowed = () => true) => {
  const shown = []
  const called = []
  const b = createToolBadge({ decideTool: allowed, show: (n) => shown.push(n), called: (n) => called.push(n) })
  return { ...b, shown, called }
}

test('an allowed tool is shown at once, and logged without its mcp__ prefix', () => {
  const b = badge()
  b.announceTool('t1', 'mcp__jarvis_pc__read_file')
  b.announceTool('t2', 'WebSearch')
  assert.deepEqual(b.shown, ['mcp__jarvis_pc__read_file', 'WebSearch'])
  assert.deepEqual(b.called, ['jarvis_pc__read_file', 'WebSearch'])
})

test('the same call seen twice (stream, then the whole message) is announced once', () => {
  const b = badge()
  b.announceTool('t1', 'WebSearch')
  b.announceTool('t1', 'WebSearch')
  assert.deepEqual(b.shown, ['WebSearch'])
  assert.deepEqual(b.called, ['WebSearch'])
  // Without an id there is nothing to remember it by: each one counts.
  b.announceTool(undefined, 'WebFetch')
  b.announceTool(undefined, 'WebFetch')
  assert.deepEqual(b.shown, ['WebSearch', 'WebFetch', 'WebFetch'])
})

test('no name, nothing at all', () => {
  const b = badge()
  b.announceTool('t1', '')
  b.announceTool('t2', undefined)
  assert.deepEqual(b.shown, [])
  assert.deepEqual(b.called, [])
  b.announceTool('t1', 'WebSearch')
  assert.deepEqual(b.shown, ['WebSearch'], 'and the id was not taken')
})

test('the display and ui_* tools are logged but never shown — the HUD talking about itself', () => {
  const b = badge()
  b.announceTool('t1', 'mcp__jarvis__display')
  b.announceTool('t2', 'mcp__jarvis_ui__tint')
  assert.deepEqual(b.shown, [])
  assert.deepEqual(b.called, ['jarvis__display', 'jarvis_ui__tint'])
  b.settleTool('t1', false)
  b.settleTool('t2', false)
  assert.deepEqual(b.shown, [], 'nor shown when their result comes back')
})

test('a tool the policy does not allow is held until its result: shown if it ran, never if it was refused', () => {
  const b = badge((name) => name !== 'Bash' && name !== 'Write')
  b.announceTool('t1', 'Bash')
  b.announceTool('t2', 'Write')
  assert.deepEqual(b.shown, [])
  assert.deepEqual(b.called, ['Bash', 'Write'], 'logged as called either way')
  b.settleTool('t1', false)
  b.settleTool('t2', true)
  assert.deepEqual(b.shown, ['Bash'])
  b.settleTool('t1', false)
  assert.deepEqual(b.shown, ['Bash'], 'settled once')
})

test('a held tool without an id cannot be settled, so it is never shown', () => {
  const b = badge(() => false)
  b.announceTool(undefined, 'Bash')
  b.settleTool(undefined, false)
  assert.deepEqual(b.shown, [])
})

test('a result for a tool that was shown at once, or never announced, changes nothing', () => {
  const b = badge()
  b.announceTool('t1', 'WebSearch')
  b.settleTool('t1', false)
  b.settleTool('nope', false)
  assert.deepEqual(b.shown, ['WebSearch'])
})

test('clear forgets the turn: ids seen and tools held', () => {
  const b = badge((name) => name !== 'Bash')
  b.announceTool('t1', 'WebSearch')
  b.announceTool('t2', 'Bash')
  b.clear()
  b.settleTool('t2', false)
  assert.deepEqual(b.shown, ['WebSearch'], 'the held one is gone')
  b.announceTool('t1', 'WebSearch')
  assert.deepEqual(b.shown, ['WebSearch', 'WebSearch'], 'the id can be announced again')
})

test('server.mjs builds the frame, logs the names on the turn, and clears where a turn ends', () => {
  const server = readFileSync(new URL('../bridge/server.mjs', import.meta.url), 'utf8').replace(/\r/g, '')
  assert.match(
    server,
    /const \{ announceTool, settleTool, clear: clearTools \} = createToolBadge\(\{\n {4}decideTool,\n {4}show: \(name\) => sendTurn\(\{ type: 'tool', name \}\),\n {4}called: \(name\) => turnTools\.push\(name\),\n {2}\}\)/,
  )
  assert.equal(server.match(/clearTools\(\)/g)?.length, 2, 'at a result and at a session restart')
  assert.doesNotMatch(server, /seenTools|heldTools/)
})
