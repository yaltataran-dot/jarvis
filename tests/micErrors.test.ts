import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { classifyMicError, micFailureMessage, speechRefusalMessage } from '../src/lib/micErrors.ts'

test('each getUserMedia failure is named as its own cause, old names included', () => {
  assert.equal(classifyMicError('NotAllowedError'), 'denied')
  assert.equal(classifyMicError('PermissionDeniedError'), 'denied')
  assert.equal(classifyMicError('NotFoundError'), 'missing')
  assert.equal(classifyMicError('DevicesNotFoundError'), 'missing')
  assert.equal(classifyMicError('OverconstrainedError'), 'missing')
  assert.equal(classifyMicError('NotReadableError'), 'busy')
  assert.equal(classifyMicError('TrackStartError'), 'busy')
  assert.equal(classifyMicError('AbortError'), 'busy')
  assert.equal(classifyMicError('SecurityError'), 'blocked')
  assert.equal(classifyMicError('TypeError'), 'unknown')
  assert.equal(classifyMicError(undefined), 'unknown')
})

test('every cause tells the user what to do, and each one says something different', () => {
  const kinds = ['denied', 'missing', 'busy', 'blocked', 'unknown'] as const
  const ru = kinds.map((k) => micFailureMessage(k, 'ru'))
  assert.equal(new Set(ru).size, kinds.length)
  assert.match(micFailureMessage('denied'), /Разрешите/)
  assert.match(micFailureMessage('busy'), /занят/)
  assert.match(micFailureMessage('missing'), /не найден/)
  for (const m of ru.filter((_, i) => kinds[i] !== 'blocked')) assert.match(m, /коснитесь экрана/i)
  assert.match(micFailureMessage('denied', 'en'), /Allow it/)
})

test('a recogniser refusal with the microphone allowed is not called a denial', () => {
  const granted = speechRefusalMessage('not-allowed', 'granted')
  assert.match(granted, /Микрофон разрешён/)
  assert.doesNotMatch(granted, /запрещён/)
  assert.match(speechRefusalMessage('not-allowed', 'denied'), /запрещён/)
  assert.match(speechRefusalMessage('not-allowed', 'unknown'), /запрещён/, 'with no answer from the browser it may well be a denial')
  assert.match(speechRefusalMessage('service-not-allowed', 'granted'), /распознавание речи браузера отключено/)
})

test('wiring: the old messages are gone and a phone can restart the microphone by touch', () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')
  const browser = read('../src/lib/browserVoice.ts')
  const voice = read('../src/lib/voice.ts')
  const vad = read('../src/lib/vad.ts')
  const app = read('../src/App.tsx')
  assert.doesNotMatch(browser, /Microphone access was refused/)
  assert.match(browser, /speechRefusalMessage\(code, permission/)
  assert.doesNotMatch(voice + vad, /Microphone access denied/)
  assert.match(voice, /micFailureMessage\(kind, LANG\)/)
  // A start-up that could not hear, a failed retry and a refusing recogniser all arm the touch.
  assert.ok((app.match(/requestMicTap\(\)/g) ?? []).length >= 3, 'three places ask for a touch')
  assert.match(app, /window\.addEventListener\(MIC_TAP, onTapRequest\)/)
  assert.match(app, /window\.removeEventListener\(MIC_TAP, onTapRequest\)/)
})
