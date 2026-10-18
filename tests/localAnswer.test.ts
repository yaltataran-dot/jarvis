import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
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

test('the time is answered however it is asked for, "точное" included', () => {
  const at905 = state({ now: new Date(2026, 9, 18, 9, 5) })
  for (const said of [
    'Сколько сейчас времени?',
    'Который час?',
    'Скажи точное время.',
    'Какое сейчас точное время?',
    'Сколько точно времени?',
    'Сколько сейчас точного времени?',
    'Подскажи время',
    'Назови точное время',
    'Время?',
    'Текущее время',
    'Который сейчас час точно?',
    'Джарвис, сколько время сейчас?',
  ]) {
    assert.equal(localKind(said), 'time', said)
    assert.equal(localAnswer(said, at905), 'Девять ноль пять.', said)
  }
})

test('the date and the time together, when both are asked for', () => {
  const now = new Date(2026, 9, 18, 23, 59)
  assert.equal(localAnswer('Какие сейчас дата и время?', state({ now })), 'Сейчас двадцать три пятьдесят девять, воскресенье, восемнадцатое октября.')
  assert.equal(localAnswer('Скажи время и дату', state({ now })), null, 'not one of the phrasings: left to the model')
  assert.equal(localAnswer('Какая сегодня дата?', state({ now })), 'Сегодня воскресенье, восемнадцатое октября.')
})

test('the clock is the machine\'s own, in its own zone: nothing is fixed in the code', () => {
  // One instant, read by the page in three zones. Each answer is that zone's wall clock.
  const src = `import { localAnswer } from ${JSON.stringify(new URL('../src/lib/localAnswer.ts', import.meta.url).href)}
    const now = new Date(Date.UTC(2026, 9, 18, 6, 5))
    process.stdout.write(localAnswer('Который час?', { now, voice: '', connected: true }) + '|' + localAnswer('Какая сегодня дата?', { now, voice: '', connected: true }))`
  const want: Record<string, string> = {
    UTC: 'Шесть ноль пять.|Сегодня воскресенье, восемнадцатое октября.',
    'Europe/Moscow': 'Девять ноль пять.|Сегодня воскресенье, восемнадцатое октября.',
    'America/Los_Angeles': 'Двадцать три ноль пять.|Сегодня суббота, семнадцатое октября.',
  }
  for (const [TZ, expected] of Object.entries(want)) {
    const out = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', src], { env: { ...process.env, TZ }, encoding: 'utf8' })
    assert.equal(out.status, 0, out.stderr)
    assert.equal(out.stdout, expected, `TZ=${TZ}`)
  }
})

test('anything more than the bare question goes to the model', () => {
  for (const said of [
    'Какая погода в Москве?',
    'Точное время в Москве',
    'Сколько времени займёт дорога?',
    'Время в Токио',
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
