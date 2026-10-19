import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { HEALTH_PATH, healthRequest } from '../bridge/http/health.mjs'

/**
 * GET /health (bridge/http/health.mjs) over real HTTP: the exact answer the
 * page reads at boot to choose its recogniser and voice, for each way the
 * bridge can be set up, and which lookups are made for it. Written against
 * the route while it was still in server.mjs (the last test checked the copy
 * matched). The fields the page reads are taken from src/lib/capabilities.ts.
 */

const CORS = { 'access-control-allow-origin': 'https://page.example', vary: 'origin' }
const KEY = 'eleven-secret-key-0123456789'
let setup
const calls = []
const deps = {
  elevenKey: () => (calls.push('elevenKey'), setup.eleven ? KEY : null),
  sttEngine: () => (calls.push('sttEngine'), setup.stt),
  piperVoices: (lang) => (calls.push(`piperVoices:${lang}`), setup.voices),
  defaultPiperVoice: (lang) => (calls.push(`defaultPiperVoice:${lang}`), setup.voices[1] ?? setup.voices[0] ?? null),
}
let server, url

before(async () => {
  server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === HEALTH_PATH) return void healthRequest(req, res, { cors: CORS, lang: 'ru', ...deps })
    res.writeHead(404).end()
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${server.address().port}${HEALTH_PATH}`
})
after(() => new Promise((r) => server.close(r)))

async function health(s) {
  setup = s
  calls.length = 0
  const r = await fetch(url)
  const text = await r.text()
  return { r, text, body: JSON.parse(text), calls: [...calls] }
}

const FIELDS = ['ok', 'tts', 'stt', 'sttRealtime', 'sttEngine', 'ttsEngine', 'voices', 'voice']

test('nothing configured: browser speech both ways', async () => {
  const { r, body, calls } = await health({ eleven: false, stt: null, voices: [] })
  assert.equal(r.status, 200)
  assert.deepEqual(body, { ok: true, tts: false, stt: false, sttRealtime: false, sttEngine: null, ttsEngine: null, voices: [], voice: null })
  assert.deepEqual(Object.keys(body), FIELDS, 'the fields, in their order')
  assert.deepEqual(calls, ['elevenKey', 'piperVoices:ru', 'sttEngine'], 'no default voice asked for without Piper')
})

test('Deepgram key and Piper voices (the production set-up): Deepgram listens, Piper speaks with its default voice', async () => {
  const { body, calls } = await health({ eleven: false, stt: 'deepgram', voices: ['ru_RU-denis-medium', 'ru_RU-irina-medium'] })
  assert.deepEqual(body, {
    ok: true, tts: true, stt: false, sttRealtime: true, sttEngine: 'deepgram', ttsEngine: 'piper',
    voices: ['ru_RU-denis-medium', 'ru_RU-irina-medium'], voice: 'ru_RU-irina-medium',
  })
  assert.deepEqual(calls, ['elevenKey', 'piperVoices:ru', 'sttEngine', 'defaultPiperVoice:ru'])
})

test('an ElevenLabs key: it speaks and transcribes; Piper is not even looked for, and the key is never in the answer', async () => {
  const { body, text, calls } = await health({ eleven: true, stt: 'elevenlabs', voices: ['ru_RU-irina-medium'] })
  assert.deepEqual(body, { ok: true, tts: true, stt: true, sttRealtime: true, sttEngine: 'elevenlabs', ttsEngine: 'elevenlabs', voices: [], voice: null })
  assert.deepEqual(calls, ['elevenKey', 'sttEngine'])
  assert.ok(!text.includes(KEY))
})

test('both keys, Deepgram chosen for listening: ElevenLabs still speaks', async () => {
  const { body } = await health({ eleven: true, stt: 'deepgram', voices: [] })
  assert.deepEqual(body, { ok: true, tts: true, stt: true, sttRealtime: true, sttEngine: 'deepgram', ttsEngine: 'elevenlabs', voices: [], voice: null })
})

test('the answer is 200 JSON with the CORS headers and no cache header, as before', async () => {
  const { r } = await health({ eleven: false, stt: null, voices: [] })
  assert.equal(r.headers.get('content-type'), 'application/json')
  assert.equal(r.headers.get('access-control-allow-origin'), 'https://page.example')
  assert.equal(r.headers.get('vary'), 'origin')
  assert.equal(r.headers.get('cache-control'), null)
})

test('every field the page reads at boot is in the answer, in every set-up, with the type the page expects', async () => {
  const caps = readFileSync(new URL('../src/lib/capabilities.ts', import.meta.url), 'utf8')
  const read = [...new Set([...caps.matchAll(/\bh\.([a-zA-Z]+)/g)].map((m) => m[1]))]
  assert.deepEqual(read.sort(), ['stt', 'sttEngine', 'sttRealtime', 'tts', 'ttsEngine', 'voice', 'voices'].sort(), 'what capabilities.ts reads')
  for (const s of [
    { eleven: false, stt: null, voices: [] },
    { eleven: false, stt: 'deepgram', voices: ['ru_RU-irina-medium'] },
    { eleven: true, stt: 'elevenlabs', voices: [] },
  ]) {
    const { body } = await health(s)
    for (const f of read) assert.ok(f in body, `${f} present`)
    assert.equal(typeof body.tts, 'boolean')
    assert.equal(typeof body.stt, 'boolean')
    assert.equal(typeof body.sttRealtime, 'boolean')
    assert.ok(body.sttEngine === null || body.sttEngine === 'deepgram' || body.sttEngine === 'elevenlabs')
    assert.ok(body.ttsEngine === null || body.ttsEngine === 'piper' || body.ttsEngine === 'elevenlabs')
    assert.ok(Array.isArray(body.voices) && body.voices.every((v) => typeof v === 'string'))
    assert.ok(body.voice === null || typeof body.voice === 'string')
  }
})

test('wiring: the bridge routes the same request to this handler with its own lookups, first after OPTIONS, behind its Host and Origin checks', () => {
  const srv = readFileSync(new URL('../bridge/server.mjs', import.meta.url), 'utf8').replace(/\r/g, '')
  assert.equal(HEALTH_PATH, '/health')
  assert.match(srv, /import \{ HEALTH_PATH, healthRequest \} from '\.\/http\/health\.mjs'/)
  const route = "if (req.method === 'GET' && req.url === HEALTH_PATH) {\n    return healthRequest(req, res, { cors, lang: LANG, elevenKey, sttEngine, piperVoices, defaultPiperVoice })"
  assert.ok(srv.includes(route), 'the same lookups as the code it replaced')
  // The lookups stay in the bridge: defined in settings.mjs, built once by server.mjs from process.env.
  const settings = readFileSync(new URL('../bridge/settings.mjs', import.meta.url), 'utf8').replace(/\r/g, '')
  for (const f of ['function elevenKey() {', 'function sttEngine() {']) assert.ok(settings.includes(f), `${f} stays in the bridge`)
  assert.ok(srv.includes('const { elevenKey, deepgramKey, sttEngine } = createVoiceKeys({ env: process.env, homedir })'))
  assert.match(srv, /import \{ defaultPiperVoice, piperSpeak, piperVoices, warmPiper \} from '\.\/piper\.mjs'/)
  const at = srv.indexOf(route)
  const handler = srv.indexOf('const handleRequest = async (req, res) => {')
  for (const guard of ['if (!hostAllowed(req.headers.host)) {', 'if (origin && !originAllowed(origin)) {', 'const cors = corsFor(req)', "if (req.method === 'OPTIONS') {"]) {
    const g = srv.indexOf(guard, handler)
    assert.ok(g > handler && g < at, `${guard} still runs before the route`)
  }
  const options = srv.indexOf("if (req.method === 'OPTIONS') {", handler)
  assert.ok(!srv.slice(options, at).includes('req.url ==='), 'still the first route after OPTIONS')
  assert.ok(!srv.includes("req.url === '/health'"), 'the old inline route is gone')
})
