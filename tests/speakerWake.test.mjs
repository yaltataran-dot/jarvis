/**
 * The real speaker (tts.ts) against a fake browser: speech engine, Wake Lock
 * and clock. The screenWake tests check the lock on its own and the wiring
 * test checks the calls are there; this one runs a whole answer through
 * createSpeaker and watches the lock — the path that differed on the phone.
 *
 * tts.ts reads import.meta.env through config.ts, so it is loaded the way the
 * page gets it, through Vite.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'

const QUIET = 200_000
const BETWEEN = 1500

// -- a fake clock ----------------------------------------------------------
let now = 0
let seq = 0
const due = new Map()
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}
async function advance(ms) {
  const end = now + ms
  for (;;) {
    const next = [...due].sort((a, b) => a[1].at - b[1].at)[0]
    if (!next || next[1].at > end) break
    now = next[1].at
    due.delete(next[0])
    next[1].fn()
    await flush()
  }
  now = end
  await flush()
}

// -- a fake browser -------------------------------------------------------
const doc = {
  visibilityState: 'visible',
  fns: new Set(),
  addEventListener(_t, fn) {
    this.fns.add(fn)
  },
  removeEventListener(_t, fn) {
    this.fns.delete(fn)
  },
}
let requests = 0
let sentinel = null
const wakeLock = {
  async request() {
    requests++
    const fns = []
    const s = {
      released: false,
      async release() {
        s.released = true
      },
      addEventListener: (_t, fn) => fns.push(fn),
      fire() {
        s.released = true
        for (const fn of fns) fn()
      },
    }
    sentinel = s
    return s
  },
}
const held = () => Boolean(sentinel && !sentinel.released)

/** Each utterance starts at once and lasts `sentenceMs`, unless `hang` (onend never fires). */
const engine = { sentenceMs: 3000, hang: false, spoken: [] }
let current = null

let tts
let server
const saved = {}

before(async () => {
  const g = globalThis
  for (const k of ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'localStorage', 'document', 'speechSynthesis', 'SpeechSynthesisUtterance', 'requestAnimationFrame', 'cancelAnimationFrame', 'fetch', 'window', 'Audio']) {
    saved[k] = g[k]
  }
  // Vite itself needs the real timers while it starts.
  server = await createServer({ configFile: false, root: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), logLevel: 'silent', server: { middlewareMode: true, hmr: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } })

  g.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
  g.document = doc
  g.window = g
  Object.defineProperty(g.navigator, 'wakeLock', { value: wakeLock, configurable: true })
  g.requestAnimationFrame = () => 0
  g.cancelAnimationFrame = () => {}
  g.fetch = async () => {
    throw new Error('offline in the test')
  }
  g.SpeechSynthesisUtterance = class {
    constructor(text) {
      this.text = text
    }
  }
  g.speechSynthesis = {
    getVoices: () => [],
    resume() {},
    pause() {},
    cancel() {
      const u = current
      current = null
      u?.onerror?.({ error: 'interrupted' })
    },
    speak(u) {
      current = u
      engine.spoken.push(u.text)
      g.setTimeout(() => {
        if (current !== u) return
        u.onstart?.()
        if (engine.hang) return
        g.setTimeout(() => {
          if (current !== u) return
          current = null
          u.onend?.()
        }, engine.sentenceMs)
      }, 10)
    },
    addEventListener() {},
  }
  g.setTimeout = (fn, ms = 0) => {
    due.set(++seq, { at: now + ms, fn })
    return seq
  }
  g.clearTimeout = (t) => void due.delete(t)
  g.setInterval = () => 0
  g.clearInterval = () => {}

  tts = await server.ssrLoadModule('/src/lib/tts.ts')
})

after(async () => {
  const g = globalThis
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete g[k]
    else g[k] = v
  }
  delete g.navigator.wakeLock
  await server.close()
})

async function reset() {
  await advance(QUIET * 2) // let any earlier speaker's timers run out
  sentinel = null
  requests = 0
  engine.sentenceMs = 3000
  engine.hang = false
  engine.spoken = []
  doc.visibilityState = 'visible'
}

test('the lock is taken as the answer begins — before the first word, through a 24 s wait', async () => {
  await reset()
  const spk = tts.createSpeaker()
  await flush()
  assert.equal(held(), true, 'held while he thinks')
  await advance(24_000)
  assert.equal(held(), true, 'still held when the first word is 24 s away')
  spk.push('Краснодарский край расположен на юге России. ')
  await advance(1000)
  assert.equal(held(), true)
  spk.cancel()
  await flush()
  assert.equal(held(), false)
})

test('a long answer: a search between sentences does not let go; the end does, after 1.5 s', async () => {
  await reset()
  const spk = tts.createSpeaker()
  spk.say('Сейчас поищу.')
  await advance(3100) // the filler is said; the queue runs dry
  assert.equal(held(), true)
  await advance(30_000) // the search
  assert.equal(held(), true, 'not let go in the pause')
  spk.push('Краснодарский край — один из крупнейших регионов. Его столица — Краснодар. ')
  await advance(7000)
  const ended = spk.end()
  await advance(100)
  await ended
  assert.equal(held(), true, 'held for the step to the next answer')
  await advance(BETWEEN)
  assert.equal(held(), false, 'back on the phone\'s own timer')
  assert.equal(requests, 1, 'one lock for the whole answer')
})

test('"Стоп" mid-sentence lets go at once', async () => {
  await reset()
  const spk = tts.createSpeaker()
  spk.push('Это очень длинное предложение, которое он произносит. ')
  await advance(500)
  assert.equal(held(), true)
  spk.cancel()
  await flush()
  assert.equal(held(), false)
  await advance(BETWEEN)
  assert.equal(requests, 1, 'not taken again after the stop')
})

test('answers in a row: one lock, never dropped between them', async () => {
  await reset()
  for (let i = 0; i < 3; i++) {
    const spk = tts.createSpeaker()
    await advance(5000) // thinking
    assert.equal(held(), true, `answer ${i + 1}: held while thinking`)
    spk.push('Ответ готов. ')
    await advance(3100)
    const ended = spk.end()
    await advance(10)
    await ended
    await advance(800) // the next question comes within 1.5 s
    assert.equal(held(), true, `answer ${i + 1}: not dropped before the next`)
  }
  await advance(BETWEEN)
  assert.equal(held(), false)
  assert.equal(requests, 1)
})

test('a sentence whose end never fires is let go after the cap, not held for good', async () => {
  await reset()
  engine.hang = true
  const spk = tts.createSpeaker()
  spk.push('Это предложение никогда не закончится. ')
  await advance(QUIET - 1000)
  assert.equal(held(), true)
  await advance(2000)
  assert.equal(held(), false)
  spk.cancel()
})

test('hidden mid-answer and back: the lock is taken again while he is still speaking', async () => {
  await reset()
  engine.sentenceMs = 20_000
  const spk = tts.createSpeaker()
  spk.push('Длинное предложение. ')
  await advance(1000)
  doc.visibilityState = 'hidden'
  sentinel.fire() // the browser drops it on hide
  for (const fn of doc.fns) fn()
  await advance(2000)
  assert.equal(held(), false)
  doc.visibilityState = 'visible'
  for (const fn of doc.fns) fn()
  await flush()
  assert.equal(held(), true)
  assert.equal(requests, 2)
  spk.cancel()
  await flush()
  assert.equal(held(), false)
})
