import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import WebSocket, { WebSocketServer } from 'ws'
import { cleanKey, createSttProxy, listenUrl, slim, STT_PATH } from '../bridge/deepgramProxy.mjs'

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

test('one session at a time: a newer one replaces the older', async () => {
  const up = await fakeUpstream()
  const b = await bridge({ key: () => SECRET, url: up.url })
  const first = await b.open()
  await until(() => first.inbox.some((m) => m.t === 'ready'))
  const second = await b.open()
  assert.equal(await first.closed, 4001)
  await until(() => second.inbox.some((m) => m.t === 'ready'))
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
