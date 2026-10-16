import { test, mock, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { startBrowserVoice } from '../src/lib/browserVoice.ts'
import { createFloor, type FloorSpeaker } from '../src/lib/floor.ts'
import type { VoiceMode } from '../src/lib/voiceCore.ts'

/**
 * The browser engine against a recogniser the test drives: results are
 * handed in exactly as Chrome numbers them, and the clock only moves when the
 * test moves it. His own speech is a stand-in for tts.ts.
 */
class FakeRecognition {
  static all: FakeRecognition[] = []
  continuous = false
  interimResults = false
  lang = ''
  aborted = false
  onstart: (() => void) | null = null
  onresult: ((e: unknown) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  onend: (() => void) | null = null
  constructor() {
    FakeRecognition.all.push(this)
  }
  start() {}
  abort() {
    this.aborted = true
    this.onend?.()
  }
  /** One recogniser event: the whole result list, and where the change starts. */
  hear(from: number, ...rs: [string, boolean][]) {
    const results = rs.map(([transcript, isFinal]) => Object.assign([{ transcript }], { isFinal }))
    this.onresult?.({ resultIndex: from, results })
  }
}

function rig(startMode: VoiceMode) {
  FakeRecognition.all = []
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 })
  const him = { since: 0, active: false, ended: 0, text: '' }
  /** He starts saying `text`. */
  const speak = (text: string) => {
    him.since = Date.now()
    him.active = true
    him.text = text
  }
  /** He falls quiet, and is past the audible guard too. */
  const quiet = () => {
    him.since = 0
    him.ended = Date.now()
    him.active = false
  }
  /** He has just been cut off: silent, but still inside the audible guard. */
  const fading = () => {
    him.since = 0
    him.ended = Date.now()
    him.active = true
  }
  const state = { mode: startMode }
  const wakes: string[] = []
  const utterances: Array<[string, number]> = []
  let speechStarts = 0
  const handlers = {
    mode: () => state.mode,
    onWake: (trailing: string) => {
      wakes.push(trailing)
      // As App does: a wake with a command starts a turn — he is thinking.
      state.mode = trailing ? 'guard' : 'command'
    },
    onSpeechStart: () => {
      speechStarts++
      state.mode = 'command'
    },
    onPartial: () => {},
    onUtterance: (text: string, id: number) => {
      utterances.push([text, id])
      state.mode = 'guard'
    },
    onError: () => {},
  }
  const voice = startBrowserVoice(handlers, {
    Ctor: FakeRecognition,
    lang: 'ru',
    speech: {
      speakingSince: () => him.since,
      speechActive: () => him.active,
      lastSoundEnded: () => him.ended,
      speakingNow: () => him.text,
    },
  })
  const rec = () => FakeRecognition.all.at(-1)!
  rec().onstart?.()
  return { voice, state, wakes, utterances, speechStarts: () => speechStarts, rec, speak, quiet, fading, handlers }
}

afterEach(() => mock.timers.reset())

/**
 * The recogniser's 900 ms quiet gap, then the assembler's 250 ms settle. Two
 * steps: a timer set while the mock clock is ticking waits for the next tick.
 */
const endpoint = () => {
  mock.timers.tick(900)
  mock.timers.tick(250)
}

test('his name and a command in one breath: one wake, with the whole command, once', () => {
  const v = rig('wake')
  // Chrome's interim lags the speaker: the name arrives with half a command.
  v.rec().hear(0, ['Джарвис удали', false])
  assert.deepEqual(v.wakes, [], 'nothing acted on from half a phrase')
  mock.timers.tick(300)
  v.rec().hear(0, ['Джарвис удали встречу в четыре', false])
  v.rec().hear(0, ['Джарвис, удали встречу в четыре', true])
  mock.timers.tick(899)
  assert.deepEqual(v.wakes, [])
  mock.timers.tick(1)
  assert.deepEqual(v.wakes, ['удали встречу в четыре'])
  // Chrome delivers the same final again while he thinks.
  v.rec().hear(0, ['Джарвис, удали встречу в четыре', true])
  mock.timers.tick(5000)
  assert.deepEqual(v.wakes, ['удали встречу в четыре'], 'one dialogue')
  assert.equal(v.speechStarts(), 0, 'its own tail did not barge in on the turn it started')
  assert.equal(v.utterances.length, 0)
  v.voice.stop()
})

