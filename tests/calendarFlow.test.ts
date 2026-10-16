import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCalendarFlow, type CalApi, type CalEvent, type CalResult } from '../src/lib/calendarFlow.ts'

/**
 * A calendar in memory, standing in for the bridge. It records every call, so
 * a test can see that nothing was written before the yes.
 */
function fakeCalendar(
  opts: {
    events?: CalEvent[]
    writes?: boolean
    connected?: boolean
    create?: (n: number) => CalResult | null
    listError?: CalResult
    update?: CalResult
    remove?: CalResult
    /** The calendar's zone, and the offset Google writes its times with. */
    zone?: string
    offset?: string
    /** What Google's answer to a create says, where it differs from what was sent. */
    created?: (ev: CalEvent) => CalEvent
  } = {},
) {
  // Copies: a test that moves an event must not move it for the next test.
  const events = (opts.events ?? []).map((e) => ({ ...e }))
  const calls: Array<[string, unknown]> = []
  let creates = 0
  const off = opts.offset ?? '+03:00'
  const api: CalApi = {
    status: async () => ({ connected: opts.connected ?? true, writes: opts.writes ?? true, timeZone: opts.zone ?? 'Europe/Moscow' }),
    list: async (min, max, query) => {
      calls.push(['list', { min, max, query }])
      if (opts.listError) return opts.listError
      const a = Date.parse(min)
      const b = Date.parse(max)
      return {
        code: 'ok',
        events: events
          .filter((e) => {
            const s = Date.parse(e.start.length === 10 ? `${e.start}T00:00:00+03:00` : e.start)
            return s >= a && s < b
          })
          .sort((x, y) => Date.parse(x.start) - Date.parse(y.start)),
      }
    },
    create: async (e) => {
      calls.push(['create', e])
      const forced = opts.create?.(++creates)
      if (forced) return forced
      const t = (x: { dateTime?: string; date?: string }) => (x.dateTime ? `${x.dateTime}${off}` : x.date!)
      let ev: CalEvent = { id: `jarvis${e.opId}`, summary: e.summary, location: e.location, start: t(e.start), end: t(e.end) }
      if (opts.created) ev = opts.created(ev)
      if (events.some((x) => x.id === ev.id)) return { code: 'ok', event: ev, already: true }
      events.push(ev)
      return { code: 'ok', event: ev }
    },
    update: async (e) => {
      calls.push(['update', e])
      if (opts.update) return opts.update
      const ev = events.find((x) => x.id === e.id)
      if (!ev) return { code: 'not-found' }
      if (e.start?.dateTime) ev.start = `${e.start.dateTime}+03:00`
      if (e.end?.dateTime) ev.end = `${e.end.dateTime}+03:00`
      if (e.location) ev.location = e.location
      return { code: 'ok', event: { ...ev } }
    },
    remove: async (e) => {
      calls.push(['remove', e])
      if (opts.remove) return opts.remove
      const i = events.findIndex((x) => x.id === e.id)
      if (i < 0) return { code: 'not-found' }
      events.splice(i, 1)
      return { code: 'ok' }
    },
  }
  return { api, events, calls, writes: () => calls.filter(([k]) => k !== 'list') }
}

// Wednesday 14 October 2026, 15:36 in Moscow.
const clock = { t: Date.parse('2026-10-14T15:36:00+03:00') }
/** The flow without the page: nothing is ever marked as heard. */
const rawFlow = (cal: ReturnType<typeof fakeCalendar>) => {
  let n = 0
  return createCalendarFlow({ api: cal.api, now: () => new Date(clock.t), opId: () => `op${++n}` })
}
/** The flow as the page drives it: every read-back is spoken to the end, then marked heard. */
const flowWith = (cal: ReturnType<typeof fakeCalendar>) => {
  const f = rawFlow(cal)
  return {
    ...f,
    async handle(text: string) {
      const r = await f.handle(text)
      if (r?.readBack) f.heard(r.readBack)
      return r
    },
  }
}
const reset = () => (clock.t = Date.parse('2026-10-14T15:36:00+03:00'))

const BATONI_TODAY: CalEvent = { id: 'a1', etag: '"e1"', summary: 'Встреча', location: 'ресторан Батони', start: '2026-10-14T18:00:00+03:00', end: '2026-10-14T19:00:00+03:00' }
const BATONI_TOMORROW: CalEvent = { id: 'a2', etag: '"e2"', summary: 'Ужин в Батони', start: '2026-10-15T19:00:00+03:00', end: '2026-10-15T21:00:00+03:00' }
const IVAN: CalEvent = { id: 'b1', etag: '"e3"', summary: 'Встреча с Иваном', start: '2026-10-16T15:00:00+03:00', end: '2026-10-16T16:00:00+03:00' }

// -- creating --------------------------------------------------------------------

test('the main scenario: read back, nothing written, then written on yes and confirmed', async () => {
  reset()
  const cal = fakeCalendar()
  const f = flowWith(cal)
  const ask = await f.handle('Запиши встречу на 18 октября в 18:00, ресторан Батони')
  assert.deepEqual(ask, { say: 'Записать встречу в воскресенье, 18 октября с 18:00 до 19:00 — длительность не названа, ставлю час, ресторан Батони? Скажите «записывай».', expectAnswer: true, readBack: 'op1' })
  assert.equal(cal.writes().length, 0, 'nothing before the yes')
  const done = await f.handle('Записывай')
  assert.equal(done?.say, 'Готово. Встреча записана на воскресенье, 18 октября с 18:00 до 19:00, ресторан Батони.')
  const [, sent] = cal.writes()[0] as [string, Record<string, unknown>]
  assert.deepEqual(sent.start, { dateTime: '2026-10-18T18:00:00' })
  assert.deepEqual(sent.end, { dateTime: '2026-10-18T19:00:00' })
  assert.equal(sent.timeZone, 'Europe/Moscow')
  assert.equal(sent.location, 'ресторан Батони')
})

