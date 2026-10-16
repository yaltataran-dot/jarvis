import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OVERRIDE, STOP_ONLY, STOP_TAIL } from '../src/lib/stopWords.ts'

// Each of these must both cut him off (OVERRIDE) and then be swallowed rather
// than sent to Claude as a question (STOP_ONLY).
const STOPS = [
  'Стоп', 'стоп.', 'Stop', 'stop please', 'Хватит', 'хватит, сэр', 'Стоп, стоп!',
  'Замолчи', 'Тихо', 'Подожди', 'погоди', 'Постой', 'Отмена', 'Отбой',
  'Забудь', 'Неважно', 'Достаточно', 'Ну хватит', 'Всё, хватит', 'сэр стоп',
]

for (const s of STOPS) {
  test(`"${s}" stops him and is not sent on`, () => {
    assert.ok(OVERRIDE.test(s), 'does not cut through his speech')
    assert.ok(STOP_ONLY.test(s), 'would be sent to Claude as a question')
  })
}

test('a real request that starts with a stop word is sent on', () => {
  for (const s of ['Стоп, а какая завтра погода?', 'Подожди, открой почту', 'Нет, я про завтра']) {
    assert.ok(OVERRIDE.test(s), `"${s}" should still cut him off`)
    assert.ok(!STOP_ONLY.test(s), `"${s}" was swallowed`)
  }
})

test('ordinary questions neither interrupt nor get swallowed', () => {
  for (const s of ['Какая погода в Москве?', 'Открой Гитхаб', 'Сколько времени']) {
    assert.ok(!OVERRIDE.test(s), `"${s}" would cut him off`)
    assert.ok(!STOP_ONLY.test(s), `"${s}" was swallowed`)
  }
})

test('every stop is found at the end of his words, as the microphone hears them over him', () => {
  for (const s of STOPS) {
    const m = STOP_TAIL.exec(`сегодня в москве солнечно ${s}`)
    assert.ok(m, `"${s}" after his words was not found`)
    assert.ok(STOP_ONLY.test(m[1]), `"${m[1]}" taken from "${s}" is not a stop on its own`)
  }
})

test('a stop that is not the last thing said, or not a whole word, is not a stop over him', () => {
  for (const s of [
    'стоп, а какая завтра погода',
    'сегодня стоп-кран не нужен',
    'это постоянно',
    'тише едешь дальше будешь',
    'какая погода в питере',
  ]) {
    assert.equal(STOP_TAIL.exec(s), null, `"${s}" read as a stop`)
  }
})

test('stop words are whole words, not substrings', () => {
  // "постоянно" contains "стоп"-like letters; "нетбук" contains "нет".
  assert.ok(!OVERRIDE.test('это постоянно'))
  assert.ok(!OVERRIDE.test('купи нетбук'))
})
