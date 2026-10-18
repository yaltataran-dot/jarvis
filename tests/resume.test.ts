import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { RESUME_WAIT_MS, createResumeClient, type ReconnectReport } from '../src/lib/resume.ts'

function rig() {
  let now = 0
  let seq = 0
  const due = new Map<number, { at: number; fn: () => void }>()
  const timers = {
    setTimeout: (fn: () => void, ms: number) => {
      due.set(++seq, { at: now + ms, fn })
      return seq
    },
    clearTimeout: (t: unknown) => void due.delete(t as number),
  }
  const advance = (ms: number) => {
    now += ms
    for (const [id, d] of [...due]) {
      if (d.at > now) continue
      due.delete(id)
      d.fn()
    }
  }
  const sent: Array<{ type: string; id: string }> = []
  const reports: ReconnectReport[] = []
  const c = createResumeClient({ send: (f) => void sent.push(f), report: (r) => void reports.push(r), timers })
  return { c, sent, reports, advance, pending: () => due.size }
}

const ID = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d'

test('the first connection of the page reports nothing and asks for nothing', () => {
  const r = rig()
  r.c.onOpen(false)
  assert.deepEqual(r.sent, [])
  assert.deepEqual(r.reports, [])
})

test('after a drop, the session the bridge named is asked for back, once, and the answer is reported', () => {
  const r = rig()
  r.c.onSession(ID)
  r.c.onLost(false)
  r.c.onOpen(true)
  assert.deepEqual(r.sent, [{ type: 'resume', id: ID }])
  assert.deepEqual(r.reports, [], 'nothing reported until the bridge answers')
  r.c.onResumed(true)
  assert.deepEqual(r.reports, [{ resumed: true, interrupted: false }])
  assert.equal(r.c.current(), ID, 'kept for the next drop')
  assert.equal(r.pending(), 0)
})

test('a refusal is a new conversation, and the old id is forgotten', () => {
  const r = rig()
  r.c.onSession(ID)
  r.c.onOpen(true)
  r.c.onResumed(false)
  assert.deepEqual(r.reports, [{ resumed: false, interrupted: false }])
  assert.equal(r.c.current(), null)
  r.c.onOpen(true)
  assert.equal(r.sent.length, 1, 'not asked for again')
  assert.deepEqual(r.reports[1], { resumed: false, interrupted: false })
})

test('a bridge from before this never answers: after a short wait it is a new conversation', () => {
  const r = rig()
  r.c.onSession(ID)
  r.c.onOpen(true)
  r.advance(RESUME_WAIT_MS - 1)
  assert.deepEqual(r.reports, [])
  r.advance(1)
  assert.deepEqual(r.reports, [{ resumed: false, interrupted: false }])
  r.c.onResumed(true) // a late answer changes nothing
  assert.equal(r.reports.length, 1)
})

test('no session named yet (nothing asked before the drop): reported at once, nothing sent', () => {
  const r = rig()
  r.c.onOpen(true)
  assert.deepEqual(r.sent, [])
  assert.deepEqual(r.reports, [{ resumed: false, interrupted: false }])
})

test('a question in flight when the socket died is reported as possibly unfinished — and only once', () => {
  const r = rig()
  r.c.onSession(ID)
  r.c.onLost(true)
  r.c.onOpen(true)
  r.c.onResumed(true)
  assert.deepEqual(r.reports, [{ resumed: true, interrupted: true }])
  r.c.onLost(false)
  r.c.onOpen(true)
  r.c.onResumed(true)
  assert.deepEqual(r.reports[1], { resumed: true, interrupted: false })
})

test('the socket dying again while waiting for the answer counts as a new start, not a hang', () => {
  const r = rig()
  r.c.onSession(ID)
  r.c.onOpen(true)
  r.c.onLost(false)
  assert.deepEqual(r.reports, [{ resumed: false, interrupted: false }])
  assert.equal(r.pending(), 0)
})

test('only resume frames are ever sent: nothing is asked again', () => {
  const r = rig()
  r.c.onSession(ID)
  for (let i = 0; i < 3; i++) {
    r.c.onLost(true)
    r.c.onOpen(true)
    r.c.onResumed(true)
  }
  assert.ok(r.sent.every((f) => f.type === 'resume'))
})

test('wiring: one socket at a time, the drop noted before the turn clears it, no automatic re-ask', () => {
  const src = readFileSync(new URL('../src/lib/bridge.ts', import.meta.url), 'utf8').replace(/\r/g, '')
  // One dial at a time is redial.ts's, tested there; connect() is only that.
  assert.match(src, /function connect\(\): Promise<WebSocket> \{\n {2}return link\.connect\(\)/, 'single-flight connect')
  assert.match(src, /resumer\.onLost\(Boolean\(pending\)\)\n {4}onConnection\?\.\('lost'\)/)
  assert.match(src, /if \(everConnected\) resumer\.onOpen\(true\)\n {4}else onConnection\?\.\('open'\)/)
  assert.match(src, /msg\.type === 'session'\) \{\n {6}resumer\.onSession\(msg\.id\)/)
  assert.match(src, /msg\.type === 'resumed'\) \{\n {6}resumer\.onResumed\(msg\.ok\)/)
  // The only place an 'ask' frame is written is ask() itself.
  assert.equal((src.match(/type: 'ask'/g) ?? []).length, 1)
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  // A resumed conversation needs no message — the working status simply returns (linkStatus.ts).
  assert.doesNotMatch(app, /Связь восстановлена, разговор продолжен\./)
  assert.match(app, /Связь восстановлена, начат новый разговор/)
  assert.match(app, /Последний вопрос мог не завершиться/)
  assert.doesNotMatch(app, /The previous conversation was not kept/)
})