test('refused: nothing written', async () => {
  reset()
  const cal = fakeCalendar()
  const f = flowWith(cal)
  await f.handle('Запиши встречу завтра в 15:00')
  assert.equal((await f.handle('Нет'))?.say, 'Хорошо, не записываю.')
  assert.equal(await f.handle('Да'), null, 'a later yes belongs to nothing')
  assert.equal(cal.writes().length, 0)
})

test('a correction makes a new draft, read back again; the yes goes to the new one', async () => {
  reset()
  const cal = fakeCalendar()
  const f = flowWith(cal)
  await f.handle('Запиши встречу завтра в 15:00')
  const again = await f.handle('Измени время на 19:00')
  assert.equal(again?.say, 'Записать встречу завтра с 19:00 до 20:00 — длительность не названа, ставлю час? Скажите «записывай».')
  await f.handle('Записывай')
  const [, sent] = cal.writes()[0] as [string, { start: unknown }]
  assert.deepEqual(sent.start, { dateTime: '2026-10-15T19:00:00' })
  assert.equal(cal.writes().length, 1)
  const longer = flowWith(fakeCalendar())
  await longer.handle('Запиши встречу завтра в 15:00')
  assert.equal((await longer.handle('на два часа'))?.say, 'Записать встречу завтра с 15:00 до 17:00? Скажите «записывай».')
})

test('an expired question: the yes does not write', async () => {
  reset()
  const cal = fakeCalendar()
  const f = flowWith(cal)
  await f.handle('Запиши встречу завтра в 15:00')
  clock.t += 31_000
  assert.equal(await f.handle('Записывай'), null)
  assert.equal(cal.writes().length, 0)
})

test('a new command while waiting ends the question; a yes after it writes nothing', async () => {
  reset()
  const cal = fakeCalendar()
  const f = flowWith(cal)
  await f.handle('Запиши встречу завтра в 15:00')
  const list = await f.handle('Что у меня завтра?')
  assert.equal(list?.say, 'Завтра встреч нет.')
  assert.equal(await f.handle('Записывай'), null)
  assert.equal(cal.writes().length, 0)
  // A phrase that is not about the calendar at all also ends it.
  await f.handle('Запиши встречу завтра в 16:00')
  assert.equal(await f.handle('Включи камеру'), null)
  assert.equal(await f.handle('Записывай'), null)
  assert.equal(cal.writes().length, 0)
})

test('a stale confirmation never reaches a different meeting', async () => {
  reset()
  const cal = fakeCalendar()
  const f = flowWith(cal)
  await f.handle('Запиши встречу завтра в 15:00')
  await f.handle('Запиши звонок послезавтра в 11:00')
  await f.handle('Записывай')
  assert.equal(cal.writes().length, 1)
  assert.equal((cal.writes()[0][1] as { summary: string }).summary, 'Звонок')
})

test('missing date and time are asked for, only what is missing', async () => {
  reset()
  const cal = fakeCalendar()
  const f = flowWith(cal)
  assert.equal((await f.handle('Запиши встречу с Иваном'))?.say, 'На какую дату и время записать «Встреча с Иваном»?')
  assert.equal((await f.handle('Завтра вечером'))?.say, 'Во сколько именно?')
  assert.equal((await f.handle('в семь'))?.say, 'Записать «Встреча с Иваном» завтра с 19:00 до 20:00 — длительность не названа, ставлю час? Скажите «записывай».')
  await f.handle('Записывай')
  assert.equal(cal.writes().length, 1)
  assert.equal((await flowWith(fakeCalendar()).handle('Запланируй встречу с клиентом на следующей неделе'))?.say, 'В какой день следующей недели и во сколько?')
})

test('a time already past is not written; a date carried into next year is said', async () => {
  reset()
  const f = flowWith(fakeCalendar())
  assert.match((await f.handle('Запиши встречу сегодня в 10:00'))!.say, /уже прошло/)
  const g = flowWith(fakeCalendar())
  assert.match((await g.handle('Запиши встречу 5 марта в 12:00'))!.say, /5 марта 2027 года .* это 2027 год\?/)
})

test('a twin of an existing meeting is pointed out before writing', async () => {
  reset()
  const twin: CalEvent = { id: 'x', summary: 'Встреча', start: '2026-10-15T15:00:00+03:00', end: '2026-10-15T16:00:00+03:00' }
  const f = flowWith(fakeCalendar({ events: [twin] }))
  assert.match((await f.handle('Запиши встречу завтра в 15:00'))!.say, /уже есть в календаре/)
})

test('writes disabled, or not connected: said so, no draft', async () => {
  reset()
  const off = fakeCalendar({ writes: false })
  assert.match((await flowWith(off).handle('Запиши встречу завтра в 15:00'))!.say, /JARVIS_CALENDAR_WRITES=1/)
  assert.equal(off.writes().length, 0)
  assert.match((await flowWith(fakeCalendar({ connected: false })).handle('Что у меня сегодня?'))!.say, /не подключён/)
  // Reading still works with writes off.
  assert.equal((await flowWith(fakeCalendar({ writes: false })).handle('Что у меня сегодня?'))?.say, 'Сегодня встреч нет.')
})

test('an answer that never came: said honestly, and a second yes reuses the same id — no twin', async () => {
  reset()
  const cal = fakeCalendar({ create: (n) => (n === 1 ? { code: 'unknown' } : null) })
  const f = flowWith(cal)
  await f.handle('Запиши встречу завтра в 15:00')
  const first = await f.handle('Записывай')
  assert.match(first!.say, /Не удалось проверить результат.*«записывай» ещё раз/)
  assert.equal(first!.expectAnswer, true)
  const second = await f.handle('Записывай')
  assert.match(second!.say, /^Готово/)
  const ids = cal.writes().map(([, e]) => (e as { opId: string }).opId)
  assert.deepEqual(ids, ['op1', 'op1'], 'the same operation, both times')
})

test('a failed write is said, never as success', async () => {
  reset()
  const f = flowWith(fakeCalendar({ create: () => ({ code: 'network' }) }))
  await f.handle('Запиши встречу завтра в 15:00')
  assert.equal((await f.handle('Записывай'))?.say, 'Не удалось подключиться к календарю — ничего не изменено.')
  const g = flowWith(fakeCalendar({ create: () => ({ code: 'auth' }) }))
  await g.handle('Запиши встречу завтра в 15:00')
  assert.match((await g.handle('Записывай'))!.say, /заново подключить/)
})

