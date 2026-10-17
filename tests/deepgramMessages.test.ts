import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDeepgramParser } from '../src/lib/deepgramVoice.ts'
import type { ScribeHooks } from '../src/lib/scribeVoice.ts'

function rig() {
  const log: string[] = []
  const hooks: ScribeHooks = {
    onStarted: () => log.push('started'),
    onPartial: (t) => log.push(`p:${t}`),
    onCommitted: (t) => log.push(`c:${t}`),
    onError: (r) => log.push(`e:${r}`),
    onClose: () => log.push('close'),
  }
  const p = createDeepgramParser(hooks)
  const send = (m: object) => p.handle(JSON.stringify(m))
  const r = (text: string, final = false, speech = false) => send({ t: 'r', text, final, speech })
  return { log, p, send, r }
}

test('ready starts the session once', () => {
  const { log, send } = rig()
  send({ t: 'ready' })
  send({ t: 'ready' })
  assert.deepEqual(log, ['started'])
})

test('an interim result is a partial, and a commit never comes from it', () => {
  const { log, r } = rig()
  r('включи')
  r('включи музыку')
  assert.deepEqual(log, ['p:включи', 'p:включи музыку'])
})

test('finals are held until speech_final, then committed as one phrase', () => {
  const { log, r } = rig()
  r('какая сегодня', true)
  r('погода в москве')
  r('погода в москве', true, true)
  assert.deepEqual(log, ['p:какая сегодня', 'p:какая сегодня погода в москве', 'c:какая сегодня погода в москве'])
})

test('a speech_final with no words closes what was held', () => {
  const { log, r } = rig()
  r('стоп', true)
  r('', true, true)
  assert.deepEqual(log, ['p:стоп', 'c:стоп'])
})

test('UtteranceEnd commits what speech_final never closed, once', () => {
  const { log, r, send } = rig()
  r('открой календарь', true)
  send({ t: 'u' })
  send({ t: 'u' })
  assert.deepEqual(log, ['p:открой календарь', 'c:открой календарь'])
})

test('speech_final then UtteranceEnd is one commit, not two', () => {
  const { log, r, send } = rig()
  r('привет', true, true)
  send({ t: 'u' })
  assert.deepEqual(log, ['c:привет'])
})

test('empty and whitespace results say nothing', () => {
  const { log, r, send } = rig()
  r('')
  r('   ')
  r('', true)
  send({ t: 'u' })
  assert.deepEqual(log, [])
})

test('the next phrase starts clean after a commit', () => {
  const { log, r } = rig()
  r('один', true, true)
  r('два')
  r('два', true, true)
  assert.deepEqual(log, ['c:один', 'p:два', 'c:два'])
})

test('an upstream error is reported and drops the held words', () => {
  const { log, r, send, p } = rig()
  r('половина', true)
  send({ t: 'err' })
  assert.equal(p.pending(), '')
  assert.deepEqual(log, ['p:половина', 'e:deepgram'])
})

test('junk and unknown messages are ignored', () => {
  const { log, p, send } = rig()
  p.handle('not json')
  p.handle('null')
  send({ t: 'metadata', request_id: 'x' })
  assert.deepEqual(log, [])
})
