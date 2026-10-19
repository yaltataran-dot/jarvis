import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTurns } from '../bridge/turns.mjs'
import { createAccounts } from '../bridge/accounts.mjs'
import { readFileSync } from 'node:fs'

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

/**
 * A session on real login state (accounts.mjs), wired the way server.mjs wires
 * it, on a clock the test moves. `handed` records which login each question
 * went to.
 */
function loginRig({
  backup = true,
  /** Backup directories as a list (three logins); `backup` is ignored when given. */
  backups = null,
  fallback = null,
  // Shared between rigs, as one bridge's logins are shared by all its pages.
  clock = { now: Date.UTC(2026, 9, 17, 15, 20) },
  accounts = createAccounts(backups ? { backupDirs: backups } : { backupDir: backup ? '/root/.claude-backup' : null }),
} = {}) {
  const s = { account: accounts.pick(clock.now) ?? 'primary', switches: [] }
  const sent = []
  const handed = []
  const logs = []
  const interrupts = []
  const timers = manualTimers()
  const move = (to, why) => {
    s.switches.push(`${s.account}->${to} (${why})`)
    s.account = to
  }
  const turns = createTurns({
    send: (f) => sent.push(f),
    say: { fallbackDown: (k) => `down:${k}`, limitMidTurn: () => 'mid-turn' },
    primary: {
      hand: (t) => handed.push(`${t.id}@${s.account}`),
      interrupt: () => interrupts.push(s.account),
      restart: () => {},
      atBoundary() {
        const to = accounts.pick(clock.now)
        if (to && to !== s.account) move(to, 'boundary')
      },
      account: () => s.account,
      switchAccount(tried) {
        const to = accounts.pick(clock.now, tried)
        if (!to || to === s.account) return false
        move(to, 'limited')
        return to
      },
      pausedFrame() {
        const b = accounts.blocked(clock.now)
        return b && { type: 'error', kind: 'rate', resetAt: b.clock, message: `limit:${b.clock}` }
      },
    },
    fallback,
    log: (event, turn) => logs.push(`${event}:${turn?.id}`),
    // One more try per other login.
    maxSwitches: accounts.labels().length - 1,
    timers,
  })
  /** What server.mjs does on a 429 before it reports the result. */
  const limited = (until, resetAt) => {
    accounts.hold(s.account, until, resetAt)
    turns.primaryEnded({ kind: 'rate', frame: { type: 'error', kind: 'rate', resetAt, message: `limit:${resetAt}` } })
  }
  /** What server.mjs does on a 401: that login set aside, the failure shown as it is. */
  const refused = (forMs) => {
    accounts.hold(s.account, clock.now + forMs, null, 'down')
    turns.primaryEnded({ kind: 'failed', frame: { type: 'error', kind: 'service', message: 'auth' } })
  }
  return { turns, accounts, clock, s, sent, handed, logs, interrupts, timers, limited, refused }
}

const HOUR = 60 * 60_000

test('logins: the primary limited mid-question — the same question once more on the backup, with no limit shown', () => {
  const r = loginRig()
  r.turns.ask('a1', item('погода'))
  assert.deepEqual(r.handed, ['a1@primary'])
  r.limited(r.clock.now + HOUR, '19:20')
  assert.deepEqual(r.handed, ['a1@primary', 'a1@backup'])
  assert.deepEqual(r.s.switches, ['primary->backup (limited)'])
  assert.deepEqual(r.sent, [])
  assert.deepEqual(r.logs, ['account-switch:a1'])
  r.turns.frame({ type: 'text', delta: 'Солнечно.' })
  r.turns.primaryEnded(OK('Солнечно.'))
  assert.deepEqual(r.sent.map((f) => f.type), ['text', 'done'])
  assert.ok(r.sent.every((f) => f.ask === 'a1'))
  // The next question stays on the backup while the primary is held off.
  r.turns.ask('a2', item('а завтра?'))
  assert.equal(r.handed.at(-1), 'a2@backup')
})

