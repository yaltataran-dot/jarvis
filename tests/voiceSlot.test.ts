import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeVoiceSlot } from '../src/lib/voiceSlot.ts'

/**
 * Voice loops as the slot sees them: each launch is one microphone plus one
 * recogniser, live until stopped. `running()` counts the loops hearing at
 * once — the number that must never pass one.
 */
function loops() {
  const all: Array<{ n: number; stopped: boolean; works: boolean; stop: () => void; ok: () => boolean }> = []
  /** Launches that have not come back yet, resolved by the test. */
  const waiting: Array<() => void> = []
  let works = true
  let held = false
  const launch = () =>
    new Promise<(typeof all)[number]>((resolve) => {
      const v = {
        n: all.length + 1,
        stopped: false,
        works,
        stop: () => {
          v.stopped = true
        },
        ok: () => v.works && !v.stopped,
      }
      all.push(v)
      if (held) waiting.push(() => resolve(v))
      else resolve(v)
    })
  return {
    all,
    launch,
    running: () => all.filter((v) => !v.stopped && v.works).length,
    /** The next launches fail, as a refused microphone does. */
    failing: (on: boolean) => (works = !on),
    /** The next launches wait to be released, as a permission prompt does. */
    hold: (on: boolean) => (held = on),
    release: () => waiting.splice(0).forEach((r) => r()),
  }
}

test('INITIALISE pressed twice: one voice loop', async () => {
  const l = loops()
  const slot = makeVoiceSlot(l.launch)
  l.hold(true)
  const a = slot.start()
  const b = slot.start()
  l.release()
  const [va, vb] = await Promise.all([a, b])
  assert.equal(va, vb, 'both presses get the same loop')
  assert.equal(l.all.length, 1, 'launched once')
  // And again once it runs.
  assert.equal(await slot.start(), va)
  assert.equal(l.all.length, 1)
  assert.equal(l.running(), 1)
})

test('the bridge reconnecting does not touch the voice loop', async () => {
  // The bridge is the brain's socket; the loop is the microphone's. A
  // reconnect asks nothing of the slot — only a dead loop is ever replaced.
  const l = loops()
  const slot = makeVoiceSlot(l.launch)
  const v = await slot.start()
  // Whatever the page does on 'lost' and 'reconnected' that touches the
  // voice at all goes through start(), which keeps a working loop.
  await slot.start()
  await slot.start()
  assert.equal(slot.current(), v)
  assert.equal(l.all.length, 1)
  assert.equal(l.running(), 1)
})

test('the interface mounted again: the old loop is stopped before the new one starts', async () => {
  const l = loops()
  const slot = makeVoiceSlot(l.launch)
  const first = await slot.start()
  slot.stop() // unmount
  assert.equal(first.stopped, true)
  assert.equal(slot.current(), null)
  const second = await slot.start() // mount again
  assert.notEqual(second, first)
  assert.equal(l.all.length, 2)
  assert.equal(l.running(), 1, 'one loop hearing, never two')
})

test('unmounted while the loop was still starting: it is stopped the moment it arrives', async () => {
  const l = loops()
  const slot = makeVoiceSlot(l.launch)
  l.hold(true)
  const starting = slot.start()
  slot.stop() // the page came down during the permission prompt
  // Mounted again before the first launch came back.
  const again = slot.start()
  l.release()
  const orphan = await starting
  assert.equal(orphan.stopped, true, 'the unwanted loop stopped itself')
  l.release() // the second launch, which waited for the first
  const v = await again
  assert.equal(v.stopped, false)
  assert.equal(slot.current(), v)
  assert.equal(l.running(), 1)
})

test('a refused microphone, then started again: the dead loop is replaced, not joined', async () => {
  const l = loops()
  const slot = makeVoiceSlot(l.launch)
  l.failing(true)
  const dead = await slot.start()
  assert.equal(dead.ok(), false)
  assert.equal(l.running(), 0)
  l.failing(false)
  const live = await slot.start() // Space, after allowing the microphone
  assert.equal(live.ok(), true)
  assert.equal(dead.stopped, true)
  assert.equal(l.all.length, 2)
  assert.equal(l.running(), 1)
})
