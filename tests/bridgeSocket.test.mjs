import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'

/**
 * The agent socket (`/`) of the running bridge, frame by frame, in DRY mode:
 * questions get the fixed reply and Claude is never asked anything. Written
 * against the socket handling while it is all in server.mjs, so that moving it
 * out can be checked against the same frames.
 *
 * What DRY mode can show: the greeting, ping, a question and its two frames,
 * trace, interrupt, a reply nobody asked for, a refused resume, and what is
 * ignored. A real turn — the model's stream, tools, panels, the limit and the
 * fallback — cannot be reached this way; turns.test.mjs covers that logic.
 * The agent session is opened on every connection as usual, but no question is
 * ever put to it, so it sends nothing of its own (no second "ready" from init).
 */
const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const ORIGIN = 'http://localhost:5173'

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

const health = (port) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/health', headers: { Host: 'localhost' } }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (d) => (body += d))
      res.on('end', () => resolve({ status: res.statusCode, body }))
      res.on('error', reject)
    })
    req.setTimeout(2000, () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end()
  })

let home
let bridge
let log = ''

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'jarvis-socket-'))
  const port = await freePort()
  const child = spawn(process.execPath, ['bridge/server.mjs'], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, JARVIS_BRIDGE_PORT: String(port), JARVIS_DRY_ASK: '1', JARVIS_KB: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => (log += d))
  child.stderr.on('data', (d) => (log += d))
  child.on('error', (e) => (log += `\n[test] child process error: ${e.message}\n`))
  bridge = { port, child }
  const alive = () => child.exitCode === null && child.signalCode === null
  // Ready: the "listening" line, then GET /health answering 200 with { ok: true }.
  await new Promise((resolve, reject) => {
    let settled = false
    let probing = false
    const settle = (err) => {
      if (settled) return
      settled = true
      clearInterval(poll)
      clearTimeout(deadline)
      child.off('exit', onExit)
      if (err) reject(err)
      else resolve()
    }
    const onExit = (code, signal) => settle(new Error(`bridge exited before it was ready (code ${code}, signal ${signal}):\n${log}`))
    const deadline = setTimeout(() => settle(new Error(`bridge was not ready within 20 s:\n${log}`)), 20000)
    const poll = setInterval(async () => {
      if (settled || probing || !/bridge listening/.test(log) || !alive()) return
      probing = true
      try {
        const { status, body } = await health(port)
        let ok = false
        try {
          ok = JSON.parse(body)?.ok === true
        } catch {
          ok = false
        }
        if (status === 200 && ok && alive()) settle()
      } catch {
        // ECONNREFUSED and the like: not ready yet.
      } finally {
        probing = false
      }
    }, 50)
    child.on('exit', onExit)
  })
})