test('logins: both limited — one limit frame with the sooner time, no third try, and nothing sent after', () => {
  const r = loginRig()
  r.turns.ask('a1', item('новости'))
  r.limited(r.clock.now + 3 * HOUR, '21:20')
  // The backup is limited too, on the one retry this turn gets.
  r.limited(r.clock.now + HOUR, '19:20')
  assert.deepEqual(r.handed, ['a1@primary', 'a1@backup'])
  assert.deepEqual(r.sent, [{ type: 'error', kind: 'rate', resetAt: '19:20', message: 'limit:19:20', ask: 'a1' }])
  // While both are held off no question reaches either login.
  r.turns.ask('a2', item('ещё раз'))
  assert.deepEqual(r.handed, ['a1@primary', 'a1@backup'])
  assert.deepEqual(r.sent.at(-1), { type: 'error', kind: 'rate', resetAt: '19:20', message: 'limit:19:20', ask: 'a2' })
})

test('logins: the primary is taken back at the first turn after its time, not in the middle of one', () => {
  const r = loginRig()
  r.turns.ask('a1', item('один'))
  r.limited(r.clock.now + HOUR, '16:20')
  // The primary's time passes while the backup is still answering a1.
  r.clock.now += HOUR + 1
  r.turns.frame({ type: 'text', delta: 'Ответ.' })
  assert.equal(r.s.account, 'backup')
  r.turns.primaryEnded(OK('Ответ.'))
  r.turns.ask('a2', item('два'))
  assert.deepEqual(r.s.switches, ['primary->backup (limited)', 'backup->primary (boundary)'])
  assert.equal(r.handed.at(-1), 'a2@primary')
  // Not actually lifted: its 429 sends the question back to the backup, once.
  r.limited(r.clock.now + HOUR, '17:20')
  assert.equal(r.handed.at(-1), 'a2@backup')
})

test('logins: a question that called a tool is never asked again on the other login', () => {
  const r = loginRig()
  r.turns.ask('a1', item('включи музыку'))
  r.turns.acted()
  r.limited(r.clock.now + HOUR, '16:20')
  assert.deepEqual(r.handed, ['a1@primary'])
  assert.deepEqual(r.s.switches, [])
  assert.deepEqual(r.sent, [{ type: 'error', kind: 'rate', resetAt: '16:20', message: 'mid-turn', ask: 'a1' }])
  // The next question opens on the backup, at the boundary.
  r.turns.ask('a2', item('что играет?'))
  assert.equal(r.handed.at(-1), 'a2@backup')
})

test('logins: a question already answered in part is not asked again either', () => {
  const r = loginRig()
  r.turns.ask('a1', item('расскажи'))
  r.turns.frame({ type: 'text', delta: 'Итак,' })
  r.limited(r.clock.now + HOUR, '16:20')
  assert.deepEqual(r.handed, ['a1@primary'])
  assert.equal(r.sent.at(-1).kind, 'rate')
})

test('logins: at most one switch per question, even when switching always claims to work', () => {
  const sent = []
  const handed = []
  let switches = 0
  const turns = createTurns({
    send: (f) => sent.push(f),
    say: { fallbackDown: (k) => k, limitMidTurn: () => 'mid' },
    primary: {
      hand: (t) => handed.push(t.id),
      interrupt: () => {},
      restart: () => {},
      pausedFrame: () => null,
      switchAccount: () => ++switches > 0,
    },
    timers: manualTimers(),
  })
  turns.ask('a1', item('x'))
  turns.primaryEnded(RATE)
  turns.primaryEnded(RATE)
  assert.equal(switches, 1)
  assert.deepEqual(handed, ['a1', 'a1'])
  assert.deepEqual(sent, [{ ...RATE.frame, ask: 'a1' }])
})

test('logins: a stopped question is not moved to the other login', () => {
  const r = loginRig()
  r.turns.ask('a1', item('стоп потом'))
  r.turns.interrupt()
  r.limited(r.clock.now + HOUR, '16:20')
  assert.deepEqual(r.handed, ['a1@primary'])
  assert.deepEqual(r.s.switches, [])
  assert.deepEqual(r.sent, [])
})

