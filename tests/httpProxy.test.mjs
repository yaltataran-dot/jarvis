import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { imgRequest, mediaRequest } from '../bridge/http/proxy.mjs'
import { PROXY_UA } from '../bridge/net.mjs'

/**
 * GET /img and GET /media — the remote-media proxy — as the running bridge
 * serves them. Written against the routes while they were still in server.mjs.
 *
 * Only what a real server can show without the network: everything here is
 * refused by the SSRF gate or the checks in front of it before a socket to
 * the outside is opened, so no test depends on reaching the internet and the
 * gate is exercised as it is, never switched off. What happens after a target
 * is accepted — the MIME check, the byte caps, Range, streaming — is not
 * reachable this way.
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

/** GET (or another method) with an exact Host header; resolves with status, headers and body. */
const request = ({ port, path, host = 'localhost', method = 'GET', headers = {} }) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { Host: host, ...headers } }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (d) => (body += d))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
      res.on('error', reject)
    })
    req.setTimeout(4000, () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end()
  })

let home
let bridge
let log = ''

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'jarvis-proxy-'))
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
        const { status, body } = await request({ port, path: '/health' })
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

const get = (path, opts = {}) => request({ port: bridge.port, path, ...opts })
const q = (u) => encodeURIComponent(u)

for (const route of ['/img', '/media']) {
  test(`${route}: no url, or one that is not an absolute http(s) url, is 400`, async () => {
    for (const path of [`${route}?`, `${route}?url=`, `${route}?other=1`, `${route}?url=${q('not a url')}`, `${route}?url=${q('/relative/a.png')}`]) {
      const r = await get(path)
      assert.equal(r.status, 400, path)
      assert.equal(r.body, 'absolute http(s) url required', path)
    }
  })

  test(`${route}: other schemes are 400 — file, ftp, data, javascript`, async () => {
    for (const u of ['file:///etc/passwd', 'file:///C:/Windows/win.ini', 'ftp://example.com/a.png', 'data:image/png;base64,AAAA', 'javascript:alert(1)']) {
      const r = await get(`${route}?url=${q(u)}`)
      assert.equal(r.status, 400, u)
      assert.equal(r.body, 'absolute http(s) url required', u)
    }
  })

  test(`${route}: loopback, private, link-local and local names are 403 before any connection`, async () => {
    const targets = [
      `http://127.0.0.1:${bridge.port}/health`,
      'http://127.1.2.3/',
      'http://0.0.0.0/',
      'http://10.0.0.5/a.png',
      'http://172.16.0.1/',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://100.64.0.1/',
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://[fd00::1]/',
      'http://[fe80::1]/',
      'http://localhost/',
      `http://localhost:${bridge.port}/health`,
      'https://printer.local/',
      'http://nas.internal/',
      'http://router.home.arpa/',
    ]
    for (const u of targets) {
      const r = await get(`${route}?url=${q(u)}`)
      assert.equal(r.status, 403, u)
      assert.equal(r.body, 'blocked host', u)
    }
  })

  test(`${route}: an error carries the CORS headers and nothing that claims a media type`, async () => {
    const withOrigin = await get(`${route}?url=${q('http://127.0.0.1/')}`, { headers: { Origin: 'http://localhost:5173' } })
    assert.equal(withOrigin.status, 403)
    assert.equal(withOrigin.headers['access-control-allow-origin'], 'http://localhost:5173')
    assert.equal(withOrigin.headers['access-control-allow-headers'], 'content-type')
    assert.equal(withOrigin.headers.vary, 'origin')
    assert.equal(withOrigin.headers['content-type'], undefined)
    assert.equal(withOrigin.headers['cache-control'], undefined)
    // An <img> load sends no Origin: served, and nothing is reflected.
    const without = await get(`${route}?url=${q('http://127.0.0.1/')}`)
    assert.equal(without.status, 403)
    assert.equal(without.headers['access-control-allow-origin'], undefined)
    assert.equal(without.headers.vary, 'origin')
  })

  test(`${route}: the path must be followed by "?" and the method must be GET`, async () => {
    assert.equal((await get(route)).status, 404, `${route} without ?`)
    assert.equal((await get(`${route}/`)).status, 404, `${route}/`)
    assert.equal((await get(`${route}x?url=${q('http://127.0.0.1/')}`)).status, 404, `${route}x?`)
    for (const method of ['POST', 'PUT', 'DELETE']) {
      assert.equal((await get(`${route}?url=${q('http://127.0.0.1/')}`, { method })).status, 404, method)
    }
  })

  test(`${route}: Host, then Origin, then OPTIONS — all before the route`, async () => {
    const path = `${route}?url=${q('http://127.0.0.1/')}`
    const badHost = await get(path, { host: 'evil.example', headers: { Origin: 'http://localhost:5173' } })
    assert.equal(badHost.status, 403)
    assert.equal(badHost.body, 'forbidden', 'the Host check answers, not the SSRF gate')
    assert.equal(badHost.headers['access-control-allow-origin'], undefined)

    const badOrigin = await get(path, { headers: { Origin: 'http://evil.example' } })
    assert.equal(badOrigin.status, 403)
    assert.equal(badOrigin.body, 'forbidden', 'the Origin check answers, not the SSRF gate')

    const preflight = await get(path, { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173' } })
    assert.equal(preflight.status, 204)
    assert.equal(preflight.body, '')
    assert.equal(preflight.headers['access-control-allow-origin'], 'http://localhost:5173')
  })
}

test('/img and /media are separate routes: neither prefix answers for the other', async () => {
  // Their differences (accepted types, size and time limits, Range) only show
  // once a target is accepted, which a test without the network cannot reach.
  assert.equal((await get(`/imgs?url=${q('http://127.0.0.1/')}`)).status, 404)
  assert.equal((await get(`/medias?url=${q('http://127.0.0.1/')}`)).status, 404)
  assert.equal((await get(`/image?url=${q('http://127.0.0.1/')}`)).status, 404)
})

test('a refused target is not echoed back, and the bridge stays up', async () => {
  const r = await get(`/img?url=${q('http://127.0.0.1/secret-path-token')}`)
  assert.doesNotMatch(r.body, /secret-path-token/)
  assert.equal(bridge.child.exitCode, null)
  assert.equal((await get('/health')).status, 200)
})

// ---------------------------------------------------------------------------
// The handlers in http/proxy.mjs once a target is accepted. Only the network
// hop is stood in for: `openRemote` is replaced, `vetTarget` is the real gate
// and runs first, exactly as in the bridge. These were written after the move
// (the code was not importable while it sat inside server.mjs).

/** A stand-in upstream response: a stream with a status and headers. */
const upstream = ({ status = 200, headers = {}, chunks = [], end = true } = {}) => {
  const u = new PassThrough()
  u.statusCode = status
  u.headers = headers
  setImmediate(() => {
    for (const c of chunks) u.write(c)
    if (end) u.end()
  })
  return u
}

/** A fake openRemote that records what it was asked for and answers with `make()`. */
const fakeOpen = (make) => {
  const calls = []
  const open = async (target, headers, timeoutMs) => {
    calls.push({ target, headers, timeoutMs })
    const res = await make()
    return { res, url: target }
  }
  return { open, calls }
}

const CORS = { vary: 'origin', 'access-control-allow-origin': 'http://localhost:5173' }
const redact = (text) => text.replace(/sk-[a-z0-9]+/gi, '[скрыто]')

/** Serve one handler on loopback, make one request, collect what came back. */
async function call(handler, open, { path, headers = {}, abortAfterHeaders = false }) {
  const server = http.createServer((req, res) => handler(req, res, { cors: CORS, redact, openRemote: open }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    return await new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
        if (abortAfterHeaders) {
          req.destroy()
          return resolve({ status: res.statusCode, headers: res.headers })
        }
        const parts = []
        res.on('data', (d) => parts.push(d))
        res.on('close', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts), complete: res.complete }))
      })
      req.on('error', (e) => (abortAfterHeaders ? null : reject(e)))
      req.setTimeout(10000, () => req.destroy(new Error('timeout')))
    })
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}

