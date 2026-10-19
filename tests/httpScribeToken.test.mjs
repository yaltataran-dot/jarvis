import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { SCRIBE_TOKEN_PATH, SCRIBE_TOKEN_URL, scribeTokenRequest } from '../bridge/http/scribe-token.mjs'

/**
 * GET /scribe-token (bridge/http/scribe-token.mjs) over real HTTP, with a fake
 * ElevenLabs and a fake clock. Mostly the refusals: the strict Origin rule, no
 * key, the rate gap, every upstream failure, and nothing secret leaking. The
 * token itself is single-use by ElevenLabs' rules; the bridge neither keeps
 * nor reuses one, which is checked too. Written against the route while it
 * was still in server.mjs (the last test checked the copy matched).
 */

const CORS = { 'access-control-allow-origin': 'https://page.example', vary: 'origin' }
const KEY = 'xi-secret-key-0123456789abcdef'
const GOOD = 'https://page.example'

let state
function reset() {
  state = {
    allowNoOrigin: false,
    key: KEY,
    clock: 100_000,
    last: 0,
    upstream: async () => ({ ok: true, status: 200, json: async () => ({ token: `tok-${state.calls.length}` }) }),
    calls: [],
    logs: [],
  }
}
reset()

let server, url
before(async () => {
  server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === SCRIBE_TOKEN_PATH) {
      return void scribeTokenRequest(req, res, {
        cors: CORS,
        origin: req.headers.origin,
        // As the bridge decides it: a listed origin, or no Origin only when JARVIS_ALLOW_NO_ORIGIN is set.
        originAllowed: (o) => (o ? o === GOOD : state.allowNoOrigin),
        elevenKey: () => state.key,
        gap: { ms: 2000, last: () => state.last, mark: (t) => void (state.last = t) },
        fetch: async (u, init) => (state.calls.push({ u, init }), state.upstream()),
        now: () => state.clock,
        log: (l) => state.logs.push(l),
      })
    }
    res.writeHead(404).end()
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${server.address().port}${SCRIBE_TOKEN_PATH}`
})
after(() => new Promise((r) => server.close(r)))
beforeEach(reset)

// Node's fetch sends no Origin unless told; http.get is used where none must be sent.
const get = (origin) =>
  new Promise((ok, no) => {
    const r = http.get(url, { headers: origin ? { origin } : {} }, (res) => {
      let body = ''
      res.on('data', (d) => (body += d)).on('end', () => ok({ status: res.statusCode, headers: res.headers, body }))
    })
    r.on('error', no)
  })

test('allowed origin, a key, ElevenLabs answers: 200 {token}, no-store; asked once, with the key in its header', async () => {
  const r = await get(GOOD)
  assert.equal(r.status, 200)
  assert.equal(r.headers['content-type'], 'application/json')
  assert.equal(r.headers['cache-control'], 'no-store')
  assert.equal(r.headers['access-control-allow-origin'], 'https://page.example')
  assert.deepEqual(JSON.parse(r.body), { token: 'tok-1' })
  assert.equal(state.calls.length, 1)
  assert.equal(state.calls[0].u, 'https://api.elevenlabs.io/v1/single-use-token/realtime_scribe')
  assert.equal(SCRIBE_TOKEN_URL, state.calls[0].u)
  assert.equal(state.calls[0].init.method, 'POST')
  assert.deepEqual(state.calls[0].init.headers, { 'xi-api-key': KEY })
  assert.ok(state.calls[0].init.signal instanceof AbortSignal, 'with a time limit')
  assert.equal(state.last, 100_000, 'the issue time is recorded')
})

test('no Origin is refused (403, no-store) unless JARVIS_ALLOW_NO_ORIGIN; nothing is asked of ElevenLabs', async () => {
  const r = await get(undefined)
  assert.equal(r.status, 403)
  assert.equal(r.body, 'forbidden')
  assert.equal(r.headers['cache-control'], 'no-store')
  assert.equal(state.calls.length, 0)
  assert.equal(state.last, 0, 'a refusal does not use up the gap')
  state.allowNoOrigin = true
  const allowed = await get(undefined)
  assert.equal(allowed.status, 200, 'allowed only when explicitly switched on')
})

test('a foreign origin is refused: 403, nothing asked', async () => {
  const r = await get('https://evil.example')
  assert.equal(r.status, 403)
  assert.equal(r.body, 'forbidden')
  assert.equal(state.calls.length, 0)
})

test('no ElevenLabs key: 503 "no elevenlabs key", no-store, nothing asked', async () => {
  state.key = null
  const r = await get(GOOD)
  assert.equal(r.status, 503)
  assert.equal(r.body, 'no elevenlabs key')
  assert.equal(r.headers['cache-control'], 'no-store')
  assert.equal(state.calls.length, 0)
})

test('tokens are at least 2 s apart: a second request sooner is 429 with retry-after 2, and nothing is asked', async () => {
  assert.equal((await get(GOOD)).status, 200)
  state.clock += 1999
  const r = await get(GOOD)
  assert.equal(r.status, 429)
  assert.equal(r.body, 'too many requests')
  assert.equal(r.headers['retry-after'], '2')
  assert.equal(r.headers['cache-control'], 'no-store')
  assert.equal(state.calls.length, 1)
  state.clock += 1
  assert.equal((await get(GOOD)).status, 200, 'after the gap, the next one is issued')
})

test('a failed request still counts against the gap: a loop of failing starts cannot hammer ElevenLabs', async () => {
  state.upstream = async () => ({ ok: false, status: 500, json: async () => ({}) })
  assert.equal((await get(GOOD)).status, 502)
  state.clock += 500
  assert.equal((await get(GOOD)).status, 429)
  assert.equal(state.calls.length, 1)
})

test('the bridge keeps and reuses no token: each issue asks ElevenLabs afresh and passes on what it gave', async () => {
  const a = JSON.parse((await get(GOOD)).body).token
  state.clock += 2000
  const b = JSON.parse((await get(GOOD)).body).token
  assert.equal(state.calls.length, 2)
  assert.notEqual(a, b)
})

test('ElevenLabs refusing: 502 "token request failed"; the log has the status only, never its body, the key or a token', async () => {
  state.upstream = async () => ({ ok: false, status: 401, json: async () => ({ detail: 'invalid key xi-secret-key-0123456789abcdef' }) })
  const r = await get(GOOD)
  assert.equal(r.status, 502)
  assert.equal(r.body, 'token request failed')
  assert.equal(r.headers['cache-control'], 'no-store')
  assert.deepEqual(state.logs, ['[jarvis] scribe token refused by ElevenLabs (401)'])
})

test('an answer without a usable token is a failure: 502', async () => {
  for (const json of [{}, { token: '' }, { token: 42 }, { token: null }]) {
    reset()
    state.upstream = async () => ({ ok: true, status: 200, json: async () => json })
    const r = await get(GOOD)
    assert.equal(r.status, 502, JSON.stringify(json))
    assert.equal(r.body, 'token request failed')
  }
})

test('ElevenLabs unreachable, timing out, or answering garbage: 502', async () => {
  for (const upstream of [
    async () => { throw new TypeError('fetch failed') },
    async () => { throw new DOMException('timed out', 'TimeoutError') },
    async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json') } }),
  ]) {
    reset()
    state.upstream = upstream
    const r = await get(GOOD)
    assert.equal(r.status, 502)
    assert.equal(r.body, 'token request failed')
    assert.equal(r.headers['cache-control'], 'no-store')
  }
})

test('the key is never in any answer, and a token never in the log', async () => {
  const bodies = []
  bodies.push((await get(GOOD)).body)
  state.clock += 2000
  state.upstream = async () => ({ ok: false, status: 403, json: async () => ({ key: KEY }) })
  bodies.push((await get(GOOD)).body)
  bodies.push((await get(undefined)).body)
  assert.ok(bodies.every((b) => !b.includes(KEY)))
  assert.ok(state.logs.every((l) => !l.includes(KEY) && !l.includes('tok-')))
})

test('wiring: the bridge routes the same request here with its own Origin rule, key and one shared gap, after its Host and Origin checks', () => {
  const srv = readFileSync(new URL('../bridge/server.mjs', import.meta.url), 'utf8').replace(/\r/g, '')
  assert.equal(SCRIBE_TOKEN_PATH, '/scribe-token')
  assert.match(srv, /import \{ SCRIBE_TOKEN_PATH, scribeTokenRequest \} from '\.\/http\/scribe-token\.mjs'/)
  const route = `if (req.method === 'GET' && req.url === SCRIBE_TOKEN_PATH) {
    return scribeTokenRequest(req, res, {
      cors,
      origin,
      originAllowed,
      elevenKey,
      gap: { ms: SCRIBE_TOKEN_GAP_MS, last: () => lastScribeToken, mark: (t) => void (lastScribeToken = t) },
    })`
  assert.ok(srv.includes(route), 'no fetch or clock passed: the real ones, as before')
  // The gap is still one value for the whole bridge, two seconds, in server.mjs.
  assert.match(srv, /const SCRIBE_TOKEN_GAP_MS = 2000\nlet lastScribeToken = 0\n/)
  // The strict rule rests on the bridge's own originAllowed: no Origin only with JARVIS_ALLOW_NO_ORIGIN.
  // It lives in access.mjs, built once from process.env by server.mjs.
  const access = readFileSync(new URL('../bridge/access.mjs', import.meta.url), 'utf8').replace(/\r/g, '')
  assert.match(access, /function originAllowed\(origin\) \{\n {4}if \(!origin\) return ALLOW_NO_ORIGIN/)
  assert.match(access, /const ALLOW_NO_ORIGIN = env\.JARVIS_ALLOW_NO_ORIGIN === '1'/)
  assert.match(srv, /^const \{ originAllowed, hostAllowed, extraOrigins: EXTRA_ORIGINS, allowNoOrigin: ALLOW_NO_ORIGIN \} = createAccess\(process\.env\)$/m)
  const at = srv.indexOf(route)
  const handler = srv.indexOf('const handleRequest = async (req, res) => {')
  for (const guard of ['if (!hostAllowed(req.headers.host)) {', 'const origin = req.headers.origin', 'if (origin && !originAllowed(origin)) {', 'const cors = corsFor(req)']) {
    const g = srv.indexOf(guard, handler)
    assert.ok(g > handler && g < at, `${guard} still runs before the route`)
  }
  assert.ok(!srv.includes("req.url === '/scribe-token'"), 'the old inline route is gone')
  assert.ok(!srv.includes('single-use-token/realtime_scribe'), 'the upstream URL lives in the route module only')
})