test('logins: a backup that would not start is set aside, and the next turn goes where it can', () => {
  const r = loginRig()
  r.turns.ask('a1', item('один'))
  r.limited(r.clock.now + HOUR, '16:20')
  // The backup session fails to start: server.mjs holds that login off.
  r.accounts.hold('backup', r.clock.now + 15 * 60_000, null, 'down')
  r.turns.primaryEnded(FAILED)
  // Both held now: the plain limit frame, with no clock, since the backup is back first.
  r.turns.ask('a2', item('два'))
  assert.deepEqual(r.sent.at(-1), { type: 'error', kind: 'rate', resetAt: null, message: 'limit:null', ask: 'a2' })
  // Fifteen minutes on, the backup is tried again; an hour on, the primary.
  r.clock.now += 15 * 60_000
  r.turns.ask('a3', item('три'))
  assert.equal(r.handed.at(-1), 'a3@backup')
  r.clock.now += HOUR
  r.turns.primaryEnded(OK('ok'))
  r.turns.ask('a4', item('четыре'))
  assert.equal(r.handed.at(-1), 'a4@primary')
})

test('logins: with no backup configured, a limit behaves exactly as before', () => {
  const r = loginRig({ backup: false })
  r.turns.ask('a1', item('погода'))
  r.limited(r.clock.now + HOUR, '16:20')
  assert.deepEqual(r.handed, ['a1@primary'])
  assert.deepEqual(r.s.switches, [])
  assert.deepEqual(r.sent, [{ type: 'error', kind: 'rate', resetAt: '16:20', message: 'limit:16:20', ask: 'a1' }])
  r.turns.ask('a2', item('ещё'))
  assert.deepEqual(r.handed, ['a1@primary'])
  // And the fallback channel still takes the turn when it is configured.
  const fb = fakeFallback()
  const f = loginRig({ backup: false, fallback: fb })
  f.turns.ask('b1', item('2+2'))
  f.limited(f.clock.now + HOUR, '16:20')
  assert.equal(fb.calls.length, 1)
})

test('logins: the backup is tried before the fallback channel, and the fallback after both', () => {
  const fb = fakeFallback()
  const r = loginRig({ fallback: fb })
  r.turns.ask('a1', item('2+2'))
  r.limited(r.clock.now + HOUR, '16:20')
  assert.equal(fb.calls.length, 0)
  assert.equal(r.handed.at(-1), 'a1@backup')
  r.limited(r.clock.now + HOUR, '16:20')
  assert.equal(fb.calls.length, 1)
})

test('logins: the primary working — every question stays on it, nothing switches', () => {
  const r = loginRig()
  for (const id of ['a1', 'a2', 'a3']) {
    r.turns.ask(id, item(id))
    r.turns.primaryEnded(OK(`answer ${id}`))
  }
  assert.deepEqual(r.handed, ['a1@primary', 'a2@primary', 'a3@primary'])
  assert.deepEqual(r.s.switches, [])
})

test('logins: a network failure is shown as it is, and moves nothing', () => {
  const r = loginRig()
  r.turns.ask('a1', item('погода'))
  r.turns.primaryEnded(FAILED)
  assert.deepEqual(r.handed, ['a1@primary'])
  assert.deepEqual(r.s.switches, [])
  assert.deepEqual(r.sent, [{ ...FAILED.frame, ask: 'a1' }])
  assert.equal(r.accounts.held('primary', r.clock.now), false)
  // The next question goes to the primary as before.
  r.turns.ask('a2', item('ещё раз'))
  assert.equal(r.handed.at(-1), 'a2@primary')
})

test('logins: a refused primary shows its failure, is not asked again in that turn, and the next turn opens on the backup', () => {
  const r = loginRig()
  r.turns.ask('a1', item('погода'))
  r.refused(15 * 60_000)
  assert.deepEqual(r.handed, ['a1@primary'])
  assert.deepEqual(r.sent, [{ type: 'error', kind: 'service', message: 'auth', ask: 'a1' }])
  r.turns.ask('a2', item('ещё раз'))
  assert.equal(r.handed.at(-1), 'a2@backup')
  // Set aside for its while only, then the primary is taken back.
  r.clock.now += 15 * 60_000
  r.turns.primaryEnded(OK('ok'))
  r.turns.ask('a3', item('и ещё'))
  assert.equal(r.handed.at(-1), 'a3@primary')
})

