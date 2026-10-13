import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isEcho } from '../src/lib/echo.ts'
import { prepareForSpeech } from '../src/lib/speechText.ts'

/** What the speaker registers while a sentence plays: the written form and the spoken one. */
const playing = (written: string) => `${written} ${prepareForSpeech(written, 'ru')}`

test('his own sentence coming back through the microphone is echo', () => {
  const said = playing('Сейчас в Москве плюс двенадцать, облачно, ветер слабый.')
  assert.ok(isEcho('сейчас в москве плюс двенадцать облачно', said))
  // The recogniser drops and mangles words; most of them still match.
  assert.ok(isEcho('москве плюс двенадцать облачно ветер', said))
})

test('echo is caught when the recogniser writes numbers back as digits', () => {
  // He says "шестьдесят километров в час"; Chrome writes it back as "60 км/ч".
  const said = playing('Скорость ветра 60 км/ч, давление 750 мм.')
  assert.ok(isEcho('скорость ветра 60 км/ч давление 750 мм', said))
  // …or in words, the way it was actually spoken.
  assert.ok(isEcho('скорость ветра 60 километров в час', said))
})

test('echo of a date is caught in either form', () => {
  const said = playing('Встреча перенесена на 1 августа.')
  assert.ok(isEcho('встреча перенесена на 1 августа', said))
  assert.ok(isEcho('встреча перенесена на первого августа', said))
})

test('a real follow-up question is not mistaken for echo', () => {
  const said = playing('Сейчас в Москве плюс двенадцать, облачно.')
  assert.ok(!isEcho('а какая погода будет завтра в питере', said))
  assert.ok(!isEcho('открой почту', said))
})

test('stop words always get through, even when he just said them', () => {
  const said = playing('Хватит ли этого? Подожди минуту, сэр.')
  for (const s of ['стоп', 'подожди', 'хватит сэр']) assert.ok(!isEcho(s, said), s)
})

test('nothing is echo when he is silent', () => {
  assert.ok(!isEcho('какая погода', ''))
})
