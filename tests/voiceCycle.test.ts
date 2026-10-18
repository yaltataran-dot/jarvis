import { test, mock, afterEach, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * The whole listening loop, the way the page runs it on Deepgram: the
 * supervisor, the realtime engine, the bridge socket and the real audio
 * capture (pcmCapture.ts) — against a fake browser whose AudioContext starts
 * only when it is allowed to: with permission to play (a desktop, or a phone
 * after its first touch) or when it was made inside a touch.
 *
 * On the phone the loop answered, went back to waiting, and heard nothing
 * more. The bridge log showed why: after the page came back (12:35:15) the
 * recogniser's session opened and received no audio at all until it was
 * closed as idle 30 s later (4408). Every automatic restart — the page
 * returning, the swap back from the browser's recogniser — made its audio
 * context with no touch behind it, and the capture waited for ever on a
 * resume the phone held.
 */

// -- a fake browser ----------------------------------------------------------

const env = {
  /** The browser lets contexts start without a touch (desktop, or sticky activation). */
  allow: true,
  /** Inside a user gesture right now. */
  inGesture: false,
  contexts: [] as FakeCtx[],
  worklets: [] as FakeWorklet[],
  sockets: [] as FakeWs[],
}

const node = () => ({ connect() {}, disconnect() {} })

class FakeCtx {
  state = 'suspended'
  sampleRate = 48000
  destination = {}
  madeInGesture = env.inGesture
  audioWorklet = { addModule: async () => {} }
  constructor() {
    env.contexts.push(this)
  }
  resume() {
    if (this.state === 'closed') return Promise.reject(new Error('closed'))
    // A held resume never settles — the spec's pending resume promise.
    if (!env.allow && !this.madeInGesture) return new Promise<void>(() => {})
    this.state = 'running'
    return Promise.resolve()
  }
  close() {
    this.state = 'closed'
    return Promise.resolve()
  }
  createMediaStreamSource() {
    return node()
  }
  createGain() {
    return { ...node(), gain: { value: 1 } }
  }
}

class FakeWorklet {
  port: { onmessage: ((e: { data: Float32Array }) => void) | null } = { onmessage: null }
  connect() {}
  disconnect() {}
  constructor() {
    env.worklets.push(this)
  }
  /** 100 ms of sound at 48 kHz: one 16 kHz frame to the bridge. */
  sound() {
    this.port.onmessage?.({ data: new Float32Array(4800).fill(0.01) })
  }
}

class FakeWs {
  static OPEN = 1
  OPEN = 1
  readyState = 0
  bufferedAmount = 0
  binaryType = ''
  sent = 0
  closedWith: number | null = null
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  constructor(public url: string) {
    env.sockets.push(this)
  }
  send() {
    this.sent++
  }
  close(code = 1000) {
    if (this.closedWith !== null) return
    this.closedWith = code
    this.readyState = 3
    queueMicrotask(() => this.onclose?.())
  }
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  say(m: object) {
    this.onmessage?.({ data: JSON.stringify(m) })
  }
  /** The bridge ends the session (idle 4408, upstream gone…). */
  dropped() {
    this.readyState = 3
    this.onclose?.()
  }
}

const track = { readyState: 'live', addEventListener() {}, stop() {} }
const stream = { getAudioTracks: () => [track] }

type Mods = {
  pcm: typeof import('../src/lib/pcmCapture.ts')
  dg: typeof import('../src/lib/deepgramVoice.ts')
  scribe: typeof import('../src/lib/scribeVoice.ts')
  sup: typeof import('../src/lib/voiceSupervisor.ts')
  slot: typeof import('../src/lib/voiceSlot.ts')
  start: typeof import('../src/lib/audioStart.ts')
}
let m: Mods

before(async () => {
  const g = globalThis as Record<string, unknown>
  g.AudioContext = FakeCtx
  g.AudioWorkletNode = FakeWorklet
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    value: { getUserMedia: async () => stream },
    configurable: true,
  })
  m = {
    pcm: await import('../src/lib/pcmCapture.ts'),
    dg: await import('../src/lib/deepgramVoice.ts'),
    scribe: await import('../src/lib/scribeVoice.ts'),
    sup: await import('../src/lib/voiceSupervisor.ts'),
    slot: await import('../src/lib/voiceSlot.ts'),
    start: await import('../src/lib/audioStart.ts'),
  }
})

