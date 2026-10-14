import { test } from 'node:test'
import assert from 'node:assert/strict'
import { effortFor } from '../bridge/effort.mjs'

test('short questions that need nothing looked up are low', () => {
  for (const q of ['Сколько будет семнадцать умножить на три?', 'Спасибо', 'Привет, как дела?', 'Как тебя зовут?', 'Сделай интерфейс красным']) {
    assert.equal(effortFor(q), 'low', q)
  }
})

test('anything that may need current information is never low', () => {
  for (const q of [
    'Какая сейчас погода в Краснодаре?',
    'Какой курс доллара?',
    'Что нового в мире ИИ на этой неделе?',
    'Найди телефон автовокзала',
    'Сколько ехать до аэропорта?',
    'Открой почту',
  ]) {
    assert.equal(effortFor(q), 'medium', q)
  }
})

test('asked to think, or a long request, is high', () => {
  for (const q of [
    'Сравни тарифы двух операторов',
    'Объясни, почему небо голубое',
    'Составь план поездки в Сочи на три дня',
    'Проанализируй этот отчёт',
  ]) {
    assert.equal(effortFor(q), 'high', q)
  }
  const long = 'мне нужно ' + 'очень '.repeat(30) + 'много всего'
  assert.equal(effortFor(long), 'high')
})

test('anything else is medium', () => {
  assert.equal(
    effortFor('Расскажи что-нибудь интересное про историю Краснодарского края и его казачьих станиц'),
    'medium',
  )
})
