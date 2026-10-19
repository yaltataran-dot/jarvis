import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pageRequest } from '../bridge/http/page.mjs'

/**
 * GET /page — a remote web page served from the bridge's origin so it can be
 * framed — as the running bridge serves it. Written against the route while
 * it was still in server.mjs.
 *
 * Only what a real server can show without the network: every request here is
 * refused by the SSRF gate (net.mjs, reached through renderPage → fetchText)
 * before a socket to the outside is opened, so the gate is exercised as it is,
 * never switched off. That reaches the error page only, and only with the
 * gate's own messages — which contain neither `<` nor `&`, so the escaping is
 * not visible from here. The success path and the mode switch are not
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

/** A request with an exact Host header; resolves with status, headers and body. */
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
  home = mkdtempSync(join(tmpdir(), 'jarvis-page-'))
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

/** The error page, byte for byte, for a given (already escaped) message. */
const errorPage = (message) =>
  `<!doctype html><meta charset="utf-8"><style>
           body{margin:0;padding:26px;background:transparent;color:#7fb6bf;
                font:400 13px/1.6 ui-monospace,monospace}
           b{color:#cfe9ee;font-weight:500;display:block;margin-bottom:6px}
         </style><b>This page could not be opened.</b>${message}`
const ERROR_CSP = "default-src 'none'; style-src 'unsafe-inline'"

test('/page: no url, or one that is not an absolute http(s) url, is a 400 error page', async () => {
  for (const path of ['/page?', '/page?url=', '/page?mode=live', `/page?url=${q('not a url')}`, `/page?url=${q('/relative')}&mode=reader`]) {
    const r = await get(path)
    assert.equal(r.status, 400, path)
    assert.equal(r.body, errorPage('absolute http(s) url required'), path)
  }
})

test('/page: other schemes are a 400 error page — file, ftp, data, javascript', async () => {
  for (const u of ['file:///etc/passwd', 'file:///C:/Windows/win.ini', 'ftp://example.com/', 'data:text/html,<b>x</b>', 'javascript:alert(1)']) {
    for (const mode of ['reader', 'live']) {
      const r = await get(`/page?url=${q(u)}&mode=${mode}`)
      assert.equal(r.status, 400, `${u} ${mode}`)
      assert.equal(r.body, errorPage('absolute http(s) url required'), `${u} ${mode}`)
    }
  }
})

test('/page: loopback, private, link-local and local names are a 403 error page before any connection', async () => {
  const targets = [
    `http://127.0.0.1:${bridge.port}/health`,
    `http://localhost:${bridge.port}/page?url=x`,
    'http://0.0.0.0/',
    'http://10.0.0.5/',
    'http://172.16.0.1/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[fd00::1]/',
    'https://printer.local/',
    'http://nas.internal/',
    'http://router.home.arpa/',
  ]
  for (const u of targets) {
    for (const mode of ['reader', 'live']) {
      const r = await get(`/page?url=${q(u)}&mode=${mode}`)
      assert.equal(r.status, 403, `${u} ${mode}`)
      assert.equal(r.body, errorPage('blocked host'), `${u} ${mode}`)
    }
  }
})

test('/page: the error page is HTML with its own CSP, the CORS headers, and no nosniff', async () => {
  const r = await get(`/page?url=${q('http://127.0.0.1/')}`, { headers: { Origin: 'http://localhost:5173' } })
  assert.equal(r.status, 403)
  assert.equal(r.headers['content-type'], 'text/html; charset=utf-8')
  assert.equal(r.headers['content-security-policy'], ERROR_CSP)
  assert.equal(r.headers['access-control-allow-origin'], 'http://localhost:5173')
  assert.equal(r.headers['access-control-allow-headers'], 'content-type')
  assert.equal(r.headers.vary, 'origin')
  assert.equal(r.headers['x-content-type-options'], undefined)
  assert.equal(r.headers['cache-control'], undefined)
})

test('/page: an iframe load (no Origin) is served by the shared checks, with nothing reflected', async () => {
  const r = await get(`/page?url=${q('http://127.0.0.1/')}`)
  assert.equal(r.status, 403)
  assert.equal(r.body, errorPage('blocked host'), 'the route answered, not the Origin check')
  assert.equal(r.headers['access-control-allow-origin'], undefined)
  assert.equal(r.headers.vary, 'origin')
})

test('/page: the path must be followed by "?" and the method must be GET', async () => {
  for (const path of ['/page', '/page/', `/pages?url=${q('http://127.0.0.1/')}`, `/pagex?url=${q('http://127.0.0.1/')}`]) {
    const r = await get(path)
    assert.equal(r.status, 404, path)
    assert.equal(r.body, '', path)
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
    const r = await get(`/page?url=${q('http://127.0.0.1/')}`, { method })
    assert.equal(r.status, 404, method)
  }
})

