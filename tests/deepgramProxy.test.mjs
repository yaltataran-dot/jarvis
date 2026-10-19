import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import WebSocket, { WebSocketServer } from 'ws'
import { cleanKey, createSttProxy, keyProblem, listenUrl, slim, startReason, STT_PATH } from '../bridge/deepgramProxy.mjs'

const SECRET = 'dg-test-secret-0123456789'

/** A stand-in for Deepgram that records the handshake and the messages. */
async function fakeUpstream({ refuse = 0 } = {}) {
  const seen = { auth: null, url: null, frames: [], texts: [], connections: 0 }
  const server = http.createServer()
  const wss = new WebSocketServer({
    server,
    verifyClient: ({ req }, done) => {
      seen.auth = req.headers.authorization
      seen.url = req.url
      seen.connections++
      if (refuse) done(false, refuse, 'no')
      else done(true)
    },
  })
  const sockets = []
  wss.on('connection', (s) => {
    sockets.push(s)
    s.on('message', (d, bin) => (bin ? seen.frames.push(d) : seen.texts.push(d.toString())))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    seen,
    sockets,
    url: `ws://127.0.0.1:${server.address().port}/v1/listen?x=1`,
    close: () => new Promise((r) => (wss.close(), server.close(r), sockets.forEach((s) => s.terminate()))),
  }
}

/** The bridge side: a server that hands every socket on STT_PATH to the proxy. */
async function bridge(opts) {
  const proxy = createSttProxy(opts)
  const server = http.createServer()
  const wss = new WebSocketServer({ server })
  wss.on('connection', (s) => proxy.accept(s))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `ws://127.0.0.1:${server.address().port}${STT_PATH}`
  const clients = []
  return {
    proxy,
    url,
    open: async () => {
      const c = new WebSocket(url)
      clients.push(c)
      const inbox = []
      const closed = new Promise((r) => c.on('close', (code) => r(code)))
      c.on('message', (d, bin) => !bin && inbox.push(JSON.parse(d.toString())))
      await new Promise((ok, no) => (c.on('open', ok), c.on('error', no)))
      return { c, inbox, closed }
    },
    close: () => new Promise((r) => (clients.forEach((c) => c.terminate()), wss.close(), server.close(r))),
  }
}

const until = async (f, ms = 2000) => {
  const t = Date.now()
  while (!f()) {
    if (Date.now() - t > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

test('the key is sent upstream in a header, and nowhere the page can read', async () => {
  const up = await fakeUpstream()
  const b = await bridge({ key: () => SECRET, url: up.url })
  const { c, inbox } = await b.open()
  await until(() => inbox.some((m) => m.t === 'ready'))
  c.send(Buffer.alloc(3200, 1))
  await until(() => up.seen.frames.length === 1)
  up.sockets[0].send(JSON.stringify({ type: 'Metadata', request_id: 'req-123', secret: SECRET }))
  up.sockets[0].send(JSON.stringify({ type: 'Results', is_final: true, speech_final: true, channel: { alternatives: [{ transcript: 'привет' }] }, metadata: { request_id: 'req-123' } }))
  await until(() => inbox.some((m) => m.t === 'r'))
  assert.equal(up.seen.auth, `Token ${SECRET}`)
  assert.ok(!up.seen.url.includes(SECRET))
  const everything = JSON.stringify(inbox)
  assert.ok(!everything.includes(SECRET) && !everything.includes('req-123'))
  assert.deepEqual(inbox.find((m) => m.t === 'r'), { t: 'r', text: 'привет', final: true, speech: true })
  await b.close()
  await up.close()
})

test('with no key, or a blank one, the socket is refused and nothing is dialled', async () => {
  const up = await fakeUpstream()
  for (const key of [() => undefined, () => '', () => '   \n']) {
    const b = await bridge({ key, url: up.url })
    const { closed } = await b.open()
    assert.equal(await closed, 4503)
    await b.close()
  }
  assert.equal(up.seen.connections, 0)
  await up.close()
})

test('the upstream URL carries the settings the voice loop depends on', () => {
  const q = new URL(listenUrl('ru')).searchParams
  assert.equal(q.get('model'), 'nova-3')
  assert.equal(q.get('language'), 'ru')
  assert.equal(q.get('encoding'), 'linear16')
  assert.equal(q.get('sample_rate'), '16000')
  assert.equal(q.get('interim_results'), 'true')
  assert.equal(q.get('endpointing'), '700')
  assert.equal(q.get('utterance_end_ms'), '1000')
})

test('a refused upstream session ends the page socket without leaking the reason', async () => {
  const up = await fakeUpstream({ refuse: 401 })
  const logs = []
  const b = await bridge({ key: () => SECRET, url: up.url, log: (m) => logs.push(m) })
  const { inbox, closed } = await b.open()
  assert.equal(await closed, 4502)
  assert.deepEqual(inbox.filter((m) => m.t !== 'err'), [])
  assert.ok(logs.every((l) => !l.includes(SECRET)))
  assert.ok(logs.some((l) => l.includes('401')))
  await b.close()
  await up.close()
})

test('text from the page is not forwarded: it is audio or nothing', async () => {
  const up = await fakeUpstream()
  const b = await bridge({ key: () => SECRET, url: up.url, keepAliveMs: 60_000 })
  const { c, inbox } = await b.open()
  await until(() => inbox.some((m) => m.t === 'ready'))
  c.send(JSON.stringify({ type: 'Configure', model: 'other' }))
  c.send(Buffer.alloc(100))
  await until(() => up.seen.frames.length === 1)
  assert.deepEqual(up.seen.texts, [])
  await b.close()
  await up.close()
})

test('an oversized frame ends the session', async () => {
  const up = await fakeUpstream()
  const b = await bridge({ key: () => SECRET, url: up.url })
  const { c, inbox, closed } = await b.open()
  await until(() => inbox.some((m) => m.t === 'ready'))
  c.send(Buffer.alloc(70 * 1024))
  assert.equal(await closed, 1009)
  await b.close()
  await up.close()
})

test('too much audio in one session ends it', async () => {
  const up = await fakeUpstream()
  const b = await bridge({ key: () => SECRET, url: up.url, maxBytes: 5000 })
  const { c, inbox, closed } = await b.open()
  await until(() => inbox.some((m) => m.t === 'ready'))
  c.send(Buffer.alloc(3200))
  c.send(Buffer.alloc(3200))
  assert.equal(await closed, 1009)
  await b.close()
  await up.close()
})

test('a page that sends nothing is let go', async () => {
  const up = await fakeUpstream()
  const b = await bridge({ key: () => SECRET, url: up.url, idleMs: 80 })
  const { closed } = await b.open()
  assert.equal(await closed, 4408)
  await b.close()
  await up.close()
})

test('a computer and a phone listen at once: the second page does not end the first', async () => {
  const up = await fakeUpstream()
  const b = await bridge({ key: () => SECRET, url: up.url })
  const pc = await b.open()
  await until(() => pc.inbox.some((m) => m.t === 'ready'))
  const phone = await b.open()
  await until(() => phone.inbox.some((m) => m.t === 'ready'))
  assert.equal(pc.c.readyState, WebSocket.OPEN, 'the first page still listens')
  assert.equal(b.proxy.count(), 2)
  pc.c.send(Buffer.alloc(320, 1))
  phone.c.send(Buffer.alloc(320, 2))
  await until(() => up.seen.frames.length === 2)
  await b.close()
  await up.close()
})

test('past the limit the oldest session is replaced, so a half-open socket cannot lock the user out', async () => {
  const up = await fakeUpstream()
  const b = await bridge({ key: () => SECRET, url: up.url, maxSessions: 2 })
  const first = await b.open()
  await until(() => first.inbox.some((m) => m.t === 'ready'))
  const second = await b.open()
  await until(() => second.inbox.some((m) => m.t === 'ready'))
  const third = await b.open()
  assert.equal(await first.closed, 4001)
  await until(() => third.inbox.some((m) => m.t === 'ready'))
  assert.equal(second.c.readyState, WebSocket.OPEN)
  assert.equal(b.proxy.count(), 2)
  assert.equal(b.proxy.active(), true)
  await b.close()
  await up.close()
})

test('closing the page ends the upstream with CloseStream', async () => {
  const up = await fakeUpstream()
  const b = await bridge({ key: () => SECRET, url: up.url })
  const { c, inbox } = await b.open()
  await until(() => inbox.some((m) => m.t === 'ready'))
  c.close()
  await until(() => up.seen.texts.some((t) => t.includes('CloseStream')))
  await until(() => !b.proxy.active())
  await b.close()
  await up.close()
})

test('keepalive is sent upstream while the page is quiet', async () => {
  const up = await fakeUpstream()
  const b = await bridge({ key: () => SECRET, url: up.url, keepAliveMs: 40 })
  const { inbox } = await b.open()
  await until(() => inbox.some((m) => m.t === 'ready'))
  await until(() => up.seen.texts.some((t) => t.includes('KeepAlive')))
  await b.close()
  await up.close()
})

test('slim keeps four message kinds and drops the rest', () => {
  assert.deepEqual(slim(JSON.stringify({ type: 'UtteranceEnd', last_word_end: 1 })), { t: 'u' })
  assert.deepEqual(slim(JSON.stringify({ type: 'Error', message: SECRET })), { t: 'err' })
  assert.equal(slim(JSON.stringify({ type: 'Metadata' })), null)
  assert.equal(slim(JSON.stringify({ type: 'SpeechStarted' })), null)
  assert.equal(slim('nope'), null)
  assert.deepEqual(slim(JSON.stringify({ type: 'Results', channel: { alternatives: [] } })), { t: 'r', text: '', final: false, speech: false })
})

test('cleanKey treats blank as missing and trims the rest', () => {
  assert.equal(cleanKey(undefined), null)
  assert.equal(cleanKey(''), null)
  assert.equal(cleanKey('  \r\n'), null)
  assert.equal(cleanKey(' abc\r\n'), 'abc')
})

test('a key with spaces, quotes or non-ASCII letters is unusable, not sent', () => {
  for (const raw of ['"abc123"', "'abc123'", 'abc 123', 'ваш ключ Deepgram', 'abc123 # мой ключ', 'abc 123']) {
    assert.equal(keyProblem(raw), 'unusable', JSON.stringify(raw))
    assert.equal(cleanKey(raw), null, JSON.stringify(raw))
  }
  assert.equal(keyProblem(undefined), 'missing')
  assert.equal(keyProblem('  '), 'missing')
  assert.equal(keyProblem(' 0123abcdefABCDEF0123456789abcdef01234567\n'), null)
})

test('an unusable key refuses the page socket like a missing one, and nothing is dialled', async () => {
  const up = await fakeUpstream()
  const b = await bridge({ key: () => '"вставьте ключ сюда"', url: up.url })
  const { closed } = await b.open()
  assert.equal(await closed, 4503)
  assert.equal(up.seen.connections, 0)
  await b.close()
  await up.close()
})

test('a socket that cannot even be opened is logged by its code, not its message', async () => {
  const logs = []
  const b = await bridge({
    key: () => SECRET,
    log: (m) => logs.push(m),
    connectUpstream: () => {
      throw Object.assign(new TypeError(`Invalid character in header content ["Authorization"]: Token ${SECRET}`), { code: 'ERR_INVALID_CHAR' })
    },
  })
  const { inbox, closed } = await b.open()
  assert.equal(await closed, 4502)
  assert.ok(inbox.some((m) => m.t === 'err'))
  assert.ok(logs.some((l) => l === 'stt upstream could not be opened (ERR_INVALID_CHAR)'), logs.join(' | '))
  assert.ok(logs.every((l) => !l.includes(SECRET)), 'no secret in the log')
  await b.close()
})

test('Deepgram closing a live session is logged with its code and reason', async () => {
  const up = await fakeUpstream()
  const logs = []
  const b = await bridge({ key: () => SECRET, url: up.url, log: (m) => logs.push(m) })
  const { inbox, closed } = await b.open()
  await until(() => inbox.some((m) => m.t === 'ready'))
  up.sockets[0].close(1011, 'NET-0001 no audio\u0000ÿ received')
  assert.equal(await closed, 4502)
  assert.ok(logs.includes('stt upstream closed (1011, NET-0001 no audio received)'), logs.join(' | '))
  assert.ok(logs.every((l) => !l.includes(SECRET)))
  await b.close()
  await up.close()
})

test('our own end of a session does not log an upstream close', async () => {
  const up = await fakeUpstream()
  const logs = []
  const b = await bridge({ key: () => SECRET, url: up.url, log: (m) => logs.push(m) })
  const { c, inbox } = await b.open()
  await until(() => inbox.some((m) => m.t === 'ready'))
  c.close()
  await until(() => logs.some((l) => l.startsWith('stt session ended')))
  await new Promise((r) => setTimeout(r, 50))
  assert.ok(!logs.some((l) => l.startsWith('stt upstream closed')), logs.join(' | '))
  await b.close()
  await up.close()
})

test('the page saying why it closed (4010: the phone would not start the audio) reaches the log; other codes stay plain', async () => {
  const up = await fakeUpstream()
  const logs = []
  const b = await bridge({ key: () => SECRET, url: up.url, log: (m) => logs.push(m) })
  const first = await b.open()
  await until(() => first.inbox.some((m) => m.t === 'ready'))
  first.c.close(4010)
  await until(() => logs.includes('stt session ended (4010)'))
  const second = await b.open()
  await until(() => second.inbox.some((m) => m.t === 'ready'))
  second.c.close(4500)
  await until(() => logs.filter((l) => l.startsWith('stt session ended')).length === 2)
  assert.equal(logs.filter((l) => l.startsWith('stt session ended'))[1], 'stt session ended (1000)')
  await b.close()
  await up.close()
})

test('each session says in the log which start of the page it is, as one known word', async () => {
  assert.equal(startReason('recover'), 'recover')
  assert.equal(startReason('restore'), 'restore')
  assert.equal(startReason('<script>'), 'other')
  assert.equal(startReason(''), 'other', 'an old page sends none')
  const up = await fakeUpstream()
  const logs = []
  const proxy = createSttProxy({ key: () => SECRET, url: up.url, log: (m) => logs.push(m) })
  const server = http.createServer()
  const wss = new WebSocketServer({ server })
  wss.on('connection', (s, req) => proxy.accept(s, new URL(req.url, 'http://bridge').searchParams.get('why') ?? ''))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const c = new WebSocket(`ws://127.0.0.1:${server.address().port}${STT_PATH}?why=tap`)
  await new Promise((ok, no) => (c.on('open', ok), c.on('error', no)))
  await until(() => logs.includes('stt session started (tap)'))
  c.close(4010)
  await until(() => logs.includes('stt session ended (4010)'))
  assert.ok(logs.every((l) => !l.includes(SECRET)))
  await new Promise((r) => (wss.close(), server.close(r)))
  await up.close()
})

test('a session past its time limit is ended with 4000, the code the page reads as "session limit"', async () => {
  const up = await fakeUpstream()
  const b = await bridge({ key: () => SECRET, url: up.url, maxSessionMs: 80, idleMs: 10_000 })
  const { closed } = await b.open()
  assert.equal(await closed, 4000)
  await b.close()
  await up.close()
})

test('an accepted session tells the page exactly {t: "ready"}, before anything else', async () => {
  const up = await fakeUpstream()
  const b = await bridge({ key: () => SECRET, url: up.url })
  const { inbox } = await b.open()
  await until(() => inbox.length > 0)
  assert.deepEqual(inbox[0], { t: 'ready' })
  await b.close()
  await up.close()
})
