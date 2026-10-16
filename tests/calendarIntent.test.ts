import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONFIRM_WORD, confirmAnswer, confirmFor, parseCalendarCommand, readAnswer, type Ctx } from '../src/lib/calendarIntent.ts'

// Wednesday 14 October 2026, 15:36.
const C: Ctx = { now: { y: 2026, m: 10, d: 14, hh: 15, mm: 36 }, today: { y: 2026, m: 10, d: 14 } }
const p = (s: string, c: Ctx = C) => parseCalendarCommand(s, c)
const D = (m: number, d: number, y = 2026) => ({ y, m, d })
const T = (hh: number, mm = 0) => ({ hh, mm })

test('the main example: date, time and place, the title left as a meeting', () => {
  assert.deepEqual(p('Джарвис, запиши мою встречу на 18 октября в 18:00, ресторан Батони'), {
    action: 'create',
    title: 'Встреча',
    date: D(10, 18),
    time: T(18),
    location: 'ресторан Батони',
  })
  assert.deepEqual(p('Запиши на 18 октября в 18:00 ресторан Батони'), {
    action: 'create',
    title: 'Встреча',
    date: D(10, 18),
    time: T(18),
    location: 'ресторан Батони',
  })
})

test('create, many ways of saying it', () => {
  assert.deepEqual(p('Запиши встречу завтра в 15:00'), { action: 'create', title: 'Встреча', date: D(10, 15), time: T(15) })
  assert.deepEqual(p('Поставь встречу на пятницу в шесть вечера'), { action: 'create', title: 'Встреча', date: D(10, 16), time: T(18), part: 'evening' })
  assert.deepEqual(p('Создай встречу с Иваном завтра в два часа'), { action: 'create', title: 'Встреча с Иваном', date: D(10, 15), time: T(14) })
  assert.deepEqual(p('Добавь звонок с партнёром в понедельник в 11 утра'), {
    action: 'create',
    title: 'Звонок с партнёром',
    date: D(10, 19),
    time: T(11),
    part: 'morning',
  })
  assert.deepEqual(p('Запланируй встречу с клиентом на следующей неделе'), { action: 'create', title: 'Встреча с клиентом', week: 'next' })
  assert.deepEqual(p('Запиши встречу с Иваном'), { action: 'create', title: 'Встреча с Иваном' })
  assert.deepEqual(p('Запиши встречу в ресторане Батони завтра в 19:00 на два часа'), {
    action: 'create',
    title: 'Встреча',
    date: D(10, 15),
    time: T(19),
    durationMin: 120,
    location: 'ресторан Батони',
  })
})

test('dates', () => {
  assert.deepEqual(p('Запиши встречу сегодня в 18:00')?.date ?? null, D(10, 14))
  assert.deepEqual(p('Запиши встречу послезавтра в 10:00')?.date ?? null, D(10, 16))
  assert.deepEqual(p('Запиши встречу 18-го в 12:00')?.date ?? null, D(10, 18))
  assert.deepEqual(p('Запиши встречу в следующую пятницу в 12:00')?.date ?? null, D(10, 23))
  assert.deepEqual(p('Запиши встречу в эту пятницу в 12:00')?.date ?? null, D(10, 16))
  assert.deepEqual(p('Запиши встречу 18.11 в 12:00')?.date ?? null, D(11, 18))
  assert.deepEqual(p('Запиши встречу 3 ноября 2027 года в 12:00')?.date ?? null, D(11, 3, 2027))
})

test('a date with no year that has passed moves to next year, flagged to be said aloud', () => {
  const r = p('Запиши встречу 5 марта в 12:00')
  assert.equal(r?.action, 'create')
  assert.deepEqual((r as { date: unknown }).date, D(3, 5, 2027))
  assert.equal((r as { yearRolled?: boolean }).yearRolled, true)
})

