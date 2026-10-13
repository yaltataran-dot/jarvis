import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_UNSPOKEN, takeSentences } from '../src/lib/sentences.ts'

/** Feed text the way Claude streams it — a few characters at a time — and collect every piece. */
function stream(text: string, step = 3): string[] {
  const out: string[] = []
  let buffer = ''
  for (let i = 0; i < text.length; i += step) {
    buffer += text.slice(i, i + step)
    const { sentences, rest } = takeSentences(buffer)
    out.push(...sentences)
    buffer = rest
  }
  if (buffer.trim()) out.push(buffer)
  return out.map((s) => s.trim())
}

test('sentences are cut at their ends', () => {
  assert.deepEqual(stream('Готово, сэр. Встреча перенесена. Напоминание стоит.'), [
    'Готово, сэр.',
    'Встреча перенесена.',
    'Напоминание стоит.',
  ])
})

test('a question and an exclamation end sentences too', () => {
  assert.deepEqual(stream('Вы уверены? Да! Тогда начинаю.'), ['Вы уверены?', 'Да!', 'Тогда начинаю.'])
})

test('initials do not split a name', () => {
  assert.deepEqual(stream('Это написал А. С. Пушкин. Очень давно.'), ['Это написал А. С. Пушкин.', 'Очень давно.'])
})

test('spaced abbreviations do not split a sentence', () => {
  assert.deepEqual(stream('Почта, календарь и т. д. всё проверено. Готово.'), [
    'Почта, календарь и т. д. всё проверено.',
    'Готово.',
  ])
  assert.deepEqual(stream('Это, т. е. завтра, удобно. Да.'), ['Это, т. е. завтра, удобно.', 'Да.'])
  assert.deepEqual(stream('Цена 5 тыс. руб. за штуку. Дорого.'), ['Цена 5 тыс. руб. за штуку.', 'Дорого.'])
})

test('a list number is not spoken on its own', () => {
  assert.deepEqual(stream('1. Купить молоко. 2. Позвонить маме.'), ['1. Купить молоко.', '2. Позвонить маме.'])
})

test('"это я." still ends a sentence', () => {
  assert.deepEqual(stream('Это я. Слушаю.'), ['Это я.', 'Слушаю.'])
})

test('decimals and times are not sentence ends', () => {
  assert.deepEqual(stream('Курс 92.5 рубля, в 15.30 обновится. Всё.'), ['Курс 92.5 рубля, в 15.30 обновится.', 'Всё.'])
})

test('a long unpunctuated run is cut at a comma, not mid-phrase', () => {
  const long =
    'Я проверил погоду на ближайшие дни и могу сказать что в понедельник будет солнечно и тепло, ' +
    'во вторник ожидается небольшой дождь во второй половине дня и прохладный ветер с севера, ' +
    'а в среду снова прояснится и потеплеет до двадцати градусов'
  assert.ok(long.length > MAX_UNSPOKEN)
  const { sentences } = takeSentences(long)
  assert.equal(sentences.length, 1)
  assert.ok(sentences[0].endsWith(','), `cut mid-phrase: "…${sentences[0].slice(-30)}"`)
})

test('nothing is cut before a sentence is finished', () => {
  const { sentences, rest } = takeSentences('Сейчас в Москве плюс')
  assert.deepEqual(sentences, [])
  assert.equal(rest, 'Сейчас в Москве плюс')
})