after(async () => {
  const c = bridge?.child
  if (c && c.exitCode === null && c.signalCode === null) {
    await Promise.race([
      new Promise((resolve) => {
        c.once('exit', resolve)
        c.kill('SIGTERM')
      }),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ])
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

/**
 * A page's socket: every frame it receives, in order, and a way to wait for
 * the next one that matches — or to be sure none arrives.
 */
async function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/`, { headers: { Host: 'localhost', Origin: ORIGIN } })
  const frames = []
  const waiters = []
  ws.on('message', (raw) => {
    const f = JSON.parse(raw.toString())
    frames.push(f)
    for (const w of [...waiters]) w(f)
  })
  ws.on('error', () => {})
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('unexpected-response', (_q, res) => reject(new Error(`handshake ${res.statusCode}`)))
  })
  const next = (match, ms = 5000) =>
    new Promise((resolve, reject) => {
      const seen = frames.find(match)
      if (seen) return resolve(seen)
      const w = (f) => {
        if (!match(f)) return
        clearTimeout(t)
        waiters.splice(waiters.indexOf(w), 1)
        resolve(f)
      }
      const t = setTimeout(() => {
        waiters.splice(waiters.indexOf(w), 1)
        reject(new Error(`no frame matching ${match} within ${ms} ms; got ${JSON.stringify(frames)}`))
      }, ms)
      waiters.push(w)
    })
  const send = (f) => ws.send(typeof f === 'string' ? f : JSON.stringify(f))
  /** A ping and its pong: everything sent before it has been handled. */
  const roundTrip = async () => {
    const before = frames.filter((f) => f.type === 'pong').length
    send({ type: 'ping' })
    await next(() => frames.filter((f) => f.type === 'pong').length > before)
  }
  const close = () =>
    new Promise((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) return resolve()
      ws.once('close', resolve)
      ws.close(1000)
    })
  return { ws, frames, next, send, roundTrip, close }
}

/** Waits until the bridge's log matches `re`. */
const waitForLog = (re, ms = 5000) =>
  new Promise((resolve, reject) => {
    if (re.test(log)) return resolve()
    const check = () => {
      if (re.test(log)) done()
    }
    const t = setTimeout(() => done(new Error(`no log line matching ${re} within ${ms} ms:\n${log}`)), ms)
    const done = (err) => {
      clearTimeout(t)
      bridge.child.stdout.off('data', check)
      bridge.child.stderr.off('data', check)
      if (err) reject(err)
      else resolve()
    }
    bridge.child.stdout.on('data', check)
    bridge.child.stderr.on('data', check)
  })

test('on connect: "ready" first, with the configured MCP servers (none here)', async () => {
  const p = await connect()
  const ready = await p.next((f) => f.type === 'ready')
  assert.deepEqual(ready, { type: 'ready', servers: [] })
  assert.equal(p.frames[0].type, 'ready', 'before anything else')
  await waitForLog(/\[jarvis\] client connected/)
  await p.close()
})

test('ping is answered with pong, and only pong', async () => {
  const p = await connect()
  await p.next((f) => f.type === 'ready')
  p.send({ type: 'ping' })
  const pong = await p.next((f) => f.type === 'pong')
  assert.deepEqual(pong, { type: 'pong' })
  await p.close()
})

test('DRY: a question gets the fixed reply as "text" then "done", tagged with its id, after a pause', async () => {
  const p = await connect()
  await p.next((f) => f.type === 'ready')
  const sent = Date.now()
  p.send({ type: 'ask', id: 'q-1', text: 'который час?' })
  const done = await p.next((f) => f.type === 'done' && f.ask === 'q-1')
  assert.ok(Date.now() - sent >= 1400, 'the reply waits about a second and a half')
  const text = p.frames.find((f) => f.type === 'text' && f.ask === 'q-1')
  assert.ok(text, 'a text frame came first')
  assert.ok(p.frames.indexOf(text) < p.frames.indexOf(done))
  assert.deepEqual(Object.keys(text).sort(), ['ask', 'delta', 'type'])
  assert.match(text.delta, /^Проверка связи, сэр\. Мост получил команду и отвечает без обращения к модели/)
  assert.deepEqual(done, { type: 'done', text: text.delta, costUsd: 0, ask: 'q-1' })
  await waitForLog(/\[jarvis\] ask q-1 received \(12 chars\) — DRY, Claude not called/)
  await p.close()
})

test('DRY: a question without a string id is answered with ask: null; one without text gets nothing', async () => {
  const p = await connect()
  await p.next((f) => f.type === 'ready')
  p.send({ type: 'ask', id: 42, text: 'привет' })
  const done = await p.next((f) => f.type === 'done')
  assert.equal(done.ask, null)
  assert.equal(p.frames.find((f) => f.type === 'text').ask, null)
  const count = p.frames.length
  p.send({ type: 'ask', id: 'q-2' })
  p.send({ type: 'ask', id: 'q-3', text: 7 })
  await new Promise((resolve) => setTimeout(resolve, 1800))
  await p.roundTrip()
  assert.deepEqual(p.frames.slice(count).map((f) => f.type), ['pong'], 'no text, no done')
  await p.close()
})

test('trace: logged in the trace format, answered with nothing', async () => {
  const p = await connect()
  await p.next((f) => f.type === 'ready')
  const count = p.frames.length
  p.send({ type: 'trace', step: 'test.step', at: 1, info: { n: 3 } })
  await waitForLog(/\[trace\] test\.step n=3/)
  await p.roundTrip()
  assert.deepEqual(p.frames.slice(count).map((f) => f.type), ['pong'])
  await p.close()
})

test('interrupt with nothing running, a reply nobody asked for, junk and unknown frames: nothing answered, the socket stays', async () => {
  const p = await connect()
  await p.next((f) => f.type === 'ready')
  const count = p.frames.length
  p.send({ type: 'interrupt' })
  p.send({ type: 'reply', id: 'nobody-asked', ok: true })
  p.send('this is not json')
  p.send({ type: 'no-such-frame' })
  p.send({ nope: true })
  await waitForLog(/\[jarvis\] interrupt received/)
  await p.roundTrip()
  assert.deepEqual(p.frames.slice(count).map((f) => f.type), ['pong'])
  assert.equal(p.ws.readyState, WebSocket.OPEN)
  await p.close()
})

test('resume of a session this bridge never handed out is refused, and the conversation is new', async () => {
  const p = await connect()
  await p.next((f) => f.type === 'ready')
  p.send({ type: 'resume', id: '00000000-0000-4000-8000-000000000000' })
  const r = await p.next((f) => f.type === 'resumed')
  assert.deepEqual(r, { type: 'resumed', ok: false })
  await waitForLog(/\[jarvis\] resume refused \([a-z-]+\) — new conversation/)
  // A DRY question afterwards is answered as usual.
  p.send({ type: 'ask', id: 'after', text: 'да' })
  await p.next((f) => f.type === 'done' && f.ask === 'after')
  await p.close()
})

test('closing the socket is logged with its code', async () => {
  const p = await connect()
  await p.next((f) => f.type === 'ready')
  await p.close()
  await waitForLog(/\[jarvis\] client disconnected \(code 1000\)/)
  assert.equal(bridge.child.exitCode, null, 'the bridge stays up')
})