test('times', () => {
  const t = (s: string) => (p(`Запиши встречу завтра ${s}`) as { time?: unknown })?.time
  assert.deepEqual(t('в 18:00'), T(18))
  assert.deepEqual(t('в шесть вечера'), T(18))
  assert.deepEqual(t('в половине седьмого'), T(18, 30))
  assert.deepEqual(t('в половине седьмого утра'), T(6, 30))
  assert.deepEqual(t('в 9 утра'), T(9))
  assert.deepEqual(t('в 3 дня'), T(15))
  assert.deepEqual(t('в полдень'), T(12))
  assert.deepEqual(t('в 8:30'), T(8, 30))
  assert.deepEqual(t('в шесть тридцать'), T(18, 30))
  const evening = p('Запиши встречу завтра вечером') as { part?: string; time?: unknown }
  assert.equal(evening.part, 'evening')
  assert.equal(evening.time, undefined, 'вечером is not a time')
})

test('relative: через два часа, через полчаса', () => {
  assert.deepEqual(p('Запиши звонок через два часа'), { action: 'create', title: 'Звонок', date: D(10, 14), time: T(17, 36) })
  assert.deepEqual((p('Запиши звонок через полчаса') as { time?: unknown }).time, T(16, 6))
})

test('the year turns over cleanly', () => {
  const eve: Ctx = { now: { y: 2026, m: 12, d: 31, hh: 22, mm: 0 }, today: { y: 2026, m: 12, d: 31 } }
  assert.deepEqual((p('Запиши встречу завтра в 12:00', eve) as { date: unknown }).date, D(1, 1, 2027))
  assert.deepEqual((p('Запиши встречу в понедельник в 12:00', eve) as { date: unknown }).date, D(1, 4, 2027))
  assert.deepEqual((p('Запиши звонок через три часа', eve) as { date: unknown; time: unknown }).date, D(1, 1, 2027))
})

test('reading the calendar', () => {
  assert.deepEqual(p('Что у меня сегодня?'), { action: 'list', from: D(10, 14), days: 1, label: '' })
  assert.deepEqual(p('Что у меня завтра?'), { action: 'list', from: D(10, 15), days: 1, label: '' })
  assert.deepEqual(p('Какие встречи на этой неделе?'), { action: 'list', from: D(10, 14), days: 5, label: 'на этой неделе' })
  assert.deepEqual(p('Какие встречи на следующей неделе?'), { action: 'list', from: D(10, 19), days: 7, label: 'на следующей неделе' })
  assert.deepEqual(p('Что у меня 18 октября?'), { action: 'list', from: D(10, 18), days: 1, label: '' })
  assert.deepEqual(p('Покажи мои планы на понедельник'), { action: 'list', from: D(10, 19), days: 1, label: '' })
  assert.deepEqual(p('Когда у меня следующая встреча?'), { action: 'next' })
  assert.deepEqual(p('Во сколько встреча с Батони?'), { action: 'when', query: 'Батони' })
})

test('moving', () => {
  assert.deepEqual(p('Перенеси встречу с Батони на 19:00'), { action: 'move', query: 'Батони', to: { time: T(19) } })
  assert.deepEqual(p('Перенеси встречу с Батони на завтра'), { action: 'move', query: 'Батони', to: { date: D(10, 15) } })
  assert.deepEqual(p('Перенеси встречу с Иваном на пятницу в 15:00'), { action: 'move', query: 'Иваном', to: { date: D(10, 16), time: T(15) } })
  assert.deepEqual(p('Поставь встречу на час позже'), { action: 'move', query: '', to: {}, shiftMin: 60 })
  assert.deepEqual(p('Перенеси встречу с Иваном на полчаса раньше'), { action: 'move', query: 'Иваном', to: {}, shiftMin: -30 })
})

test('changing the place, deleting', () => {
  assert.deepEqual(p('Измени место встречи с Батони'), { action: 'relocate', query: 'Батони' })
  assert.deepEqual(p('Измени место встречи с Батони на кафе Пушкин'), { action: 'relocate', query: 'Батони', location: 'кафе Пушкин' })
  assert.deepEqual(p('Отмени встречу с Батони'), { action: 'delete', query: 'Батони' })
  assert.deepEqual(p('Удали встречу с Иваном завтра'), { action: 'delete', query: 'Иваном', on: D(10, 15) })
  assert.deepEqual(p('Отмени встречу сегодня в 18:00'), { action: 'delete', query: '', on: D(10, 14), at: T(18) })
})

