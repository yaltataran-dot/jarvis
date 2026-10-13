import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OVERRIDE, STOP_ONLY } from '../src/lib/stopWords.ts'

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

test('stop words are whole words, not substrings', () => {
  // "постоянно" contains "стоп"-like letters; "нетбук" contains "нет".
  assert.ok(!OVERRIDE.test('это постоянно'))
  assert.ok(!OVERRIDE.test('купи нетбук'))
})
