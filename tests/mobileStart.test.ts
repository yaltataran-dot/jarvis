import { test, mock, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { AUDIO_START_MS, AudioBlockedError, startContext, within } from '../src/lib/audioStart.ts'
import { CLOSE_AUDIO_BLOCKED, CLOSE_CAPTURE_FAILED, CLOSE_WORKLET_STALLED, connectDeepgram } from '../src/lib/deepgramVoice.ts'
import { superviseVoice } from '../src/lib/voiceSupervisor.ts'
import { audioBlockedMessage, micFailureMessage } from '../src/lib/micErrors.ts'
import type { ScribeHooks } from '../src/lib/scribeVoice.ts'
import type { Voice } from '../src/lib/voiceCore.ts'

/**
 * Starting to listen on a phone. On a phone the recogniser's session opened
 * and then sat deaf: the audio capture waited on a resume() the browser held,
 * nothing was sent, nothing was reported, and the bridge closed the session as
 * idle (4408) half a minute later. A mouse never showed it.
 */

const flush = () => new Promise<void>((r) => setImmediate(r))
afterEach(() => mock.timers.reset())

const never = <T>() => new Promise<T>(() => {})

// -- the start of the audio, bounded ---------------------------------------

test('a context the browser starts is fine; one already running is not asked again', async () => {
  let asked = 0
  const running = { state: 'running', resume: async () => void asked++ }
  await startContext(running)
  assert.equal(asked, 0)
  const ctx = { state: 'suspended', resume: async () => void (ctx.state = 'running') }
  await startContext(ctx)
  assert.equal(ctx.state, 'running')
})

test('a resume the browser holds for ever fails after the bound, with a reason the page can name', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const ctx = { state: 'suspended', resume: never<void> }
  const started = startContext(ctx)
  let settled: unknown = null
  started.catch((e: unknown) => (settled = e))
  mock.timers.tick(AUDIO_START_MS - 1)
  await flush()
  assert.equal(settled, null, 'not before the bound')
  mock.timers.tick(1)
  await flush()
  assert.ok(settled instanceof AudioBlockedError)
  assert.equal((settled as AudioBlockedError).step, 'resume')
})

test('a rejected resume, or one that resolves with the context still suspended, is a refusal too', async () => {
  await assert.rejects(startContext({ state: 'suspended', resume: () => Promise.reject(new Error('x')) }), AudioBlockedError)
  await assert.rejects(startContext({ state: 'suspended', resume: async () => {} }), AudioBlockedError)
  // iOS reports an interrupted context: not running, so not started.
  await assert.rejects(startContext({ state: 'interrupted', resume: async () => {} }), AudioBlockedError)
})

test('a worklet that never loads is bounded the same way', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const p = within(never<void>(), 'worklet', 1000)
  let err: unknown = null
  p.catch((e: unknown) => (err = e))
  mock.timers.tick(1000)
  await flush()
  assert.equal((err as AudioBlockedError)?.step, 'worklet')
  // A result inside the bound passes through, and its error stays its own.
  assert.equal(await within(Promise.resolve(7), 'worklet', 1000), 7)
  await assert.rejects(within(Promise.reject(new TypeError('net')), 'worklet', 1000), TypeError)
})

// -- the recogniser's session -------------------------------------------------

/** A WebSocket the test drives. */
function fakeSocketCtor() {
  const made: Array<{ closed: number | null; sent: number; open: () => void; message: (s: string) => void }> = []
  class FakeWs {
    static OPEN = 1
    OPEN = 1
    readyState = 0
    bufferedAmount = 0
    binaryType = ''
    onopen: (() => void) | null = null
    onerror: (() => void) | null = null
    onclose: (() => void) | null = null
    onmessage: ((e: { data: unknown }) => void) | null = null
    rec = {
      closed: null as number | null,
      sent: 0,
      open: () => {
        this.readyState = 1
        this.onopen?.()
      },
      message: (s: string) => this.onmessage?.({ data: s }),
    }
    constructor() {
      made.push(this.rec)
    }
    send() {
      this.rec.sent++
    }
    close(code = 1000) {
      if (this.rec.closed !== null) return
      this.rec.closed = code
      this.readyState = 3
    }
  }
  return { Ctor: FakeWs as unknown as typeof WebSocket, made }
}

function hooks() {
  const errors: string[] = []
  let started = 0
  const h: ScribeHooks = {
    onStarted: () => void started++,
    onPartial: () => {},
    onCommitted: () => {},
    onError: (r) => void errors.push(r),
    onClose: () => void errors.push('closed'),
  }
  return { h, errors, started: () => started }
}

async function session(capture: () => Promise<{ stop: () => void }>) {
  const { Ctor, made } = fakeSocketCtor()
  const k = hooks()
  const link = connectDeepgram(k.h, { url: 'ws://x/stt-stream', WebSocketCtor: Ctor, capture })
  made[0].open()
  await link
  made[0].message(JSON.stringify({ t: 'ready' }))
  await flush()
  return { ws: made[0], ...k }
}

test('the phone would not start the audio: the session says why, to the page and to the bridge log', async () => {
  const s = await session(() => Promise.reject(new AudioBlockedError('resume')))
  assert.equal(s.started(), 1)
  assert.deepEqual(s.errors, ['audio-blocked'])
  assert.equal(s.ws.closed, CLOSE_AUDIO_BLOCKED, 'closed with the code the bridge logs, not left open to idle out')
})