const IMG = `/img?url=${q('https://cdn.example/a.png')}`
const MEDIA = `/media?url=${q('https://cdn.example/v.mp4')}`

test('module: the SSRF gate still runs before the network — a blocked target never reaches openRemote', async () => {
  const { open, calls } = fakeOpen(() => upstream({ headers: { 'content-type': 'image/png' } }))
  for (const [handler, route] of [[imgRequest, '/img'], [mediaRequest, '/media']]) {
    for (const u of ['http://127.0.0.1/', 'http://169.254.169.254/', 'http://localhost/', 'file:///etc/passwd']) {
      const r = await call(handler, open, { path: `${route}?url=${q(u)}` })
      assert.ok(r.status === 400 || r.status === 403, `${route} ${u}: ${r.status}`)
    }
  }
  assert.equal(calls.length, 0)
})

test('module: an image is streamed with its type, length, nosniff, cache-control and the CORS headers', async () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex')
  const { open, calls } = fakeOpen(() => upstream({ headers: { 'content-type': 'Image/PNG; charset=binary', 'content-length': String(png.length) }, chunks: [png] }))
  const r = await call(imgRequest, open, { path: IMG, headers: { range: 'bytes=0-1' } })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, png)
  assert.equal(r.headers['content-type'], 'image/png')
  assert.equal(r.headers['content-length'], String(png.length))
  assert.equal(r.headers['x-content-type-options'], 'nosniff')
  assert.equal(r.headers['cache-control'], 'private, max-age=600')
  assert.equal(r.headers['access-control-allow-origin'], 'http://localhost:5173')
  assert.equal(r.headers.vary, 'origin')
  assert.equal(r.headers['accept-ranges'], undefined, '/img never claims ranges')
  const [{ target, headers, timeoutMs }] = calls
  assert.equal(target.href, 'https://cdn.example/a.png')
  assert.equal(timeoutMs, 10_000)
  assert.deepEqual(headers, { 'user-agent': PROXY_UA, accept: 'image/*,*/*;q=0.8', 'accept-encoding': 'identity' }, 'no Range is passed on for /img')
})