afterEach(() => mock.timers.reset())

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise<void>((r) => setImmediate(r))
}

// -- the loop, wired as voice.ts wires it ---------------------------------------

type Mode = 'wake' | 'command' | 'guard' | 'deaf'

function loop(opts: { delays?: number[]; fallback?: boolean } = {}) {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 })
  env.allow = true
  env.inGesture = false
  const state = { mode: 'wake' as Mode }
  const heard: string[] = []
  const wakes: string[] = []
  const errors: string[] = []
  const log: string[] = []
  const health: string[] = []
  const h = {
    mode: () => state.mode,
    onWake: (trailing: string) => {
      wakes.push(trailing)
      state.mode = trailing ? 'guard' : 'command'
    },
    onSpeechStart: () => {},
    onPartial: () => {},
    onUtterance: (t: string) => {
      heard.push(t)
      state.mode = 'guard' // he is thinking, then speaking
    },
    onError: (msg: string) => void errors.push(msg),
  }
  /** His own voice, as tts.ts reports it. */
  const him = { since: 0, text: '' }
  const speech = { speakingSince: () => him.since, speechActive: () => him.since !== 0, lastSoundEnded: () => 0, speakingNow: () => him.text }
  let why = 'boot'
  const start = () =>
    m.sup.superviseVoice({
      mode: h.mode,
      getToken: async () => '',
      realtimeName: 'deepgram',
      startScribe: (token, onFail) => {
        const url = `ws://bridge/stt-stream?why=${why}`
        why = 'restore'
        return m.scribe.startScribeVoice(token, h, {
          connect: (_t, hooks) =>
            m.dg.connectDeepgram(hooks, { url, WebSocketCtor: FakeWs as unknown as typeof WebSocket, capture: m.pcm.startPcmCapture }),
          speech,
          onFail,
        })
      },
      startBrowser: () => {
        log.push('browser')
        return { ok: () => true, live: () => true, rearm: async () => true, idle: () => true, stop: () => void log.push('browser:stop') }
      },
      fatal: (r) => r === 'audio-blocked',
      onFatal: (r) => void errors.push(r),
      reconnectDelays: opts.delays,
      fallback: opts.fallback,
      onHealth: (hh) => void health.push(hh),
    })
  /** Start the loop and have the bridge accept the session; the capture then starts. */
  const up = async (reason = 'boot') => {
    why = reason
    const p = start()
    await flush()
    const ws = env.sockets.at(-1)!
    ws.open()
    await flush()
    ws.say({ t: 'ready' })
    await flush()
    return { v: await p, ws }
  }
  /** One phrase from Deepgram, ended by a pause. */
  const phrase = (ws: FakeWs, text: string) => ws.say({ t: 'r', text, final: true, speech: true })
  /** The bridge accepts whatever session the loop opened last. */
  const accept = async () => {
    const ws = env.sockets.at(-1)!
    ws.open()
    await flush()
    ws.say({ t: 'ready' })
    await flush()
    return ws
  }
  return { state, him, heard, wakes, errors, log, health, up, phrase, accept }
}

const worklet = () => env.worklets.at(-1)!
const ctx = () => env.contexts.at(-1)!

// -- 1, 2. command → spoken answer → waiting → the next command, twice -----

test('two voice cycles in a row: answer, waiting, and the next command is heard without a reload', async () => {
  const t = loop()
  const { v, ws } = await t.up()
  assert.equal(ctx().state, 'running')
  worklet().sound()
  assert.ok(ws.sent > 0, 'audio reaches the bridge')

  for (const [i, ask] of ['Какая погода в Москве?', 'А завтра будет дождь?'].entries()) {
    // Waiting for his name.
    t.state.mode = 'wake'
    t.phrase(ws, 'Джарвис')
    assert.equal(t.wakes.length, i + 1, `cycle ${i + 1}: woken`)
    // Listening for the command.
    t.phrase(ws, ask)
    assert.equal(t.heard.at(-1), ask, `cycle ${i + 1}: the command is heard`)
    // He thinks and speaks (guard); the answer ends; back to waiting.
    t.state.mode = 'guard'
    mock.timers.tick(5000)
    await flush()
    t.state.mode = 'wake'
    const before = ws.sent
    worklet().sound()
    assert.ok(ws.sent > before, `cycle ${i + 1}: still sending audio after the answer`)
    assert.equal(v.ok(), true)
  }
  assert.equal(env.sockets.filter((s) => s.closedWith === null).length >= 1, true)
  v.stop()
})

