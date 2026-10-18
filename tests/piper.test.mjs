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
  const loaded = Date.now() - t0
  // The best of three different sentences (none of them cached). `npm test`
  // runs the test files side by side on every core, and one warm sentence
  // measured once took 2324 ms there against 160–200 ms alone: the scheduler,
  // not Piper. A real slowdown makes all three slow, so the budget stays.
  const warm = []
  const wavs = [first]
  for (const line of ['Плюс двенадцать, облачно.', 'Встреча через десять минут.', 'Музыка поставлена на паузу.']) {
    const t = Date.now()
    wavs.push(await piperSpeak(line, 'ru'))
    warm.push(Date.now() - t)
  }
  for (const wav of wavs) {
    assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF')
    assert.ok(wav.length > 20_000, `wav too short: ${wav.length}`)
  }
  const best = Math.min(...warm)
  console.log(`  first ${loaded} ms (includes model load), warm ${warm.join('/')} ms`)
  // A warm sentence must be quicker than the one before it takes to play.
  assert.ok(best < 2000, `warm synthesis too slow: ${warm.join('/')} ms`)
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

test('the announce style is its own rendering, and cached apart from answers', { skip: !voices.length && 'no piper voice installed' }, async () => {
  const line = 'Здравствуйте!'
  const normal = await piperSpeak(line, 'ru', null, 'normal')
  const announce = await piperSpeak(line, 'ru', null, 'announce')
  assert.equal(announce.subarray(0, 4).toString('ascii'), 'RIFF')
  // Different settings, different audio — not the normal line served from the cache.
  assert.notEqual(announce, normal)
  assert.ok(!announce.equals(normal), 'announce returned the normal rendering')
  // And the announcer's own repeat is cached.
  const t0 = Date.now()
  assert.equal(await piperSpeak(line, 'ru', null, 'announce'), announce)
  assert.ok(Date.now() - t0 < 20, 'announce line not cached')
  // An unknown style is an ordinary answer.
  assert.equal(await piperSpeak(line, 'ru', null, 'shout'), normal)
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