test('/page: Host, then Origin, then OPTIONS — all before the route', async () => {
  const path = `/page?url=${q('http://127.0.0.1/')}`
  const badHost = await get(path, { host: 'evil.example', headers: { Origin: 'http://localhost:5173' } })
  assert.equal(badHost.status, 403)
  assert.equal(badHost.body, 'forbidden', 'the Host check answers, not the error page')
  assert.equal(badHost.headers['content-security-policy'], undefined)

  const badOrigin = await get(path, { headers: { Origin: 'http://evil.example' } })
  assert.equal(badOrigin.status, 403)
  assert.equal(badOrigin.body, 'forbidden', 'the Origin check answers, not the error page')

  const preflight = await get(path, { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173' } })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.body, '')
  assert.equal(preflight.headers['access-control-allow-origin'], 'http://localhost:5173')
  assert.equal(preflight.headers['content-security-policy'], undefined)
})

test('/page: the bridge stays up after a run of refusals', async () => {
  assert.equal(bridge.child.exitCode, null)
  assert.equal((await get('/health')).status, 200)
})

// ---------------------------------------------------------------------------
// The handler in http/page.mjs, with a stand-in `render` so nothing reaches
// the network. These test the route around renderPage, not page.mjs itself,
// and were written after the move (the code was not importable while it sat
// inside server.mjs).

const CORS = { vary: 'origin', 'access-control-allow-origin': 'http://localhost:5173', 'access-control-allow-headers': 'content-type' }
const ORIGIN = 'http://localhost:8787'

/** A stand-in render that records its arguments and answers with `make()`. */
const fakeRender = (make) => {
  const calls = []
  const render = async (target, mode, bridgeOrigin) => {
    calls.push({ target, mode, bridgeOrigin })
    return make()
  }
  return { render, calls }
}

/** Serve the handler on loopback, make one request, collect what came back. */
async function call(path, deps) {
  const server = http.createServer((req, res) => pageRequest(req, res, { cors: CORS, bridgeOrigin: ORIGIN, ...deps }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    return await request({ port: server.address().port, path })
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}

const ok = () => ({ body: '<p>hi</p>', title: 't', headers: { 'content-type': 'text/html; charset=utf-8' } })

test('module: the url, the mode and bridgeOrigin reach render as they did', async () => {
  const { render, calls } = fakeRender(ok)
  await call(`/page?url=${q('https://news.example/a?b=1&c=2')}&mode=live`, { render })
  assert.deepEqual(calls[0], { target: 'https://news.example/a?b=1&c=2', mode: 'live', bridgeOrigin: ORIGIN })
  await call('/page?mode=live', { render })
  assert.equal(calls[1].target, '', 'no url is an empty string, for renderPage to refuse')
})

test('module: "live" only when the mode is exactly live; reader otherwise', async () => {
  const { render, calls } = fakeRender(ok)
  const modes = { '': 'reader', '&mode=reader': 'reader', '&mode=live': 'live', '&mode=LIVE': 'reader', '&mode=live%20': 'reader', '&mode=': 'reader', '&mode=x': 'reader', '&mode=reader&mode=live': 'reader', '&mode=live&mode=reader': 'live' }
  for (const [suffix, want] of Object.entries(modes)) {
    await call(`/page?url=${q('https://news.example/')}${suffix}`, { render })
    assert.equal(calls.at(-1).mode, want, JSON.stringify(suffix))
  }
})

test('module: success is 200 with the body, and the page headers over the CORS ones', async () => {
  const { render } = fakeRender(() => ({
    body: '<!doctype html><p>article</p>',
    title: 'ignored',
    headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'", 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', vary: 'accept' },
  }))
  const r = await call(`/page?url=${q('https://news.example/')}`, { render })
  assert.equal(r.status, 200)
  assert.equal(r.body, '<!doctype html><p>article</p>')
  assert.equal(r.headers['content-security-policy'], "default-src 'none'")
  assert.equal(r.headers['x-content-type-options'], 'nosniff')
  assert.equal(r.headers['cache-control'], 'no-store')
  assert.equal(r.headers['access-control-allow-origin'], 'http://localhost:5173', 'CORS kept where the page says nothing')
  assert.equal(r.headers.vary, 'accept', 'the page wins where both set a header')
})

test('module: a failure is the error page — its status, or 502 without one', async () => {
  const failing = (err) => fakeRender(() => Promise.reject(err)).render
  let r = await call(`/page?url=${q('https://news.example/')}`, { render: failing(Object.assign(new Error('not a web page (got image/png)'), { status: 415 })) })
  assert.equal(r.status, 415)
  assert.equal(r.body, errorPage('not a web page (got image/png)'))
  assert.equal(r.headers['content-type'], 'text/html; charset=utf-8')
  assert.equal(r.headers['content-security-policy'], ERROR_CSP)
  assert.equal(r.headers['access-control-allow-origin'], 'http://localhost:5173')
  assert.equal(r.headers['x-content-type-options'], undefined)
  r = await call(`/page?url=${q('https://news.example/')}`, { render: failing(new Error('socket hang up')) })
  assert.equal(r.status, 502)
  assert.equal(r.body, errorPage('socket hang up'))
})

test('module: the message has < and & removed, and is not redacted', async () => {
  const failing = (message) => fakeRender(() => Promise.reject(Object.assign(new Error(), { message }))).render
  let r = await call(`/page?url=${q('https://news.example/')}`, { render: failing('a <script>x</script> & b; key sk-abc123') })
  assert.equal(r.body, errorPage('a script>x/script>  b; key sk-abc123'))
  // `??`, not `||`: only a missing message becomes "unknown error"; an empty one stays empty.
  r = await call(`/page?url=${q('https://news.example/')}`, { render: failing(undefined) })
  assert.equal(r.body, errorPage('unknown error'))
  r = await call(`/page?url=${q('https://news.example/')}`, { render: failing('') })
  assert.equal(r.body, errorPage(''))
})

test('module: without a stand-in, the real renderPage and its SSRF gate are what run', async () => {
  for (const [u, status, message] of [['http://127.0.0.1/', 403, 'blocked host'], ['http://169.254.169.254/', 403, 'blocked host'], ['file:///etc/passwd', 400, 'absolute http(s) url required']]) {
    const r = await call(`/page?url=${q(u)}`, {})
    assert.equal(r.status, status, u)
    assert.equal(r.body, errorPage(message), u)
  }
})