// -- 3, 4. the recogniser ending, or failing, and coming back -------------------

test('the session ending (the bridge closes it) moves to the fallback and comes back at a quiet moment, hearing again', async () => {
  const t = loop()
  const first = await t.up()
  first.ws.dropped()
  await flush()
  assert.deepEqual(t.log, ['browser'], 'never deaf: the browser recogniser takes over')
  // A minute later, waiting for his name: Deepgram again, its session marked as the supervisor's.
  t.state.mode = 'wake'
  mock.timers.tick(60_000)
  await flush()
  const ws = env.sockets.at(-1)!
  assert.notEqual(ws, first.ws)
  assert.match(ws.url, /why=restore$/)
  ws.open()
  await flush()
  ws.say({ t: 'ready' })
  await flush()
  assert.equal(ctx().state, 'running')
  worklet().sound()
  assert.ok(ws.sent > 0)
  t.phrase(ws, 'Джарвис')
  assert.equal(t.wakes.length, 1, 'the next command is heard')
  first.v.stop()
})

test('an error from the recogniser is recovered the same way', async () => {
  const t = loop()
  const { v, ws } = await t.up()
  ws.say({ t: 'err' })
  await flush()
  assert.deepEqual(t.log, ['browser'])
  assert.equal(v.ok(), true)
  v.stop()
})

// -- 5. the audio context: started, or held by the phone -------------------------

test('a restart with no touch on a phone that holds the audio: closed as blocked, the loop says so and stops — no false listening', async () => {
  const t = loop()
  env.allow = false // a phone after the page came back: no gesture behind this start
  const { v, ws } = await t.up('recover')
  assert.match(ws.url, /why=recover$/)
  assert.equal(ctx().state, 'suspended')
  assert.equal(v.ok(), true, 'the session is up; the capture is still waiting')
  mock.timers.tick(m.start.AUDIO_START_MS)
  await flush()
  assert.equal(ws.closedWith, m.dg.CLOSE_AUDIO_BLOCKED, 'the bridge log says blocked (4010), not idle 30 s later')
  assert.deepEqual(t.errors, ['audio-blocked'], 'the page is told, and asks for a touch')
  assert.equal(v.ok(), false, 'not ok, so the tap restart is armed (onVoiceError)')
  assert.deepEqual(t.log, [], 'no fallback that would blame the permission')
  mock.timers.tick(120_000)
  await flush()
  assert.equal(env.sockets.at(-1), ws, 'no retries behind the user\'s back')
})

test('the touch then restarts it for real: the audio is started inside the touch and the next command is heard', async () => {
  const t = loop()
  env.allow = false
  const blocked = await t.up('recover')
  mock.timers.tick(m.start.AUDIO_START_MS)
  await flush()
  assert.equal(blocked.v.ok(), false)
  // The tap (App: armTapOnce → primeCapture() → quietRestart()).
  env.inGesture = true
  m.pcm.primeCapture()
  env.inGesture = false
  const { v, ws } = await t.up('tap')
  assert.match(ws.url, /why=tap$/)
  assert.equal(m.pcm.captureDiag.primedUsed, true, 'the capture took the context started in the touch')
  assert.equal(ctx().state, 'running')
  worklet().sound()
  assert.ok(ws.sent > 0)
  t.state.mode = 'wake'
  t.phrase(ws, 'Джарвис')
  assert.equal(t.wakes.length, 1)
  v.stop()
})

test('a context made and started in the touch long before the session still works (no 5 s gesture window to beat)', async () => {
  const t = loop()
  env.allow = false
  env.inGesture = true
  m.pcm.primeCapture() // the start button
  env.inGesture = false
  mock.timers.tick(20_000) // the boot sequence, the greeting
  const { v } = await t.up('boot')
  assert.equal(ctx().state, 'running')
  assert.deepEqual(t.errors, [])
  v.stop()
})

// -- 6. "Стоп" ---------------------------------------------------------------------