test('logins: "стоп" while the question is on the backup stops it there, and it is not moved again', async () => {
  const r = loginRig()
  r.turns.ask('a1', item('расскажи длинно'))
  r.limited(r.clock.now + HOUR, '16:20')
  assert.equal(r.handed.at(-1), 'a1@backup')
  r.turns.interrupt()
  await tick()
  assert.deepEqual(r.interrupts, ['backup'])
  // The stopped turn ends as a limit on the backup too: nothing said, no third login, no fallback.
  r.limited(r.clock.now + HOUR, '16:20')
  assert.deepEqual(r.handed, ['a1@primary', 'a1@backup'])
  assert.deepEqual(r.sent, [])
  // The floor is free: a new question is taken (both are held now, so it is told the limit).
  r.turns.ask('a2', item('а теперь?'))
  assert.equal(r.sent.at(-1).ask, 'a2')
})

test('logins: several pages at once share the logins — one page hitting the limit moves the others at their next turn', () => {
  const clock = { now: Date.UTC(2026, 9, 17, 15, 20) }
  const accounts = createAccounts({ backupDir: '/root/.claude-backup' })
  const phone = loginRig({ clock, accounts })
  const laptop = loginRig({ clock, accounts })
  phone.turns.ask('p1', item('погода'))
  laptop.turns.ask('l1', item('новости'))
  // The phone's question hits the limit first: it moves, once.
  phone.limited(clock.now + HOUR, '16:20')
  assert.equal(phone.handed.at(-1), 'p1@backup')
  // The laptop's question is already on the primary and is not touched mid-turn…
  assert.deepEqual(laptop.s.switches, [])
  // …its own 429 moves it, once, like any other.
  laptop.limited(clock.now + HOUR, '16:20')
  assert.equal(laptop.handed.at(-1), 'l1@backup')
  // A question the laptop asks later starts on the backup straight away.
  laptop.turns.primaryEnded(OK('ok'))
  laptop.turns.ask('l2', item('ещё'))
  assert.equal(laptop.handed.at(-1), 'l2@backup')
  // Each page asked each question once per login, never more.
  assert.deepEqual(phone.handed, ['p1@primary', 'p1@backup'])
  assert.deepEqual(laptop.handed, ['l1@primary', 'l1@backup', 'l2@backup'])
})

test('logins: a newer question while one is on the backup — the old one is stopped, the newer one waits and is asked once', () => {
  const r = loginRig()
  r.turns.ask('a1', item('первый'))
  r.limited(r.clock.now + HOUR, '16:20')
  r.turns.ask('a2', item('второй'))
  // a1 is stopped, a2 waits for its end and is not handed beside it.
  assert.deepEqual(r.handed, ['a1@primary', 'a1@backup'])
  r.turns.primaryEnded(OK('поздно'))
  assert.deepEqual(r.handed, ['a1@primary', 'a1@backup', 'a2@backup'])
  assert.equal(r.sent.some((f) => f.ask === 'a1'), false)
})

const THREE = ['/root/.claude-b', '/root/.claude-c']

test('three logins: the primary limited — answered on the backup, and the third login is not touched', () => {
  const r = loginRig({ backups: THREE })
  r.turns.ask('a1', item('погода'))
  r.limited(r.clock.now + HOUR, '16:20')
  r.turns.frame({ type: 'text', delta: 'Солнечно.' })
  r.turns.primaryEnded(OK('Солнечно.'))
  assert.deepEqual(r.handed, ['a1@primary', 'a1@backup'])
  assert.deepEqual(r.s.switches, ['primary->backup (limited)'])
  assert.deepEqual(r.sent.map((f) => f.type), ['text', 'done'])
})

test('three logins: the primary and the backup limited — answered on backup2, with no limit shown', () => {
  const r = loginRig({ backups: THREE })
  r.turns.ask('a1', item('новости'))
  r.limited(r.clock.now + 2 * HOUR, '17:20')
  r.limited(r.clock.now + HOUR, '16:20')
  assert.deepEqual(r.handed, ['a1@primary', 'a1@backup', 'a1@backup2'])
  assert.deepEqual(r.s.switches, ['primary->backup (limited)', 'backup->backup2 (limited)'])
  assert.deepEqual(r.logs, ['account-switch:a1', 'account-switch:a1'])
  assert.deepEqual(r.sent, [])
  r.turns.frame({ type: 'text', delta: 'Вот.' })
  r.turns.primaryEnded(OK('Вот.'))
  assert.deepEqual(r.sent.map((f) => f.type), ['text', 'done'])
  // The next question stays on backup2 while the other two are held off.
  r.turns.ask('a2', item('ещё'))
  assert.equal(r.handed.at(-1), 'a2@backup2')
})

