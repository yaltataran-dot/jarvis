import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { MAX_BODY, TTS_PATH, ttsRequest } from '../bridge/http/tts.mjs'

/**
 * POST /tts (bridge/http/tts.mjs) over real HTTP, with a fake Piper and a fake
 * ElevenLabs (a streamed body that arrives in pieces). The engine choice, the
 * refusals, the fallbacks to Piper, the audio headers, the stream passed
 * through and how it ends. Written against the route while it was still in
 * server.mjs (the last test checked the copy matched). No real voice and no
 * real ElevenLabs call.
 */

const CORS = { 'access-control-allow-origin': 'https://page.example', vary: 'origin' }
const KEY = 'xi-secret-key-0123456789abcdef'
const WAV = Buffer.from('RIFF....WAVEfmt fake-wav-bytes')

let s
function reset() {
  s = {
    key: null,
    voices: ['ru_RU-irina-medium'],
    piper: async () => WAV,
    upstream: null,
    piperCalls: [],
    fetchCalls: [],
    logs: [],
  }
}
reset()

/** A streamed ElevenLabs answer: each piece after a short wait; `fail` throws after the pieces. */
const streamed = (pieces, { status = 200, fail = false } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => 'upstream said no',
  body: (async function* () {
    for (const p of pieces) {
      await new Promise((r) => setTimeout(r, 15))
      yield new TextEncoder().encode(p)
    }
    // A connection that dies a moment later, after what came has gone out. (Dying at
    // the very same instant can cut the socket before even the headers leave.)
    if (fail) {
      await new Promise((r) => setTimeout(r, 40))
      throw new Error('connection reset by peer')
    }
  })(),
})

let server, port
before(async () => {
  server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === TTS_PATH) {
      return void ttsRequest(req, res, {
        cors: CORS,
        lang: 'ru',
        voiceId: 'VOICE123',
        elevenKey: () => s.key,
        piperVoices: (lang) => (lang === 'ru' ? s.voices : []),
        piperSpeak: async (...args) => (s.piperCalls.push(args), s.piper()),
        redact: (t) => t.replaceAll(KEY, '[redacted]'),
        fetch: async (u, init) => (s.fetchCalls.push({ u, init }), s.upstream()),
        log: (l) => s.logs.push(l),
      })
    }
    res.writeHead(404).end()
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  port = server.address().port
})
after(() => new Promise((r) => server.close(r)))
beforeEach(reset)

/** POST, collecting status, headers, the body and when each piece arrived; `aborted` if the server cut it. */
const post = (body) =>
  new Promise((ok, no) => {
    let started = null
    const pieces = []
    let aborted = false
    const done = () => ok({ status: started.statusCode, headers: started.headers, body: Buffer.concat(pieces.map((p) => p.d)), pieces, aborted, complete: started.complete })
    const req = http.request({ host: '127.0.0.1', port, path: TTS_PATH, method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      started = res
      res.on('data', (d) => pieces.push({ at: Date.now(), d }))
      res.on('aborted', () => (aborted = true))
      res.on('error', () => (aborted = true))
      res.on('close', done)
    })
    // A cut after the answer began is part of what is being tested; before it, a failure of the request.
    req.on('error', (err) => (started ? (aborted = true) : no(err)))
    req.end(body)
  })

test('no ElevenLabs key and no Piper voice: 503, said in words, nothing else tried', async () => {
  s.voices = []
  const r = await post(JSON.stringify({ text: 'Готово, сэр.' }))
  assert.equal(r.status, 503)
  assert.equal(r.body.toString(), 'no speech engine: no elevenlabs key and no piper voice')
  assert.equal(r.headers['access-control-allow-origin'], 'https://page.example')
  assert.equal(s.piperCalls.length + s.fetchCalls.length, 0)
})

test('a body that is not JSON, or has no text: 400 with the reason, nothing spoken', async () => {
  for (const [body, why] of [['{not json', 'bad json'], [JSON.stringify({}), 'no text'], [JSON.stringify({ text: '' }), 'no text'], [JSON.stringify({ text: 42 }), 'no text'], ['', 'no text']]) {
    const r = await post(body)
    assert.equal(r.status, 400, body)
    assert.equal(r.body.toString(), why, body)
  }
  assert.equal(s.piperCalls.length, 0)
})

