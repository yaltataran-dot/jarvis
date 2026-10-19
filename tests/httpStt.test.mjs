import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { MAX_AUDIO, MIN_AUDIO, SCRIBE_URL, STT_HTTP_PATH, sttRequest } from '../bridge/http/stt.mjs'

/**
 * POST /stt (bridge/http/stt.mjs) over real HTTP, with a fake ElevenLabs
 * Scribe that reads the form it is sent. The key check, the size rules, the
 * bytes passed through untouched, the codec hint, Scribe's answers and
 * failures. Mocks only: this proves what the bridge sends and returns, not
 * that the real Scribe transcribes. Written against the route while it was
 * still in server.mjs (the last test checked the copy matched).
 */

const CORS = { 'access-control-allow-origin': 'https://page.example', vary: 'origin' }
const KEY = 'xi-secret-key-0123456789abcdef'

let s
function reset() {
  s = {
    key: KEY,
    upstream: async () => ({ ok: true, status: 200, json: async () => ({ text: '  который час  ' }), text: async () => '' }),
    calls: [],
  }
}
reset()

let server, port
before(async () => {
  server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === STT_HTTP_PATH) {
      return void sttRequest(req, res, {
        cors: CORS,
        lang: 'ru',
        elevenKey: () => s.key,
        redact: (t) => t.replaceAll(KEY, '[redacted]'),
        fetch: async (u, init) => {
          const file = init.body.get('file')
          s.calls.push({
            u,
            method: init.method,
            headers: init.headers,
            model: init.body.get('model_id'),
            lang: init.body.get('language_code'),
            name: file.name,
            type: file.type,
            bytes: Buffer.from(await file.arrayBuffer()),
          })
          return s.upstream()
        },
      })
    }
    res.writeHead(404).end()
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  port = server.address().port
})
after(() => new Promise((r) => server.close(r)))
beforeEach(reset)

const post = (body, type) =>
  new Promise((ok, no) => {
    const headers = type === undefined ? {} : { 'content-type': type }
    const req = http.request({ host: '127.0.0.1', port, path: STT_HTTP_PATH, method: 'POST', headers }, (res) => {
      let data = ''
      res.on('data', (d) => (data += d)).on('end', () => ok({ status: res.statusCode, headers: res.headers, body: data }))
    })
    req.on('error', no)
    req.end(body)
  })

/** Every byte value, repeated: anything that treats the audio as text would change it. */
const audio = (n = 4096) => Buffer.from(Array.from({ length: n }, (_, i) => i % 256))

test('no ElevenLabs key: 503 "no elevenlabs key", and Scribe is not asked', async () => {
  s.key = null
  const r = await post(audio(), 'audio/webm')
  assert.equal(r.status, 503)
  assert.equal(r.body, 'no elevenlabs key')
  assert.equal(r.headers['access-control-allow-origin'], 'https://page.example')
  assert.equal(s.calls.length, 0)
})

test('a segment is sent to Scribe as it came: the same bytes, its type, scribe_v1, the language, the key in the header only', async () => {
  const bytes = audio()
  const r = await post(bytes, 'audio/webm;codecs=opus')
  assert.equal(r.status, 200)
  assert.equal(s.calls.length, 1)
  const c = s.calls[0]
  assert.equal(c.u, 'https://api.elevenlabs.io/v1/speech-to-text')
  assert.equal(SCRIBE_URL, c.u)
  assert.equal(c.method, 'POST')
  assert.deepEqual(c.headers, { 'xi-api-key': KEY })
  assert.equal(c.model, 'scribe_v1')
  assert.equal(c.lang, 'ru')
  assert.equal(c.type, 'audio/webm;codecs=opus')
  assert.equal(c.name, 'speech.webm')
  assert.ok(c.bytes.equals(bytes), 'byte for byte, no conversion')
})

test('Scribe answering: 200 JSON {text}, trimmed; no text from Scribe is an empty one', async () => {
  const r = await post(audio(), 'audio/webm')
  assert.equal(r.status, 200)
  assert.equal(r.headers['content-type'], 'application/json')
  assert.equal(r.headers['access-control-allow-origin'], 'https://page.example')
  assert.deepEqual(JSON.parse(r.body), { text: 'который час' })
  s.upstream = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' })
  assert.deepEqual(JSON.parse((await post(audio(), 'audio/webm')).body), { text: '' })
  assert.ok(!r.body.includes(KEY))
})

test(`under ${MIN_AUDIO} bytes is silence: 200 {text:""} at once, Scribe not asked; from ${MIN_AUDIO} it is`, async () => {
  assert.equal(MIN_AUDIO, 1200)
  for (const body of [Buffer.alloc(0), audio(MIN_AUDIO - 1)]) {
    const r = await post(body, 'audio/webm')
    assert.equal(r.status, 200)
    assert.equal(r.headers['content-type'], 'application/json')
    assert.deepEqual(JSON.parse(r.body), { text: '' })
  }
  assert.equal(s.calls.length, 0)
  await post(audio(MIN_AUDIO), 'audio/webm')
  assert.equal(s.calls.length, 1)
})

