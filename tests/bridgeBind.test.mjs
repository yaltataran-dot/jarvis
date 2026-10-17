import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'

/**
 * The bridge as a process: where it listens, and whose Host header it answers to.
 *
 * This is a regression test for something that happened — the bind address and
 * the Host check were lost from server.mjs once, silently, and the bridge ended
 * up on every interface answering to any Host. Unit tests of a helper would not
 * have noticed; only the running server does. Claude is never called (DRY mode),
 * and the home folder is empty so no MCP server is started.
 */
const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

let home
const running = []

async function boot(extraEnv = {}) {
  const port = await freePort()
  const child = spawn(process.execPath, ['bridge/server.mjs'], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, JARVIS_BRIDGE_PORT: String(port), JARVIS_DRY_ASK: '1', JARVIS_KB: '0', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (d) => (log += d))
  child.stderr.on('data', (d) => (log += d))
  running.push(child)
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`bridge did not start:\n${log}`)), 20000)
    const poll = setInterval(() => {
      if (/bridge listening/.test(log)) {
        clearInterval(poll)
        clearTimeout(t)
        resolve()
      }
    }, 50)
    child.once('exit', (code) => reject(new Error(`bridge exited ${code}:\n${log}`)))
  })
  return { port, log: () => log }
}

/** GET with an exact Host header (fetch cannot set one). */
const get = ({ port, host, path = '/health', headers = {}, address = '127.0.0.1' }) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: address, port, path, method: 'GET', headers: { ...(host === undefined ? {} : { Host: host }), ...headers } }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    req.setTimeout(4000, () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end()
  })

/** WebSocket handshake outcome: 101 or the refusing status. */
const handshake = ({ port, host, origin }) =>
  new Promise((resolve) => {
    const headers = {}
    if (host !== undefined) headers.Host = host
    if (origin !== undefined) headers.Origin = origin
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers })
    const t = setTimeout(() => (ws.terminate(), resolve('timeout')), 4000)
    ws.on('open', () => (clearTimeout(t), ws.close(), resolve(101)))
    ws.on('unexpected-response', (_q, res) => (clearTimeout(t), resolve(res.statusCode)))
    ws.on('error', () => {})
  })

let plain
let withHosts
before(async () => {
  home = mkdtempSync(join(tmpdir(), 'jarvis-bind-'))
  ;[plain, withHosts] = await Promise.all([
    boot(),
    boot({ JARVIS_ALLOWED_ORIGINS: 'http://box.example:15173', JARVIS_ALLOWED_HOSTS: 'Jarvis.Example' }),
  ])
})
after(() => {
  for (const c of running) c.kill('SIGTERM')
  rmSync(home, { recursive: true, force: true })
})

test('the bridge says it listens on loopback, by default', () => {
  assert.match(plain.log(), new RegExp(`bridge listening on ws://127\\.0\\.0\\.1:${plain.port}`))
})

const external = Object.values(networkInterfaces())
  .flat()
  .find((i) => i && i.family === 'IPv4' && !i.internal)

test('it does not answer on the machine’s other addresses', { skip: external ? false : 'no non-loopback address on this machine' }, async () => {
  await assert.rejects(get({ port: plain.port, address: external.address, host: 'localhost' }), /ECONNREFUSED/)
  assert.equal(await get({ port: plain.port, host: 'localhost' }), 200, 'and still answers on loopback')
})

test('loopback names are served, on any port (a tunnel may remap it)', async () => {
  for (const host of ['localhost', 'localhost:8787', '127.0.0.1', '127.0.0.1:15173', '[::1]:8787', 'LOCALHOST:8787']) {
    assert.equal(await get({ port: plain.port, host }), 200, host)
  }
})

test('any other Host is refused — the DNS-rebinding guard', async () => {
  for (const host of ['evil.example', 'evil.example:8787', 'localhost.evil.example', 'evil-localhost', '10.0.0.5:8787', 'a b']) {
    assert.equal(await get({ port: plain.port, host }), 403, JSON.stringify(host))
  }
})

/** A request written by hand, so the Host header is exactly what is typed (or absent). */
const raw = (port, head) =>
  new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.write(head))
    let out = ''
    sock.setTimeout(4000, () => sock.destroy(new Error('timeout')))
    sock.on('data', (d) => (out += d))
    sock.on('close', () => resolve(Number(/^HTTP\/1\.[01] (\d{3})/.exec(out)?.[1])))
    sock.on('error', reject)
  })

test('an empty Host, or none at all, is refused', async () => {
  assert.equal(await raw(plain.port, 'GET /health HTTP/1.1\r\nHost: \r\nConnection: close\r\n\r\n'), 403, 'empty')
  assert.equal(await raw(plain.port, 'GET /health HTTP/1.0\r\n\r\n'), 403, 'absent')
  assert.equal(await raw(plain.port, 'GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'), 200, 'control: a proper Host passes')
})

test('the Host check comes first: a good Origin does not save a bad Host', async () => {
  assert.equal(await get({ port: plain.port, host: 'evil.example', headers: { Origin: 'http://localhost:5173' } }), 403)
  assert.equal(await get({ port: plain.port, host: 'localhost', headers: { Origin: 'http://localhost:5173' } }), 200)
  assert.equal(await get({ port: plain.port, host: 'localhost', headers: { Origin: 'http://evil.example' } }), 403, 'and a bad Origin is still refused')
})

test('the WebSocket handshake checks Host too', async () => {
  assert.equal(await handshake({ port: plain.port, host: 'localhost', origin: 'http://localhost:5173' }), 101)
  assert.equal(await handshake({ port: plain.port, host: 'evil.example', origin: 'http://localhost:5173' }), 403)
  assert.equal(await handshake({ port: plain.port, host: 'localhost', origin: 'http://localhost:15174' }), 403, 'the Origin rule is unchanged')
  assert.equal(await handshake({ port: plain.port, host: 'localhost' }), 403, 'no Origin, no socket')
})

test('hosts named in JARVIS_ALLOWED_ORIGINS or JARVIS_ALLOWED_HOSTS are served, nothing else', async () => {
  for (const host of ['box.example', 'box.example:15173', 'jarvis.example', 'localhost']) {
    assert.equal(await get({ port: withHosts.port, host }), 200, host)
  }
  assert.equal(await get({ port: withHosts.port, host: 'evil.example' }), 403)
  assert.equal(await get({ port: withHosts.port, host: 'box.example.evil.example' }), 403)
  assert.equal(await get({ port: plain.port, host: 'box.example' }), 403, 'and not on a bridge that was not told about them')
  assert.equal(await handshake({ port: withHosts.port, host: 'box.example', origin: 'http://box.example:15173' }), 101)
})

test('refusals are logged with the host that was refused, without secrets', async () => {
  await get({ port: plain.port, host: 'logged.example' })
  assert.match(plain.log(), /refused http request for host logged\.example/)
})