test(`a body over ${MAX_BODY} bytes: 400 "body too large", or the connection cut while still sending; nothing spoken`, async () => {
  assert.equal(MAX_BODY, 65536)
  try {
    const r = await post(JSON.stringify({ text: 'x'.repeat(MAX_BODY + 100) }))
    assert.equal(r.status, 400)
    assert.equal(r.body.toString(), 'body too large')
  } catch (err) {
    // The handler destroys the request as soon as it is too long; a client
    // still writing can see the socket close before it reads the answer.
    assert.match(String(err?.code ?? err), /ECONNRESET|EPIPE/)
  }
  assert.equal(s.piperCalls.length, 0)
})

test('Piper only: a whole WAV, with its length and no-cache; the voice and style passed as asked', async () => {
  const r = await post(JSON.stringify({ text: 'Готово, сэр.', voice: 'ru_RU-denis-medium', style: 'announce' }))
  assert.equal(r.status, 200)
  assert.equal(r.headers['content-type'], 'audio/wav')
  assert.equal(r.headers['content-length'], String(WAV.length))
  assert.equal(r.headers['cache-control'], 'no-cache')
  assert.equal(r.headers['access-control-allow-origin'], 'https://page.example')
  assert.deepEqual(r.body, WAV)
  assert.deepEqual(s.piperCalls, [['Готово, сэр.', 'ru', 'ru_RU-denis-medium', 'announce']])
  assert.equal(s.fetchCalls.length, 0, 'no key: ElevenLabs is not asked')
})

test('Piper: a voice or style that is not a string becomes the default (no voice, "normal")', async () => {
  await post(JSON.stringify({ text: 'Да.', voice: 7, style: { x: 1 } }))
  assert.deepEqual(s.piperCalls, [['Да.', 'ru', null, 'normal']])
})

test('Piper failing: 502 with its message, redacted; logged', async () => {
  s.piper = async () => {
    throw new Error(`piper exited 1 (key ${KEY})`)
  }
  const r = await post(JSON.stringify({ text: 'Да.' }))
  assert.equal(r.status, 502)
  assert.equal(r.body.toString(), 'piper exited 1 (key [redacted])')
  assert.ok(s.logs.some((l) => l.startsWith('[jarvis] piper failed: piper exited 1')))
})

test('an ElevenLabs key: asked once, exactly as before, and its mp3 streamed through piece by piece, then ended', async () => {
  s.key = KEY
  s.upstream = () => streamed(['ID3-a', 'b', 'c'])
  const r = await post(JSON.stringify({ text: 'Готово, сэр.', voice: 'ignored', style: 'announce' }))
  assert.equal(r.status, 200)
  assert.equal(r.headers['content-type'], 'audio/mpeg')
  assert.equal(r.headers['cache-control'], 'no-cache')
  assert.equal(r.headers['content-length'], undefined, 'streamed, so no length')
  assert.equal(r.body.toString(), 'ID3-abc')
  assert.ok(r.pieces.length >= 2, 'passed through as it came, not buffered whole')
  assert.equal(r.complete, true)
  assert.equal(s.piperCalls.length, 0)
  assert.equal(s.fetchCalls.length, 1)
  const { u, init } = s.fetchCalls[0]
  assert.equal(u, 'https://api.elevenlabs.io/v1/text-to-speech/VOICE123/stream?output_format=mp3_22050_32&optimize_streaming_latency=3')
  assert.equal(init.method, 'POST')
  assert.deepEqual(init.headers, { 'xi-api-key': KEY, 'content-type': 'application/json' })
  assert.deepEqual(JSON.parse(init.body), {
    text: 'Готово, сэр.',
    model_id: 'eleven_flash_v2_5',
    language_code: 'ru',
    voice_settings: { stability: 0.4, similarity_boost: 0.75, speed: 1.05 },
  })
  assert.ok(!r.body.toString().includes(KEY))
})

