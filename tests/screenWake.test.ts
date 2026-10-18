import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createScreenWake } from '../src/lib/screenWake.ts'

/** Mirrors tts.ts: the waits it hands to letGo(). Checked against the source in the wiring test. */
const BETWEEN = 1500
const QUIET = 200_000

/** A fake Wake Lock API, document and clock, so every step is explicit. */
function rig({ refuse = false, supported = true } = {}) {
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
  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  }
  const advance = async (ms: number) => {
    now += ms
    for (const [id, d] of [...due].sort((a, b) => a[1].at - b[1].at)) {
      if (d.at > now) continue
      due.delete(id)
      d.fn()
    }
    await flush()
  }
  const docFns = new Set<() => void>()
  const doc = {
    visibilityState: 'visible',
    addEventListener: (_t: string, fn: () => void) => void docFns.add(fn),
    removeEventListener: (_t: string, fn: () => void) => void docFns.delete(fn),
  }
  const setVisible = async (v: 'visible' | 'hidden') => {
    doc.visibilityState = v
    for (const fn of [...docFns]) fn()
    await flush()
  }
  const locks: Array<{ released: boolean; fire: () => void }> = []
  let requests = 0
  const request = async () => {
    requests++
    if (refuse) throw Object.assign(new Error('refused'), { name: 'NotAllowedError' })
    const fns: Array<() => void> = []
    const lock = {
      released: false,
      release: async () => {
        lock.released = true
      },
      addEventListener: (_t: 'release', fn: () => void) => void fns.push(fn),
      /** The browser letting go itself, as it does when the page is hidden. */
      fire: () => {
        lock.released = true
        for (const fn of fns) fn()
      },
    }
    locks.push(lock)
    return lock
  }
  const wake = createScreenWake({ request: supported ? request : null, doc, timers })
  return { wake, advance, flush, setVisible, locks, requests: () => requests, docFns, pending: () => due.size }
}

test('nothing is asked for while no answer is under way', async () => {
  const r = rig()
  await r.advance(30_000)
  assert.equal(r.requests(), 0)
  assert.equal(r.wake.held(), false)
})

test('the wait for the first word: held from the question on, 24 s of thinking included', async () => {
  const r = rig()
  const answer = {}
  r.wake.hold(answer, QUIET) // the speaker is made as the turn begins
  await r.flush()
  assert.equal(r.wake.held(), true, 'before any sound')
  await r.advance(24_000) // the slowest first word in the bridge log
  assert.equal(r.wake.held(), true)
  r.wake.hold(answer, QUIET) // the first sound renews the cap
  await r.advance(QUIET - 1)
  assert.equal(r.wake.held(), true, 'the cap counts from the last sound, not from the question')
  assert.equal(r.requests(), 1)
})

test('every hold is capped: a sound whose end never fires lets the screen go', async () => {
  const r = rig()
  const answer = {}
  r.wake.hold(answer, QUIET)
  await r.flush()
  await r.advance(QUIET - 1)
  assert.equal(r.wake.held(), true)
  await r.advance(1)
  assert.equal(r.wake.held(), false)
  assert.equal(r.wake.state().owners, 0)
  assert.equal(r.pending(), 0)
})

test('the first sound takes the lock, once, however many sentences follow', async () => {
  const r = rig()
  const answer = {}
  r.wake.hold(answer)
  await r.flush()
  r.wake.hold(answer)
  r.wake.hold(answer)
  await r.flush()
  assert.equal(r.requests(), 1)
  assert.equal(r.wake.held(), true)
})

test('a long answer: a 20 s pause mid-answer (a search) does not let the screen go', async () => {
  const r = rig()
  const answer = {}
  r.wake.hold(answer)
  await r.flush()
  await r.advance(5000)
  // The queue ran dry mid-answer: end() not called yet, so only the long cap runs.
  r.wake.letGo(answer, QUIET)
  await r.advance(20_000)
  assert.equal(r.wake.held(), true, 'still held through the pause')
  r.wake.hold(answer) // the next sentence starts
  await r.advance(60_000)
  assert.equal(r.wake.held(), true, 'the cap was cancelled by the new sound')
  assert.equal(r.requests(), 1)
})

