import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addDays, addMinutes, dateIso, isValidDate, localIso, parseApiTime, rfc3339, sayDate, toInstant, weekdayOf, zonedNow } from '../src/lib/calendarTime.ts'

test('the user\'s clock, not the machine\'s', () => {
  // 21:30 UTC on 14 October is already the 15th in Moscow, still the 14th in New York.
  const t = new Date('2026-10-14T21:30:00Z')
  assert.deepEqual(zonedNow(t, 'Europe/Moscow'), { y: 2026, m: 10, d: 15, hh: 0, mm: 30, weekday: 4 })
  assert.deepEqual(zonedNow(t, 'America/New_York'), { y: 2026, m: 10, d: 14, hh: 17, mm: 30, weekday: 3 })
})

test('a local time becomes the right instant, and back, with no day lost', () => {
  assert.equal(rfc3339({ y: 2026, m: 10, d: 18, hh: 18, mm: 0 }, 'Europe/Moscow'), '2026-10-18T18:00:00+03:00')
  assert.equal(toInstant({ y: 2026, m: 10, d: 18, hh: 0, mm: 0 }, 'Europe/Moscow').toISOString(), '2026-10-17T21:00:00.000Z')
  // Midnight in Moscow is the previous day in UTC — the date sent stays the 18th.
  assert.equal(localIso({ y: 2026, m: 10, d: 18, hh: 0, mm: 0 }), '2026-10-18T00:00:00')
  assert.equal(dateIso({ y: 2026, m: 1, d: 5 }), '2026-01-05')
})

test('summer time: the offset is the one in force on that day', () => {
  // Berlin changes on 29 March and 25 October 2026.
  assert.equal(rfc3339({ y: 2026, m: 3, d: 28, hh: 12, mm: 0 }, 'Europe/Berlin'), '2026-03-28T12:00:00+01:00')
  assert.equal(rfc3339({ y: 2026, m: 3, d: 30, hh: 12, mm: 0 }, 'Europe/Berlin'), '2026-03-30T12:00:00+02:00')
  assert.equal(rfc3339({ y: 2026, m: 10, d: 24, hh: 12, mm: 0 }, 'Europe/Berlin'), '2026-10-24T12:00:00+02:00')
  assert.equal(rfc3339({ y: 2026, m: 10, d: 26, hh: 12, mm: 0 }, 'Europe/Berlin'), '2026-10-26T12:00:00+01:00')
  // A day's range across the change is 23 or 25 hours long, as it should be.
  const day = (d: number) => toInstant({ y: 2026, m: 3, d, hh: 0, mm: 0 }, 'Europe/Berlin').getTime()
  assert.equal((day(30) - day(29)) / 3_600_000, 23)
})

test('calendar arithmetic over month and year ends', () => {
  assert.deepEqual(addDays({ y: 2026, m: 12, d: 31 }, 1), { y: 2027, m: 1, d: 1 })
  assert.deepEqual(addDays({ y: 2028, m: 2, d: 28 }, 1), { y: 2028, m: 2, d: 29 })
  assert.deepEqual(addMinutes({ y: 2026, m: 12, d: 31, hh: 23, mm: 30 }, 60), { y: 2027, m: 1, d: 1, hh: 0, mm: 30 })
  assert.equal(weekdayOf({ y: 2026, m: 10, d: 14 }), 3)
  assert.equal(isValidDate({ y: 2026, m: 2, d: 31 }), false)
  assert.equal(isValidDate({ y: 2028, m: 2, d: 29 }), true)
})

test('times from the API are read as the wall time they carry', () => {
  assert.deepEqual(parseApiTime('2026-10-18T18:00:00+03:00'), { y: 2026, m: 10, d: 18, hh: 18, mm: 0, allDay: false })
  assert.deepEqual(parseApiTime('2026-10-18'), { y: 2026, m: 10, d: 18, allDay: true })
})

test('saying a date: today, tomorrow, the weekday this week, the year only when it differs', () => {
  const today = { y: 2026, m: 10, d: 14 }
  assert.equal(sayDate(today, today), 'сегодня')
  assert.equal(sayDate({ y: 2026, m: 10, d: 15 }, today), 'завтра')
  assert.equal(sayDate({ y: 2026, m: 10, d: 16 }, today), 'послезавтра')
  assert.equal(sayDate({ y: 2026, m: 10, d: 18 }, today), 'в воскресенье, 18 октября')
  assert.equal(sayDate({ y: 2026, m: 11, d: 3 }, today), '3 ноября')
  assert.equal(sayDate({ y: 2027, m: 3, d: 5 }, today), '5 марта 2027 года')
})
