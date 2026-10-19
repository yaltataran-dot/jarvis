import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createPageFrames } from '../bridge/pageFrames.mjs'
import { createResumable, transcriptPath } from '../bridge/resumable.mjs'
import { createSocketState } from '../bridge/socketState.mjs'

/**
 * The page's frames on one agent socket (bridge/pageFrames.mjs), moved out of
 * server.mjs unchanged, on a stand-in turn queue and session. The same code
 * through the real connection handler: tests/sessionCore.test.mjs (resume) and
 * tests/bridgeSocket.test.mjs (ping, ask, interrupt in DRY mode).
 */

const A = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d'
const B = '1b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d'

/** A socket with its frame handler; `init` is how the next replaced session starts. */
function rig({ dryAsk = false, init = () => Promise.resolve() } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-frames-'))
  const s = createSocketState({ effort: 'medium', account: 'primary' })
  const sent = []
  const asked = []
  const replies = []
  const replaced = []
  let interrupts = 0
  const resumable = createResumable()
  const owner = { close() {} }
  const replace = (resume) => {
    replaced.push(resume)
    s.sessionGen++
    s.session = { initializationResult: init }
    return s.sessionGen
  }
  const onFrame = createPageFrames({
    s,
    send: (f) => sent.push(f),
    turns: { ask: (id, item) => asked.push([id, item]), interrupt: () => interrupts++ },
    replace,
    replied: (msg) => replies.push(msg),
    owner,
    resumable,
    accounts: { env: (account, base) => ({ ...base, CLAUDE_CONFIG_DIR: join(dir, account) }), switchable: () => false },
    agentEnv: {},
    trace: false,
    dialogLog: false,
    turnLog: null,
    dryAsk,
    dryReply: 'Готово.',
  })
  const frame = (f) => onFrame(Buffer.from(typeof f === 'string' ? f : JSON.stringify(f)))
  const transcript = (id, account = 'primary') => {
    const p = transcriptPath(join(dir, account), homedir(), id)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, '')
  }
  return { s, sent, asked, replies, replaced, interrupts: () => interrupts, resumable, owner, frame, transcript, done: () => rmSync(dir, { recursive: true, force: true }) }
}

const settle = () => new Promise((r) => setImmediate(r))

test('what is not JSON, or no frame the bridge knows, is dropped without a word', () => {
  const r = rig()
  r.frame('{not json')
  r.frame({ type: 'nonsense' })
  r.frame({ type: 'ask', text: 42 })
  r.frame({ type: 'reply', id: 7 })
  assert.deepEqual([r.sent, r.asked, r.replies, r.replaced, r.interrupts(), r.s.asked], [[], [], [], [], 0, false])
  r.done()
})

test('a ping is answered with a pong, and a trace frame with nothing', () => {
  const r = rig()
  r.frame({ type: 'ping' })
  r.frame({ type: 'trace', step: 'x', info: {} })
  assert.deepEqual(r.sent, [{ type: 'pong' }])
  r.done()
})

test('a question goes to the turn queue with its asides read and a latency record, and marks the socket as asking', () => {
  const r = rig()
  const aside = { id: 'a', said: 'Который час?', reply: 'Четыре.' }
  r.frame({ type: 'ask', id: 'q1', text: 'Привет', asides: [aside, { id: '', said: 'x', reply: 'y' }] })
  assert.equal(r.s.asked, true)
  assert.equal(r.asked.length, 1)
  const [id, item] = r.asked[0]
  assert.equal(id, 'q1')
  assert.equal(item.text, 'Привет')
  assert.deepEqual(item.asides, [aside], 'only well-formed asides')
  assert.equal(item.lat.id, 'q1')
  assert.ok(item.lat.recv > 0)
  r.frame({ type: 'ask', id: 5, text: 'Ещё' })
  assert.equal(r.asked[1][0], null, 'an id that is not a string is no id')
  assert.equal(r.asked[1][1].asides, null)
  assert.deepEqual(r.sent, [], 'the frames are the turn queue\'s to send')
  r.done()
})

test('each question keeps the session resumable for this socket', () => {
  const r = rig()
  r.frame({ type: 'ask', id: 'q1', text: 'Привет' })
  assert.equal(r.resumable.check(A, 'primary').ok, false, 'no session id yet')
  r.s.sessionId = A
  r.frame({ type: 'ask', id: 'q2', text: 'Ещё' })
  assert.deepEqual(r.resumable.check(A, 'primary'), { ok: true, holder: r.owner })
  r.done()
})