// -- reading ----------------------------------------------------------------------

test('what is on: by time, with places; none; many, with the rest offered', async () => {
  reset()
  const f = flowWith(fakeCalendar({ events: [BATONI_TODAY, BATONI_TOMORROW, IVAN] }))
  assert.equal((await f.handle('Что у меня сегодня?'))?.say, 'Сегодня 1 встреча: в 18:00 — Встреча, ресторан Батони.')
  assert.equal((await f.handle('Что у меня 18 октября?'))?.say, 'В воскресенье, 18 октября встреч нет.')
  assert.equal(
    (await f.handle('Какие встречи на этой неделе?'))?.say,
    'На этой неделе 3 встречи: сегодня в 18:00 — Встреча, ресторан Батони; завтра в 19:00 — Ужин в Батони; послезавтра в 15:00 — Встреча с Иваном.',
  )
  const many = Array.from({ length: 7 }, (_, i): CalEvent => ({ id: `m${i}`, summary: `Дело ${i + 1}`, start: `2026-10-15T${10 + i}:00:00+03:00`, end: `2026-10-15T${10 + i}:30:00+03:00` }))
  const g = flowWith(fakeCalendar({ events: many }))
  const first = await g.handle('Что у меня завтра?')
  assert.match(first!.say, /^Завтра 7 встреч: .*Дело 5\. И ещё 2\. Продолжить\?$/)
  assert.equal((await g.handle('Да'))?.say, 'завтра в 15:00 — Дело 6; завтра в 16:00 — Дело 7.')
})

test('the next meeting, and when a named one is', async () => {
  reset()
  const f = flowWith(fakeCalendar({ events: [BATONI_TODAY, IVAN] }))
  assert.equal((await f.handle('Когда у меня следующая встреча?'))?.say, 'Следующая встреча — Встреча, сегодня в 18:00, ресторан Батони.')
  assert.equal((await f.handle('Во сколько встреча с Иваном?'))?.say, 'Встреча с Иваном — послезавтра в 15:00.')
  assert.equal((await f.handle('Во сколько встреча с Петром?'))?.say, 'Не нашёл такую встречу.')
})

test('a calendar that cannot be reached: said, and JARVIS goes on', async () => {
  reset()
  const f = flowWith(fakeCalendar({ listError: { code: 'network' } }))
  assert.equal((await f.handle('Что у меня сегодня?'))?.say, 'Не удалось подключиться к календарю.')
  assert.equal(await f.handle('Включи камеру'), null)
})

// -- changing ----------------------------------------------------------------------

test('two matches: asked which, nothing changed; "завтрашнюю" picks one; a new time keeps its day', async () => {
  reset()
  const cal = fakeCalendar({ events: [BATONI_TODAY, BATONI_TOMORROW] })
  const f = flowWith(cal)
  const which = await f.handle('Перенеси встречу с Батони на 20:00')
  assert.equal(which?.say, 'Я нашёл 2 встречи с Батони: сегодня в 18:00, завтра в 19:00. Какую перенести?')
  assert.equal(cal.writes().length, 0)
  assert.equal((await f.handle('Завтрашнюю'))?.say, 'Перенести «Ужин в Батони», завтра в 19:00, на завтра в 20:00? Скажите «переноси».')
  assert.equal((await f.handle('Переноси'))?.say, 'Готово. Перенёс «Ужин в Батони» на завтра в 20:00.')
  const [, sent] = cal.writes()[0] as [string, { id: string; etag: string; start: unknown; end: unknown }]
  assert.equal(sent.id, 'a2')
  assert.equal(sent.etag, '"e2"', 'sent with the version it was read at')
  assert.deepEqual(sent.start, { dateTime: '2026-10-15T20:00:00' })
  assert.deepEqual(sent.end, { dateTime: '2026-10-15T22:00:00' }, 'its two hours kept')
})

test('moving to another day keeps the time; a shift moves both', async () => {
  reset()
  const f = flowWith(fakeCalendar({ events: [IVAN] }))
  assert.equal((await f.handle('Перенеси встречу с Иваном на завтра'))?.say, 'Перенести «Встреча с Иваном», послезавтра в 15:00, на завтра в 15:00? Скажите «переноси».')
  const g = flowWith(fakeCalendar({ events: [BATONI_TODAY] }))
  assert.equal((await g.handle('Поставь встречу на час позже'))?.say, 'Перенести встречу, сегодня в 18:00, на сегодня в 19:00? Скажите «переноси».')
})

test('a change that loses a race with another edit is said as a conflict', async () => {
  reset()
  const f = flowWith(fakeCalendar({ events: [IVAN], update: { code: 'conflict' } }))
  await f.handle('Перенеси встречу с Иваном на 17:00')
  assert.match((await f.handle('Переноси'))!.say, /только что изменили/)
})

test('changing the place: asked for it, then read back', async () => {
  reset()
  const cal = fakeCalendar({ events: [BATONI_TODAY] })
  const f = flowWith(cal)
  assert.equal((await f.handle('Измени место встречи с Батони'))?.say, 'Какое новое место?')
  assert.equal((await f.handle('кафе Пушкин'))?.say, 'Изменить место встречи сегодня в 18:00 на «кафе Пушкин»? Скажите «меняй».')
  await f.handle('Меняй')
  assert.equal((cal.writes()[0][1] as { location: string }).location, 'кафе Пушкин')
})

test('deleting: read back with its day and time, removed on yes; already gone is said', async () => {
  reset()
  const cal = fakeCalendar({ events: [BATONI_TODAY] })
  const f = flowWith(cal)
  assert.equal((await f.handle('Отмени встречу с Батони'))?.say, 'Удалить встречу сегодня в 18:00? Скажите «удаляй».')
  assert.equal(cal.writes().length, 0)
  assert.equal((await f.handle('Удаляй'))?.say, 'Готово. Удалил встречу сегодня в 18:00.')
  assert.equal(cal.events.length, 0)
  const again = flowWith(fakeCalendar({ events: [BATONI_TODAY], remove: { code: 'not-found' } }))
  await again.handle('Отмени встречу сегодня в 18:00')
  assert.match((await again.handle('Удаляй'))!.say, /не нашёл/i)
})