test('module: each route accepts only its own kinds — 415 otherwise', async () => {
  const typed = (type) => fakeOpen(() => upstream({ headers: type === undefined ? {} : { 'content-type': type } })).open
  let r = await call(imgRequest, typed('text/html'), { path: IMG })
  assert.equal(r.status, 415)
  assert.equal(r.body.toString(), 'not image/ (got text/html)')
  r = await call(imgRequest, typed('video/mp4'), { path: IMG })
  assert.equal(r.body.toString(), 'not image/ (got video/mp4)')
  r = await call(imgRequest, typed(undefined), { path: IMG })
  assert.equal(r.body.toString(), 'not image/ (got nothing)')
  r = await call(mediaRequest, typed('image/png'), { path: MEDIA })
  assert.equal(r.status, 415)
  assert.equal(r.body.toString(), 'not video/ or audio/ (got image/png)')
  for (const type of ['video/mp4', 'audio/mpeg']) {
    r = await call(mediaRequest, typed(type), { path: MEDIA })
    assert.equal(r.status, 200, type)
  }
  assert.equal(r.headers['access-control-allow-origin'], 'http://localhost:5173')
})

test('module: upstream status — 404 stays 404, anything else not 200/206 is 502', async () => {
  for (const [status, want] of [[404, 404], [500, 502], [403, 502], [304, 502], [204, 502]]) {
    const { open } = fakeOpen(() => upstream({ status, headers: { 'content-type': 'image/png' } }))
    const r = await call(imgRequest, open, { path: IMG })
    assert.equal(r.status, want, String(status))
    assert.equal(r.body.toString(), `upstream said ${status}`)
    assert.equal(r.headers['content-type'], undefined)
  }
})

test('module: a declared length over the cap is 413 — 15 MB for images, 200 MB for media', async () => {
  const sized = (type, n) => fakeOpen(() => upstream({ headers: { 'content-type': type, 'content-length': String(n) } })).open
  assert.equal((await call(imgRequest, sized('image/png', 15 * 1024 * 1024 + 1), { path: IMG })).status, 413)
  // Exactly at the cap is served; only the status matters (the stand-in sends no body).
  assert.equal((await call(imgRequest, sized('image/png', 15 * 1024 * 1024), { path: IMG, abortAfterHeaders: true })).status, 200)
  const over = await call(mediaRequest, sized('video/mp4', 200 * 1024 * 1024 + 1), { path: MEDIA })
  assert.equal(over.status, 413)
  assert.equal(over.body.toString(), 'too large')
})

