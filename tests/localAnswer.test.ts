import { test } from 'node:test'
import assert from 'node:assert/strict'
import { localAnswer, localKind, sayClock } from '../src/lib/localAnswer.ts'

const state = (over: Partial<{ now: Date; voice: string; connected: boolean }> = {}) => ({
  now: new Date(2026, 9, 16, 16, 42),
  voice: 'Руслан (Piper)',
  connected: true,
  ...over,
})

test('the questions it owns are answered from the page, in words', () => {
  assert.equal(localAnswer('Который час?', state()), 'Шестнадцать сорок две.')
  assert.equal(localAnswer('Сколько сейчас времени', state({ now: new Date(2026, 0, 1, 9, 5) })), 'Девять ноль пять.')
  assert.equal(localAnswer('Скажи, пожалуйста, который час?', state({ now: new Date(2026, 0, 1, 21, 0) })), 'Двадцать один ноль-ноль.')
  assert.equal(localAnswer('Какое сегодня число?', state()), 'Сегодня пятница, шестнадцатое октября.')
  assert.equal(localAnswer('Какой сегодня день недели', state({ now: new Date(2026, 4, 3) })), 'Сегодня воскресенье, третье мая.')
  assert.equal(localAnswer('Как тебя зовут?', state()), 'Юг-Трансфер, ваш голосовой помощник.')
  assert.equal(localAnswer('Какой голос ты используешь?', state()), 'Голос Руслан, локальный синтезатор Пайпер.')
  assert.equal(localAnswer('Ты меня слышишь?', state()), 'Слышу вас хорошо.')
  assert.equal(localAnswer('Ты на связи?', state()), 'На связи, сэр.')
  assert.equal(localAnswer('Ты на связи?', state({ connected: false })), 'Связь с мостом потеряна, восстанавливаю.')
})

test('anything more than the bare question goes to the model', () => {
  for (const said of [
    'Который час в Токио?',
    'Как тебя зовут по-английски?',
    'Какое число будет через неделю?',
    'Сколько времени ехать до Краснодара?',
    'Какой голос лучше для озвучки?',
    'Кто ты по профессии у нас в компании?',
    'Слышишь меня, включи музыку',
    'Что у меня сегодня в календаре?',
    'Привет',
    '',
  ]) {
    assert.equal(localKind(said), null, said)
    assert.equal(localAnswer(said, state()), null, said)
  }
})

test('with no voice known yet, the voice question is left to the model', () => {
  assert.equal(localAnswer('Какой голос ты используешь?', state({ voice: '' })), null)
})

test('the clock reads minutes in the feminine and fills the hour', () => {
  assert.equal(sayClock(0, 1), 'ноль ноль одна')
  assert.equal(sayClock(13, 2), 'тринадцать ноль две')
  assert.equal(sayClock(23, 59), 'двадцать три пятьдесят девять')
  assert.equal(sayClock(12, 0), 'двенадцать ноль-ноль')
  assert.equal(sayClock(10, 21), 'десять двадцать одна')
})
