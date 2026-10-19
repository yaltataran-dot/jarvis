import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { openKnowledge } from '../bridge/knowledge.mjs'
import { KNOWLEDGE_ANSWER_PATH, MAX_BODY, knowledgeAnswer } from '../bridge/http/knowledge.mjs'

/**
 * POST /knowledge/answer (bridge/http/knowledge.mjs) over real HTTP: status
 * codes, bodies and headers as the page gets them. Written against the route
 * while it was still in server.mjs (the last test checked the copy matched),
 * so a change in what the page receives shows up here.
 */

const CORS = { 'access-control-allow-origin': 'https://page.example', vary: 'origin' }
let kb, server, base
const deferred = []
const logs = []
let withKb = true

before(async () => {
  kb = openKnowledge({ dir: ':memory:' })
  kb.add({ question: 'Какой у меня любимый кофе', answer: 'Капучино без сахара', provenance: 'user-explicit' })
  server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === KNOWLEDGE_ANSWER_PATH) {
      return void knowledgeAnswer(req, res, { cors: CORS, kb: withKb ? kb : null, log: (l) => logs.push(l), defer: (fn) => deferred.push(fn) })
    }
    res.writeHead(404).end()
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}${KNOWLEDGE_ANSWER_PATH}`
})
after(async () => {
  await new Promise((r) => server.close(r))
  kb.close()
})

const post = (body) => fetch(base, { method: 'POST', body, headers: { 'content-type': 'application/json' } })

test('a question the user has answered before: 200, the answer and its id, no-store, the CORS headers; the use is counted after', async () => {
  deferred.length = 0
  const r = await post(JSON.stringify({ text: 'какой у меня любимый кофе?' }))
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-type'), 'application/json')
  assert.equal(r.headers.get('cache-control'), 'no-store')
  assert.equal(r.headers.get('access-control-allow-origin'), 'https://page.example')
  assert.equal(r.headers.get('vary'), 'origin')
  const j = await r.json()
  assert.equal(j.hit, true)
  assert.equal(j.answer, 'Капучино без сахара')
  assert.equal(typeof j.id, 'number', 'the record id, as the knowledge base keeps it')
  assert.equal(typeof j.ms, 'number')
  assert.equal(deferred.length, 1, 'counting the use waits until the answer is sent')
  deferred[0]()
})

test('a question it does not know: still 200, hit false with the reason', async () => {
  const r = await post(JSON.stringify({ text: 'Как зовут мою собаку' }))
  assert.equal(r.status, 200)
  const j = await r.json()
  assert.equal(j.hit, false)
  assert.equal(typeof j.reason, 'string')
  assert.equal(typeof j.ms, 'number')
})

test('an empty body is an empty question: a miss, not an error', async () => {
  const r = await post('')
  assert.equal(r.status, 200)
  assert.equal((await r.json()).hit, false)
})

test('a bridge without a knowledge base always misses, with 200', async () => {
  withKb = false
  try {
    const r = await post(JSON.stringify({ text: 'какой у меня любимый кофе?' }))
    assert.equal(r.status, 200)
    assert.equal((await r.json()).hit, false)
  } finally {
    withKb = true
  }
})

test('a body that is not JSON: 400 "bad json", with the CORS headers', async () => {
  const r = await post('{not json')
  assert.equal(r.status, 400)
  assert.equal(await r.text(), 'bad json')
  assert.equal(r.headers.get('access-control-allow-origin'), 'https://page.example')
})

test(`a body over ${MAX_BODY} characters is refused: 413 "body too large", or the connection is cut while it is still sending`, async () => {
  assert.equal(MAX_BODY, 4096)
  try {
    const r = await post(JSON.stringify({ text: 'x'.repeat(MAX_BODY + 100) }))
    assert.equal(r.status, 413)
    assert.equal(await r.text(), 'body too large')
  } catch (err) {
    // The handler destroys the request as soon as it is too long; a client
    // still writing can see the socket close before it reads the 413.
    assert.match(String(err?.cause?.code ?? err?.code ?? err), /ECONNRESET|EPIPE|UND_ERR_SOCKET|other side closed/)
  }
})

test('logs carry hit or miss and timings, never the words asked', () => {
  assert.ok(logs.some((l) => /knowledge_hit id=/.test(l)))
  assert.ok(logs.some((l) => /knowledge_miss reason=/.test(l)))
  assert.ok(logs.every((l) => !/кофе|собак/i.test(l)))
})

test('wiring: the bridge routes the same request to this handler, after its Host and Origin checks', () => {
  const server = readFileSync(new URL('../bridge/server.mjs', import.meta.url), 'utf8').replace(/\r/g, '')
  assert.equal(KNOWLEDGE_ANSWER_PATH, '/knowledge/answer')
  assert.match(server, /import \{ KNOWLEDGE_ANSWER_PATH, knowledgeAnswer \} from '\.\/http\/knowledge\.mjs'/)
  const route = "if (req.method === 'POST' && req.url === KNOWLEDGE_ANSWER_PATH) {\n    return knowledgeAnswer(req, res, { cors, kb: KNOWLEDGE.kb, log: (line) => console.log(line), defer: setImmediate })"
  assert.ok(server.includes(route), 'same arguments as the code it replaced')
  const at = server.indexOf(route)
  const handler = server.indexOf('const handleRequest = async (req, res) => {')
  for (const guard of ['if (!hostAllowed(req.headers.host)) {', 'if (origin && !originAllowed(origin)) {', 'const cors = corsFor(req)']) {
    const g = server.indexOf(guard, handler)
    assert.ok(g > handler && g < at, `${guard} still runs before the route`)
  }
  assert.ok(!server.includes("req.url === '/knowledge/answer'"), 'the old inline route is gone')
})
