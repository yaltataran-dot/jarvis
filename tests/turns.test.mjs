import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTurns } from '../bridge/turns.mjs'

/** Timers that fire only when the test says so. */
function manualTimers() {
  const due = new Map()
  let n = 0
  return {
    setTimeout(fn) {
      due.set(++n, fn)
      return n
    },
    clearTimeout(id) {
      due.delete(id)
    },
    fireAll() {
      const fns = [...due.values()]
      due.clear()
      for (const fn of fns) fn()
    },
    get pending() {
      return due.size
    },
  }
}

/** A fallback whose every answer the test settles by hand. */
function fakeFallback({ ready = { ok: true }, ignoresAbort = false } = {}) {
  const calls = []
  return {
    calls,
    ready: () => ready,
    answer(a) {
      return new Promise((resolve, reject) => {
        const call = { ...a, resolve, reject }
        calls.push(call)
        if (!ignoresAbort) a.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { kind: 'cancelled' })))
      })
    },
  }
}

function rig({ fallback = null, paused = null } = {}) {
  const sent = []
  const handed = []
  const counts = { interrupts: 0, restarts: 0 }
  const timers = manualTimers()
  const turns = createTurns({
    send: (f) => sent.push(f),
    say: { fallbackDown: (k) => `down:${k}`, limitMidTurn: () => 'mid-turn' },
    primary: {
      hand: (t) => handed.push(t.id),
      interrupt: () => {
        counts.interrupts++
      },
      restart: () => {
        counts.restarts++
      },
      pausedFrame: () => paused,
    },
    fallback,
    timers,
  })
  return { turns, sent, handed, counts, timers }
}

const tick = () => new Promise((r) => setImmediate(r))
const item = (text) => ({ text, asides: [] })
const RATE = { kind: 'rate', frame: { type: 'error', kind: 'rate', resetAt: '22:50', message: 'limit' } }
const OK = (text) => ({ kind: 'ok', frame: { type: 'done', text, costUsd: 0 } })
const FAILED = { kind: 'failed', frame: { type: 'error', kind: 'service', message: 'network' } }

test('1. the primary hits its limit: the limit frame goes to that question, and the floor is free again', () => {
  const r = rig()
  r.turns.ask('a1', item('погода'))
  assert.deepEqual(r.handed, ['a1'])
  r.turns.primaryEnded(RATE)
  assert.deepEqual(r.sent, [{ ...RATE.frame, ask: 'a1' }])
  r.turns.ask('a2', item('время'))
  assert.deepEqual(r.handed, ['a1', 'a2'])
})

test('1b. while the limit holds, no question reaches the primary at all', () => {
  const paused = { type: 'error', kind: 'rate', resetAt: '22:50', message: 'limit' }
  const r = rig({ paused })
  r.turns.ask('a1', item('погода'))
  assert.deepEqual(r.handed, [])
  assert.deepEqual(r.sent, [{ ...paused, ask: 'a1' }])
})

test('2. the limit with a fallback: the same question, in the same turn, after the primary has finished', async () => {
  const fb = fakeFallback()
  const r = rig({ fallback: fb })
  r.turns.ask('a1', item('сколько будет 2+2'))
  // Nothing goes to the fallback while the primary still has the question.
  assert.equal(fb.calls.length, 0)
  r.turns.primaryEnded(RATE)
  assert.equal(fb.calls.length, 1)
  assert.equal(fb.calls[0].item.text, 'сколько будет 2+2')
  fb.calls[0].onText('Четыре.')
  fb.calls[0].resolve({ text: 'Четыре.', costUsd: 0.001 })
  await tick()
  assert.deepEqual(r.sent, [
    { type: 'text', delta: 'Четыре.', ask: 'a1' },
    { type: 'done', text: 'Четыре.', costUsd: 0.001, provider: 'fallback', ask: 'a1' },
  ])
  // Once only, and the primary is not asked again.
  assert.equal(fb.calls.length, 1)
  assert.deepEqual(r.handed, ['a1'])
})

