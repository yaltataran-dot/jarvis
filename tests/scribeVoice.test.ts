import { test, mock, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { startScribeVoice, type ScribeHooks, type ScribeLink } from '../src/lib/scribeVoice.ts'
import { superviseVoice } from '../src/lib/voiceSupervisor.ts'
import { diag, type Voice, type VoiceMode } from '../src/lib/voiceCore.ts'

/**
 * The realtime Scribe engine against a connection the test drives, and the
 * supervisor that moves the loop between it and the browser engine. The clock
 * only moves when the test moves it; the network is a fake that records what
 * was opened and closed.
 */

const flush = () => new Promise<void>((r) => setImmediate(r))

afterEach(() => mock.timers.reset())

function rig(startMode: VoiceMode) {
  mock.timers.reset()
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 })
  const state = { mode: startMode }
  const him = { since: 0, active: false, text: '' }
  const wakes: string[] = []
  const utterances: string[] = []
  const partials: string[] = []
  let speechStarts = 0
  const handlers = {
    mode: () => state.mode,
    onWake: (trailing: string) => {
      wakes.push(trailing)
      state.mode = trailing ? 'guard' : 'command'
    },
    onSpeechStart: () => {
      speechStarts++
      state.mode = 'command'
    },
    onPartial: (t: string) => partials.push(t),
    onUtterance: (t: string) => {
      utterances.push(t)
      state.mode = 'guard'
    },
    onError: () => {},
  }
  const speech = {
    speakingSince: () => him.since,
    speechActive: () => him.active,
    lastSoundEnded: () => 0,
    speakingNow: () => him.text,
  }
  const link = { closed: 0 }
  let hooks!: ScribeHooks
  const fails: string[] = []
  const deps = {
    speech,
    onFail: (r: string) => fails.push(r),
    connect: async (_token: string, h: ScribeHooks): Promise<ScribeLink> => {
      hooks = h
      return { close: () => void link.closed++ }
    },
  }
  /** Start the engine and have the server accept the session. */
  const up = async () => {
    const p = startScribeVoice('tok', handlers, deps)
    await flush()
    hooks.onStarted()
    return p
  }
  return {
    state,
    him,
    wakes,
    utterances,
    partials,
    fails,
    link,
    up,
    hooks: () => hooks,
    deps,
    handlers,
    speechStarts: () => speechStarts,
    /** He starts saying `text`. */
    speak: (text: string) => {
      him.since = Date.now()
      him.active = true
      him.text = text
    },
  }
}

test('a partial is a caption, and only the committed phrase becomes a turn', async () => {
  const r = rig('command')
  await r.up()
  r.hooks().onPartial('какая погода')
  r.hooks().onPartial('какая погода в москве')
  assert.equal(r.speechStarts(), 1, 'the user started talking once')
  assert.deepEqual(r.partials, ['какая погода', 'какая погода в москве'])
  assert.deepEqual(r.utterances, [], 'a partial is never a command')

  r.hooks().onCommitted('Какая погода в Москве?')
  assert.deepEqual(r.utterances, ['Какая погода в Москве?'])
  assert.equal(r.speechStarts(), 1, 'the commit does not announce the phrase a second time')
})

test('the same phrase committed twice is answered once', async () => {
  const r = rig('command')
  await r.up()
  r.hooks().onCommitted('Какая погода в Москве?')
  r.state.mode = 'command'
  r.hooks().onCommitted('Какая погода в Москве?')
  assert.equal(r.utterances.length, 1)

  // Saying it again a moment later is the user, not a duplicate.
  mock.timers.tick(2000)
  r.state.mode = 'command'
  r.hooks().onCommitted('Какая погода в Москве?')
  assert.equal(r.utterances.length, 2)
})

test('a phrase that is not finished waits in the assembler, then goes once', async () => {
  const r = rig('command')
  await r.up()
  r.hooks().onCommitted('открой почту и')
  assert.deepEqual(r.utterances, [])
  r.hooks().onCommitted('покажи письма от Ивана.')
  assert.deepEqual(r.utterances, ['открой почту и покажи письма от Ивана.'])
})

