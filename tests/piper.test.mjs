import { test } from 'node:test'
import assert from 'node:assert/strict'
import { piperSpeak, piperVoices, defaultPiperVoice, stopPiper } from '../bridge/piper.mjs'

// A real synthesis, so it only runs where a voice is installed
// (scripts/windows/install-voice.ps1). Elsewhere it is skipped, not failed.
const voices = piperVoices('ru')

test('piper speaks Russian through the bridge module', { skip: !voices.length && 'no piper voice installed' }, async () => {
  assert.ok(defaultPiperVoice('ru'))
  const t0 = Date.now()
  const first = await piperSpeak('Готово, сэр.', 'ru')
  const warm = Date.now()
  const second = await piperSpeak('Плюс двенадцать, облачно.', 'ru')
  const done = Date.now()
  for (const wav of [first, second]) {
    assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF')
    assert.ok(wav.length > 20_000, `wav too short: ${wav.length}`)
  }
  console.log(`  first ${warm - t0} ms (includes model load), warm ${done - warm} ms`)
  // A warm sentence must be quicker than the one before it takes to play.
  assert.ok(done - warm < 2000, `warm synthesis too slow: ${done - warm} ms`)
})

test('Ruslan is the default, and only Russian voices are offered in Russian', { skip: !voices.length && 'no piper voice installed' }, () => {
  if (voices.includes('ru_RU-ruslan-medium') && !process.env.JARVIS_PIPER_VOICE) {
    assert.equal(defaultPiperVoice('ru'), 'ru_RU-ruslan-medium')
    assert.equal(voices[0], 'ru_RU-ruslan-medium')
  }
  for (const v of voices) assert.ok(v.startsWith('ru_'), `${v} offered for Russian`)
})

test('a repeated short line comes from the cache', { skip: !voices.length && 'no piper voice installed' }, async () => {
  const first = await piperSpeak('Да, сэр?', 'ru')
  const t0 = Date.now()
  const again = await piperSpeak('Да, сэр?', 'ru')
  assert.ok(Date.now() - t0 < 20, 'cache miss')
  assert.equal(again, first)
})

test('an unknown voice falls back to the default', { skip: !voices.length && 'no piper voice installed' }, async () => {
  const wav = await piperSpeak('Проверка.', 'ru', 'no-such-voice')
  assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF')
})

test('every installed voice can speak', { skip: voices.length < 2 && 'fewer than two voices' }, async () => {
  for (const v of voices) {
    const wav = await piperSpeak('Слушаю.', 'ru', v)
    assert.ok(wav.length > 10_000, `${v} produced ${wav.length} bytes`)
  }
})

// The worker is a child process holding stdin open; unload it so the run ends.
test.after(stopPiper)
