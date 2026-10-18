import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CHECK_EVERY_MS, DIAL_TIMEOUT_MS, PONG_WAIT_MS, REDIAL_DELAYS_MS, createLink } from '../src/lib/redial.ts'

/** A WebSocket the test opens, fails and drops by hand. */
class FakeSocket {
  readyState = 0
  onopen: ((e: unknown) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  onclose: ((e: unknown) => void) | null = null
  closeCalls = 0
  open() {
    this.readyState = 1
    this.onopen?.({})
  }
  /** The dial failed: the bridge down, the network gone. */
  fail() {
    this.readyState = 3
    this.onerror?.({})
    this.onclose?.({})
  }
  /** An open socket dropped by the other side. */
  drop() {
    this.readyState = 3
    this.onclose?.({})
  }
  /** As a browser does: closing now, the close event later (`finish`). */
  close() {
    this.closeCalls += 1
    if (this.readyState < 2) this.readyState = 2
  }
  finish() {
    this.readyState = 3
    this.onclose?.({})
  }
}

function rig(opts: { throwOnMake?: () => boolean } = {}) {
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
  /** Runs every timer that comes due, in order, as time passes. */
  const advance = async (ms: number) => {
    const end = now + ms
    for (;;) {
      const next = [...due].filter(([, d]) => d.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (!next) break
      now = next[1].at
      due.delete(next[0])
      next[1].fn()
      await flush()
    }
    now = end
    await flush()
  }
  const sockets: FakeSocket[] = []
  const events: string[] = []
  const page = { visible: true }
  /** The sockets asked for a sign of life, in order. */
  const pings: FakeSocket[] = []
  const link = createLink<FakeSocket>({
    make: () => {
      if (opts.throwOnMake?.()) throw new Error('bad url')
      const ws = new FakeSocket()
      sockets.push(ws)
      return ws
    },
    opened: (ws) => void events.push(`open#${sockets.indexOf(ws)}`),
    lost: (ws) => void events.push(`lost#${sockets.indexOf(ws)}`),
    failure: (why) => new Error(why),
    ping: (ws) => void pings.push(ws),
    visible: () => page.visible,
    gaveUp: () => void events.push('gave-up'),
    timers,
  })
  /** Re-dial timers waiting (the dial timeout of a socket being made is not one). */
  const redials = () => (link.waiting() ? 1 : 0)
  /** The bridge answers the last ping on `ws`. */
  const pong = (ws: FakeSocket) => link.heard(ws, true)
  // Timers due, less the page's own check that runs for its whole life once it has dialled.
  const timersDue = () => due.size - 1
  return { link, sockets, events, page, pings, pong, advance, redials, last: () => sockets.at(-1)!, timersDue }
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

test('a failed first dial (the bridge down at boot) is retried, and every failed retry schedules the next', async () => {
  const r = rig()
  const first = r.link.connect()
  r.last().fail()
  await assert.rejects(first, /error/)
  assert.equal(r.redials(), 1, 'the next attempt is waiting')
  for (const [i, wait] of REDIAL_DELAYS_MS.slice(0, 3).entries()) {
    const before = r.sockets.length
    await r.advance(wait - 1)
    assert.equal(r.sockets.length, before, 'not before its wait')
    await r.advance(1)
    assert.equal(r.sockets.length, before + 1, `retry ${i + 1} dialled`)
    r.last().fail()
    await flush()
    assert.equal(r.redials(), 1, `retry ${i + 1} failed and the one after it is waiting`)
  }
  assert.equal(r.link.attempts(), 4, 'three made, the fourth waiting')
})

test('after several failures the bridge comes back: one socket, the count reset, nothing left waiting', async () => {
  const r = rig()
  r.link.connect().catch(() => {})
  r.last().fail()
  await flush()
  await r.advance(REDIAL_DELAYS_MS[0])
  r.last().fail()
  await flush()
  await r.advance(REDIAL_DELAYS_MS[1])
  r.last().open()
  await flush()
  assert.deepEqual(r.events, ['open#2'])
  assert.equal(r.link.socket(), r.sockets[2])
  assert.equal(r.link.attempts(), 0, 'reset on success')
  assert.equal(r.redials(), 0)
  r.link.heard(r.last()) // the bridge's `ready`
  assert.equal(r.timersDue(), 0, 'the dial timeout is cleared too')
  await r.advance(60_000)
  assert.equal(r.sockets.length, 3, 'nothing more is dialled while it is open')
  // And a later drop gets the whole backoff again, from the first wait.
  r.last().drop()
  await r.advance(REDIAL_DELAYS_MS[0])
  assert.equal(r.sockets.length, 4)
})

test('the live socket closing is reported once and re-dialled after the first wait; a failed dial is not a lost session', async () => {
  const r = rig()
  const p = r.link.connect()
  r.last().open()
  assert.equal(await p, r.sockets[0])
  r.sockets[0].drop()
  await flush()
  assert.deepEqual(r.events, ['open#0', 'lost#0'])
  assert.equal(r.link.socket(), null)
  await r.advance(REDIAL_DELAYS_MS[0])
  assert.equal(r.sockets.length, 2)
  r.last().fail()
  await flush()
  assert.deepEqual(r.events, ['open#0', 'lost#0'], 'no second "lost" for a dial that never opened')
  await r.advance(REDIAL_DELAYS_MS[1])
  r.last().open()
  await flush()
  assert.deepEqual(r.events, ['open#0', 'lost#0', 'open#2'])
})

test('a hidden page stops after the last wait, says so once, and dials nothing after that without being asked', async () => {
  const r = rig()
  r.page.visible = false
  r.link.connect().catch(() => {})
  r.last().fail()
  await flush()
  for (const wait of REDIAL_DELAYS_MS) {
    await r.advance(wait)
    r.last().fail()
    await flush()
  }
  assert.equal(r.sockets.length, 1 + REDIAL_DELAYS_MS.length)
  assert.equal(r.redials(), 0)
  await r.advance(3_600_000)
  assert.equal(r.sockets.length, 1 + REDIAL_DELAYS_MS.length, 'bounded')
  assert.deepEqual(r.events, ['gave-up'], 'reported once')
})

test('a page on screen goes on trying after the quick retries, once every check, without starting them again', async () => {
  const r = rig()
  r.link.connect().catch(() => {})
  r.last().fail()
  await flush()
  for (const wait of REDIAL_DELAYS_MS) {
    await r.advance(wait)
    r.last().fail()
    await flush()
  }
  assert.deepEqual(r.events, ['gave-up'])
  const count = r.sockets.length
  // Just past the first check (the quick retries took less than one period).
  const spent = REDIAL_DELAYS_MS.reduce((a, b) => a + b, 0)
  for (let i = 0; i < 3; i++) {
    await r.advance(i === 0 ? CHECK_EVERY_MS - spent + 100 : CHECK_EVERY_MS)
    assert.equal(r.last().readyState, 0, 'a dial made by this check')
    r.last().fail()
    await flush()
  }
  assert.equal(r.sockets.length - count, 3, 'one dial per check')
  assert.equal(r.redials(), 0, 'no quick retries started by them')
  assert.deepEqual(r.events, ['gave-up'], 'not reported again in the same outage')
  await r.advance(CHECK_EVERY_MS)
  r.last().open()
  await flush()
  assert.deepEqual(r.events, ['gave-up', `open#${r.sockets.length - 1}`], 'back on its own, no reload')
})

test('concurrent requests share one dial: one socket, one promise, no extra timer', async () => {
  const r = rig()
  const a = r.link.connect()
  const b = r.link.connect()
  r.link.now()
  r.link.now()
  assert.equal(a, b)
  assert.equal(r.sockets.length, 1)
  assert.equal(r.timersDue(), 1, 'only the dial timeout')
  r.last().open()
  assert.equal(await a, await b)
  assert.equal(await r.link.connect(), r.sockets[0], 'an open socket is handed out, not redialled')
  assert.equal(r.sockets.length, 1)
})

test('a request while a re-dial waits dials at once and cancels the wait: never two sockets', async () => {
  const r = rig()
  r.link.connect().catch(() => {})
  r.last().fail()
  await flush()
  assert.equal(r.redials(), 1)
  const asked = r.link.connect() // a question, before the wait is over
  assert.equal(r.sockets.length, 2)
  assert.equal(r.redials(), 0, 'the waiting re-dial is cancelled')
  await r.advance(DIAL_TIMEOUT_MS - 1)
  assert.equal(r.sockets.length, 2, 'the cancelled wait dials nothing later')
  r.last().open()
  assert.equal(await asked, r.sockets[1])
})

test('the old socket closing after the new one is up changes nothing: the new one stays live, nothing is re-dialled', async () => {
  const r = rig()
  r.link.connect().catch(() => {})
  r.sockets[0].open()
  await flush()
  // The bridge starts closing it; the close event has not come yet.
  r.sockets[0].readyState = 2
  const p = r.link.connect()
  assert.equal(r.sockets.length, 2, 'a closing socket is not open: a new one is dialled')
  r.sockets[1].open()
  await p
  assert.deepEqual(r.events, ['open#0', 'lost#0', 'open#1'], 'the old one counted as lost once, when the new one took over')
  r.sockets[0].finish()
  await flush()
  assert.equal(r.link.socket(), r.sockets[1])
  assert.deepEqual(r.events, ['open#0', 'lost#0', 'open#1'], 'its late close is not a second loss')
  assert.equal(r.redials(), 0)
  await r.advance(60_000)
  assert.equal(r.sockets.length, 2)
})

test('a dial that times out counts as failed and is retried; if it opens late it is closed, not made live', async () => {
  const r = rig()
  const p = r.link.connect()
  await r.advance(DIAL_TIMEOUT_MS)
  await assert.rejects(p, /timeout/)
  assert.equal(r.sockets[0].closeCalls, 1)
  assert.equal(r.redials(), 1)
  r.sockets[0].readyState = 0
  r.sockets[0].open() // the browser opened it anyway
  assert.equal(r.link.socket(), null)
  assert.equal(r.sockets[0].closeCalls, 2, 'closed again')
  assert.deepEqual(r.events, [])
  await r.advance(REDIAL_DELAYS_MS[0])
  r.last().open()
  await flush()
  assert.equal(r.link.socket(), r.sockets[1])
})

test('the page comes back after the network was lost: a fresh dial with a fresh set of retries, one for the whole burst', async () => {
  const r = rig()
  r.link.connect().catch(() => {})
  r.sockets[0].open()
  await flush()
  r.page.visible = false
  r.sockets[0].drop() // out of signal, in a pocket
  await flush()
  for (const wait of REDIAL_DELAYS_MS) {
    await r.advance(wait)
    r.last().fail()
    await flush()
  }
  assert.equal(r.redials(), 0, 'gave up while away')
  const count = r.sockets.length
  r.page.visible = true
  // Unlocked: visibilitychange, online and pageshow each ask.
  r.link.now()
  r.link.now()
  r.link.now()
  assert.equal(r.sockets.length, count + 1, 'one dial')
  assert.equal(r.link.attempts(), 0)
  r.last().fail() // the radio is not quite back yet
  await flush()
  await r.advance(REDIAL_DELAYS_MS[0])
  assert.equal(r.sockets.length, count + 2, 'retried from the first wait')
  r.last().open()
  await flush()
  assert.equal(r.link.socket(), r.last())
  r.link.now()
  assert.equal(r.sockets.length, count + 2, 'nothing while open')
})

test('a socket that cannot even be made does not spin: the failure waits for the next turn', async () => {
  let throwing = true
  const r = rig({ throwOnMake: () => throwing })
  r.link.now()
  await flush()
  assert.equal(r.redials(), 1, 'one wait, no dial in the same tick')
  await assert.rejects(r.link.connect(), /error/)
  assert.equal(r.redials(), 1, 'still one')
  await r.advance(REDIAL_DELAYS_MS[0] + REDIAL_DELAYS_MS[1])
  throwing = false
  await r.advance(REDIAL_DELAYS_MS[2])
  r.last().open()
  await flush()
  assert.equal(r.sockets.length, 1)
  assert.equal(r.link.socket(), r.sockets[0], 'and once it can be made, it is')
})

test('wiring: bridge.ts dials through the link, the page asks for a re-dial on its return', () => {
  const bridge = readFileSync(new URL('../src/lib/bridge.ts', import.meta.url), 'utf8')
  assert.match(bridge, /const link = createLink<WebSocket>\(\{/)
  assert.match(bridge, /make: \(\) => new WebSocket\(BRIDGE_WS_URL\)/)
  assert.match(bridge, /function connect\(\): Promise<WebSocket> \{\s*return link\.connect\(\)/)
  assert.match(bridge, /export function reconnectNow\(\): void \{\s*link\.check\(\)/)
  assert.doesNotMatch(bridge, /new WebSocket\((?!BRIDGE_WS_URL\))/, 'no socket made anywhere else')
  assert.doesNotMatch(bridge, /scheduleReconnect|RECONNECT_DELAYS/, 'the old re-dial is gone')
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  assert.match(app, /if \(usingBridge\) reconnectNow\(\)/)
})

// -- a socket open in name only: VPN switched on, route changed ------------------

/** An open socket whose bridge has shown it answers pings. */
async function upAnswering(r: ReturnType<typeof rig>) {
  r.link.connect().catch(() => {})
  const ws = r.last()
  ws.open()
  await flush()
  assert.deepEqual(r.pings, [ws], 'asked once on open, to learn whether it answers')
  r.pong(ws)
  return ws
}

test('VPN switched on: the page comes back, the silent socket is dropped without waiting for its close, and a new one takes over', async () => {
  const r = rig()
  const old = await upAnswering(r)
  // The route changed under it: nothing arrives, and the browser still calls it open.
  r.link.check() // visibilitychange or online
  assert.equal(r.pings.length, 2, 'asked for a sign of life')
  assert.equal(r.sockets.length, 1, 'not redialled while it may still be alive')
  await r.advance(PONG_WAIT_MS - 1)
  assert.deepEqual(r.events, ['open#0'])
  await r.advance(1)
  assert.deepEqual(r.events, ['open#0', 'lost#0'], 'dropped: reported as lost at once')
  assert.equal(old.closeCalls, 1, 'and closed by the page')
  assert.equal(r.link.socket(), null)
  await r.advance(REDIAL_DELAYS_MS[0])
  assert.equal(r.sockets.length, 2)
  r.last().open()
  await flush()
  assert.deepEqual(r.events, ['open#0', 'lost#0', 'open#1'])
  old.finish() // its close turns up at last
  await flush()
  assert.equal(r.link.socket(), r.sockets[1], 'the late close of the old one changes nothing')
  assert.deepEqual(r.events, ['open#0', 'lost#0', 'open#1'])
})

test('VPN switched on while the page stays on screen, with no event at all: found by the regular check', async () => {
  const r = rig()
  await upAnswering(r)
  await r.advance(CHECK_EVERY_MS + PONG_WAIT_MS)
  assert.deepEqual(r.events, ['open#0', 'lost#0'])
  await r.advance(REDIAL_DELAYS_MS[0])
  assert.equal(r.sockets.length, 2, 're-dialled')
})

test('the new route is not up yet: the re-dials fail for a while, then one gets through', async () => {
  const r = rig()
  await upAnswering(r)
  r.link.check()
  await r.advance(PONG_WAIT_MS)
  for (const wait of REDIAL_DELAYS_MS.slice(0, 3)) {
    await r.advance(wait)
    r.last().fail()
    await flush()
  }
  await r.advance(REDIAL_DELAYS_MS[3])
  r.last().open()
  await flush()
  assert.deepEqual(r.events, ['open#0', 'lost#0', 'open#4'])
  assert.equal(r.link.attempts(), 0)
})

test('a socket that answers is kept: any frame during the wait is a sign of life', async () => {
  const r = rig()
  const ws = await upAnswering(r)
  r.link.check()
  r.link.heard(ws) // a text delta, a panel — anything
  await r.advance(PONG_WAIT_MS * 2)
  r.link.check()
  r.pong(ws)
  await r.advance(PONG_WAIT_MS * 2)
  assert.deepEqual(r.events, ['open#0'])
  assert.equal(r.link.socket(), ws)
  assert.equal(r.sockets.length, 1)
})

test('a bridge from before this never answers a ping: its socket is never dropped for silence', async () => {
  const r = rig()
  r.link.connect().catch(() => {})
  r.last().open()
  await flush()
  for (let i = 0; i < 5; i++) {
    r.link.check()
    await r.advance(CHECK_EVERY_MS)
  }
  assert.deepEqual(r.events, ['open#0'])
  assert.equal(r.sockets.length, 1)
})

test('a hidden page is not checked: its socket is left alone until it comes back', async () => {
  const r = rig()
  await upAnswering(r)
  r.page.visible = false
  await r.advance(CHECK_EVERY_MS * 4)
  assert.equal(r.pings.length, 1, 'no checks while hidden')
  assert.deepEqual(r.events, ['open#0'])
  r.page.visible = true
  r.link.check()
  await r.advance(PONG_WAIT_MS)
  assert.deepEqual(r.events, ['open#0', 'lost#0'], 'checked on return, and dropped')
})

test('checks do not pile up: one ping outstanding at a time', async () => {
  const r = rig()
  await upAnswering(r)
  r.link.check()
  r.link.check()
  r.link.check()
  assert.equal(r.pings.length, 2)
})

test('with no socket at all, a check dials at once with a fresh set of retries', async () => {
  const r = rig()
  r.link.check()
  assert.equal(r.sockets.length, 1)
  r.link.check()
  assert.equal(r.sockets.length, 1, 'not while that dial is under way')
})

test('wiring: the page pings, hears every frame, checks on its return, fails a question on a dropped socket; the bridge answers', () => {
  const bridge = readFileSync(new URL('../src/lib/bridge.ts', import.meta.url), 'utf8').replace(/\r/g, '')
  assert.match(bridge, /ping: \(ws\) => ws\.send\(JSON\.stringify\(\{ type: 'ping' \}\)\)/)
  assert.match(bridge, /visible: \(\) => document\.visibilityState !== 'hidden'/)
  assert.match(bridge, /gaveUp: \(\) => onConnection\?\.\('down'\)/)
  assert.match(bridge, /link\.heard\(ws, msg\.type === 'pong'\)/)
  assert.match(bridge, /export function reconnectNow\(\): void \{\n {2}link\.check\(\)/)
  assert.match(bridge, /if \(pending\?\.ws === ws\) pending\.lost\?\.\(\)/)
  assert.match(bridge, /pending = \{ finish, ws, lost: onClose \}/)
  const server = readFileSync(new URL('../bridge/server.mjs', import.meta.url), 'utf8').replace(/\r/g, '')
  assert.match(server, /if \(msg\.type === 'ping'\) \{\n {6}send\(\{ type: 'pong' \}\)\n {6}return/)
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8').replace(/\r/g, '')
  // The boot's failure is taken back once connected; 'down' is the link state's (linkStatus.test.ts).
  assert.match(app, /if \(state === 'open'\) \{\n {8}link\.restored\(\)\n.*\n {8}if \(shown && shown === bootFailure\) store\.getState\(\)\.setError\(null\)/)
  assert.match(app, /\} else if \(state === 'down'\) \{\n {8}link\.down\(\)/)
  assert.match(app, /bootFailure = err\.message/)
})
