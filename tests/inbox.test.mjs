import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createInbox } from '../bridge/inbox.mjs'

/**
 * One agent session's questions (bridge/inbox.mjs), moved out of server.mjs
 * unchanged. Written after the move: a running bridge in DRY mode never hands
 * a question to the session. The generator below reads it the way
 * server.mjs's userMessages does.
 */

/** userMessages' loop, without the turn: the items it would hand the SDK. */
async function* reader(ch, socketClosed = () => false) {
  while (!socketClosed() && !ch.closed) {
    const item = ch.next() ?? (await ch.wait())
    if (socketClosed() || ch.closed || item == null) return
    yield item
  }
}

test('a question put while the generator waits goes straight to it', async () => {
  const ch = createInbox()
  const it = reader(ch)
  const first = it.next()
  ch.put({ text: 'one' })
  assert.deepEqual(await first, { value: { text: 'one' }, done: false })
})

test('questions put with nobody waiting are queued, and read in order without waiting', async () => {
  const ch = createInbox()
  ch.put({ text: 'one' })
  ch.put({ text: 'two' })
  assert.deepEqual(ch.next(), { text: 'one' })
  const it = reader(ch)
  assert.deepEqual((await it.next()).value, { text: 'two' })
  assert.equal(ch.next(), undefined)
})

test('close wakes a waiting generator with nothing, and it ends', async () => {
  const ch = createInbox()
  const it = reader(ch)
  const waiting = it.next()
  ch.close()
  assert.equal(ch.closed, true)
  assert.deepEqual(await waiting, { value: undefined, done: true })
})

test('a closed inbox ends its generator before reading, even with questions queued', async () => {
  const ch = createInbox()
  ch.put({ text: 'left over' })
  ch.close()
  assert.deepEqual(await reader(ch).next(), { value: undefined, done: true })
})

test('a replaced session: the old inbox closed, the new one takes the next question, the old generator never sees it', async () => {
  let chan = createInbox()
  const old = reader(chan)
  const oldWait = old.next()
  chan.close()
  chan = createInbox()
  const fresh = reader(chan)
  const freshWait = fresh.next()
  chan.put({ text: 'next' })
  assert.deepEqual(await oldWait, { value: undefined, done: true })
  assert.deepEqual(await freshWait, { value: { text: 'next' }, done: false })
})

test('the socket closing ends the generator too', async () => {
  const ch = createInbox()
  let socketClosed = false
  const it = reader(ch, () => socketClosed)
  ch.put({ text: 'one' })
  assert.equal((await it.next()).value.text, 'one')
  socketClosed = true
  assert.equal((await it.next()).done, true)
})

test('server.mjs: one inbox per session, closed before it is replaced, read as next ?? wait, handed with put', () => {
  const server = readFileSync(new URL('../bridge/server.mjs', import.meta.url), 'utf8').replace(/\r/g, '')
  assert.match(server, /const item = ch\.next\(\) \?\? \(await ch\.wait\(\)\)\n {6}if \(closed \|\| ch\.closed \|\| item == null\) return/)
  assert.equal(server.match(/chan\.close\(\)\n\s+chan = createInbox\(\)/g)?.length, 3, 'switch login, restart, resume')
  assert.equal(server.match(/chan\.close\(\)/g)?.length, 5, 'and on a dead stream and a closed socket')
  assert.equal(server.match(/chan\.put\(/g)?.length, 1, 'only primary.hand puts a question in')
  assert.doesNotMatch(server, /chan\.(inbox|deliver)|chan\.closed = /)
})