test('the codec hint follows the type the recorder reported; no type means webm; an unknown type is not refused', async () => {
  const cases = [
    ['audio/ogg;codecs=opus', 'speech.ogg', 'audio/ogg;codecs=opus'],
    ['audio/mp4', 'speech.mp4', 'audio/mp4'],
    ['audio/mpeg', 'speech.mp4', 'audio/mpeg'],
    ['audio/wav', 'speech.wav', 'audio/wav'],
    ['video/webm', 'speech.webm', 'video/webm'],
    ['application/octet-stream', 'speech.webm', 'application/octet-stream'],
    [undefined, 'speech.webm', 'audio/webm'],
  ]
  for (const [type, name, sent] of cases) {
    reset()
    const r = await post(audio(), type)
    assert.equal(r.status, 200, String(type))
    assert.equal(s.calls[0].name, name, String(type))
    assert.equal(s.calls[0].type, sent, String(type))
  }
})

test(`over ${MAX_AUDIO} bytes: 413 "audio too large", or the connection cut while still sending; Scribe not asked`, async () => {
  assert.equal(MAX_AUDIO, 25 * 1024 * 1024)
  try {
    const r = await post(Buffer.alloc(MAX_AUDIO + 1024, 7), 'audio/webm')
    assert.equal(r.status, 413)
    assert.equal(r.body, 'audio too large')
  } catch (err) {
    // The handler destroys the request as soon as it is too long; a client
    // still writing can see the socket close before it reads the answer.
    assert.match(String(err?.code ?? err), /ECONNRESET|EPIPE/)
  }
  assert.equal(s.calls.length, 0)
})

test('Scribe refusing: its status and its body are passed on as they are', async () => {
  s.upstream = async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => '{"detail":"invalid api key"}' })
  const r = await post(audio(), 'audio/webm')
  assert.equal(r.status, 401)
  assert.equal(r.body, '{"detail":"invalid api key"}')
  assert.equal(r.headers['access-control-allow-origin'], 'https://page.example')
})

test('Scribe unreachable, timing out, or answering garbage: 502 with the error, redacted', async () => {
  for (const [upstream, expected] of [
    [async () => { throw new Error(`fetch failed (key ${KEY})`) }, 'fetch failed (key [redacted])'],
    // The error's message only, as server.mjs wrote it (err.message), not its name.
    [async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError') }, 'The operation was aborted due to timeout'],
    [async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token < in JSON') }, text: async () => '' }), 'Unexpected token < in JSON'],
  ]) {
    reset()
    s.upstream = upstream
    const r = await post(audio(), 'audio/webm')
    assert.equal(r.status, 502)
    assert.equal(r.body, expected)
  }
})

test('a request that fails while being read is not answered here: the handler rejects, for the bridge to answer 500', async () => {
  const req = {
    headers: { 'content-type': 'audio/webm' },
    async *[Symbol.asyncIterator]() {
      yield audio(100)
      throw Object.assign(new Error('aborted'), { code: 'ECONNRESET' })
    },
  }
  const written = []
  const res = { writeHead: (...a) => written.push(['head', ...a]), end: (...a) => written.push(['end', ...a]) }
  await assert.rejects(sttRequest(req, res, { cors: CORS, lang: 'ru', elevenKey: () => KEY, redact: (t) => t, fetch: async () => assert.fail('not asked') }), /aborted/)
  assert.deepEqual(written, [])
})

test('wiring: /stt reaches this handler with the bridge\'s key, language and redaction; the realtime socket keeps its own path', () => {
  const srv = readFileSync(new URL('../bridge/server.mjs', import.meta.url), 'utf8').replace(/\r/g, '')
  assert.equal(STT_HTTP_PATH, '/stt')
  assert.match(srv, /import \{ STT_HTTP_PATH, sttRequest \} from '\.\/http\/stt\.mjs'/)
  const route = "if (req.method === 'POST' && req.url === STT_HTTP_PATH) {\n    return sttRequest(req, res, { cors, lang: LANG, elevenKey, redact: redactSecrets })"
  assert.ok(srv.includes(route), 'no fetch passed: the real one, as before')
  // STT_PATH is still the Deepgram socket's '/stt-stream', from deepgramProxy.mjs, used by the upgrade only.
  assert.match(srv, /import \{ STT_PATH, cleanKey, createSttProxy, keyProblem \} from '\.\/deepgramProxy\.mjs'/)
  assert.ok(srv.includes("path !== '/' && path !== '/ws' && path !== STT_PATH"), 'the socket upgrade still knows /stt-stream')
  assert.ok(!/req\.method === 'POST' && req\.url === STT_PATH\b/.test(srv), 'no HTTP route on the socket path')
  const at = srv.indexOf(route)
  const handler = srv.indexOf('const handleRequest = async (req, res) => {')
  for (const guard of ['if (!hostAllowed(req.headers.host)) {', 'if (origin && !originAllowed(origin)) {', 'const cors = corsFor(req)']) {
    const g = srv.indexOf(guard, handler)
    assert.ok(g > handler && g < at, `${guard} still runs before the route`)
  }
  assert.ok(srv.indexOf('res.writeHead(404, cors)', at) > at, 'the 404 for anything else still follows')
  assert.ok(!srv.includes("req.url === '/stt'"), 'the old inline route is gone')
  assert.ok(!srv.includes('/v1/speech-to-text'), 'the Scribe call lives in the route module only')
})