// -- confirmations: each write by its own word -----------------------------------

const DRAFTS: Array<{ op: string; events: CalEvent[]; say: string; word: string; others: string[] }> = [
  { op: 'create', events: [], say: 'Запиши встречу завтра в 15:00', word: 'Записывай', others: ['Переноси', 'Меняй', 'Удаляй'] },
  { op: 'move', events: [IVAN], say: 'Перенеси встречу с Иваном на 17:00', word: 'Переноси', others: ['Записывай', 'Меняй', 'Удаляй'] },
  { op: 'relocate', events: [BATONI_TODAY], say: 'Измени место встречи с Батони на кафе Пушкин', word: 'Меняй', others: ['Записывай', 'Переноси', 'Удаляй'] },
  { op: 'delete', events: [BATONI_TODAY], say: 'Отмени встречу с Батони', word: 'Удаляй', others: ['Записывай', 'Переноси', 'Меняй'] },
]

for (const d of DRAFTS) {
  test(`${d.op}: a plain yes, "давай", "конечно" and other writes' words run nothing; its own word does`, async () => {
    reset()
    const cal = fakeCalendar({ events: d.events })
    const f = flowWith(cal)
    const ask = await f.handle(d.say)
    assert.ok(ask?.say.endsWith(`Скажите «${d.word.toLowerCase()}».`), ask?.say)
    for (const s of ['Да', 'да.', 'Давай', 'Конечно', 'Да, конечно', 'Подтверждаю', 'Верно', ...d.others]) {
      const r = await f.handle(s)
      assert.equal(r?.expectAnswer, true, `${s}: asked again`)
      assert.match(r!.say, new RegExp(`скажите «${d.word.toLowerCase()}»`), s)
      assert.equal(cal.writes().length, 0, `${s}: nothing written`)
    }
    assert.match((await f.handle(d.word))!.say, /^Готово/)
    assert.equal(cal.writes().length, 1)
    assert.equal(cal.writes()[0][0], d.op === 'move' || d.op === 'relocate' ? 'update' : d.op === 'delete' ? 'remove' : 'create')
  })
}

test('asking again does not extend the 30 seconds: the right word after them runs nothing', async () => {
  reset()
  const cal = fakeCalendar({ events: [BATONI_TODAY] })
  const f = flowWith(cal)
  await f.handle('Отмени встречу с Батони')
  clock.t += 20_000
  assert.equal((await f.handle('Да'))?.expectAnswer, true)
  clock.t += 11_000 // 31 s after the read-back, 11 s after asking again
  assert.equal(f.waiting(), false)
  assert.equal(await f.handle('Удаляй'), null)
  assert.equal(cal.writes().length, 0)
  assert.equal(cal.events.length, 1, 'the meeting is still there')
})

test('the right word inside the 30 seconds still works after asking again', async () => {
  reset()
  const cal = fakeCalendar({ events: [IVAN] })
  const f = flowWith(cal)
  await f.handle('Перенеси встречу с Иваном на 17:00')
  clock.t += 10_000
  await f.handle('Да')
  clock.t += 19_000
  assert.match((await f.handle('Переноси'))!.say, /^Готово/)
  assert.equal(cal.writes().length, 1)
})

test('a correction is a new draft with its own read-back and its own 30 seconds; the old draft is not run', async () => {
  reset()
  const cal = fakeCalendar()
  const f = flowWith(cal)
  await f.handle('Запиши встречу завтра в 15:00')
  clock.t += 25_000
  assert.equal((await f.handle('Измени время на 19:00'))?.say, 'Записать встречу завтра с 19:00 до 20:00 — длительность не названа, ставлю час? Скажите «записывай».')
  clock.t += 25_000
  await f.handle('Записывай')
  assert.equal(cal.writes().length, 1)
  const [, sent] = cal.writes()[0] as [string, { opId: string; start: unknown }]
  assert.deepEqual(sent.start, { dateTime: '2026-10-15T19:00:00' })
  assert.equal(sent.opId, 'op2', 'the corrected draft, not the first')
})

test('the write carries exactly the draft that was read back', async () => {
  reset()
  const cal = fakeCalendar({ events: [BATONI_TODAY, BATONI_TOMORROW] })
  const f = flowWith(cal)
  await f.handle('Перенеси встречу с Батони на 20:00')
  await f.handle('Завтрашнюю')
  // The calendar's own copy changes after the read-back; the write does not follow it.
  cal.events.find((e) => e.id === 'a2')!.etag = '"changed"'
  await f.handle('Переноси')
  const [, sent] = cal.writes()[0] as [string, { id: string; etag: string }]
  assert.equal(sent.id, 'a2')
  assert.equal(sent.etag, '"e2"', 'the version read out, so a change made meanwhile is a conflict')
})

test('a delete whose answer never came: asked again for «удаляй», not for a plain yes', async () => {
  reset()
  const cal = fakeCalendar({ events: [BATONI_TODAY], remove: { code: 'unknown' } })
  const f = flowWith(cal)
  await f.handle('Отмени встречу с Батони')
  const first = await f.handle('Удаляй')
  assert.match(first!.say, /«удаляй» ещё раз/)
  assert.equal((await f.handle('Да'))?.expectAnswer, true)
  assert.equal(cal.writes().length, 1, 'a plain yes does not send it again')
})

test('no once asked again still refuses', async () => {
  reset()
  const cal = fakeCalendar({ events: [BATONI_TODAY] })
  const f = flowWith(cal)
  await f.handle('Отмени встречу с Батони')
  await f.handle('Да')
  assert.equal((await f.handle('Нет'))?.say, 'Хорошо, не удаляю.')
  assert.equal(await f.handle('Удаляй'), null)
  assert.equal(cal.writes().length, 0)
})

// -- lengths, ends, zones: what is said is what is written ---------------------------

