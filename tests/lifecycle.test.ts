import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  MAX_AUTO_RESTARTS,
  RESTART_WINDOW_MS,
  armTapOnce,
  createRecoveryGate,
  isInteractive,
  planRecovery,
  recentCount,
  watchLifecycle,
  type RecoveryState,
  type ShowReason,
} from '../src/lib/lifecycle.ts'

/** Something events can be added to and fired on, counting what is attached. */
function target<T extends object>(extra: T) {
  const fns = new Map<string, Set<(e: Event) => void>>()
  return Object.assign(extra, {
    addEventListener: (type: string, fn: (e: Event) => void) => {
      if (!fns.has(type)) fns.set(type, new Set())
      fns.get(type)!.add(fn)
    },
    removeEventListener: (type: string, fn: (e: Event) => void) => void fns.get(type)?.delete(fn),
    fire: (type: string, e: object = {}) => {
      for (const fn of [...(fns.get(type) ?? [])]) fn(e as Event)
    },
    attached: () => [...fns.values()].reduce((n, s) => n + s.size, 0),
  })
}

function rig(start: 'visible' | 'hidden' = 'visible') {
  const doc = target({ visibilityState: start as string })
  const win = target({})
  const shown: string[] = []
  const hidden: string[] = []
  const stop = watchLifecycle({ doc, win, onShow: (r) => shown.push(r), onHide: (r) => hidden.push(r) })
  const setVisible = (v: 'visible' | 'hidden') => {
    doc.visibilityState = v
    doc.fire('visibilitychange')
  }
  return { doc, win, shown, hidden, stop, setVisible }
}

test('coming back to the screen is reported once per return; hiding changes nothing', () => {
  const r = rig()
  r.setVisible('hidden')
  assert.deepEqual(r.shown, [], 'hiding is not a return')
  assert.deepEqual(r.hidden, [], 'and does not let go of the microphone (a computer keeps it in a hidden tab)')
  r.setVisible('visible')
  r.setVisible('visible')
  assert.deepEqual(r.shown, ['visible'], 'a repeated visible event is not a second return')
  r.setVisible('hidden')
  r.setVisible('visible')
  assert.deepEqual(r.shown, ['visible', 'visible'])
})

test('a page that loads hidden reports its first time on screen', () => {
  const r = rig('hidden')
  r.setVisible('visible')
  assert.deepEqual(r.shown, ['visible'])
})

test('the back-forward cache: pagehide lets go, a restored pageshow comes back, a fresh load does not', () => {
  const r = rig()
  r.win.fire('pagehide', { persisted: true })
  assert.deepEqual(r.hidden, ['pagehide'])
  r.win.fire('pageshow', { persisted: false })
  assert.deepEqual(r.shown, [], 'a fresh load is the boot\'s business')
  r.win.fire('pageshow', { persisted: true })
  assert.deepEqual(r.shown, ['pageshow'])
})

test('the network coming back is a return too', () => {
  const r = rig()
  r.win.fire('offline')
  assert.deepEqual(r.shown, [])
  r.win.fire('online')
  assert.deepEqual(r.shown, ['online'])
})

test('unwatching removes every listener it added', () => {
  const r = rig()
  assert.equal(r.doc.attached() + r.win.attached(), 4)
  r.stop()
  assert.equal(r.doc.attached() + r.win.attached(), 0)
  r.setVisible('hidden')
  r.setVisible('visible')
  r.win.fire('online')
  assert.deepEqual(r.shown, [])
})

const ok: RecoveryState = { visible: true, micAlive: true, voiceOk: true, permission: 'granted', recentRestarts: 0 }

test('nothing is touched while the microphone hears and the loop works', () => {
  assert.equal(planRecovery(ok), 'none')
  assert.equal(planRecovery({ ...ok, permission: 'unknown' }), 'none', 'not even where permission is unknown')
})

test('a dead stream or a dead loop is restarted where the microphone is allowed', () => {
  assert.equal(planRecovery({ ...ok, micAlive: false }), 'restart', 'the loop calls itself working on a dead stream')
  assert.equal(planRecovery({ ...ok, voiceOk: false }), 'restart')
})

test('a hidden page waits: a phone will not give it the microphone', () => {
  assert.equal(planRecovery({ ...ok, visible: false, micAlive: false }), 'wait')
})

test('without a granted permission the microphone is never requested unprompted: a touch is asked for', () => {
  for (const permission of ['prompt', 'denied', 'unknown'] as const) {
    assert.equal(planRecovery({ ...ok, micAlive: false, permission }), 'tap', permission)
  }
})

