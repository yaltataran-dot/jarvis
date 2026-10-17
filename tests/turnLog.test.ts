import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeTurnLog, repeatedRun, sanitize, type Stamped } from '../src/lib/turnLog.ts'
import { createTurnLog } from '../bridge/turnLog.mjs'

/** A log with a clock and timers the test moves by hand. */
function rig(opts: { dialog?: boolean } = {}) {
  let t = 1_000
  const out: Stamped[] = []
  const timers: { at: number; fn: () => void; dead: boolean }[] = []
  const log = makeTurnLog({
    ...opts,
    out: (e) => out.push(e),
    now: () => t,
    setTimer: (fn, ms) => {
      const h = { at: t + ms, fn, dead: false }
      timers.push(h)
      return h
    },
    clearTimer: (h) => {
      ;(h as { dead: boolean }).dead = true
    },
  })
  const tick = (ms: number) => {
    t += ms
    for (const h of timers) if (!h.dead && h.at <= t) ((h.dead = true), h.fn())
  }
  return { log, out, tick, steps: () => out.map((e) => e.step) }
}

test('events share one tid, carry dt, and a new phrase gets a new tid', () => {
  const r = rig()
  r.log.event('rec:start', { mode: 'command' })
  r.tick(900)
  r.log.event('voice:emit', { len: 12 })
  r.tick(40)
  r.log.event('app:respond', { len: 12 })
  r.log.event('rec:start')
  assert.deepEqual(r.out.map((e) => [e.tid, e.dt]), [['t1', 0], ['t1', 900], ['t1', 40], ['t2', 0]])
  assert.equal(typeof r.out[1].t, 'number')
})

test('dialogue words are dropped unless dialog logging is on; secrets never survive', () => {
  const off = rig()
  off.log.event('voice:emit', { len: 5, text: 'секретная фраза', why: 'heard "привет" — not his name' })
  assert.deepEqual(off.out[0].info, { len: 5, why: 'heard "…" — not his name' })
  const on = rig({ dialog: true })
  on.log.event('voice:emit', { text: 'привет' })
  assert.equal(on.out[0].info.text, 'привет')
  const s = sanitize(
    { a: 'key sk-ant-abcdef123456', b: 'Authorization: Bearer abc.def-ghijkl', c: 'token=hunter2', d: 'x'.repeat(40) },
    true,
  )
  assert.deepEqual(Object.values(s), ['key ***', 'Authorization: ***', '***', '***'])
})

test('an ask with no first word in 20 s is reported hung; a first word cancels it', () => {
  const r = rig()
  r.log.event('rec:start')
  r.log.event('ask:sent', { id: 'a' })
  r.tick(19_999)
  assert.ok(!r.steps().includes('warn:hung'))
  r.tick(1)
  assert.equal(r.steps().at(-1), 'warn:hung')
  assert.equal(r.out.at(-1)!.info.waitedMs, 20_000)

  const ok = rig()
  ok.log.event('ask:sent')
  ok.tick(3_000)
  ok.log.event('ask:first-delta')
  ok.tick(60_000)
  assert.ok(!ok.steps().includes('warn:hung'))
})

test('duplicate phrases, repeated runs and unanswered stops are flagged', () => {
  assert.equal(repeatedRun('отмени 23:15 23 15'), true)
  assert.equal(repeatedRun('отмени встречу в 23:15'), false)

  const r = rig()
  r.log.event('voice:emit', { text: 'отмени 23:15 23 15' })
  assert.ok(r.steps().includes('warn:repeat-in-phrase'))
  r.log.event('voice:emit', { text: 'какая погода' })
  r.tick(2000)
  r.log.event('voice:emit', { text: 'Какая погода?' })
  assert.ok(r.steps().includes('warn:duplicate'))

  const stop = rig()
  stop.log.event('floor:speak:start')
  stop.log.event('voice:emit', { text: 'стоп' })
  stop.tick(2_000)
  assert.equal(stop.steps().at(-1), 'warn:stop-missed')
  const heeded = rig()
  heeded.log.event('floor:speak:start')
  heeded.log.event('voice:emit', { text: 'стоп' })
  heeded.log.event('floor:speak:cut')
  heeded.tick(5_000)
  assert.ok(!heeded.steps().includes('warn:stop-missed'))
  const idle = rig()
  idle.log.event('voice:emit', { text: 'стоп' })
  idle.tick(5_000)
  assert.ok(!idle.steps().includes('warn:stop-missed'), 'a stop with nothing to stop is not a miss')
})

test('the file log rotates at the size limit and keeps at most three files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-log-'))
  try {
    const log = createTurnLog({ dir, maxBytes: 600, files: 3 })
    for (let i = 0; i < 60; i++) log.add('voice:emit', { tid: 't1', dt: i, len: 5, text: 'dialogue words' })
    await log.idle()
    const names = (await readdir(dir)).sort()
    assert.deepEqual(names, ['trace.jsonl', 'trace.jsonl.1', 'trace.jsonl.2'])
    for (const n of names) assert.ok((await stat(join(dir, n))).size <= 600, `${n} within the limit`)
    const line = JSON.parse((await readFile(join(dir, 'trace.jsonl'), 'utf8')).trim().split('\n').at(-1)!)
    assert.equal(line.step, 'voice:emit')
    assert.equal(line.tid, 't1')
    assert.ok(!('text' in line), 'dialogue words are not written by default')
    assert.equal(typeof line.t, 'number')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an unwritable log directory costs lines, never throws', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-log-'))
  try {
    await writeFile(join(dir, 'file'), '')
    const log = createTurnLog({ dir: join(dir, 'file', 'logs') }) // a directory under a plain file
    assert.doesNotThrow(() => log.add('x', {}))
    await log.idle()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