test('three logins: all three limited — two retries, then one limit frame with the soonest time, and nothing more sent', () => {
  const r = loginRig({ backups: THREE })
  r.turns.ask('a1', item('новости'))
  r.limited(r.clock.now + 3 * HOUR, '18:20')
  r.limited(r.clock.now + 2 * HOUR, '17:20')
  // The last one is the soonest, as server.mjs would report it (the rig passes its time on as given).
  r.limited(r.clock.now + HOUR, '16:20')
  assert.deepEqual(r.handed, ['a1@primary', 'a1@backup', 'a1@backup2'])
  assert.deepEqual(r.sent, [{ type: 'error', kind: 'rate', resetAt: '16:20', message: 'limit:16:20', ask: 'a1' }])
  r.turns.ask('a2', item('ещё раз'))
  assert.equal(r.handed.length, 3)
  assert.equal(r.sent.at(-1).ask, 'a2')
})

test('three logins: all three limited with a fallback — the fallback takes it after the third, not before', () => {
  const fb = fakeFallback()
  const r = loginRig({ backups: THREE, fallback: fb })
  r.turns.ask('a1', item('2+2'))
  r.limited(r.clock.now + HOUR, '16:20')
  r.limited(r.clock.now + HOUR, '16:20')
  assert.equal(fb.calls.length, 0)
  r.limited(r.clock.now + HOUR, '16:20')
  assert.equal(fb.calls.length, 1)
  assert.deepEqual(r.handed, ['a1@primary', 'a1@backup', 'a1@backup2'])
})

test('three logins: a tool called on the backup — never asked on backup2', () => {
  const r = loginRig({ backups: THREE })
  r.turns.ask('a1', item('включи музыку'))
  r.limited(r.clock.now + HOUR, '16:20')
  assert.equal(r.handed.at(-1), 'a1@backup')
  r.turns.acted()
  r.limited(r.clock.now + HOUR, '16:20')
  assert.deepEqual(r.handed, ['a1@primary', 'a1@backup'])
  assert.deepEqual(r.sent, [{ type: 'error', kind: 'rate', resetAt: '16:20', message: 'mid-turn', ask: 'a1' }])
})

test('three logins: an answer begun on the backup — never asked on backup2', () => {
  const fb = fakeFallback()
  const r = loginRig({ backups: THREE, fallback: fb })
  r.turns.ask('a1', item('расскажи'))
  r.limited(r.clock.now + HOUR, '16:20')
  r.turns.frame({ type: 'text', delta: 'Итак,' })
  r.limited(r.clock.now + HOUR, '16:20')
  assert.deepEqual(r.handed, ['a1@primary', 'a1@backup'])
  assert.equal(fb.calls.length, 0)
  assert.equal(r.sent.at(-1).kind, 'rate')
})

test('three logins: a login is never tried twice in one question, even when its time has passed meanwhile', () => {
  const r = loginRig({ backups: THREE })
  r.turns.ask('a1', item('один'))
  // The primary gave no time: held for a minute only.
  r.limited(r.clock.now + 60_000, null)
  r.clock.now += 2 * 60_000
  // The backup's 429 comes after the primary is free again: the question goes on, not back.
  r.limited(r.clock.now + HOUR, '17:20')
  assert.deepEqual(r.handed, ['a1@primary', 'a1@backup', 'a1@backup2'])
  // And with backup2 out as well, the primary is still not asked a second time.
  const q = loginRig({ backups: THREE })
  q.accounts.hold('backup2', q.clock.now + HOUR, '16:20')
  q.turns.ask('b1', item('два'))
  q.limited(q.clock.now + 60_000, null)
  q.clock.now += 2 * 60_000
  q.limited(q.clock.now + HOUR, '17:20')
  assert.deepEqual(q.handed, ['b1@primary', 'b1@backup'])
  assert.equal(q.sent.at(-1).kind, 'rate')
})