test('a stream that keeps dying is not reopened in a loop', () => {
  assert.equal(planRecovery({ ...ok, micAlive: false, recentRestarts: MAX_AUTO_RESTARTS - 1 }), 'restart')
  assert.equal(planRecovery({ ...ok, micAlive: false, recentRestarts: MAX_AUTO_RESTARTS }), 'tap')
})

test('restarts are counted within the window only', () => {
  const stamps = [0, 10_000, 60_000]
  assert.equal(recentCount(stamps, 60_000), 3)
  assert.equal(recentCount(stamps, RESTART_WINDOW_MS + 10_001), 1, 'the two oldest have left the window')
  assert.deepEqual(stamps, [60_000])
  assert.equal(recentCount([], 1), 0)
})

/** Timers driven by hand, so a burst of events can be replayed exactly. */
function clock() {
  let now = 0
  let seq = 0
  const due = new Map<number, { at: number; fn: () => void }>()
  return {
    timers: {
      setTimeout: (fn: () => void, ms: number) => {
        due.set(++seq, { at: now + ms, fn })
        return seq
      },
      clearTimeout: (t: unknown) => void due.delete(t as number),
    },
    /** Move time on, running whatever falls due, then let promises settle. */
    async advance(ms: number) {
      now += ms
      for (const [id, d] of [...due].sort((a, b) => a[1].at - b[1].at)) {
        if (d.at <= now) {
          due.delete(id)
          d.fn()
        }
      }
      for (let i = 0; i < 5; i++) await Promise.resolve()
    },
    pending: () => due.size,
  }
}

test('a burst of returns — unlock: visible, then online, then pageshow — is one recovery', async () => {
  const c = clock()
  const runs: ShowReason[][] = []
  const gate = createRecoveryGate(async (r) => void runs.push(r), { settleMs: 1500, timers: c.timers })
  gate.schedule('visible')
  await c.advance(400)
  gate.schedule('online')
  await c.advance(400)
  gate.schedule('pageshow')
  await c.advance(1499)
  assert.deepEqual(runs, [], 'still settling')
  await c.advance(1)
  assert.deepEqual(runs, [['visible', 'online', 'pageshow']])
  assert.equal(c.pending(), 0)
})

test('a return during a recovery is not dropped, and does not run two at once', async () => {
  const c = clock()
  const runs: ShowReason[][] = []
  let active = 0
  let most = 0
  let release: () => void = () => {}
  const gate = createRecoveryGate(
    async (r) => {
      runs.push(r)
      active++
      most = Math.max(most, active)
      await new Promise<void>((ok) => (release = ok))
      active--
    },
    { settleMs: 100, timers: c.timers },
  )
  gate.schedule('visible')
  await c.advance(100)
  assert.equal(runs.length, 1)
  gate.schedule('online')
  await c.advance(100)
  assert.equal(runs.length, 1, 'waits for the first to finish')
  release()
  await c.advance(0)
  assert.equal(runs.length, 2)
  assert.deepEqual(runs[1], ['online'])
  release()
  await c.advance(0)
  assert.equal(most, 1, 'never two recoveries at once')
})

test('a closed gate runs nothing more', async () => {
  const c = clock()
  const runs: ShowReason[][] = []
  const gate = createRecoveryGate(async (r) => void runs.push(r), { settleMs: 100, timers: c.timers })
  gate.schedule('visible')
  gate.close()
  await c.advance(500)
  gate.schedule('online')
  await c.advance(500)
  assert.deepEqual(runs, [])
})

/** Something with closest(), like a DOM element inside the given selectors. */
const el = (inside: boolean) => ({ closest: (s: string) => (inside && s.includes('button') ? {} : null) })

test('taps on buttons, panels and dialogs are theirs; a tap on the page is not', () => {
  assert.equal(isInteractive(el(true)), true)
  assert.equal(isInteractive(el(false)), false)
  assert.equal(isInteractive(null), false)
  assert.equal(isInteractive({}), false, 'a target with no closest() (the window) is the page')
})

test('the tap restart waits through taps on controls, then fires once on the page and stops waiting', () => {
  const win = (() => {
    const fns = new Set<(e: Event) => void>()
    return {
      addEventListener: (_t: string, fn: (e: Event) => void) => void fns.add(fn),
      removeEventListener: (_t: string, fn: (e: Event) => void) => void fns.delete(fn),
      tap: (target: unknown) => {
        for (const fn of [...fns]) fn({ target } as unknown as Event)
      },
      size: () => fns.size,
    }
  })()
  let taps = 0
  const disarm = armTapOnce(win, () => taps++)
  win.tap(el(true))
  win.tap(el(true))
  assert.equal(taps, 0, 'a button press is not a request for the microphone')
  assert.equal(win.size(), 3, 'still waiting (down, cancel and up are watched)')
  win.tap(el(false))
  assert.equal(taps, 1)
  assert.equal(win.size(), 0, 'stopped waiting')
  win.tap(el(false))
  assert.equal(taps, 1, 'once')
  disarm()
  const again = armTapOnce(win, () => taps++)
  again()
  win.tap(el(false))
  assert.equal(taps, 1, 'disarmed before any tap')
})