test('module: an undeclared body over the cap is cut — headers already sent, so the connection is dropped', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  const mb = Buffer.alloc(1024 * 1024)
  const { open } = fakeOpen(() => upstream({ headers: { 'content-type': 'image/jpeg' }, chunks: Array(16).fill(mb) }))
  const r = await call(imgRequest, open, { path: IMG })
  assert.equal(r.status, 200)
  assert.equal(r.complete, false)
  assert.ok(r.body.length <= 15 * 1024 * 1024, String(r.body.length))
  assert.match(String(warn.mock.calls.at(-1)?.arguments[0]), /proxy cut https:\/\/cdn\.example\/a\.png at 15728640 bytes/)
})

test('module: /media passes Range on and reports ranges only when the origin showed it can', async () => {
  let { open, calls } = fakeOpen(() => upstream({ status: 206, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-3/100', 'content-length': '4' }, chunks: [Buffer.from('abcd')] }))
  let r = await call(mediaRequest, open, { path: MEDIA, headers: { range: 'bytes=0-3' } })
  assert.equal(r.status, 206)
  assert.equal(r.headers['accept-ranges'], 'bytes')
  assert.equal(r.headers['content-range'], 'bytes 0-3/100')
  assert.equal(r.body.toString(), 'abcd')
  assert.deepEqual(calls[0].headers, { 'user-agent': PROXY_UA, accept: '*/*', 'accept-encoding': 'identity', range: 'bytes=0-3' })
  assert.equal(calls[0].timeoutMs, 30_000)
  // A 200 that ignored the Range: no accept-ranges of our own making.
  ;({ open } = fakeOpen(() => upstream({ headers: { 'content-type': 'video/mp4' } })))
  r = await call(mediaRequest, open, { path: MEDIA, headers: { range: 'bytes=0-3' } })
  assert.equal(r.status, 200)
  assert.equal(r.headers['accept-ranges'], undefined)
  assert.equal(r.headers['content-range'], undefined)
  ;({ open } = fakeOpen(() => upstream({ headers: { 'content-type': 'audio/mpeg', 'accept-ranges': 'bytes' } })))
  r = await call(mediaRequest, open, { path: MEDIA })
  assert.equal(r.headers['accept-ranges'], 'bytes')
})

test('module: a failure before headers is its status (502 by default) with the message redacted', async () => {
  const failing = (err) => fakeOpen(() => Promise.reject(err)).open
  let r = await call(imgRequest, failing(new Error('connect failed, key sk-abc123')), { path: IMG })
  assert.equal(r.status, 502)
  assert.equal(r.body.toString(), 'connect failed, key [скрыто]')
  assert.equal(r.headers['access-control-allow-origin'], 'http://localhost:5173')
  const timedOut = Object.assign(new Error('upstream timed out'), { status: 504 })
  r = await call(mediaRequest, failing(timedOut), { path: MEDIA })
  assert.equal(r.status, 504)
  assert.equal(r.body.toString(), 'upstream timed out')
  r = await call(imgRequest, failing(Object.assign(new Error(), { message: undefined })), { path: IMG })
  assert.equal(r.status, 502)
  assert.equal(r.body.toString(), 'proxy failed')
})

test('module: an upstream error after the headers drops the connection', async () => {
  const { open } = fakeOpen(() => {
    const u = upstream({ headers: { 'content-type': 'video/mp4' }, chunks: [Buffer.from('ab')], end: false })
    setTimeout(() => u.destroy(new Error('reset')), 50)
    return u
  })
  const r = await call(mediaRequest, open, { path: MEDIA })
  assert.equal(r.status, 200)
  assert.equal(r.complete, false)
})

test('module: a client that goes away stops the upstream download', async () => {
  let u
  const { open } = fakeOpen(() => (u = upstream({ headers: { 'content-type': 'video/mp4' }, chunks: [Buffer.from('ab')], end: false })))
  await call(mediaRequest, open, { path: MEDIA, abortAfterHeaders: true })
  const deadline = Date.now() + 3000
  while (!u.destroyed && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(u.destroyed, true)
})
