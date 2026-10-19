import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createInbox } from '../bridge/inbox.mjs'

/**
 * One agent session's questions (bridge/inbox.mjs), moved out of server.mjs
 * unchanged. Written after the move: a running bridge in DRY mode never hands
 * a question to the session. The generator below reads it the way
 * sessionInput.mjs's userMessages does.
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
  // The inbox lives on the socket's state, `s` (socketState.mjs), and is read by the input
  // generator (sessionInput.mjs) that each session is opened on.
  const input = readFileSync(new URL('../bridge/sessionInput.mjs', import.meta.url), 'utf8').replace(/\r/g, '')
  assert.match(input, /const item = ch\.next\(\) \?\? \(await ch\.wait\(\)\)\n {6}if \(s\.closed \|\| ch\.closed \|\| item == null\) return/)
  assert.match(server, /prompt: userMessages\(s\.chan\),/)
  assert.equal(input.match(/s\.chan\.|\.put\(/g), null, 'the reader neither puts nor reaches past the inbox it is given')
  // A session replaced closes its inbox first (sessionLifecycle.mjs: switch login, restart, resume).
  const life = readFileSync(new URL('../bridge/sessionLifecycle.mjs', import.meta.url), 'utf8').replace(/\r/g, '')
  assert.equal(life.match(/s\.chan\.close\(\)\n\s+s\.chan = createInbox\(\)/g)?.length, 3, 'switch login, restart, resume')
  assert.equal(life.match(/s\.chan\.close\(\)/g)?.length, 3)
  assert.equal(server.match(/s\.chan\.close\(\)/g)?.length, 1, 'and on a closed socket')
  // A dead stream closes it too, then the socket (sessionStream.mjs).
  const stream = readFileSync(new URL('../bridge/sessionStream.mjs', import.meta.url), 'utf8').replace(/\r/g, '')
  assert.equal(stream.match(/s\.chan\.close\(\)/g)?.length, 1, 'and on a dead stream')
  assert.match(stream, /s\.closed = true\n\s+turns\.close\(\)\n\s+s\.chan\.close\(\)\n\s+q\.close\?\.\(\)\n\s+closeSocket\(\)/)
  assert.match(server, /closeSocket: \(\) => socket\.close\(\),/)
  assert.equal(stream.match(/s\.chan\.put\(/g), null, 'the stream puts no question in')
  assert.equal(server.match(/s\.chan\.put\(/g)?.length, 1, 'only primary.hand puts a question in')
  assert.doesNotMatch(server, /chan\.(inbox|deliver)|chan\.closed = /)
  const state = readFileSync(new URL('../bridge/socketState.mjs', import.meta.url), 'utf8')
  assert.match(state, /chan: createInbox\(\),/, 'one inbox from the start, per connection')
})
