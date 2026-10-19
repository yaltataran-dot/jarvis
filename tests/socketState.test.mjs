import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createSocketState } from '../bridge/socketState.mjs'

/**
 * One agent socket's state (bridge/socketState.mjs): the values the connection
 * handler's own `let`s started with, and one object per connection. Behaviour
 * through the handler is in tests/sessionCore.test.mjs, before and after.
 */

test('a new connection starts as the handler\'s lets did', () => {
  const s = createSocketState({ effort: 'medium', account: 'backup' })
  const { chan, asideLedger, ...plain } = s
  assert.deepEqual(plain, {
    closed: false,
    sessionEffort: 'medium',
    turnMayShow: false,
    lat: null,
    turnStartedAt: 0,
    turnTools: [],
    turnApiError: null,
    session: null,
    sessionGen: 0,
    sessionId: null,
    asked: false,
    account: 'backup',
  })
  assert.equal(chan.closed, false)
  assert.equal(chan.next(), undefined, 'an empty inbox')
  assert.deepEqual(asideLedger.fresh([{ id: 'a', said: 's', reply: 'r' }]).map((x) => x.id), ['a'], 'a ledger that has handed nothing over')
})

test('two connections share nothing: their own inbox, ledger and lists', () => {
  const a = createSocketState({ effort: 'low', account: 'primary' })
  const b = createSocketState({ effort: 'low', account: 'primary' })
  assert.notEqual(a.chan, b.chan)
  assert.notEqual(a.asideLedger, b.asideLedger)
  assert.notEqual(a.turnTools, b.turnTools)
  a.turnTools.push('WebSearch')
  a.chan.put({ text: 'x' })
  a.asked = true
  assert.deepEqual(b.turnTools, [])
  assert.equal(b.chan.next(), undefined)
  assert.equal(b.asked, false)
})

test('server.mjs makes one per connection, at the start of the handler, and keeps no per-socket lets of its own', () => {
  const server = readFileSync(new URL('../bridge/server.mjs', import.meta.url), 'utf8').replace(/\r/g, '')
  const at = server.indexOf("wss.on('connection', (socket, req) => {")
  const made = server.indexOf("  const s = createSocketState({ effort: EFFORT, account: ACCOUNTS.pick() ?? 'primary' })", at)
  assert.ok(at > 0 && made > at)
  assert.equal(server.match(/createSocketState\(/g)?.length, 1)
  const handler = server.slice(at)
  for (const name of ['closed', 'chan', 'sessionEffort', 'turnMayShow', 'asideLedger', 'lat', 'turnStartedAt', 'turnTools', 'turnApiError', 'session', 'sessionGen', 'sessionId', 'asked', 'account']) {
    assert.doesNotMatch(handler, new RegExp(`\\blet ${name}\\b`), `${name} is a field of s`)
  }
})