test('a worklet that stalled is told apart in the bridge log, and still asks for a touch', async () => {
  const s = await session(() => Promise.reject(new AudioBlockedError('worklet')))
  assert.deepEqual(s.errors, ['audio-blocked'])
  assert.equal(s.ws.closed, CLOSE_WORKLET_STALLED)
})

test('any other capture failure is the engine\'s: reported as such, with its own code', async () => {
  const s = await session(() => Promise.reject(new Error('NotSupportedError')))
  assert.deepEqual(s.errors, ['capture'])
  assert.equal(s.ws.closed, CLOSE_CAPTURE_FAILED)
})

test('a capture that starts sends audio and reports nothing', async () => {
  const s = await session(async () => ({ stop: () => {} }))
  assert.deepEqual(s.errors, [])
  assert.equal(s.ws.closed, null)
})

// -- the supervisor ----------------------------------------------------------

function supervised() {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 })
  const log: string[] = []
  let failRealtime: (r: string) => void = () => {}
  let n = 0
  const engine = (name: string): Voice => ({
    ok: () => true,
    live: () => true,
    rearm: async () => true,
    idle: () => true,
    stop: () => void log.push(`stop:${name}`),
  })
  const fatal: string[] = []
  const start = () =>
    superviseVoice({
      mode: () => 'wake',
      getToken: async () => '',
      startScribe: async (_t, onFail) => {
        failRealtime = onFail
        const name = `deepgram${++n}`
        log.push(`start:${name}`)
        return engine(name)
      },
      startBrowser: () => {
        log.push('start:browser')
        return engine('browser')
      },
      realtimeName: 'deepgram',
      fatal: (r) => r === 'audio-blocked',
      onFatal: (r) => void fatal.push(r),
    })
  return { log, fatal, start, fail: (r: string) => failRealtime(r) }
}

test('audio blocked: the loop stops and asks for a touch — no fallback that would blame the permission', async () => {
  const t = supervised()
  const v = await t.start()
  assert.equal(v.ok(), true)
  t.fail('audio-blocked')
  assert.deepEqual(t.log, ['start:deepgram1', 'stop:deepgram1'], 'the browser recogniser is not started')
  assert.deepEqual(t.fatal, ['audio-blocked'])
  assert.equal(v.ok(), false, 'not ok: the page arms the tap restart (onVoiceError)')
  // No retry runs behind the user's back: the next start is the tap's.
  mock.timers.tick(120_000)
  await flush()
  assert.deepEqual(t.log, ['start:deepgram1', 'stop:deepgram1'])
  t.fail('audio-blocked')
  assert.deepEqual(t.fatal, ['audio-blocked'], 'reported once')
})

test('after the tap a new loop starts and hears: the retry is possible', async () => {
  const t = supervised()
  const first = await t.start()
  t.fail('audio-blocked')
  assert.equal(first.ok(), false)
  // The tap: the slot replaces a loop that is not ok with a new one.
  const second = await t.start()
  assert.equal(second.ok(), true)
  assert.deepEqual(t.log.slice(-1), ['start:deepgram2'])
})

test('a session that dies for any other reason still moves to the browser recogniser, as before', async () => {
  const t = supervised()
  await t.start()
  t.fail('closed')
  assert.deepEqual(t.log, ['start:deepgram1', 'stop:deepgram1', 'start:browser'])
  assert.deepEqual(t.fatal, [])
})

// -- what the user is told -----------------------------------------------------

test('the message names the audio and asks for one touch; it does not blame the permission', () => {
  const ru = audioBlockedMessage('ru')
  assert.match(ru, /Коснитесь экрана один раз/)
  assert.doesNotMatch(ru, /разреш|Доступ/i, 'the microphone is allowed; that is not the cause')
  assert.notEqual(ru, micFailureMessage('denied', 'ru'))
  assert.match(audioBlockedMessage('en'), /Tap the screen once/)
})

// -- the wiring ----------------------------------------------------------------

test('wiring: both waits of the capture are bounded, the power-up cannot latch, the voice asks for a touch', () => {
  const pcm = readFileSync(new URL('../src/lib/pcmCapture.ts', import.meta.url), 'utf8')
  assert.match(pcm, /await within\(ctx\.audioWorklet\.addModule\('\/pcm-worklet\.js'\), 'worklet'\)/)
  assert.match(pcm, /await startContext\(ctx\)/)
  assert.doesNotMatch(pcm, /await ctx\.resume\(\)/, 'no unbounded resume')
  const sfx = readFileSync(new URL('../src/lib/sfx.ts', import.meta.url), 'utf8')
  assert.match(sfx, /await within\(c\.resume\(\), 'resume'\)/, 'unlockAudio cannot hold powerOn for ever')
  const voice = readFileSync(new URL('../src/lib/voice.ts', import.meta.url), 'utf8')
  assert.match(voice, /fatal: \(reason\) => reason === 'audio-blocked'/)
  assert.match(voice, /h\.onError\(audioBlockedMessage\(LANG\)\)/)
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  // The voice error arms the tap restart when the loop is no longer ok.
  assert.match(app, /const onVoiceError = \(message: string\) => \{[\s\S]{0,400}if \(v && !v\.ok\(\)\) requestMicTap\(\)/)
  // The power-up guard is released on failure, so the start button works again.
  assert.match(app, /catch \(err\) \{[\s\S]{0,700}booting\.current = false/)
  const ignition = readFileSync(new URL('../src/ui/Ignition.tsx', import.meta.url), 'utf8')
  assert.match(ignition, /<button className="ignition" onClick=\{onStart\}/, 'the start gate is a real button: a tap on it is a click on every phone')
})