test('his name alone: one wake, with nothing to answer yet', () => {
  const v = rig('wake')
  v.rec().hear(0, ['Джарвис', true])
  mock.timers.tick(900)
  assert.deepEqual(v.wakes, [''])
  v.voice.stop()
})

test('one recogniser event delivered twice: one utterance', () => {
  const v = rig('command')
  v.rec().hear(0, ['какая погода в москве', true])
  v.rec().hear(0, ['какая погода в москве', true])
  endpoint()
  assert.equal(v.utterances.length, 1)
  assert.equal(v.utterances[0][0], 'какая погода в москве')
  // And again, the same final, now he is thinking: neither a new question nor
  // a barge-in that would cancel the one just asked.
  v.rec().hear(0, ['Какая погода в Москве?', true])
  mock.timers.tick(5000)
  assert.equal(v.utterances.length, 1)
  assert.equal(v.speechStarts(), 1, 'only the start of the question itself')
  v.voice.stop()
})

test('a late final that adds words to the phrase just sent replaces it whole, not as a second question', () => {
  const v = rig('command')
  // Chrome sat on an interim for the whole endpoint: it is sent as it stands.
  v.rec().hear(0, ['какая погода', false])
  endpoint()
  mock.timers.tick(1600) // two words: the assembler waits for more
  assert.deepEqual(v.utterances.map((u) => u[0]), ['какая погода'])
  assert.equal(v.state.mode, 'guard', 'that turn is under way')
  // The same result, finalised a moment later with the rest of the words.
  v.rec().hear(0, ['какая погода в москве', true])
  endpoint()
  mock.timers.tick(1600)
  assert.deepEqual(
    v.utterances.map((u) => u[0]),
    ['какая погода', 'какая погода в москве'],
    'the second turn carries the whole question, not the tail "в москве"',
  )
  assert.equal(v.speechStarts(), 2, 'the half-question turn was superseded once')
  v.voice.stop()
})

test('a new phrase after the one just sent is still its own question', () => {
  const v = rig('command')
  v.rec().hear(0, ['какая погода в москве', true])
  endpoint()
  // The user goes on, as a new result: not glued to the last question.
  v.rec().hear(0, ['какая погода в москве', true], ['а в питере', true])
  endpoint()
  assert.deepEqual(v.utterances.map((u) => u[0]), ['какая погода в москве', 'а в питере'])
  v.voice.stop()
})

test('every utterance has its own id', () => {
  const v = rig('command')
  v.rec().hear(0, ['включи свет на кухне', true])
  endpoint()
  v.state.mode = 'command'
  v.rec().hear(0, ['включи свет на кухне', true], ['и выключи в зале', true])
  endpoint()
  assert.equal(v.utterances.length, 2)
  assert.ok(v.utterances[1][1] > v.utterances[0][1])
  v.voice.stop()
})

test('his own answer through the microphone is never a command, nor a barge-in', () => {
  const v = rig('guard')
  v.speak('Сегодня в Москве солнечно, плюс пятнадцать.')
  mock.timers.tick(400)
  v.rec().hear(0, ['сегодня в москве солнечно плюс пятнадцать', true])
  v.rec().hear(0, ['сегодня в москве солнечно плюс пятнадцать', true], ['пятнадцать градусов', false])
  mock.timers.tick(2000)
  assert.equal(v.speechStarts(), 0)
  assert.equal(v.utterances.length, 0)
  v.voice.stop()
})

test('after he falls quiet, the session that heard him is replaced, and its late results go nowhere', () => {
  const v = rig('guard')
  v.speak('Сегодня солнечно.')
  mock.timers.tick(200)
  const heardHim = v.rec()
  v.quiet()
  v.state.mode = 'command'
  mock.timers.tick(100)
  assert.equal(heardHim.aborted, true, 'resynced')
  assert.equal(FakeRecognition.all.length, 2, 'exactly one new recogniser')
  mock.timers.tick(1000)
  assert.equal(FakeRecognition.all.length, 2, 'and still only one: no second one started by a timer')
  // Chrome finalising his last sentence on the old session.
  heardHim.hear(0, ['сегодня солнечно', true])
  mock.timers.tick(2000)
  assert.equal(v.utterances.length, 0)
  // The user, on the new one.
  v.rec().onstart?.()
  v.rec().hear(0, ['а что завтра', true])
  endpoint()
  assert.deepEqual(v.utterances.map((u) => u[0]), ['а что завтра'])
  v.voice.stop()
})