test('three logins: without maxSwitches (the wiring as it was) a question still moves only once', () => {
  const accounts = createAccounts({ backupDirs: THREE })
  let on = 'primary'
  const handed = []
  const sent = []
  const turns = createTurns({
    send: (f) => sent.push(f),
    say: { fallbackDown: (k) => k, limitMidTurn: () => 'mid' },
    primary: {
      hand: (t) => handed.push(`${t.id}@${on}`),
      interrupt: () => {},
      restart: () => {},
      pausedFrame: () => null,
      switchAccount() {
        const to = accounts.pick()
        if (!to || to === on) return false
        on = to
        return true
      },
    },
    timers: manualTimers(),
  })
  turns.ask('a1', item('x'))
  accounts.hold('primary', Date.now() + HOUR)
  turns.primaryEnded(RATE)
  accounts.hold('backup', Date.now() + HOUR)
  turns.primaryEnded(RATE)
  assert.deepEqual(handed, ['a1@primary', 'a1@backup'])
  assert.deepEqual(sent, [{ ...RATE.frame, ask: 'a1' }])
})

test('the fallback could not answer: fallbackDown is given the very frame it words, "service" or the limit', async () => {
  const asked = []
  const sent = []
  const make = (frame, fallback) =>
    createTurns({
      send: (f) => sent.push(f),
      say: { fallbackDown: (k, f) => (asked.push([k, f]), `${f.kind}:${k}`), limitMidTurn: () => 'mid' },
      primary: { hand: () => {}, interrupt: () => {}, restart: () => {}, pausedFrame: () => frame },
      fallback,
      timers: manualTimers(),
    })
  // Every login held, some only set aside: the frame is "service", and so is its sentence.
  const setAside = { type: 'error', kind: 'service', resetAt: null, message: 'unavailable' }
  make(setAside, fakeFallback({ ready: { ok: false, kind: 'budget' } })).ask('a1', item('x'))
  assert.deepEqual(asked, [['budget', setAside]])
  assert.deepEqual(sent.at(-1), { ...setAside, message: 'service:budget', ask: 'a1' })
  // The limit: the fallback fails part way, and is told it was the limit's frame.
  const fb = fakeFallback()
  make(RATE.frame, fb).ask('a2', item('y'))
  fb.calls[0].reject(Object.assign(new Error('x'), { kind: 'network' }))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(asked.at(-1), ['network', RATE.frame])
  assert.deepEqual(sent.at(-1), { ...RATE.frame, message: 'rate:network', ask: 'a2' })
})

test('server.mjs wires the logins as loginRig does: one try per other login, the login it is on, the next untried one', () => {
  const server = readFileSync(new URL('../bridge/server.mjs', import.meta.url), 'utf8').replace(/\r/g, '')
  assert.match(server, /^ {4}maxSwitches: ACCOUNTS\.labels\(\)\.length - 1,$/m)
  assert.match(server, /^ {6}account: \(\) => account,$/m)
  assert.match(
    server,
    /switchAccount\(tried\) \{\n {8}const to = ACCOUNTS\.pick\(Date\.now\(\), tried\)\n {8}if \(!to \|\| to === account\) return false\n {8}switchTo\(to, `\$\{account\} limited`\)\n {8}return to\n {6}\}/,
  )
  // The logins come from JARVIS_CLAUDE_BACKUP_DIR through settings.mjs, the primary's own directory left out.
  assert.match(server, /const ACCOUNTS = createAccounts\(\{ backupDirs: backupLoginDirs\(process\.env, \{ primaryDir: PRIMARY_LOGIN_DIR \}\) \}\)/)
  assert.match(server, /const PRIMARY_LOGIN_DIR = process\.env\.CLAUDE_CONFIG_DIR \|\| join\(homedir\(\), '\.claude'\)/)
  // Labels only in the log.
  assert.match(server, /console\.log\(`\[jarvis\] claude logins: \$\{ACCOUNTS\.labels\(\)\.join\(', '\)\}`\)/)
})
