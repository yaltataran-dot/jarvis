import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { createGoogleCalendar } from '../bridge/googleCalendar.mjs'
import { CALENDAR_PATH, MAX_BODY, calendarRequest } from '../bridge/http/calendar.mjs'

/**
 * POST /calendar (bridge/http/calendar.mjs) over real HTTP. The calendar's own
 * rules — what may be written, how a command is checked — are tested in
 * googleCalendar.test.mjs; here: that the route reads the body, passes the
 * command on, returns the result as it is, and opens nothing the calendar
 * keeps shut. Written against the route while it was still in server.mjs
 * (the last test checked the copy matched).
 */

const CORS = { 'access-control-allow-origin': 'https://page.example', vary: 'origin' }
const seen = []
/** Records each call; answers {code:'ok', op}. */
const recording = new Proxy({}, { get: (_, op) => async (arg) => (seen.push([op, arg]), { code: 'ok', op }) })
let netCalls = 0
/** The real calendar, not connected and without JARVIS_CALENDAR_WRITES: nothing may reach Google. */
const shut = createGoogleCalendar({ exists: () => false, fetch: async () => (netCalls++, assert.fail('nothing should be sent')), env: {}, log: () => {} })
let cal = recording
let server, url

before(async () => {
  server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === CALENDAR_PATH) return void calendarRequest(req, res, { cors: CORS, cal })
    res.writeHead(404).end()
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${server.address().port}${CALENDAR_PATH}`
})
after(() => new Promise((r) => server.close(r)))

const post = (body) => fetch(url, { method: 'POST', body, headers: { 'content-type': 'application/json' } })

test('a command is passed to the calendar and its result returned as it is: 200 JSON with the CORS headers, no cache header', async () => {
  seen.length = 0
  const r = await post(JSON.stringify({ op: 'list', timeMin: '2026-10-18T00:00:00+03:00', timeMax: '2026-10-19T00:00:00+03:00' }))
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-type'), 'application/json')
  assert.equal(r.headers.get('access-control-allow-origin'), 'https://page.example')
  assert.equal(r.headers.get('cache-control'), null, 'as before: no cache-control on this route')
  assert.deepEqual(await r.json(), { code: 'ok', op: 'list' })
  assert.deepEqual(seen, [['list', { timeMin: '2026-10-18T00:00:00+03:00', timeMax: '2026-10-19T00:00:00+03:00' }]])
})

test('a command the calendar refuses is still a 200: what happened is in `code`', async () => {
  seen.length = 0
  for (const cmd of [{ op: 'drop-all' }, { op: 'list', timeMin: 'yesterday', timeMax: 'x' }, { op: 'remove', id: 'ABC/../x' }]) {
    const r = await post(JSON.stringify(cmd))
    assert.equal(r.status, 200)
    assert.equal((await r.json()).code, 'failed', JSON.stringify(cmd))
  }
  assert.deepEqual(seen, [], 'nothing invalid reached the calendar')
})

test('an empty body is no command: 200 with code "failed"', async () => {
  const r = await post('')
  assert.equal(r.status, 200)
  assert.equal((await r.json()).code, 'failed')
})

test('through the route, the real calendar without JARVIS_CALENDAR_WRITES writes nothing and sends nothing', async () => {
  cal = shut
  try {
    const NEW = { opId: '0123456789abcdef0123', summary: 'Встреча', timeZone: 'Europe/Moscow', start: { dateTime: '2026-10-18T18:00:00' }, end: { dateTime: '2026-10-18T19:00:00' } }
    for (const cmd of [{ ...NEW, op: 'create' }, { op: 'remove', id: 'abc12' }]) {
      const r = await post(JSON.stringify(cmd))
      assert.equal(r.status, 200)
      assert.equal((await r.json()).code, 'writes-disabled', JSON.stringify(cmd))
    }
    const status = await (await post(JSON.stringify({ op: 'status' }))).json()
    assert.equal(status.writes, false)
    assert.equal(netCalls, 0)
  } finally {
    cal = recording
  }
})

test('a body that is not JSON: 400 "bad json", with the CORS headers', async () => {
  const r = await post('{not json')
  assert.equal(r.status, 400)
  assert.equal(await r.text(), 'bad json')
  assert.equal(r.headers.get('access-control-allow-origin'), 'https://page.example')
})

test(`a body over ${MAX_BODY} characters is refused: 413 "body too large", or the connection is cut while it is still sending`, async () => {
  assert.equal(MAX_BODY, 8192)
  seen.length = 0
  try {
    const r = await post(JSON.stringify({ op: 'status', pad: 'x'.repeat(MAX_BODY + 100) }))
    assert.equal(r.status, 413)
    assert.equal(await r.text(), 'body too large')
  } catch (err) {
    // The handler destroys the request as soon as it is too long; a client
    // still writing can see the socket close before it reads the 413.
    assert.match(String(err?.cause?.code ?? err?.code ?? err), /ECONNRESET|EPIPE|UND_ERR_SOCKET|other side closed/)
  }
  assert.deepEqual(seen, [], 'nothing reached the calendar')
})

test('wiring: the bridge routes the same request to this handler with its one calendar, after its Host and Origin checks', () => {
  const server = readFileSync(new URL('../bridge/server.mjs', import.meta.url), 'utf8').replace(/\r/g, '')
  assert.equal(CALENDAR_PATH, '/calendar')
  assert.match(server, /import \{ CALENDAR_PATH, calendarRequest \} from '\.\/http\/calendar\.mjs'/)
  const route = "if (req.method === 'POST' && req.url === CALENDAR_PATH) {\n    return calendarRequest(req, res, { cors, cal: CAL })"
  assert.ok(server.includes(route), 'the calendar the bridge built once, as before')
  assert.match(server, /const CAL = createGoogleCalendar\(\{ log: \(line\) => console\.log\(line\) \}\)/)
  const at = server.indexOf(route)
  const handler = server.indexOf('const handleRequest = async (req, res) => {')
  for (const guard of ['if (!hostAllowed(req.headers.host)) {', 'if (origin && !originAllowed(origin)) {', 'const cors = corsFor(req)']) {
    const g = server.indexOf(guard, handler)
    assert.ok(g > handler && g < at, `${guard} still runs before the route`)
  }
  assert.ok(!server.includes("req.url === '/calendar'"), 'the old inline route is gone')
})