test('"стоп" while he speaks cuts him off at once — the real speaker, through the floor', () => {
  const v = rig('guard')
  const floor = createFloor<FloorSpeaker>({ interrupt: () => {} })
  let cancelled = 0
  const spk = floor.begin('utterance').speaker(() => ({
    push: () => {},
    say: () => {},
    end: async () => {},
    cancel: () => void cancelled++,
    level: () => 0,
  }))
  spk.push('Сегодня в Москве солнечно, плюс пятнадцать.')
  // App.onSpeechStart on a barge-in.
  const appStart = v.handlers.onSpeechStart
  v.handlers.onSpeechStart = () => {
    floor.supersede('barge-in')
    appStart()
  }
  v.speak('Сегодня в Москве солнечно, плюс пятнадцать.')
  mock.timers.tick(400)
  v.rec().hear(0, ['стоп', false]) // the first interim, no waiting for a final
  assert.equal(cancelled, 1, 'cut in the same event')
  assert.equal(floor.current(), null)
  assert.deepEqual(v.utterances.map((u) => u[0]), ['стоп'])
  v.voice.stop()
})

/** He is in the middle of a long answer, loud enough to be heard. */
const LONG = 'Сегодня в Москве солнечно, плюс пятнадцать. Завтра облачно, вечером возможен дождь.'

for (const word of ['стоп', 'хватит', 'замолчи', 'тихо']) {
  test(`«${word}» over a long answer, heard together with his own words: he stops at once`, () => {
    const v = rig('guard')
    v.speak(LONG)
    mock.timers.tick(400)
    // The microphone hears the speakers and the user as one phrase.
    v.rec().hear(0, ['сегодня в москве солнечно плюс', false])
    assert.equal(v.speechStarts(), 0)
    v.rec().hear(0, [`сегодня в москве солнечно плюс ${word}`, false])
    assert.equal(v.speechStarts(), 1, 'cut on the interim, not after the sentence')
    assert.deepEqual(v.utterances.map((u) => u[0]), [word], 'handed on as a stop, nothing else of the phrase')
    v.voice.stop()
  })
}

test('«стоп» when the recogniser also rewrites his words before it', () => {
  const v = rig('guard')
  v.speak(LONG)
  mock.timers.tick(400)
  v.rec().hear(0, ['сегодня в москве солнечна', false])
  // His words heard better, and the stop after them, in one revision.
  v.rec().hear(0, ['сегодня в москве солнечно плюс стоп', false])
  assert.equal(v.speechStarts(), 1)
  assert.deepEqual(v.utterances.map((u) => u[0]), ['стоп'])
  v.voice.stop()
})

test('«стоп, сэр» and «хватит, пожалуйста» stop him too', () => {
  for (const said of ['стоп, сэр', 'хватит пожалуйста']) {
    const v = rig('guard')
    v.speak(LONG)
    mock.timers.tick(400)
    v.rec().hear(0, [`завтра облачно ${said}`, false])
    assert.equal(v.speechStarts(), 1, said)
    v.voice.stop()
    mock.timers.reset()
  }
})

test('his own word that happens to be a stop word does not stop him', () => {
  const v = rig('guard')
  v.speak('На море сегодня тихо, и этого достаточно.')
  mock.timers.tick(400)
  v.rec().hear(0, ['на море сегодня тихо', false])
  v.rec().hear(0, ['на море сегодня тихо и этого достаточно', true])
  mock.timers.tick(2000)
  assert.equal(v.speechStarts(), 0)
  assert.equal(v.utterances.length, 0)
  v.voice.stop()
})