test('"Стоп" while he speaks reaches the page, and the loop goes on hearing after it', async () => {
  const t = loop()
  const { v, ws } = await t.up()
  t.state.mode = 'guard'
  // He has been speaking for a few seconds.
  t.him.since = Date.now()
  t.him.text = 'Краснодарский край расположен на юге России'
  mock.timers.tick(3000)
  t.phrase(ws, 'стоп')
  // The engine hands it to the page (App cuts the voice — floor/bargeIn tests).
  assert.equal(t.heard.at(-1)?.toLowerCase().replace(/[^а-я]/g, ''), 'стоп')
  // Cut off: he is silent; the page goes back to waiting.
  t.him.since = 0
  t.him.text = ''
  mock.timers.tick(3000)
  t.state.mode = 'wake'
  t.phrase(ws, 'Джарвис')
  assert.equal(t.wakes.length, 1, 'the next cycle is not broken by the stop')
  assert.equal(v.ok(), true)
  v.stop()
})

test('a phone hearing his answer through its own speaker: the first command after the answer is not thrown away', async () => {
  const t = loop()
  const { v, ws } = await t.up()
  t.state.mode = 'guard'
  t.him.since = Date.now()
  t.him.text = 'В Краснодаре сейчас плюс двенадцать'
  mock.timers.tick(2000)
  // The microphone picks up his voice: interim results of it, never settled into words.
  ws.say({ t: 'r', text: 'в краснодаре сейчас', final: false, speech: false })
  ws.say({ t: 'r', text: '', final: true, speech: true }) // Deepgram ends that phrase with nothing
  // The answer ends; back to waiting.
  t.him.since = 0
  t.him.text = ''
  mock.timers.tick(3000)
  t.state.mode = 'wake'
  t.phrase(ws, 'Джарвис')
  assert.equal(t.wakes.length, 1, 'his name, said after the answer, wakes him')
  v.stop()
})

test('the same with the phrase closed by UtteranceEnd instead', async () => {
  const t = loop()
  const { v, ws } = await t.up()
  t.state.mode = 'guard'
  t.him.since = Date.now()
  t.him.text = 'Встреча в десять'
  mock.timers.tick(2000)
  ws.say({ t: 'r', text: 'встреча в', final: false, speech: false })
  ws.say({ t: 'u' })
  t.him.since = 0
  t.him.text = ''
  mock.timers.tick(3000)
  t.state.mode = 'command' // the follow-up window
  t.phrase(ws, 'А завтра?')
  assert.equal(t.heard.at(-1), 'А завтра?')
  v.stop()
})

// -- 9. never two at once -------------------------------------------------------------

test('two starts at once (a tap and the page coming back) make one loop, not two', async () => {
  let launched = 0
  const slot = m.slot.makeVoiceSlot(async () => {
    launched++
    await new Promise<void>((r) => setImmediate(r))
    return { ok: () => true, stop() {} }
  })
  const [a, b] = await Promise.all([slot.start(), slot.start()])
  assert.equal(launched, 1)
  assert.equal(a, b)
})

// -- 10. a late event from the old session -----------------------------------------------

test('a late close or a late capture failure from the old session does not touch the new one', async () => {
  const t = loop()
  env.allow = false
  const old = await t.up('recover')
  // The tap restarts before the old capture's bound has run out.
  env.inGesture = true
  m.pcm.primeCapture()
  env.inGesture = false
  old.v.stop()
  const fresh = await t.up('tap')
  // Now the old capture's wait runs out, and the old socket's close arrives late.
  mock.timers.tick(m.start.AUDIO_START_MS)
  await flush()
  old.ws.dropped()
  await flush()
  assert.deepEqual(t.errors, [], 'nothing from the old session reaches the page')
  assert.equal(fresh.v.ok(), true)
  assert.equal(fresh.ws.closedWith, null)
  worklet().sound()
  assert.ok(fresh.ws.sent > 0)
  fresh.v.stop()
})

// -- 7, 8. the bridge socket and the page coming back: the wiring -----------------------

