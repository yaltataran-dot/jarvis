import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { LONG_OUTAGE_MS, createLinkStatus, type LinkState } from '../src/lib/linkStatus.ts'
import { PONG_WAIT_MS, REDIAL_DELAYS_MS, createLink } from '../src/lib/redial.ts'

function clock() {
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
  const advance = async (ms: number) => {
    const end = now + ms
    for (;;) {
      const next = [...due].filter(([, d]) => d.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (!next) break
      now = next[1].at
      due.delete(next[0])
      next[1].fn()
      for (let i = 0; i < 5; i++) await Promise.resolve()
    }
    now = end
    for (let i = 0; i < 5; i++) await Promise.resolve()
  }
  return { timers, advance, pending: () => due.size }
}

function status() {
  const c = clock()
  const seen: LinkState[] = []
  const s = createLinkStatus({ onChange: (x) => void seen.push(x), timers: c.timers })
  return { s, seen, ...c }
}

test('a short drop is a quiet reconnect and nothing more: back to ok, no outage', async () => {
  const t = status()
  t.s.lost()
  await t.advance(3000)
  t.s.restored()
  assert.deepEqual(t.seen, ['reconnecting', 'ok'])
  await t.advance(LONG_OUTAGE_MS * 2)
  assert.deepEqual(t.seen, ['reconnecting', 'ok'], 'the outage clock was stopped with the reconnect')
  assert.equal(t.pending(), 0)
})

test('many disconnects in one outage: one state change, one clock', async () => {
  const t = status()
  for (let i = 0; i < 5; i++) {
    t.s.lost()
    await t.advance(1000)
  }
  assert.deepEqual(t.seen, ['reconnecting'])
  assert.equal(t.pending(), 1, 'one outage clock, not five')
  await t.advance(LONG_OUTAGE_MS - 5000)
  assert.deepEqual(t.seen, ['reconnecting', 'down'], 'counted from the first drop, not reset by each one')
  t.s.lost()
  assert.deepEqual(t.seen, ['reconnecting', 'down'], 'a drop during an outage changes nothing')
})

test('an outage that lasts is said: down after the long wait, or at once when the retries run out', async () => {
  const t = status()
  t.s.lost()
  await t.advance(LONG_OUTAGE_MS - 1)
  assert.equal(t.s.state(), 'reconnecting')
  await t.advance(1)
  assert.equal(t.s.state(), 'down')
  t.s.restored()
  assert.equal(t.s.state(), 'ok', 'and back without a reload once it is')
  const u = status()
  u.s.lost()
  u.s.down()
  assert.deepEqual(u.seen, ['reconnecting', 'down'])
  assert.equal(u.pending(), 0)
})

test('the first connection of the page is simply ok, and repeated reports do not repeat changes', () => {
  const t = status()
  t.s.restored()
  t.s.restored()
  assert.deepEqual(t.seen, [])
  assert.equal(t.s.state(), 'ok')
})

// -- the real redial driving the real status, wired as bridge.ts wires them ----------------

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
  fail() {
    this.readyState = 3
    this.onerror?.({})
    this.onclose?.({})
  }
  close() {
    this.closeCalls += 1
    if (this.readyState < 2) this.readyState = 2
  }
}

function wired() {
  const c = clock()
  const seen: LinkState[] = []
  const st = createLinkStatus({ onChange: (x) => void seen.push(x), timers: c.timers })
  const sockets: FakeSocket[] = []
  const link = createLink<FakeSocket>({
    make: () => {
      const ws = new FakeSocket()
      sockets.push(ws)
      return ws
    },
    opened: () => st.restored(),
    lost: () => st.lost(),
    gaveUp: () => st.down(),
    failure: (why) => new Error(why),
    ping: () => {},
    timers: c.timers,
  })
  return { c, seen, st, sockets, link, last: () => sockets.at(-1)! }
}

test('VPN switched on and off: the silent socket is dropped, the page shows reconnecting, then ok; twice over', async () => {
  const w = wired()
  w.link.connect().catch(() => {})
  w.last().open()
  w.link.heard(w.last(), true) // this bridge answers pings
  for (const round of [1, 2]) {
    w.link.check() // the page came back after the switch
    await w.c.advance(PONG_WAIT_MS)
    assert.equal(w.st.state(), 'reconnecting', `round ${round}: dropped, reconnecting`)
    await w.c.advance(REDIAL_DELAYS_MS[0])
    w.last().open()
    w.link.heard(w.last(), true)
    await w.c.advance(0)
    assert.equal(w.st.state(), 'ok', `round ${round}: back`)
  }
  assert.deepEqual(w.seen, ['reconnecting', 'ok', 'reconnecting', 'ok'])
})