test('a stop is taken once: the same word coming back while he falls quiet is not a second stop', () => {
  const v = rig('guard')
  v.speak(LONG)
  mock.timers.tick(400)
  v.rec().hear(0, ['сегодня в москве стоп', false])
  assert.equal(v.speechStarts(), 1)
  // The app cut him: he is silent, still inside the audible guard.
  v.fading()
  v.state.mode = 'command'
  v.rec().hear(0, ['сегодня в москве стоп', true])
  v.rec().hear(0, ['Сегодня в Москве, стоп.', true])
  assert.equal(v.speechStarts(), 1)
  assert.equal(v.utterances.length, 1)
  // His next answer, a few seconds later, can be stopped again.
  mock.timers.tick(3000)
  v.state.mode = 'guard'
  v.speak('Новый ответ, тоже длинный.')
  mock.timers.tick(400)
  v.rec().hear(0, ['сегодня в москве стоп', true], ['новый ответ тоже хватит', false])
  assert.equal(v.speechStarts(), 2)
  v.voice.stop()
})

test('a normal request said over him is still not a command', () => {
  const v = rig('guard')
  v.speak(LONG)
  mock.timers.tick(400)
  v.rec().hear(0, ['сегодня в москве солнечно какая погода в питере', true])
  mock.timers.tick(2000)
  assert.equal(v.speechStarts(), 0)
  assert.equal(v.utterances.length, 0)
  v.voice.stop()
})

test('a quiet room: Chrome closes each session with no-speech, and exactly one new one follows', async () => {
  const { diag } = await import('../src/lib/voiceCore.ts')
  diag.lastError = ''
  const quietBefore = diag.quiet
  const v = rig('wake')
  // A minute of silence, the way Chrome spends it: about 8 s, then no-speech
  // and end, then the loop starts a session again.
  for (let t = 0; t < 60_000; t += 8_100) {
    const r = v.rec()
    mock.timers.tick(8_000)
    r.onerror?.({ error: 'no-speech' })
    r.onend?.()
    mock.timers.tick(100)
    v.rec().onstart?.()
  }
  assert.equal(FakeRecognition.all.length, 9, 'one session per silence timeout — none from the heartbeat or a double start')
  assert.equal(diag.quiet - quietBefore, 8)
  assert.equal(diag.lastError, '', 'routine silence is not shown as a fault')
  assert.deepEqual(v.wakes, [])
  // And it still hears: his name wakes him on the latest session.
  v.rec().hear(0, ['Джарвис', true])
  mock.timers.tick(900)
  assert.deepEqual(v.wakes, [''])
  v.voice.stop()
})

test('a real error that repeats is retried more and more slowly, and anything heard resets that', () => {
  const v = rig('wake')
  const fail = () => {
    const r = v.rec()
    r.onerror?.({ error: 'network' })
    r.onend?.()
  }
  fail()
  mock.timers.tick(249)
  assert.equal(FakeRecognition.all.length, 1, 'not every 80 ms')
  mock.timers.tick(1)
  assert.equal(FakeRecognition.all.length, 2)
  fail()
  mock.timers.tick(499)
  assert.equal(FakeRecognition.all.length, 2)
  mock.timers.tick(1)
  assert.equal(FakeRecognition.all.length, 3)
  for (let i = 0; i < 6; i++) {
    fail()
    mock.timers.tick(5_000)
  }
  const n = FakeRecognition.all.length
  fail()
  mock.timers.tick(4_999)
  assert.equal(FakeRecognition.all.length, n, 'capped at 5 s, not growing for ever')
  mock.timers.tick(1)
  assert.equal(FakeRecognition.all.length, n + 1)
  // The service is back: a result, then an ordinary end restarts at once.
  v.rec().onstart?.()
  v.rec().hear(0, ['тишина', false])
  v.rec().onend?.()
  mock.timers.tick(80)
  assert.equal(FakeRecognition.all.length, n + 2)
  v.voice.stop()
})

test('stopped: no recogniser restarts, nothing fires afterwards', () => {
  const v = rig('command')
  v.rec().hear(0, ['напомни мне про', true])
  v.voice.stop()
  const n = FakeRecognition.all.length
  mock.timers.tick(60_000)
  assert.equal(FakeRecognition.all.length, n, 'no new session')
  assert.equal(v.utterances.length, 0, 'the held phrase was dropped, not sent later')
})