test('a two-minute search mid-answer still keeps the screen on — the cap sits above any real turn', async () => {
  const r = rig()
  const answer = {}
  r.wake.hold(answer)
  await r.flush()
  r.wake.letGo(answer, QUIET)
  await r.advance(120_000) // the turn's own idle limit in bridge.ts
  assert.equal(r.wake.held(), true)
  await r.advance(60_000) // and its whole-turn limit
  assert.equal(r.wake.held(), true, 'a turn fails at 180 s and its speaker is cancelled before this cap')
  await r.advance(QUIET - 180_000)
  assert.equal(r.wake.held(), false, 'a speaker nothing ever ended is still let go')
})

test('every answer speaker is ended or cancelled by its turn, so the cap is only a backstop', () => {
  const bridge = readFileSync(new URL('../src/lib/bridge.ts', import.meta.url), 'utf8')
  const floor = readFileSync(new URL('../src/lib/floor.ts', import.meta.url), 'utf8').replace(/\r/g, '')
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  const limit = Number(/const TURN_LIMIT_MS = ([\d_]+)/.exec(bridge)?.[1].replace(/_/g, ''))
  assert.ok(limit > 0 && limit < QUIET, `TURN_LIMIT_MS ${limit} must stay below the cap ${QUIET}`)
  // A released speaker that did not finish is cancelled (a failed or stale turn).
  assert.match(floor, /unfinished\.set\(wrapped, \(\) => \{\n\s*if \(over\) return\n\s*raw\.cancel\(\)/)
  assert.match(app, /await spk\.end\(\)/)
  assert.match(app, /t\.release\(spk\)/)
})

test('the end of the whole answer: held 1.5 s more, then the screen is back on its own timer', async () => {
  const r = rig()
  const answer = {}
  r.wake.hold(answer)
  await r.flush()
  r.wake.letGo(answer, BETWEEN)
  await r.advance(BETWEEN - 1)
  assert.equal(r.wake.held(), true)
  await r.advance(1)
  assert.equal(r.wake.held(), false)
  assert.equal(r.locks[0].released, true)
  assert.equal(r.pending(), 0, 'no timer left behind')
})

test('answers in a row: the next answer starting within 1.5 s keeps the same lock', async () => {
  const r = rig()
  const first = {}
  const second = {}
  r.wake.hold(first)
  await r.flush()
  r.wake.letGo(first, BETWEEN)
  await r.advance(800)
  r.wake.hold(second)
  await r.advance(BETWEEN)
  assert.equal(r.wake.held(), true, 'not let go between the two answers')
  assert.equal(r.requests(), 1)
  r.wake.letGo(second, BETWEEN)
  await r.advance(BETWEEN)
  assert.equal(r.wake.held(), false)
  assert.ok(r.locks.every((l) => l.released))
})

test('"Стоп" lets go at once — but only for the answer that was stopped', async () => {
  const r = rig()
  const answer = {}
  r.wake.hold(answer)
  await r.flush()
  r.wake.letGo(answer, 0)
  await r.flush()
  assert.equal(r.wake.held(), false)
  assert.equal(r.locks[0].released, true)

  const greeting = {}
  const reply = {}
  r.wake.hold(greeting)
  r.wake.hold(reply)
  await r.flush()
  r.wake.letGo(greeting, 0)
  await r.flush()
  assert.equal(r.wake.held(), true, 'the other speaker still holds it')
})

test('an answer whose audio failed is still let go at its end', async () => {
  const r = rig()
  const answer = {}
  r.wake.hold(answer, QUIET)
  await r.flush()
  // No sound ever started; the queue ran dry and end() came.
  r.wake.letGo(answer, BETWEEN)
  await r.advance(BETWEEN)
  assert.equal(r.wake.held(), false)
  // A letGo for an owner that never held does nothing.
  r.wake.letGo({}, BETWEEN)
  assert.equal(r.pending(), 0)
})

test('a speaker that never says it has ended is let go after the cap, not held for good', async () => {
  const r = rig()
  const abandoned = {}
  r.wake.hold(abandoned)
  await r.flush()
  r.wake.letGo(abandoned, QUIET)
  await r.advance(QUIET)
  assert.equal(r.wake.held(), false)
})

test('stopped while the browser was still granting the lock: it is handed straight back', async () => {
  const r = rig()
  const answer = {}
  r.wake.hold(answer)
  r.wake.letGo(answer, 0)
  await r.flush()
  assert.equal(r.wake.held(), false)
  assert.equal(r.locks[0].released, true)
})

test('a hidden page asks for nothing; coming back mid-answer takes the lock again', async () => {
  const r = rig()
  const answer = {}
  await r.setVisible('hidden')
  r.wake.hold(answer)
  await r.flush()
  assert.equal(r.requests(), 0)
  await r.setVisible('visible')
  assert.equal(r.wake.held(), true)
})

test('the browser dropping the lock on hide: re-taken on return only while an answer is still being said', async () => {
  const r = rig()
  const answer = {}
  r.wake.hold(answer)
  await r.flush()
  await r.setVisible('hidden')
  r.locks[0].fire()
  assert.equal(r.wake.held(), false, 'a released lock is not reported as held')
  await r.setVisible('visible')
  assert.equal(r.wake.held(), true)
  assert.equal(r.requests(), 2)
  r.wake.letGo(answer, 0)
  await r.setVisible('hidden')
  r.locks[1].fire()
  await r.setVisible('visible')
  assert.equal(r.requests(), 2, 'he had finished: not taken again')
})

test('a lock marked released by the browser is replaced on the next sound', async () => {
  const r = rig()
  const answer = {}
  r.wake.hold(answer)
  await r.flush()
  r.locks[0].released = true // released without the event reaching us
  assert.equal(r.wake.held(), false)
  r.wake.hold(answer)
  await r.flush()
  assert.equal(r.requests(), 2)
  assert.equal(r.wake.held(), true)
})

test('a refused or missing API changes nothing for speech, and is not reported as held', async () => {
  const refused = rig({ refuse: true })
  refused.wake.hold({})
  await refused.flush()
  assert.deepEqual(refused.wake.state(), { supported: true, held: false, owners: 1, lastError: 'NotAllowedError' })
  const missing = rig({ supported: false })
  const a = {}
  missing.wake.hold(a)
  missing.wake.letGo(a, BETWEEN)
  await missing.advance(BETWEEN)
  assert.equal(missing.requests(), 0)
  assert.deepEqual(missing.wake.state(), { supported: false, held: false, owners: 0, lastError: '' })
})

test('disposing lets the lock go, clears the timers and removes the listener', async () => {
  const r = rig()
  const answer = {}
  r.wake.hold(answer)
  await r.flush()
  r.wake.letGo(answer, QUIET)
  r.wake.dispose()
  assert.equal(r.wake.held(), false)
  assert.equal(r.docFns.size, 0)
  assert.equal(r.pending(), 0)
})

test('wiring: held from the start of the answer to its end, renewed at each sound, at once on a stop', () => {
  const tts = readFileSync(new URL('../src/lib/tts.ts', import.meta.url), 'utf8').replace(/\r/g, '')
  assert.match(tts, /export const BETWEEN_ANSWERS_MS = 1500/)
  assert.match(tts, /export const QUIET_SPEAKER_MS = 200_000/)
  assert.match(tts, /u\.onstart = \(\) => \{[\s\S]{0,120}soundStarted\(\)/, 'system voice')
  assert.match(tts, /audio\.onplaying = \(\) => \{[\s\S]{0,120}soundStarted\(\)/, 'Piper / cloud audio')
  assert.match(tts, /let ending = false\n {2}screenWake\.hold\(wakeOwner, QUIET_SPEAKER_MS\)\n/, 'taken as the speaker is made, capped')
  assert.match(tts, /const soundStarted = \(\) => screenWake\.hold\(wakeOwner, QUIET_SPEAKER_MS\)/)
  assert.match(tts, /screenWake\.letGo\(wakeOwner, ending \? BETWEEN_ANSWERS_MS : QUIET_SPEAKER_MS\)/)
  assert.match(tts, /if \(!cancelled && !queue\.length\) queueDry\(\)/, 'the queue running dry')
  assert.match(tts, /async end\(\) \{\n {6}ending = true/, 'end() marks the answer complete')
  assert.match(tts, /screenWake\.letGo\(wakeOwner, 0\)/, 'a stop')
  assert.equal((tts.match(/screenWake\.hold\(/g) ?? []).length, 2, 'at the start and at each sound, nowhere else')
  assert.doesNotMatch(tts, /screenWake\.hold\(wakeOwner\)/, 'never without a cap')
  assert.doesNotMatch(tts.slice(tts.indexOf('function setSpeaking'), tts.indexOf('function setSpeaking') + 800), /screenWake/, 'no longer let go per sentence')
})