test('the network gone for good: down when the quick retries run out, then ok when it returns on its own', async () => {
  const w = wired()
  w.link.connect().catch(() => {})
  w.last().open()
  w.last().fail() // dropped
  await w.c.advance(0)
  for (const wait of REDIAL_DELAYS_MS) {
    await w.c.advance(wait)
    if (w.last().readyState === 0) w.last().fail()
    await w.c.advance(0)
    if (w.st.state() === 'down') break
  }
  assert.equal(w.st.state(), 'down')
  w.link.check() // the Reconnect button, or the page coming back
  w.last().open()
  await w.c.advance(0)
  assert.equal(w.st.state(), 'ok')
})

// -- the page: no red plate for a reconnect; real faults untouched --------------------------

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8').replace(/\r/g, '')
const hud = readFileSync(new URL('../src/ui/Hud.tsx', import.meta.url), 'utf8').replace(/\r/g, '')
const bridge = readFileSync(new URL('../src/lib/bridge.ts', import.meta.url), 'utf8').replace(/\r/g, '')
const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8').replace(/\r/g, '')

test('connection events never put an error up: they go to the link state and its quiet line', () => {
  const start = app.indexOf('watchConnection((state, detail) => {')
  const block = app.slice(start, app.indexOf('\n    })\n', start))
  assert.ok(start > 0 && block.length > 100)
  assert.doesNotMatch(block, /setError\(\s*(?!null)/, 'no error set by a connection event (only the boot failure is cleared)')
  assert.match(block, /state === 'lost'\) \{\n {8}link\.lost\(\)/)
  assert.match(block, /state === 'down'\) \{\n {8}link\.down\(\)/)
  assert.match(block, /state === 'resumed'\) \{\n {8}link\.restored\(\)/)
  assert.match(block, /state === 'reconnected'\) \{\n {8}link\.restored\(\)/)
  assert.match(block, /state === 'open'\) \{\n {8}link\.restored\(\)/)
  assert.match(app, /createLinkStatus\(\{ onChange: \(state\) => store\.getState\(\)\.setLink\(state\) \}\)/)
})

test('a question cut off by the network is not a fault: no red core, no error sound — real failures still are', () => {
  assert.match(app, /if \(err instanceof ServiceError && err\.kind === 'link'\) \{\n {8}store\.getState\(\)\.setLinkNote\(LINK_CUT\)\n {8}return\n {6}\}\n {6}sfx\.play\('error'\)/)
  assert.match(app, /\.setError\(err instanceof Error \? err\.message : 'Something went wrong\.', service \? 'service' : 'fault'\)/, 'everything else as before')
  // Only the connection itself is 'link': closed or socket error mid-answer, or no dial after having been connected.
  assert.equal((bridge.match(/'link'\)/g) ?? []).length, 3)
  assert.match(bridge, /fail\(new ServiceError\(SAY\.closed, 'link'\)\)/)
  assert.match(bridge, /fail\(new ServiceError\(SAY\.failed, 'link'\)\)/)
  assert.match(bridge, /throw everConnected \? new ServiceError\(SAY\.failed, 'link'\) : err/)
  assert.match(bridge, /fail\(new Error\(SAY\.quiet\)\)/, 'a bridge that goes silent mid-answer is still a fault')
})

test('the HUD: reconnecting is a quiet line after a moment; a lasting outage is plain, with a reconnect button', () => {
  assert.match(hud, /link === 'reconnecting' && \(\n\s*<div className=\{'link-status link-wait'/)
  assert.match(hud, /link === 'down' && \(\n\s*<div className=\{'error link-down'/)
  assert.match(hud, /onClick=\{\(\) => reconnectNow\(\)\}/)
  assert.match(hud, /\{error && <div className="error">\{error\}<\/div>\}/, 'real errors keep their plate')
  assert.match(css, /\.link-wait \{ animation: link-in 0\.3s ease-out 1\.5s both; \}/, 'a blink of the network shows nothing')
  const quiet = css.slice(css.indexOf('.link-status {'), css.indexOf('}', css.indexOf('.link-status {')))
  assert.doesNotMatch(quiet, /danger|#ffc2b8/, 'the quiet line is not the red plate')
  assert.match(css, /\.link-down \{ pointer-events: auto; \}/, 'the button can be pressed')
})

test('"Стоп" is untouched: cancel still interrupts the bridge and settles the turn; a cut question still releases the floor', () => {
  assert.match(bridge, /export function cancel\(\): void \{\n.*\n {2}if \(socket\?\.readyState === WebSocket\.OPEN\) \{\n {4}socket\.send\(JSON\.stringify\(\{ type: 'interrupt' \}\)\)\n {2}\}\n {2}pending\?\.finish\(\)/)
  // The early return for a cut question is inside try/catch/finally: the finally still releases the floor and listens again.
  const i = app.indexOf("err.kind === 'link'")
  assert.ok(app.indexOf('} finally {', i) > i && app.indexOf('} finally {', i) - i < 1500)
})