test('DRY mode answers after a second and a half with the same frames as a turn, and never asks the model', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const r = rig({ dryAsk: true })
  r.frame({ type: 'ask', id: 'd1', text: 'Привет' })
  t.mock.timers.tick(1499)
  assert.deepEqual(r.sent, [])
  t.mock.timers.tick(1)
  assert.deepEqual(r.sent, [{ type: 'text', delta: 'Готово.', ask: 'd1' }, { type: 'done', text: 'Готово.', costUsd: 0, ask: 'd1' }])
  assert.deepEqual([r.asked, r.s.asked], [[], false])
  r.done()
})

test('a reply goes to the bridge\'s own requests; an interrupt to the turn queue', () => {
  const r = rig()
  r.frame({ type: 'reply', id: 'cap1', ok: true })
  r.frame({ type: 'interrupt' })
  assert.deepEqual(r.replies, [{ type: 'reply', id: 'cap1', ok: true }])
  assert.equal(r.interrupts(), 1)
  r.done()
})

test('a resume is refused once a question is under way, for a session not handed out here or to another login, and without its transcript', () => {
  const r = rig()
  r.transcript(A)
  r.transcript(B, 'backup')
  r.resumable.issue(A, 'primary', r.owner)
  r.resumable.issue(B, 'backup', r.owner)
  const C = '2b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d'
  r.resumable.issue(C, 'primary', r.owner)
  r.frame({ type: 'resume', id: 'not-an-id' })
  r.frame({ type: 'resume', id: '3b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d' })
  r.frame({ type: 'resume', id: B })
  r.frame({ type: 'resume', id: C })
  r.s.asked = true
  r.frame({ type: 'resume', id: A })
  assert.deepEqual(r.sent, Array(5).fill({ type: 'resumed', ok: false }))
  assert.deepEqual([r.replaced, r.asked], [[], []])
  r.done()
})

test('a resume: the old holder ended, the session replaced on it and handed to this socket, "resumed" once it has started', async () => {
  const r = rig()
  r.transcript(A)
  let closed = 0
  const old = { close: () => closed++ }
  r.resumable.issue(A, 'primary', old)
  r.frame({ type: 'resume', id: A })
  assert.equal(closed, 1, 'two sockets never share a session')
  assert.deepEqual(r.replaced, [A])
  assert.deepEqual(r.resumable.check(A, 'primary'), { ok: true, holder: r.owner })
  assert.deepEqual(r.sent, [], 'not before the session has started')
  await settle()
  assert.deepEqual(r.sent, [{ type: 'resumed', ok: true }])
  assert.deepEqual(r.asked, [], 'nothing is replayed')
  r.done()
})

test('this socket holding the session already is not ended by its own resume', async () => {
  const r = rig()
  r.transcript(A)
  let closed = 0
  r.owner.close = () => closed++
  r.resumable.issue(A, 'primary', r.owner)
  r.frame({ type: 'resume', id: A })
  await settle()
  assert.equal(closed, 0)
  r.done()
})

test('a resumed session that will not start: a fresh one in its place and the page told no — unless a question has gone into it', async () => {
  for (const askedMeanwhile of [false, true]) {
    let fail
    const r = rig({ init: () => new Promise((_, reject) => (fail = reject)) })
    r.transcript(A)
    r.resumable.issue(A, 'primary', r.owner)
    r.frame({ type: 'resume', id: A })
    if (askedMeanwhile) r.frame({ type: 'ask', id: 'q', text: 'Привет' })
    fail(new Error('no transcript loaded'))
    await settle()
    assert.deepEqual(r.replaced, askedMeanwhile ? [A] : [A, null])
    assert.deepEqual(r.sent, [{ type: 'resumed', ok: false }])
    r.done()
  }
})

test('a resume overtaken by another session, or by the socket closing, says nothing', async () => {
  for (const overtake of [(r) => r.s.sessionGen++, (r) => (r.s.closed = true)]) {
    for (const init of [() => Promise.resolve(), () => Promise.reject(new Error('x'))]) {
      const r = rig({ init })
      r.transcript(A)
      r.resumable.issue(A, 'primary', r.owner)
      r.frame({ type: 'resume', id: A })
      overtake(r)
      await settle()
      assert.deepEqual(r.sent, [])
      assert.deepEqual(r.replaced, [A], 'and does not replace the session again')
      r.done()
    }
  }
})