type Sent = { opId: string; summary: string; timeZone: string; start: { dateTime?: string; date?: string }; end: { dateTime?: string; date?: string } }
const sent = (cal: ReturnType<typeof fakeCalendar>, i = 0) => cal.writes()[i][1] as Sent

/** Say the command, check the read-back, confirm with «записывай», return what was sent and said. */
async function createVia(phrase: string, readBack: string, opts: Parameters<typeof fakeCalendar>[0] = {}) {
  const cal = fakeCalendar(opts)
  const f = flowWith(cal)
  assert.equal((await f.handle(phrase))?.say, readBack)
  assert.equal(cal.writes().length, 0, 'nothing before the confirmation')
  const done = await f.handle('Записывай')
  assert.equal(cal.writes().length, 1)
  return { cal, f, done: done!.say, sent: sent(cal) }
}

test('the reported case: "завтра в 16:00 на 15 минут" is 16:00–16:15, not an hour, not 16:15', async () => {
  reset()
  const cal = fakeCalendar()
  const f = flowWith(cal)
  assert.equal((await f.handle('Создай встречу завтра в 16:00 на 15 минут'))?.say, 'Записать встречу завтра с 16:00 до 16:15? Скажите «записывай».')
  // A plain yes does nothing.
  assert.match((await f.handle('Да'))!.say, /скажите «записывай»/)
  assert.equal(cal.writes().length, 0)
  assert.equal((await f.handle('Записывай'))?.say, 'Готово. Встреча записана на завтра с 16:00 до 16:15.')
  assert.deepEqual(sent(cal).start, { dateTime: '2026-10-15T16:00:00' })
  assert.deepEqual(sent(cal).end, { dateTime: '2026-10-15T16:15:00' })
  assert.equal(sent(cal).timeZone, 'Europe/Moscow')
})

test('a length said any usual way is kept exactly: 15 and 30 minutes, 2 hours', async () => {
  const cases: Array<[string, string, string]> = [
    ['Создай встречу завтра в 16:00 на 15 мин', '16:15', 'с 16:00 до 16:15'],
    ['Создай встречу завтра в 16:00 длительностью 15 минут', '16:15', 'с 16:00 до 16:15'],
    ['Создай встречу завтра в 16:00 на четверть часа', '16:15', 'с 16:00 до 16:15'],
    ['Создай встречу завтра в 16:00 на 30 минут', '16:30', 'с 16:00 до 16:30'],
    ['Создай встречу завтра в 16:00 на полчаса', '16:30', 'с 16:00 до 16:30'],
    ['Создай встречу завтра в 16:00 на 2 часа', '18:00', 'с 16:00 до 18:00'],
    ['Создай встречу завтра в 16:00 продолжительностью два часа', '18:00', 'с 16:00 до 18:00'],
    ['Создай встречу на 15 минут завтра в 16:00', '16:15', 'с 16:00 до 16:15'],
    ['Создай встречу завтра в 16-00 на 15 минут', '16:15', 'с 16:00 до 16:15'],
  ]
  for (const [phrase, end, range] of cases) {
    reset()
    const r = await createVia(phrase, `Записать встречу завтра ${range}? Скажите «записывай».`)
    assert.deepEqual(r.sent.start, { dateTime: '2026-10-15T16:00:00' }, phrase)
    assert.deepEqual(r.sent.end, { dateTime: `2026-10-15T${end}:00` }, phrase)
    assert.equal(r.done, `Готово. Встреча записана на завтра ${range}.`, phrase)
  }
})

test('an end said outright is the end: "с 16:00 до 16:45", "в 16:00 до 16:15"', async () => {
  reset()
  const a = await createVia('Создай встречу завтра с 16:00 до 16:45', 'Записать встречу завтра с 16:00 до 16:45? Скажите «записывай».')
  assert.deepEqual([a.sent.start, a.sent.end], [{ dateTime: '2026-10-15T16:00:00' }, { dateTime: '2026-10-15T16:45:00' }])
  reset()
  const b = await createVia('Создай встречу завтра в 16:00 до 16:15', 'Записать встречу завтра с 16:00 до 16:15? Скажите «записывай».')
  assert.deepEqual(b.sent.end, { dateTime: '2026-10-15T16:15:00' })
})

test('no length named: the default hour, its end said and the default said as such', async () => {
  reset()
  const r = await createVia('Создай встречу завтра в 16:00', 'Записать встречу завтра с 16:00 до 17:00 — длительность не названа, ставлю час? Скажите «записывай».')
  assert.deepEqual(r.sent.end, { dateTime: '2026-10-15T17:00:00' })
})

test('a length heard but not understood is asked for — never the default hour, never the start moved', async () => {
  reset()
  const cal = fakeCalendar()
  const f = flowWith(cal)
  assert.match((await f.handle('Создай встречу завтра в 16:00 15 минут'))!.say, /^Не понял длительность/)
  assert.equal((await f.handle('15 минут'))?.say, 'Записать встречу завтра с 16:00 до 16:15? Скажите «записывай».')
  await f.handle('Записывай')
  assert.deepEqual([sent(cal).start, sent(cal).end], [{ dateTime: '2026-10-15T16:00:00' }, { dateTime: '2026-10-15T16:15:00' }])
})