test('while he speaks, only a stop gets through', async () => {
  const r = rig('guard')
  await r.up()
  r.speak('сегодня в москве солнечно')

  r.hooks().onPartial('а какая завтра')
  r.hooks().onCommitted('а какая завтра погода')
  assert.deepEqual(r.utterances, [])
  assert.equal(r.speechStarts(), 0, 'his own voice is not a barge-in')

  r.hooks().onPartial('сегодня в москве солнечно стоп')
  assert.deepEqual(r.utterances, ['стоп'])
  assert.equal(r.speechStarts(), 1)

  // The same stop, settled a moment later, is not a second one.
  r.hooks().onCommitted('сегодня в москве солнечно стоп')
  assert.deepEqual(r.utterances, ['стоп'])
  assert.equal(diag.stops > 0, true)
})

test('his own word in a partial waits for the commit', async () => {
  const r = rig('guard')
  await r.up()
  r.speak('на море тихо')
  r.hooks().onPartial('тихо')
  assert.deepEqual(r.utterances, [], 'an interim "тихо" may be his own')
  r.hooks().onCommitted('тихо')
  assert.deepEqual(r.utterances, ['тихо'])
})

test('while he thinks, one word is not an interruption and two are', async () => {
  const r = rig('guard')
  await r.up()
  r.hooks().onPartial('погода')
  assert.equal(r.speechStarts(), 0)
  r.hooks().onPartial('какая погода')
  assert.equal(r.speechStarts(), 1)
})

test('his name wakes him once, with the rest of the phrase', async () => {
  const r = rig('wake')
  await r.up()
  r.hooks().onPartial('Джарвис который')
  assert.deepEqual(r.wakes, [], 'the name is acted on at the end of the phrase')
  r.hooks().onCommitted('Джарвис, который час')
  assert.deepEqual(r.wakes, ['который час'])
  r.hooks().onCommitted('просто разговор')
  assert.equal(r.wakes.length, 1)
})

test('a session that is refused leaves nothing open and rejects', async () => {
  const r = rig('command')
  r.deps.connect = async () => {
    throw new Error('network')
  }
  await assert.rejects(startScribeVoice('tok', r.handlers, r.deps))
  assert.deepEqual(r.fails, [], 'a start that failed is the caller\'s to handle, not onFail')
})

test('a session that is not accepted in time is closed even if it arrives late', async () => {
  const r = rig('command')
  let arrive!: (l: ScribeLink) => void
  r.deps.connect = (_t, h) => {
    void h
    return new Promise<ScribeLink>((res) => (arrive = res))
  }
  const p = startScribeVoice('tok', r.handlers, { ...r.deps, startTimeoutMs: 100 })
  const settled = assert.rejects(p)
  mock.timers.tick(100)
  await settled
  arrive({ close: () => void r.link.closed++ })
  await flush()
  assert.equal(r.link.closed, 1)
})

test('an error mid-session reports once, closes, and hands on what was heard', async () => {
  const r = rig('command')
  await r.up()
  r.hooks().onPartial('открой календарь на завтра')
  r.hooks().onError('quota_exceeded')
  r.hooks().onError('quota_exceeded')
  r.hooks().onClose()
  assert.deepEqual(r.fails, ['quota_exceeded'])
  assert.equal(r.link.closed, 1)
  assert.deepEqual(r.utterances, ['открой календарь на завтра'], 'the half-said command is not lost')

  // Late events from the dead session change nothing.
  r.state.mode = 'command'
  r.hooks().onCommitted('Какая погода в Москве?')
  assert.equal(r.utterances.length, 1)
})

test('an unexpected close is a failure; our own stop is not', async () => {
  const a = rig('command')
  await a.up()
  a.hooks().onClose()
  assert.deepEqual(a.fails, ['closed'])

  const b = rig('command')
  const v = await b.up()
  v.stop()
  b.hooks().onClose()
  assert.deepEqual(b.fails, [])
  assert.equal(b.link.closed, 1)
})

// ---------------------------------------------------------------------------
// The supervisor
// ---------------------------------------------------------------------------