test('wiring: every start says why, the touch starts the audio inside itself, the return restart is bounded', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8').replace(/\r/g, '')
  assert.match(app, /if \(booting\.current\) return\n {4}booting\.current = true\n[\s\S]{0,200}primeCapture\(\)\n/, 'the start button primes before any await')
  assert.match(app, /tapArmed = null\n[\s\S]{0,200}primeCapture\(\)\n {8}void quietRestart\(\)/, 'the tap primes before the restart')
  assert.match(app, /noteVoiceStart\('boot'\)\n {4}const loop = await voiceSlot\.current!\.start\(\)/)
  assert.match(app, /noteVoiceStart\('tap'\)\n {6}const v = await voiceSlot\.current\?\.start\(\)/)
  assert.match(app, /noteVoiceStart\('recover'\)\n {6}const v = await voiceSlot\.current\?\.start\(\)/)
  const voice = readFileSync(new URL('../src/lib/voice.ts', import.meta.url), 'utf8')
  assert.match(voice, /stt-stream\?why=\$\{why\}/)
  assert.match(voice, /why = 'restore'/, 'later sessions in one loop are the supervisor\'s')
  const server = readFileSync(new URL('../bridge/server.mjs', import.meta.url), 'utf8')
  assert.match(server, /sttProxy\.accept\(socket, new URL\(req\.url \?\? '\/', 'http:\/\/bridge'\)\.searchParams\.get\('why'\) \?\? ''\)/)
})

test('the parser: a phrase that ends with no words closes the phrase, and is never a command', () => {
  const seen: string[] = []
  const p = m.dg.createDeepgramParser({
    onStarted: () => {},
    onPartial: (x) => void seen.push(`p:${x}`),
    onCommitted: (x) => void seen.push(`c:${x}`),
    onPhraseEnd: () => void seen.push('end'),
    onError: () => {},
    onClose: () => {},
  })
  p.handle(JSON.stringify({ t: 'r', text: 'в краснодаре', final: false, speech: false }))
  p.handle(JSON.stringify({ t: 'r', text: '', final: true, speech: true }))
  p.handle(JSON.stringify({ t: 'u' }))
  p.handle(JSON.stringify({ t: 'r', text: 'привет', final: true, speech: true }))
  assert.deepEqual(seen, ['p:в краснодаре', 'end', 'end', 'c:привет'])
})

// -- standby that stops hearing: brought back, or said so ------------------------

test('a dropped session is brought back after a short wait, without the browser recogniser, and the next command is heard', async () => {
  const t = loop({ delays: [1000, 3000], fallback: false })
  const first = await t.up()
  first.ws.dropped() // the network blinked; the bridge closed it
  await flush()
  assert.deepEqual(t.health, ['live', 'recovering'])
  assert.equal(first.v.ok(), true, 'recovering is not dead: no tap is asked for yet')
  assert.deepEqual(t.log, [], 'no browser recogniser')
  const before = env.sockets.length
  mock.timers.tick(999)
  await flush()
  assert.equal(env.sockets.length, before, 'not before the wait')
  mock.timers.tick(1)
  await flush()
  const ws = await t.accept()
  assert.match(ws.url, /why=restore$/)
  assert.deepEqual(t.health, ['live', 'recovering', 'live'])
  worklet().sound()
  assert.ok(ws.sent > 0)
  t.state.mode = 'wake'
  t.phrase(ws, 'Джарвис')
  assert.equal(t.wakes.length, 1)
  assert.equal(env.sockets.filter((x) => x.closedWith === null && x.readyState === 1).length, 1, 'one session, not two')
  first.v.stop()
})

test('on a phone, a session that will not come back stops the loop and asks for a touch — never the recogniser that cannot hear there', async () => {
  const t = loop({ delays: [1000, 3000], fallback: false })
  const { v, ws } = await t.up()
  ws.dropped()
  await flush()
  // Both retries open a socket the bridge drops at once (the network is down).
  for (const wait of [1000, 3000]) {
    mock.timers.tick(wait)
    await flush()
    env.sockets.at(-1)!.dropped()
    await flush()
  }
  assert.deepEqual(t.errors, ['stt-unavailable'])
  assert.equal(t.health.at(-1), 'down', 'the status says stopped, not waiting')
  assert.equal(v.ok(), false, 'so the page arms the tap restart')
  assert.deepEqual(t.log, [])
  const count = env.sockets.length
  mock.timers.tick(600_000)
  await flush()
  assert.equal(env.sockets.length, count, 'bounded: nothing more without the user')
})

test('on a computer, the same ends on the browser recogniser, as before', async () => {
  const t = loop({ delays: [1000], fallback: true })
  const { v, ws } = await t.up()
  ws.dropped()
  await flush()
  mock.timers.tick(1000)
  await flush()
  env.sockets.at(-1)!.dropped()
  await flush()
  assert.deepEqual(t.log, ['browser'])
  assert.equal(t.health.at(-1), 'fallback')
  assert.equal(v.ok(), true)
  v.stop()
})