// The reported repeat: "завтра в 17:00, 15 минут" reaches the page as "в 17 часов 15 минут" —
// the comma is gone, and the words also mean 17:15. It was read as 17:15 for the default hour
// and written 17:15–18:15. Now neither is chosen: both are asked for, and nothing is read back
// or written until they are said.
test('the repeat: "в 17 часов 15 минут" is never 17:15–18:15 — start and length are asked for', async () => {
  for (const phrase of ['Создай встречу завтра в 17 часов 15 минут', 'Создай встречу завтра в 17 часов, 15 минут', 'Создай встречу завтра в 17 15 минут', 'Создай встречу завтра в семнадцать часов пятнадцать минут']) {
    reset()
    const cal = fakeCalendar()
    const f = flowWith(cal)
    const q = await f.handle(phrase)
    assert.equal(q?.say, 'Не понял: начало в 17:15 или в 17:00 на 15 минут? Скажите начало и длительность, например: «в 17:00 на 15 минут».', phrase)
    assert.equal(q?.readBack, undefined, 'a question, not a read-back: nothing to confirm')
    assert.equal((await f.handle('Записывай'))?.say.startsWith('Готово') ?? false, false, `${phrase}: no write on «записывай» here`)
    assert.equal(cal.writes().length, 0, phrase)
  }
  // Answered with both: exactly that, read back, then written.
  reset()
  const cal = fakeCalendar()
  const f = flowWith(cal)
  await f.handle('Создай встречу завтра в 17 часов 15 минут')
  assert.equal((await f.handle('в 17:00 на 15 минут'))?.say, 'Записать встречу завтра с 17:00 до 17:15? Скажите «записывай».')
  assert.equal((await f.handle('Записывай'))?.say, 'Готово. Встреча записана на завтра с 17:00 до 17:15.')
  assert.deepEqual([sent(cal).start, sent(cal).end], [{ dateTime: '2026-10-15T17:00:00' }, { dateTime: '2026-10-15T17:15:00' }])
  // Answered with a start only: the length is still asked for, not defaulted.
  reset()
  const g = flowWith(fakeCalendar())
  await g.handle('Создай встречу завтра в 17 часов 15 минут')
  assert.match((await g.handle('в 17:15'))!.say, /^Не понял длительность/)
  assert.equal((await g.handle('на час'))?.say, 'Записать встречу завтра с 17:15 до 18:15? Скажите «записывай».')
})

test('the title as named: «с названием "Проверка календаря"»', async () => {
  reset()
  const r = await createVia(
    'Создай встречу завтра в 16:00 на 15 минут с названием "Проверка календаря"',
    'Записать «Проверка календаря» завтра с 16:00 до 16:15? Скажите «записывай».',
  )
  assert.equal(r.sent.summary, 'Проверка календаря')
  assert.equal(r.done, 'Готово. Записал «Проверка календаря» на завтра с 16:00 до 16:15.')
})

test('past midnight: the end falls on the next day, and is said so', async () => {
  reset()
  const r = await createVia('Создай встречу завтра в 23:30 на час', 'Записать встречу завтра с 23:30 до 0:30 следующего дня? Скажите «записывай».')
  assert.deepEqual([r.sent.start, r.sent.end], [{ dateTime: '2026-10-15T23:30:00' }, { dateTime: '2026-10-16T00:30:00' }])
  reset()
  const s = await createVia('Создай встречу завтра с 23:45 до 00:15', 'Записать встречу завтра с 23:45 до 0:15 следующего дня? Скажите «записывай».')
  assert.deepEqual(s.sent.end, { dateTime: '2026-10-16T00:15:00' })
  assert.equal(s.done, 'Готово. Встреча записана на завтра с 23:45 до 0:15 следующего дня.')
})

test('Europe/Kiev: "завтра" is the calendar\'s tomorrow, the time goes as wall-clock with the zone, and reads back unchanged', async () => {
  // 01:30 on 15 October in Kyiv is still 14 October in UTC: "завтра" is the 16th.
  clock.t = Date.parse('2026-10-14T22:30:00Z')
  const r = await createVia('Создай встречу завтра в 16:00 на 15 минут', 'Записать встречу завтра с 16:00 до 16:15? Скажите «записывай».', { zone: 'Europe/Kiev' })
  assert.equal(r.sent.timeZone, 'Europe/Kiev')
  assert.deepEqual([r.sent.start, r.sent.end], [{ dateTime: '2026-10-16T16:00:00' }, { dateTime: '2026-10-16T16:15:00' }])
  assert.equal(r.done, 'Готово. Встреча записана на завтра с 16:00 до 16:15.')
  // Read back by the list, the same wall-clock times.
  assert.equal((await r.f.handle('Что у меня завтра?'))?.say, 'Завтра 1 встреча: в 16:00 — Встреча.')
  reset()
})

test('Europe/Kiev after the clocks change (+02:00): no hour lost or gained', async () => {
  reset()
  const r = await createVia('Создай встречу 28 октября в 16:00 на 15 минут', 'Записать встречу 28 октября с 16:00 до 16:15? Скажите «записывай».', { zone: 'Europe/Kiev', offset: '+02:00' })
  assert.deepEqual([r.sent.start, r.sent.end], [{ dateTime: '2026-10-28T16:00:00' }, { dateTime: '2026-10-28T16:15:00' }])
  assert.equal(r.done, 'Готово. Встреча записана на 28 октября с 16:00 до 16:15.')
})

test('the answer is the calendar\'s own start and end, compared as moments whatever offset they come in', async () => {
  reset()
  // Google writes the same moment in UTC: still confirmed, said in the calendar's zone.
  const utc = await createVia('Создай встречу завтра в 16:00 на 15 минут', 'Записать встречу завтра с 16:00 до 16:15? Скажите «записывай».', {
    created: (ev) => ({ ...ev, start: '2026-10-15T13:00:00Z', end: '2026-10-15T13:15:00Z' }),
  })
  assert.equal(utc.done, 'Готово. Встреча записана на завтра с 16:00 до 16:15.')
  // With no offset at all, read in the calendar's zone — not the browser's.
  reset()
  const bare = await createVia('Создай встречу завтра в 16:00 на 15 минут', 'Записать встречу завтра с 16:00 до 16:15? Скажите «записывай».', {
    zone: 'Europe/Kiev',
    created: (ev) => ({ ...ev, start: '2026-10-15T16:00:00', end: '2026-10-15T16:15:00' }),
  })
  assert.equal(bare.done, 'Готово. Встреча записана на завтра с 16:00 до 16:15.')
  // The calendar kept other times: said plainly, not as done.
  reset()
  const off = await createVia('Создай встречу завтра в 16:00 на 15 минут', 'Записать встречу завтра с 16:00 до 16:15? Скажите «записывай».', {
    created: (ev) => ({ ...ev, start: '2026-10-15T16:15:00+03:00', end: '2026-10-15T17:15:00+03:00' }),
  })
  assert.equal(off.done, 'Встреча записана, но календарь сохранил другое время: на завтра с 16:15 до 17:15. Проверьте событие в календаре.')
  // No times in the answer: not claimed.
  reset()
  const none = await createVia('Создай встречу завтра в 16:00 на 15 минут', 'Записать встречу завтра с 16:00 до 16:15? Скажите «записывай».', { create: () => ({ code: 'ok' }) })
  assert.match(none.done, /не вернул время события/)
  assert.doesNotMatch(none.done, /^Готово/)
})