test('a reminder is an event with a notification', () => {
  assert.deepEqual(p('Напомни завтра в 10:00 позвонить маме'), {
    action: 'create',
    title: 'Позвонить маме',
    date: D(10, 15),
    time: T(10),
    reminderMin: 0,
  })
  assert.equal((p('Напомни за 30 минут о встрече завтра в 10:00') as { reminderMin?: number }).reminderMin, 30)
})

test('not the calendar: left to the rest of JARVIS', () => {
  for (const s of [
    'Включи камеру',
    'Открой блокнот',
    'Запиши в заметки купить молоко',
    'Поставь будильник на 7 утра',
    'Поставь песню Группа крови',
    'Добавь в список покупок хлеб',
    'Что нового в мире',
    'Пауза',
    'Отмени',
    'Удали файл test.txt',
  ]) {
    assert.equal(p(s), null, s)
  }
})

test('answers to his questions', () => {
  assert.deepEqual(readAnswer('Завтра вечером', C), { date: D(10, 15), part: 'evening' })
  assert.deepEqual(readAnswer('в семь', C), { time: T(19) })
  assert.deepEqual(readAnswer('18:00', C), { time: T(18) })
  assert.deepEqual(readAnswer('Измени время на 19:00', C), { time: T(19) })
  assert.deepEqual(readAnswer('на два часа', C), { durationMin: 120 })
  assert.deepEqual(readAnswer('18 октября в 18:00', C), { date: D(10, 18), time: T(18) })
  assert.equal(readAnswer('расскажи анекдот про программистов', C), null)
})

test('only a plain yes confirms', () => {
  for (const s of ['Да', 'да.', 'Подтверждаю', 'Да, записывай', 'Верно']) assert.equal(confirmAnswer(s), 'yes', s)
  for (const s of ['Нет', 'Отмена', 'Не надо']) assert.equal(confirmAnswer(s), 'no', s)
  for (const s of ['да нет наверное', 'давай подумаем', 'дай подумать', 'а что там завтра']) assert.equal(confirmAnswer(s), null, s)
})

test('lengths: every usual way of saying one is read exactly, the start untouched', () => {
  const at16 = (s: string) => p(`Создай встречу завтра в 16:00 ${s}`) as { time?: unknown; durationMin?: number; durationUnclear?: true; title: string }
  for (const [s, min] of [
    ['на 15 минут', 15], ['на 15 мин', 15], ['на 15 мин.', 15], ['на пятнадцать минут', 15], ['на четверть часа', 15],
    ['длительностью 15 минут', 15], ['продолжительностью 15 минут', 15], ['продолжительностью в 15 минут', 15],
    ['на 30 минут', 30], ['на полчаса', 30], ['на час', 60], ['на полтора часа', 90], ['на 2 часа', 120], ['на два часа', 120],
  ] as const) {
    const r = at16(s)
    assert.deepEqual(r.time, T(16), s)
    assert.equal(r.durationMin, min, s)
    assert.equal(r.durationUnclear, undefined, s)
    assert.equal(r.title, 'Встреча', `${s}: nothing left in the title`)
  }
  assert.equal((p('Создай встречу на 15 минут завтра в 16:00') as { durationMin?: number }).durationMin, 15)
})

test('a length heard but not readable is flagged, not left in the title, and moves no start', () => {
  for (const s of ['Создай встречу завтра в 16:00 15 минут', 'Создай встречу завтра в 16:00, 15 мин']) {
    const r = p(s) as { time?: unknown; durationMin?: number; durationUnclear?: true; title: string }
    assert.deepEqual(r.time, T(16), s)
    assert.equal(r.durationMin, undefined, s)
    assert.equal(r.durationUnclear, true, s)
    assert.equal(r.title, 'Встреча', s)
  }
})