test('2b. while the limit holds, questions go straight to the fallback, which remembers the exchange', async () => {
  const fb = fakeFallback()
  const r = rig({ fallback: fb, paused: RATE.frame })
  r.turns.ask('a1', item('как тебя зовут'))
  fb.calls[0].resolve({ text: 'Джарвис.' })
  await tick()
  r.turns.ask('a2', item('а полностью?'))
  assert.deepEqual(fb.calls[1].history, [{ q: 'как тебя зовут', a: 'Джарвис.' }])
  assert.deepEqual(r.handed, [])
})

test('3. both providers down: one plain sentence, kept as the limit frame, naming why', async () => {
  const fb = fakeFallback()
  const r = rig({ fallback: fb })
  r.turns.ask('a1', item('новости'))
  r.turns.primaryEnded(RATE)
  fb.calls[0].reject(Object.assign(new Error('ECONNRESET'), { kind: 'network' }))
  await tick()
  assert.deepEqual(r.sent, [{ ...RATE.frame, message: 'down:network', ask: 'a1' }])

  // The budget spent: the fallback is not called at all.
  const spent = fakeFallback({ ready: { ok: false, kind: 'budget' } })
  const r2 = rig({ fallback: spent })
  r2.turns.ask('b1', item('новости'))
  r2.turns.primaryEnded(RATE)
  assert.equal(spent.calls.length, 0)
  assert.deepEqual(r2.sent, [{ ...RATE.frame, message: 'down:budget', ask: 'b1' }])
})

test('4. "стоп" during the switch-over cancels the fallback, says nothing, and frees the floor', async () => {
  const fb = fakeFallback()
  const r = rig({ fallback: fb })
  r.turns.ask('a1', item('расскажи сказку'))
  r.turns.primaryEnded(RATE)
  fb.calls[0].onText('Жил-был')
  r.turns.interrupt()
  assert.equal(fb.calls[0].signal.aborted, true)
  // A word that arrives after the stop is not passed on.
  fb.calls[0].onText(' король')
  await tick()
  assert.deepEqual(r.sent, [{ type: 'text', delta: 'Жил-был', ask: 'a1' }])
  r.turns.ask('a2', item('время'))
  assert.deepEqual(r.handed, ['a1', 'a2'])
})

test('4b. "стоп" also drops a question that was still waiting for the floor', () => {
  const r = rig()
  r.turns.ask('a1', item('один'))
  r.turns.ask('a2', item('два'))
  r.turns.interrupt()
  r.turns.primaryEnded(FAILED)
  assert.deepEqual(r.handed, ['a1'])
})

test('5. a new question before the old one has finished: the old is stopped, the new waits for its end', () => {
  const r = rig()
  r.turns.ask('a1', item('один'))
  r.turns.frame({ type: 'text', delta: 'Од' })
  r.turns.ask('a2', item('два'))
  assert.equal(r.counts.interrupts, 0, 'the interrupt is sent on the next tick')
  // Still a1's floor: a2 is not in the session yet.
  assert.deepEqual(r.handed, ['a1'])
  r.turns.frame({ type: 'text', delta: 'ин.' })
  r.turns.primaryEnded({ kind: 'failed', frame: { type: 'error', message: 'interrupted' } })
  assert.deepEqual(r.handed, ['a1', 'a2'])
  r.turns.frame({ type: 'text', delta: 'Два.' })
  // a1's tail after the stop, and its end, never reached the page.
  assert.deepEqual(r.sent, [
    { type: 'text', delta: 'Од', ask: 'a1' },
    { type: 'text', delta: 'Два.', ask: 'a2' },
  ])
})

test('5b. of several questions waiting, only the newest is asked', () => {
  const r = rig()
  r.turns.ask('a1', item('один'))
  r.turns.ask('a2', item('два'))
  r.turns.ask('a3', item('три'))
  r.turns.primaryEnded(FAILED)
  assert.deepEqual(r.handed, ['a1', 'a3'])
})