test('a changed length or end after the read-back: a new draft, read back again; the old one never runs', async () => {
  reset()
  const cal = fakeCalendar()
  const f = flowWith(cal)
  await f.handle('Создай встречу завтра в 16:00 на 15 минут')
  assert.equal((await f.handle('на 30 минут'))?.say, 'Записать встречу завтра с 16:00 до 16:30? Скажите «записывай».')
  assert.equal((await f.handle('до 16:45'))?.say, 'Записать встречу завтра с 16:00 до 16:45? Скажите «записывай».')
  // A new time keeps the length that was read back.
  assert.equal((await f.handle('в 17:00'))?.say, 'Записать встречу завтра с 17:00 до 17:45? Скажите «записывай».')
  await f.handle('Записывай')
  assert.equal(cal.writes().length, 1)
  assert.equal(sent(cal).opId, 'op4', 'the last draft')
  assert.deepEqual([sent(cal).start, sent(cal).end], [{ dateTime: '2026-10-15T17:00:00' }, { dateTime: '2026-10-15T17:45:00' }])
  // A new name is a new command: the old draft is dropped, the new one read back.
  reset()
  const g = fakeCalendar()
  const h = flowWith(g)
  await h.handle('Создай встречу завтра в 16:00 на 15 минут')
  assert.equal((await h.handle('Создай звонок завтра в 16:00 на 15 минут'))?.say, 'Записать «Звонок» завтра с 16:00 до 16:15? Скажите «записывай».')
  await h.handle('Записывай')
  assert.deepEqual(g.writes().map(([, e]) => (e as Sent).summary), ['Звонок'])
})

test('cancelled: "отмена" ends it, and a later «записывай» belongs to nothing', async () => {
  reset()
  const cal = fakeCalendar()
  const f = flowWith(cal)
  await f.handle('Создай встречу завтра в 16:00 на 15 минут')
  assert.equal((await f.handle('Отмена'))?.say, 'Хорошо, не записываю.')
  assert.equal(await f.handle('Записывай'), null)
  assert.equal(cal.writes().length, 0)
})

test('done once: a second «записывай» after success writes nothing; a twin the calendar already has is said as such', async () => {
  reset()
  const cal = fakeCalendar()
  const f = flowWith(cal)
  await f.handle('Создай встречу завтра в 16:00 на 15 минут')
  await f.handle('Записывай')
  assert.equal(await f.handle('Записывай'), null)
  assert.equal(cal.writes().length, 1)
  reset()
  const again = await createVia('Создай встречу завтра в 16:00 на 15 минут', 'Записать встречу завтра с 16:00 до 16:15? Скажите «записывай».', {
    create: () => ({ code: 'ok', already: true, event: { id: 'jarvisop1', summary: 'Встреча', start: '2026-10-15T16:00:00+03:00', end: '2026-10-15T16:15:00+03:00' } }),
  })
  assert.equal(again.done, 'Готово. Эта встреча уже была записана на завтра с 16:00 до 16:15.')
})

test('Google refusing: each said as what it is, never as done', async () => {
  const cases: Array<[CalResult, RegExp]> = [
    [{ code: 'rate' }, /ограничил число запросов/],
    [{ code: 'forbidden' }, /нет доступа/],
    [{ code: 'auth' }, /заново подключить/],
    [{ code: 'network' }, /ничего не изменено/],
    [{ code: 'writes-disabled' }, /JARVIS_CALENDAR_WRITES=1/],
    [{ code: 'failed', message: 'неверное время' }, /неверное время/],
  ]
  for (const [answer, said] of cases) {
    reset()
    const r = await createVia('Создай встречу завтра в 16:00 на 15 минут', 'Записать встречу завтра с 16:00 до 16:15? Скажите «записывай».', { create: () => answer })
    assert.match(r.done, said, answer.code)
    assert.doesNotMatch(r.done, /^Готово/, answer.code)
  }
})

// -- the confirmation is given to a read-back that was heard -------------------------

test('no write without the read-back spoken first: «записывай» over it, or after it was cut off, says it again', async () => {
  reset()
  const cal = fakeCalendar()
  const f = rawFlow(cal) // the page never reports the read-back as heard
  const q = await f.handle('Создай встречу завтра в 17:00 на 15 минут')
  assert.equal(q?.readBack, 'op1')
  const again = await f.handle('Записывай')
  assert.equal(again?.say, 'Сначала дослушайте. Записать встречу завтра с 17:00 до 17:15? Скажите «записывай».')
  assert.equal(again?.readBack, 'op1')
  assert.equal(cal.writes().length, 0, 'nothing written')
  // Heard now: the word works — inside the same 30 seconds, not new ones.
  f.heard('op1')
  assert.match((await f.handle('Записывай'))!.say, /^Готово/)
  assert.equal(cal.writes().length, 1)
  // An old read-back's mark does not count for a new one.
  reset()
  const g = fakeCalendar()
  const h = rawFlow(g)
  await h.handle('Создай встречу завтра в 16:00 на 15 минут')
  h.heard('op1')
  await h.handle('Создай встречу завтра в 17:00 на 15 минут')
  h.heard('op1')
  assert.match((await h.handle('Записывай'))!.say, /^Сначала дослушайте/)
  assert.equal(g.writes().length, 0)
})

test('the repeated read-back keeps the first deadline', async () => {
  reset()
  const cal = fakeCalendar()
  const f = rawFlow(cal)
  await f.handle('Создай встречу завтра в 17:00 на 15 минут')
  clock.t += 25_000
  await f.handle('Записывай') // not heard: said again
  f.heard('op1')
  clock.t += 6_000 // 31 s after the first read-back
  assert.equal(await f.handle('Записывай'), null)
  assert.equal(cal.writes().length, 0)
})