test('ElevenLabs refusing (no credit, revoked key): Piper speaks instead when installed', async () => {
  s.key = KEY
  s.upstream = () => streamed([], { status: 401 })
  const r = await post(JSON.stringify({ text: 'Да.' }))
  assert.equal(r.status, 200)
  assert.equal(r.headers['content-type'], 'audio/wav')
  assert.equal(s.piperCalls.length, 1)
})

test('ElevenLabs refusing with no Piper: its status and its body are passed on as they are', async () => {
  s.key = KEY
  s.voices = []
  s.upstream = () => streamed([], { status: 402 })
  const r = await post(JSON.stringify({ text: 'Да.' }))
  assert.equal(r.status, 402)
  assert.equal(r.body.toString(), 'upstream said no')
  assert.equal(r.headers['access-control-allow-origin'], 'https://page.example')
})

test('ElevenLabs unreachable before answering: Piper when installed, else 502 with the error, redacted', async () => {
  s.key = KEY
  s.upstream = async () => {
    throw new Error(`getaddrinfo ENOTFOUND (key ${KEY})`)
  }
  const withPiper = await post(JSON.stringify({ text: 'Да.' }))
  assert.equal(withPiper.status, 200)
  assert.equal(withPiper.headers['content-type'], 'audio/wav')
  s.voices = []
  const without = await post(JSON.stringify({ text: 'Да.' }))
  assert.equal(without.status, 502)
  assert.equal(without.body.toString(), 'getaddrinfo ENOTFOUND (key [redacted])')
})

test('ElevenLabs failing mid-stream: what came is delivered, then the connection is cut — no switch to Piper half way', async () => {
  s.key = KEY
  s.upstream = () => streamed(['first-half'], { fail: true })
  const r = await post(JSON.stringify({ text: 'Длинный ответ.' }))
  assert.equal(r.status, 200)
  assert.equal(r.headers['content-type'], 'audio/mpeg')
  assert.equal(r.body.toString(), 'first-half')
  assert.ok(r.aborted || !r.complete, 'the stream did not end cleanly')
  assert.equal(s.piperCalls.length, 0)
})

test('wiring: the bridge routes the same request here with its own key, voices, synthesis, voice and redaction, after its Host and Origin checks', () => {
  const srv = readFileSync(new URL('../bridge/server.mjs', import.meta.url), 'utf8').replace(/\r/g, '')
  assert.equal(TTS_PATH, '/tts')
  assert.match(srv, /import \{ TTS_PATH, ttsRequest \} from '\.\/http\/tts\.mjs'/)
  const route = "if (req.method === 'POST' && req.url === TTS_PATH) {\n    return ttsRequest(req, res, { cors, lang: LANG, voiceId: VOICE_ID, elevenKey, piperVoices, piperSpeak, redact: redactSecrets })"
  assert.ok(srv.includes(route), 'no fetch or log passed: the real ones, as before')
  assert.match(srv, /const VOICE_ID = process\.env\.JARVIS_VOICE_ID \?\? 'JBFqnCBsd6RMkjVDRZzb'/)
  assert.match(srv, /import \{ defaultPiperVoice, piperSpeak, piperVoices, warmPiper \} from '\.\/piper\.mjs'/)
  assert.match(srv, /import \{ agentEnv, installLogRedaction, redactSecrets, registerSecrets, secretValuesFrom, writesAllowed \} from '\.\/secrets\.mjs'/)
  const at = srv.indexOf(route)
  const handler = srv.indexOf('const handleRequest = async (req, res) => {')
  for (const guard of ['if (!hostAllowed(req.headers.host)) {', 'if (origin && !originAllowed(origin)) {', 'const cors = corsFor(req)']) {
    const g = srv.indexOf(guard, handler)
    assert.ok(g > handler && g < at, `${guard} still runs before the route`)
  }
  assert.ok(!srv.includes("req.url === '/tts'"), 'the old inline route is gone')
  assert.ok(!srv.includes('/v1/text-to-speech/'), 'the ElevenLabs call lives in the route module only')
})
