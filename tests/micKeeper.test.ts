import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMicKeeper } from '../src/lib/audio.ts'

/** A stream whose tracks can be ended the way a phone ends them on lock. */
function fakeStream(id: number) {
  const ended: Array<() => void> = []
  const track = {
    readyState: 'live',
    stopped: false,
    stop() {
      this.readyState = 'ended'
      this.stopped = true
    },
    addEventListener: (_type: 'ended', fn: () => void) => void ended.push(fn),
  }
  return {
    id,
    track,
    getAudioTracks: () => [track],
    /** The browser ending the track itself: lock screen, unplugged, revoked. */
    endByBrowser() {
      track.readyState = 'ended'
      for (const fn of ended) fn()
    },
  }
}

function rig() {
  const opened: ReturnType<typeof fakeStream>[] = []
  const keeper = createMicKeeper(async () => {
    const s = fakeStream(opened.length + 1)
    opened.push(s)
    return s
  })
  return { keeper, opened }
}

test('a live stream is handed out again, not reopened', async () => {
  const { keeper, opened } = rig()
  const a = await keeper.get()
  const b = await keeper.get()
  assert.equal(a, b)
  assert.equal(opened.length, 1)
  assert.equal(keeper.alive(), true)
})

test('two requests at once share one getUserMedia', async () => {
  const { keeper, opened } = rig()
  const [a, b] = await Promise.all([keeper.get(), keeper.get()])
  assert.equal(a, b)
  assert.equal(opened.length, 1)
})

test('a stream the browser ended is let go and a fresh one opened on the next request', async () => {
  const { keeper, opened } = rig()
  const first = await keeper.get()
  first.endByBrowser()
  assert.equal(keeper.alive(), false)
  const second = await keeper.get()
  assert.notEqual(second, first)
  assert.equal(opened.length, 2)
  assert.equal(keeper.alive(), true)
})

test('the browser ending the stream in use is reported once; release() is not', async () => {
  const { keeper } = rig()
  let ended = 0
  const off = keeper.onEnded(() => ended++)
  const first = await keeper.get()
  first.endByBrowser()
  assert.equal(ended, 1)
  // Our own release stops the tracks without announcing a loss.
  const second = await keeper.get()
  keeper.release()
  assert.equal(second.track.stopped, true)
  assert.equal(ended, 1)
  // An old stream ending after it was replaced is history, not news.
  first.endByBrowser()
  assert.equal(ended, 1)
  off()
  const third = await keeper.get()
  third.endByBrowser()
  assert.equal(ended, 1, 'unsubscribed')
})

test('release() stops the tracks and the next request reopens', async () => {
  const { keeper, opened } = rig()
  const first = await keeper.get()
  keeper.release()
  assert.equal(first.track.stopped, true)
  assert.equal(keeper.alive(), false)
  assert.equal(keeper.current(), null)
  await keeper.get()
  assert.equal(opened.length, 2)
})

test('a refused request leaves nothing behind and can be asked again', async () => {
  let n = 0
  const keeper = createMicKeeper(async () => {
    n++
    if (n === 1) throw Object.assign(new Error('denied'), { name: 'NotAllowedError' })
    return fakeStream(n)
  })
  await assert.rejects(keeper.get(), /denied/)
  assert.equal(keeper.alive(), false)
  const s = await keeper.get()
  assert.equal(s.id, 2)
  assert.equal(keeper.alive(), true)
})