test('6. a late event of a finished or stopped turn is dropped, never tagged with the next question', async () => {
  const r = rig()
  r.turns.ask('a1', item('один'))
  r.turns.primaryEnded(OK('Один.'))
  // Nothing on the floor: a frame now belongs to no question.
  assert.equal(r.turns.frame({ type: 'text', delta: 'хвост' }), false)
  assert.equal(r.turns.live(), false)
  // A second result for a turn already over changes nothing.
  r.turns.primaryEnded(OK('ещё раз'))
  assert.deepEqual(r.sent, [{ type: 'done', text: 'Один.', costUsd: 0, ask: 'a1' }])

  // Stopped before it was running: its first stream event re-sends the
  // interrupt, once.
  r.turns.ask('a2', item('два'))
  r.turns.interrupt()
  await tick()
  r.turns.streaming()
  r.turns.streaming()
  await tick()
  assert.equal(r.counts.interrupts, 2)
})

test('6b. a stopped turn that never ends restarts the session instead of letting the next question in beside it', () => {
  const r = rig()
  r.turns.ask('a1', item('один'))
  r.turns.ask('a2', item('два'))
  assert.deepEqual(r.handed, ['a1'])
  r.timers.fireAll()
  assert.equal(r.counts.restarts, 1)
  assert.deepEqual(r.handed, ['a1', 'a2'])
  r.turns.frame({ type: 'text', delta: 'Два.' })
  assert.deepEqual(r.sent, [{ type: 'text', delta: 'Два.', ask: 'a2' }])
})

test('7. a turn that called a tool is not tried again anywhere when the limit cuts it off', () => {
  const fb = fakeFallback()
  const r = rig({ fallback: fb })
  r.turns.ask('a1', item('добавь встречу на завтра'))
  r.turns.acted()
  r.turns.primaryEnded(RATE)
  assert.equal(fb.calls.length, 0)
  assert.deepEqual(r.handed, ['a1'])
  assert.deepEqual(r.sent, [{ ...RATE.frame, message: 'mid-turn', ask: 'a1' }])

  // Nor one that had already said something: the answer is not started over.
  const fb2 = fakeFallback()
  const r2 = rig({ fallback: fb2 })
  r2.turns.ask('b1', item('расскажи'))
  r2.turns.frame({ type: 'text', delta: 'Итак, ' })
  r2.turns.primaryEnded(RATE)
  assert.equal(fb2.calls.length, 0)
})

test('8. the queue recovers after every kind of failure', async () => {
  // The primary fails.
  const r = rig()
  r.turns.ask('a1', item('один'))
  r.turns.primaryEnded(FAILED)
  r.turns.ask('a2', item('два'))
  assert.deepEqual(r.handed, ['a1', 'a2'])

  // The fallback throws.
  const fb = fakeFallback()
  const r2 = rig({ fallback: fb })
  r2.turns.ask('b1', item('один'))
  r2.turns.primaryEnded(RATE)
  fb.calls[0].reject(new Error('boom'))
  await tick()
  r2.turns.ask('b2', item('два'))
  assert.deepEqual(r2.handed, ['b1', 'b2'])

  // A fallback that ignores its abort is let go after the cap, without a
  // session restart — the primary was never stuck.
  const deaf = fakeFallback({ ignoresAbort: true })
  const r3 = rig({ fallback: deaf })
  r3.turns.ask('c1', item('один'))
  r3.turns.primaryEnded(RATE)
  r3.turns.ask('c2', item('два'))
  assert.deepEqual(r3.handed, ['c1'])
  r3.timers.fireAll()
  assert.equal(r3.counts.restarts, 0)
  assert.deepEqual(r3.handed, ['c1', 'c2'])
  // Its answer, should it ever come, goes nowhere.
  deaf.calls[0].resolve({ text: 'поздно' })
  await tick()
  assert.equal(r3.sent.some((f) => f.ask === 'c1'), false)
})

test('a closed connection aborts the fallback and takes no more questions', async () => {
  const fb = fakeFallback()
  const r = rig({ fallback: fb })
  r.turns.ask('a1', item('один'))
  r.turns.primaryEnded(RATE)
  r.turns.close()
  assert.equal(fb.calls[0].signal.aborted, true)
  r.turns.ask('a2', item('два'))
  await tick()
  assert.deepEqual(r.handed, ['a1'])
  assert.deepEqual(r.sent, [])
})