test('times: hours and minutes said in words, written with a dash, or followed by an end', () => {
  // "в 16 часов 15 минут" is 16:15 or 16:00 for 15 minutes (the comma is lost in recognition): flagged, not chosen.
  for (const s of ['Создай встречу завтра в 16 часов 15 минут', 'Создай встречу завтра в 16 часов, 15 минут', 'Создай встречу завтра в 16 15 минут', 'Создай встречу завтра в четыре часа пятнадцать минут']) {
    const r = p(s) as { time?: unknown; durationMin?: number; timeUnclear?: unknown; title: string }
    assert.deepEqual(r.timeUnclear, { hh: 16, mm: 15 }, s)
    assert.equal(r.durationMin, undefined, s)
    assert.equal(r.title, 'Встреча', s)
  }
  // An explicit length or explicit minutes are not in doubt.
  assert.equal((p('Создай встречу завтра в 16 часов на 15 минут') as { timeUnclear?: unknown }).timeUnclear, undefined)
  assert.equal((p('Создай встречу завтра в 16:00 15 минут') as { timeUnclear?: unknown }).timeUnclear, undefined)
  assert.deepEqual((p('Создай встречу завтра в 16-00 на 15 минут') as { time?: unknown }).time, T(16))
  assert.deepEqual((p('Создай встречу завтра в 16 15') as { time?: unknown }).time, T(16, 15), '"шестнадцать пятнадцать" is a time')
  assert.deepEqual(p('Создай встречу завтра в 16:00 до 16:15'), { action: 'create', title: 'Встреча', date: D(10, 15), time: T(16), end: T(16, 15) })
  assert.deepEqual(p('Создай встречу завтра с 23:30 до 00:30'), { action: 'create', title: 'Встреча', date: D(10, 15), time: T(23, 30), end: T(0, 30) })
})

test('the title as named', () => {
  for (const s of [
    'Создай встречу завтра в 16:00 на 15 минут с названием "Проверка календаря"',
    'Создай встречу с названием Проверка календаря завтра в 16:00 на 15 минут',
    'Создай встречу завтра в 16:00 на 15 минут под названием «Проверка календаря»',
  ]) {
    assert.deepEqual(p(s), { action: 'create', title: 'Проверка календаря', date: D(10, 15), time: T(16), durationMin: 15 }, s)
  }
})

test('answers that are a length or an end', () => {
  for (const [s, v] of [
    ['15 минут', { durationMin: 15 }], ['на 15 минут', { durationMin: 15 }], ['полчаса', { durationMin: 30 }], ['2 часа', { durationMin: 120 }],
    ['длительностью 30 минут', { durationMin: 30 }], ['сделай на 15 минут', { durationMin: 15 }], ['до 16:15', { end: T(16, 15) }], ['пусть до 16:45', { end: T(16, 45) }],
  ] as const) assert.deepEqual(readAnswer(s, C), v, s)
  // A time is still a time.
  assert.deepEqual(readAnswer('в 16:15', C), { time: T(16, 15) })
})

test('each write is confirmed by its own word only', () => {
  const ops = ['create', 'move', 'relocate', 'delete'] as const
  const word = { create: 'Записывай', move: 'Переноси', relocate: 'Меняй', delete: 'Удаляй' }
  for (const op of ops) {
    assert.equal(CONFIRM_WORD[op], word[op].toLowerCase())
    for (const s of [word[op], `${word[op]}.`, `Да, ${word[op].toLowerCase()}`, `${word[op]}!`]) assert.equal(confirmFor(s, op), 'yes', `${op}: ${s}`)
    // Agreement that is not this write's word: asked again, never run.
    for (const s of ['Да', 'да.', 'Давай', 'Да, давай', 'Конечно', 'Да, конечно', 'Ага, да', 'Да да', 'Подтверждаю', 'Верно', 'Всё верно']) {
      assert.equal(confirmFor(s, op), 'mismatch', `${op}: ${s}`)
    }
    for (const other of ops.filter((o) => o !== op)) assert.equal(confirmFor(word[other], op), 'mismatch', `${op}: ${word[other]}`)
    for (const s of ['Нет', 'Отмена', 'Не надо', 'Стоп']) assert.equal(confirmFor(s, op), 'no', `${op}: ${s}`)
    // Not an answer at all: the question ends and the phrase is a command of its own.
    for (const s of ['удаляй всё', 'записывай потом', 'а что там завтра', '']) assert.equal(confirmFor(s, op), null, `${op}: ${s}`)
  }
})