test('stopping the loop while it waits to reconnect cancels the reconnect: nothing opens behind a stopped loop', async () => {
  const t = loop({ delays: [1000], fallback: false })
  const { v, ws } = await t.up()
  ws.dropped()
  await flush()
  v.stop()
  const count = env.sockets.length
  mock.timers.tick(5000)
  await flush()
  assert.equal(env.sockets.length, count)
  assert.deepEqual(t.errors, [])
})

test('the microphone taken mid-standby (a call): the dead stream is noticed and the session is replaced', async () => {
  const t = loop({ delays: [1000], fallback: false })
  const { v, ws } = await t.up()
  track.readyState = 'ended'
  mock.timers.tick(1000)
  await flush()
  assert.equal(ws.closedWith, m.dg.CLOSE_AUDIO_STALLED, 'closed as stalled (4013), not left to hear silence')
  track.readyState = 'live' // the call is over
  mock.timers.tick(1000)
  await flush()
  const fresh = await t.accept()
  assert.notEqual(fresh, ws)
  worklet().sound()
  assert.ok(fresh.sent > 0)
  assert.equal(v.ok(), true)
  v.stop()
})

test('audio suspended by the system mid-session: resumed if allowed, else closed as blocked and a touch is asked for', async () => {
  const t = loop({ delays: [1000], fallback: false })
  const { v, ws } = await t.up()
  // Suspended, and this time the browser lets it resume: the audio comes back.
  ctx().state = 'suspended'
  mock.timers.tick(m.pcm.STALL_MS + 1000)
  await flush()
  assert.equal(ctx().state, 'running')
  worklet().sound()
  mock.timers.tick(m.pcm.STALL_MS)
  await flush()
  assert.equal(ws.closedWith, null, 'kept: it came back')
  // Suspended again, and now held.
  env.allow = false
  ctx().madeInGesture = false
  ctx().state = 'suspended'
  mock.timers.tick(m.pcm.STALL_MS + 1000)
  await flush()
  mock.timers.tick(m.start.AUDIO_START_MS)
  await flush()
  assert.equal(ws.closedWith, m.dg.CLOSE_AUDIO_BLOCKED)
  assert.deepEqual(t.errors, ['audio-blocked'])
  assert.equal(v.ok(), false)
})

test('the status line never says "waiting for his name" while nothing hears', async () => {
  const { coreMode, hearingStatus } = await import('../src/lib/coreMode.ts')
  assert.equal(coreMode('dormant', null, 'fault', 'ok'), 'idle')
  assert.equal(coreMode('dormant', null, 'fault', 'recovering'), 'recovering')
  assert.equal(coreMode('dormant', null, 'fault', 'down'), 'error')
  assert.equal(coreMode('listening', null, 'fault', 'down'), 'error')
  assert.equal(coreMode('speaking', null, 'fault', 'down'), 'speaking', 'his answer goes on being shown')
  assert.equal(hearingStatus('dormant', 'ok', true), null)
  assert.match(hearingStatus('dormant', 'recovering', true)!, /ВОССТАНОВЛЕНИЕ/)
  assert.match(hearingStatus('dormant', 'down', true)!, /КОСНИТЕСЬ ЭКРАНА/)
  assert.equal(hearingStatus('thinking', 'down', true), null)
})

test('wiring: the browser recogniser is no fallback on Android; dropped sessions are reconnected; the page shows the state', () => {
  const voice = readFileSync(new URL('../src/lib/voice.ts', import.meta.url), 'utf8')
  assert.match(voice, /return !\/Android\/i\.test\(ua\)/)
  assert.match(voice, /fallback: browserFallbackWorks\(\)/)
  assert.match(voice, /reconnectDelays: RECONNECT_DELAYS_MS/)
  assert.match(voice, /onHealth: h\.onHealth/)
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  assert.match(app, /onHealth: onVoiceHealth/)
  assert.match(app, /setVoiceHealth\(health === 'recovering' \? 'recovering' : health === 'down' \? 'down' : 'ok'\)/)
  const hud = readFileSync(new URL('../src/ui/Hud.tsx', import.meta.url), 'utf8')
  assert.match(hud, /coreMode\(phase, error, errorKind, voiceHealth\)/)
  assert.match(hud, /hearingStatus\(phase, voiceHealth, ru\) \?\? statusText\[phase\]/)
})