// -- the phrase, read a second time, against the draft ----------------------------------

test('the old dialog state is not reused: a new command replaces a waiting draft, whatever was asked before', async () => {
  reset()
  const cal = fakeCalendar()
  const f = flowWith(cal)
  // A read-back for 16:00 for an hour is waiting; the user says the meeting again, properly.
  await f.handle('Создай встречу завтра в 16:00')
  assert.equal((await f.handle('Создай встречу завтра в 17:00 на 15 минут'))?.say, 'Записать встречу завтра с 17:00 до 17:15? Скажите «записывай».')
  await f.handle('Записывай')
  assert.deepEqual(cal.writes().map(([, e]) => [(e as Sent).start, (e as Sent).end]), [[{ dateTime: '2026-10-15T17:00:00' }, { dateTime: '2026-10-15T17:15:00' }]])
  // A question about the length of an earlier meeting does not lend it to a new command.
  reset()
  const g = fakeCalendar()
  const h = flowWith(g)
  await h.handle('Создай встречу завтра в 16:00 15 минут') // asks for the length
  assert.equal((await h.handle('Создай встречу завтра в 17:00 на 30 минут'))?.say, 'Записать встречу завтра с 17:00 до 17:30? Скажите «записывай».')
  // And after a meeting is written, nothing of it carries into the next.
  await h.handle('Записывай')
  assert.equal((await h.handle('Создай встречу завтра в 18:00'))?.say, 'Записать встречу завтра с 18:00 до 19:00 — длительность не названа, ставлю час? Скажите «записывай».')
})

test('the same request twice in a row gives the same draft — no shift from one run to the next', async () => {
  reset()
  const cal = fakeCalendar()
  const f = flowWith(cal)
  for (let i = 0; i < 3; i++) {
    assert.equal((await f.handle('Создай встречу завтра в 17:00 на 15 минут'))?.say, 'Записать встречу завтра с 17:00 до 17:15? Скажите «записывай».', `run ${i + 1}`)
    assert.equal((await f.handle('Нет'))?.say, 'Хорошо, не записываю.')
  }
  assert.equal(cal.writes().length, 0)
})

test('Europe/Kiev, the reported request: 17:00 for 15 minutes, start and end unshifted', async () => {
  reset()
  const r = await createVia('Создай встречу завтра в 17:00 продолжительностью 15 минут', 'Записать встречу завтра с 17:00 до 17:15? Скажите «записывай».', { zone: 'Europe/Kiev' })
  assert.deepEqual([r.sent.start, r.sent.end, r.sent.timeZone], [{ dateTime: '2026-10-15T17:00:00' }, { dateTime: '2026-10-15T17:15:00' }, 'Europe/Kiev'])
  assert.equal(r.done, 'Готово. Встреча записана на завтра с 17:00 до 17:15.')
})

test('the flow stops a draft the parser got wrong: two times said, one kept — not read back, not written', async () => {
  reset()
  const cal = fakeCalendar()
  const f = flowWith(cal)
  // The parser keeps 17:00 and leaves "18:00" in the title; the second reading sees 18:00 said.
  const q = await f.handle('Создай встречу завтра в 17:00 на 15 минут в 18:00')
  assert.match(q!.say, /^Не записываю: в запросе 18:00, а в записи 17:00–17:15/)
  assert.equal(q?.readBack, undefined)
  assert.equal(await f.handle('Записывай').then((r) => r?.say.startsWith('Готово') ?? false), false)
  assert.equal(cal.writes().length, 0)
})

test('a draft that does not match the phrase is never read back, and never written', async () => {
  // The second reading is independent of the parser: give it drafts the parser would not make.
  const { mismatch } = await import('../src/lib/calendarCheck.ts')
  const d = (hh: number, mm: number, dur: number, deflt = false) => {
    const e = hh * 60 + mm + dur
    return { start: { hh, mm }, end: { hh: Math.floor(e / 60) % 24, mm: e % 60 }, durationMin: dur, defaultLength: deflt }
  }
  // The reported cases, as drafts: each is caught.
  assert.match(mismatch('Создай встречу завтра в 17:00 на 15 минут', d(17, 15, 60))!, /17:00/)
  assert.match(mismatch('Создай встречу завтра в 17:00 продолжительностью 15 минут', d(17, 0, 60, true))!, /стандартный час/)
  assert.match(mismatch('Создай встречу завтра в 16:00 на 15 минут', d(16, 0, 60))!, /15 мин/)
  assert.match(mismatch('в 17 часов 15 минут', d(17, 15, 60, true))!, /15 мин/)
  assert.match(mismatch('завтра в семнадцать ноль ноль на пятнадцать минут', d(17, 0, 60))!, /15 мин/)
  assert.match(mismatch('в 18 часов на 2 часа', d(17, 0, 120))!, /18 часов/)
  // What was said, carried: nothing to say.
  for (const [s, draft] of [
    ['Создай встречу завтра в 17:00 на 15 минут', d(17, 0, 15)],
    ['Создай встречу завтра с 16:00 до 16:45', d(16, 0, 45)],
    ['Создай встречу завтра с 23:45 до 00:15', d(23, 45, 30)],
    ['Создай встречу завтра в 16:00', d(16, 0, 60, true)],
    ['Запиши встречу 18.11 в 12:00', d(12, 0, 60, true)],
    ['Напомни завтра в 10:00 за 30 минут позвонить маме', { ...d(10, 0, 60, true), reminderMin: 30 }],
    ['Запиши звонок через два часа', d(17, 36, 60, true)],
    ['Поставь встречу на пятницу в шесть вечера на полчаса', d(18, 0, 30)],
    ['в 2 часа на полтора часа', d(14, 0, 90)],
  ] as const) assert.equal(mismatch(s, draft), null, s)
})

test('no such meeting', async () => {
  reset()
  assert.equal((await flowWith(fakeCalendar({ events: [IVAN] })).handle('Отмени встречу с Петром'))?.say, 'Не нашёл такую встречу.')
})
