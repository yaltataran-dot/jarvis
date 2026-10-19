import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPageRequests } from '../bridge/pageRequests.mjs'

/**
 * The bridge's requests of the page (bridge/pageRequests.mjs): the camera's
 * `capture`, answered by a `reply` frame. Moved out of server.mjs unchanged;
 * these were written after the move — the code could not be reached on a
 * running bridge without a model turn that calls the camera.
 */

const OPEN = 1
const fakeSocket = (state = OPEN) => ({ readyState: state, OPEN })

test('a request goes out as a frame of its kind, with a fresh id per request', () => {
  const sent = []
  const r = createPageRequests({ socket: fakeSocket(), send: (m) => sent.push(m) })
  const pending = [r.ask('capture', { reason: 'look', seconds: 3 }), r.ask('capture', { reason: 'again' })]
  assert.deepEqual(sent, [
    { type: 'capture', id: 'q1', reason: 'look', seconds: 3 },
    { type: 'capture', id: 'q2', reason: 'again' },
  ])
  for (const id of ['q1', 'q2']) r.reply({ type: 'reply', id })
  return Promise.all(pending)
})

test('the reply with its id settles it, with the whole frame; a second reply to it is dropped', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const sent = []
  const r = createPageRequests({ socket: fakeSocket(), send: (m) => sent.push(m) })
  const p = r.ask('capture', {})
  const reply = { type: 'reply', id: 'q1', data: 'AAAA', mimeType: 'image/png' }
  r.reply(reply)
  assert.equal(await p, reply)
  r.reply({ type: 'reply', id: 'q1', data: 'late' })
  // The timer was cleared: running past the timeout does nothing.
  t.mock.timers.tick(60_000)
})

test('replies are matched by id, in any order; one nobody asked for is dropped', async () => {
  const r = createPageRequests({ socket: fakeSocket(), send: () => {} })
  const a = r.ask('capture', {})
  const b = r.ask('capture', {})
  r.reply({ type: 'reply', id: 'nobody' })
  r.reply({ type: 'reply', id: 'q2', data: 'b' })
  r.reply({ type: 'reply', id: 'q1', data: 'a' })
  assert.equal((await a).data, 'a')
  assert.equal((await b).data, 'b')
})

test('no answer in time: rejected after 20 s by default, or the given timeout, and a late reply is dropped', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const r = createPageRequests({ socket: fakeSocket(), send: () => {} })
  const p = r.ask('capture', {})
  const q = r.ask('capture', {}, 5000)
  let settledP = false
  p.catch(() => {}).finally(() => (settledP = true))
  t.mock.timers.tick(5000)
  await assert.rejects(q, /the interface did not answer in time/)
  await Promise.resolve()
  assert.equal(settledP, false, 'the default one is still waiting at 5 s')
  t.mock.timers.tick(15_000)
  await assert.rejects(p, /the interface did not answer in time/)
  r.reply({ type: 'reply', id: 'q1', data: 'late' })
})

test('a socket that is not open: refused at once, nothing sent, no id used', async () => {
  const sent = []
  const socket = fakeSocket(3)
  const r = createPageRequests({ socket, send: (m) => sent.push(m) })
  await assert.rejects(r.ask('capture', {}), /the interface is not connected/)
  assert.deepEqual(sent, [])
  socket.readyState = OPEN
  const p = r.ask('capture', {})
  assert.equal(sent[0].id, 'q1', 'the refused request took no id')
  r.reply({ type: 'reply', id: 'q1' })
  await p
})

test('each socket has its own registry: ids and replies do not cross', async () => {
  const one = createPageRequests({ socket: fakeSocket(), send: () => {} })
  const two = createPageRequests({ socket: fakeSocket(), send: () => {} })
  const a = one.ask('capture', {})
  const b = two.ask('capture', {})
  two.reply({ type: 'reply', id: 'q1', data: 'two' })
  one.reply({ type: 'reply', id: 'q1', data: 'one' })
  assert.equal((await a).data, 'one')
  assert.equal((await b).data, 'two')
})