test('the tap restart listens to the finger lifting (a gesture on a phone), one event only, primary pointer only', () => {
  const seen: string[] = []
  const fns = new Map<string, (e: Event) => void>()
  const win = {
    addEventListener: (t: string, fn: (e: Event) => void) => {
      seen.push(t)
      fns.set(t, fn)
    },
    removeEventListener: (t: string) => void fns.delete(t),
  }
  let taps = 0
  armTapOnce(win, () => taps++)
  assert.equal(seen.filter((t) => t !== 'pointerdown' && t !== 'pointercancel').join(), 'pointerup', 'the restart is on the lift: a touch is a gesture only when it lifts; not click: iOS sends none for page areas')
  const plain = { closest: () => null }
  fns.get('pointerup')!({ target: plain, isPrimary: false, pointerType: 'touch' } as unknown as Event)
  assert.equal(taps, 0, 'a second finger is not a tap')
  fns.get('pointerup')!({ target: plain, isPrimary: true, pointerType: 'touch' } as unknown as Event)
  assert.equal(taps, 1, 'a finger lifting restarts')
  assert.equal(fns.size, 0, 'and it stops listening: one tap, one restart')
  // A mouse goes through the same path.
  armTapOnce(win, () => taps++)
  fns.get('pointerup')!({ target: plain, isPrimary: true, pointerType: 'mouse' } as unknown as Event)
  assert.equal(taps, 2)
})

test('zooming with two fingers, or panning, is not a tap: the microphone is not restarted by it', () => {
  const fns = new Map<string, (e: Event) => void>()
  const win = {
    addEventListener: (t: string, fn: (e: Event) => void) => void fns.set(t, fn),
    removeEventListener: (t: string) => void fns.delete(t),
  }
  const plain = { closest: () => null }
  const fire = (t: string, id: number, x: number, y: number, isPrimary = id === 1) =>
    fns.get(t)?.({ target: plain, pointerId: id, isPrimary, clientX: x, clientY: y, pointerType: 'touch' } as unknown as Event)
  let taps = 0
  armTapOnce(win, () => taps++)
  // A pinch: two fingers down, spread, lifted — primary first, then the other.
  fire('pointerdown', 1, 200, 400)
  fire('pointerdown', 2, 220, 460)
  fire('pointerup', 1, 150, 300)
  fire('pointerup', 2, 280, 560)
  assert.equal(taps, 0, 'a pinch is not a tap')
  // The other order: the second finger lifts first.
  fire('pointerdown', 1, 200, 400)
  fire('pointerdown', 2, 220, 460)
  fire('pointerup', 2, 280, 560)
  fire('pointerup', 1, 200, 400)
  assert.equal(taps, 0, 'nor when the primary finger lifts last, where it began')
  // A pan: one finger, moved.
  fire('pointerdown', 1, 200, 400)
  fire('pointerup', 1, 200, 470)
  assert.equal(taps, 0, 'a pan is not a tap')
  // A gesture the browser took over (zoom) ends in pointercancel: forgotten.
  fire('pointerdown', 1, 200, 400)
  fire('pointerdown', 2, 220, 460)
  fns.get('pointercancel')!({ pointerId: 1 } as unknown as Event)
  fns.get('pointercancel')!({ pointerId: 2 } as unknown as Event)
  // And after all of that, a real tap still restarts — once.
  fire('pointerdown', 1, 200, 400)
  fire('pointerup', 1, 204, 403)
  assert.equal(taps, 1, 'a tap, a few pixels of jitter included')
  assert.equal(fns.size, 0, 'every listener removed after the one tap')
})

test('wiring: the microphone ending does not restart the loop, and the tap restart does not wake him', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(app, /onMicEnded\(/, 'no restart on the track ending: it killed a working fallback, in a loop')
  assert.match(app, /createRecoveryGate\(recover\)/, 'returns go through the gate')
  assert.match(app, /onShow: \(reason\) => gate\.schedule\(reason\)/)
  assert.match(app, /armTapOnce\(window,/, 'the tap ignores controls')
  const quiet = /const quietRestart = async \(\) => \{([\s\S]*?)\r?\n {4}\}\r?\n/.exec(app)?.[1] ?? ''
  assert.ok(quiet, 'quietRestart found')
  assert.doesNotMatch(quiet, /listenWhenReady|onWake|retryVoice/, 'a tap restarts the microphone only; it does not open it for a question')
})