function supervisorRig() {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 })
  const log: string[] = []
  const s = { mode: 'command' as VoiceMode, idle: true, tokenFails: false, sessionFails: false, scribes: 0, browsers: 0 }
  let failScribe: (reason: string) => void = () => {}
  const engine = (name: string): Voice => ({
    ok: () => true,
    live: () => true,
    rearm: async () => true,
    idle: () => s.idle,
    stop: () => void log.push(`stop:${name}`),
  })
  const sup = () =>
    superviseVoice({
      mode: () => s.mode,
      getToken: async () => {
        log.push('token')
        if (s.tokenFails) throw new Error('no token')
        return 'tok'
      },
      startScribe: async (_t, onFail) => {
        if (s.sessionFails) {
          log.push('scribe:refused')
          throw new Error('refused')
        }
        const name = `scribe${++s.scribes}`
        log.push(`start:${name}`)
        failScribe = onFail
        return engine(name)
      },
      startBrowser: () => {
        const name = `browser${++s.browsers}`
        log.push(`start:${name}`)
        return engine(name)
      },
    })
  return { log, s, sup, fail: (r: string) => failScribe(r) }
}

test('Scribe that will not start leaves the browser engine running at once', async () => {
  const t = supervisorRig()
  t.s.sessionFails = true
  const v = await t.sup()
  assert.deepEqual(t.log, ['token', 'scribe:refused', 'start:browser1'])
  assert.equal(v.ok(), true)
  assert.equal(diag.engine, 'browser')
})

test('Scribe dying mid-session is replaced by the browser engine, never alongside it', async () => {
  const t = supervisorRig()
  await t.sup()
  assert.equal(diag.engine, 'scribe')
  t.fail('closed')
  assert.deepEqual(t.log, ['token', 'start:scribe1', 'stop:scribe1', 'start:browser1'])
  // A second report from the same dead session changes nothing.
  t.fail('closed')
  assert.equal(t.log.length, 4)
  assert.equal(diag.engine, 'browser')
})

test('a minute later, at a quiet moment, Scribe is restored with the browser engine stopped first', async () => {
  const t = supervisorRig()
  await t.sup()
  t.fail('closed')
  t.log.length = 0

  t.s.mode = 'wake'
  mock.timers.tick(60_000)
  await flush()
  assert.deepEqual(t.log, ['token', 'stop:browser1', 'start:scribe2'])
  assert.equal(diag.engine, 'scribe')
})

test('the swap waits for a conversation to end and for the engine to be between phrases', async () => {
  const t = supervisorRig()
  await t.sup()
  t.fail('closed')
  t.log.length = 0

  t.s.mode = 'command'
  mock.timers.tick(60_000)
  await flush()
  mock.timers.tick(5_000)
  await flush()
  assert.deepEqual(t.log, [], 'in a conversation nothing is touched')

  t.s.mode = 'wake'
  t.s.idle = false
  mock.timers.tick(5_000)
  await flush()
  assert.deepEqual(t.log, [], 'with words half-heard nothing is touched')

  t.s.idle = true
  mock.timers.tick(5_000)
  await flush()
  assert.deepEqual(t.log, ['token', 'stop:browser1', 'start:scribe2'])
})

test('a token that cannot be had leaves the browser engine alone, and is tried again in a minute', async () => {
  const t = supervisorRig()
  await t.sup()
  t.fail('closed')
  t.log.length = 0

  t.s.mode = 'wake'
  t.s.tokenFails = true
  mock.timers.tick(60_000)
  await flush()
  assert.deepEqual(t.log, ['token'])
  mock.timers.tick(60_000)
  await flush()
  assert.deepEqual(t.log, ['token', 'token'])
  assert.equal(diag.engine, 'browser')
})

test('a restore that fails after the swap puts the browser engine back and tries again later', async () => {
  const t = supervisorRig()
  await t.sup()
  t.fail('closed')
  t.log.length = 0

  t.s.mode = 'wake'
  t.s.sessionFails = true
  mock.timers.tick(60_000)
  await flush()
  assert.deepEqual(t.log, ['token', 'stop:browser1', 'scribe:refused', 'start:browser2'])
  assert.equal(diag.engine, 'browser')

  t.s.sessionFails = false
  t.log.length = 0
  mock.timers.tick(60_000)
  await flush()
  assert.deepEqual(t.log, ['token', 'stop:browser2', 'start:scribe2'])
})

test('stopping the loop stops the engine and the retries', async () => {
  const t = supervisorRig()
  const v = await t.sup()
  t.fail('closed')
  t.log.length = 0
  v.stop()
  assert.deepEqual(t.log, ['stop:browser1'])
  t.s.mode = 'wake'
  mock.timers.tick(120_000)
  await flush()
  assert.deepEqual(t.log, ['stop:browser1'])
})
