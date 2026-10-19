import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { MAX_BODY, MUSIC_PATH, musicRequest } from '../bridge/http/music.mjs'

/**
 * POST /music (bridge/http/music.mjs) over real HTTP, behind the same request
 * error handling as server.mjs (a throw becomes an empty 500). The player's
 * own behaviour — each action, its checks and time limits — is tested in
 * yandexMusic.test.mjs; here: the body read, the command passed on, the result
 * returned as it is, and what a failing player looks like to the page.
 * Written against the route while it was still in server.mjs (the last test
 * checked the copy matched). No real player is touched.
 */

const CORS = { 'access-control-allow-origin': 'https://page.example', vary: 'origin' }
const seen = []
let answer = (op) => ({ code: 'ok', op })
/** A player that records each call and answers as `answer` says (a function that may throw or wait). */
const ym = new Proxy({}, { get: (_, op) => async (arg) => (seen.push([op, arg]), answer(op, arg)) })
let server, url, failures = 0

before(async () => {
  server = http.createServer((req, res) => {
    const handle = async () => {
      if (req.method === 'POST' && req.url === MUSIC_PATH) return musicRequest(req, res, { cors: CORS, ym })
      res.writeHead(404).end()
    }
    // As in server.mjs: a request that throws is answered 500, never left hanging.
    handle().catch(() => {
      failures++
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${server.address().port}${MUSIC_PATH}`
})
after(() => new Promise((r) => server.close(r)))

const post = (body) => fetch(url, { method: 'POST', body, headers: { 'content-type': 'application/json' } })
const reset = () => {
  seen.length = 0
  answer = (op) => ({ code: 'ok', op })
}

test('a command is passed to the player and its result returned as it is: 200 JSON with the CORS headers, no cache header', async () => {
  reset()
  const r = await post(JSON.stringify({ action: 'pause' }))
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-type'), 'application/json')
  assert.equal(r.headers.get('access-control-allow-origin'), 'https://page.example')
  assert.equal(r.headers.get('cache-control'), null, 'as before: no cache-control on this route')
  assert.deepEqual(await r.json(), { code: 'ok', op: 'pause' })
  assert.deepEqual(seen, [['pause', undefined]])
})

test('arguments reach the player as musicAction shapes them (volume clamped, search kind checked)', async () => {
  reset()
  await post(JSON.stringify({ action: 'volume', set: 250 }))
  await post(JSON.stringify({ action: 'search', query: 'Кино', kind: 'nonsense' }))
  assert.deepEqual(seen, [['volume', { set: 100 }], ['search', { query: 'Кино', kind: 'any', play: true }]])
})

test('the player saying something went wrong is still a 200: what happened is in `code`', async () => {
  reset()
  answer = () => ({ code: 'not-running', message: 'Яндекс Музыка не запущена' })
  const r = await post(JSON.stringify({ action: 'next' }))
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), { code: 'not-running', message: 'Яндекс Музыка не запущена' })
})

test('an unknown command, a volume with no amount, an empty body: 200 with code "failed", nothing reaches the player', async () => {
  reset()
  for (const body of [JSON.stringify({ action: 'format-disk' }), JSON.stringify({ action: 'volume' }), '']) {
    const r = await post(body)
    assert.equal(r.status, 200)
    assert.equal((await r.json()).code, 'failed', body || '(empty)')
  }
  assert.deepEqual(seen, [])
})

test('a slow player is waited for: the route has no time limit of its own', async () => {
  reset()
  answer = (op) => new Promise((ok) => setTimeout(() => ok({ code: 'ok', op }), 150))
  const t0 = Date.now()
  const r = await post(JSON.stringify({ action: 'now' }))
  assert.equal(r.status, 200)
  assert.ok(Date.now() - t0 >= 140)
  assert.deepEqual(await r.json(), { code: 'ok', op: 'now' })
})

test('a player call that throws is not caught by the route: the bridge answers an empty 500', async () => {
  reset()
  answer = () => {
    throw new Error('media worker crashed')
  }
  const before = failures
  const r = await post(JSON.stringify({ action: 'play' }))
  assert.equal(r.status, 500)
  assert.equal(await r.text(), '')
  assert.equal(failures, before + 1)
})

test('a body that is not JSON: 400 "bad json", with the CORS headers', async () => {
  reset()
  const r = await post('{not json')
  assert.equal(r.status, 400)
  assert.equal(await r.text(), 'bad json')
  assert.equal(r.headers.get('access-control-allow-origin'), 'https://page.example')
  assert.deepEqual(seen, [])
})

test(`a body over ${MAX_BODY} characters is refused: 413 "body too large", or the connection is cut while it is still sending`, async () => {
  reset()
  assert.equal(MAX_BODY, 4096)
  try {
    const r = await post(JSON.stringify({ action: 'search', query: 'x'.repeat(MAX_BODY + 100) }))
    assert.equal(r.status, 413)
    assert.equal(await r.text(), 'body too large')
  } catch (err) {
    // The handler destroys the request as soon as it is too long; a client
    // still writing can see the socket close before it reads the 413.
    assert.match(String(err?.cause?.code ?? err?.code ?? err), /ECONNRESET|EPIPE|UND_ERR_SOCKET|other side closed/)
  }
  assert.deepEqual(seen, [], 'nothing reached the player')
})

test('wiring: the bridge routes the same request to this handler with its one player, after its Host and Origin checks, inside its 500 catch', () => {
  const srv = readFileSync(new URL('../bridge/server.mjs', import.meta.url), 'utf8').replace(/\r/g, '')
  assert.equal(MUSIC_PATH, '/music')
  assert.match(srv, /import \{ MUSIC_PATH, musicRequest \} from '\.\/http\/music\.mjs'/)
  const route = "if (req.method === 'POST' && req.url === MUSIC_PATH) {\n    return musicRequest(req, res, { cors, ym: YM })"
  assert.ok(srv.includes(route), 'the player the bridge built once, as before')
  assert.match(srv, /const YM = createYandexMusic\(\{ log: \(line\) => console\.log\(line\) \}\)/)
  const at = srv.indexOf(route)
  const handler = srv.indexOf('const handleRequest = async (req, res) => {')
  for (const guard of ['if (!hostAllowed(req.headers.host)) {', 'if (origin && !originAllowed(origin)) {', 'const cors = corsFor(req)']) {
    const g = srv.indexOf(guard, handler)
    assert.ok(g > handler && g < at, `${guard} still runs before the route`)
  }
  assert.match(srv, /handleRequest\(req, res\)\.catch\(\(err\) => \{\n\s+console\.error\('\[jarvis\] request failed:', err\)\n\s+if \(!res\.headersSent\) res\.writeHead\(500\)\n\s+res\.end\(\)/, 'a throw is still answered 500')
  assert.ok(!srv.includes("req.url === '/music'"), 'the old inline route is gone')
})
