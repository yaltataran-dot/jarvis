/**
 * Dates and times in the user's time zone, whatever zone the machine is in.
 *
 * Everything the calendar does is in wall-clock terms — "18 октября в 18:00"
 * means 18:00 on the user's clock — so dates are kept as plain local values
 * (year, month, day, hour, minute) and only turned into instants at the edge,
 * for the API's time ranges. Event times themselves go to Google as a local
 * time plus the zone's name, so Google applies the zone's rules, summer time
 * included, and nothing here can shift a date by converting through UTC.
 *
 * Kept free of imports so the tests can run it directly.
 */

/** A calendar day. `m` is 1–12. */
export type LocalDate = { y: number; m: number; d: number }
/** A time of day, 0–23 and 0–59. */
export type LocalTime = { hh: number; mm: number }
export type LocalDateTime = LocalDate & LocalTime

const pad = (n: number) => String(n).padStart(2, '0')

/** What the clock and calendar read in `tz` at `instant`. */
export function zonedNow(instant: Date, tz: string): LocalDateTime & { weekday: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant)
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value)
  const v = { y: get('year'), m: get('month'), d: get('day'), hh: get('hour') % 24, mm: get('minute') }
  return { ...v, weekday: weekdayOf(v) }
}

/** 1 = Monday … 7 = Sunday. */
export function weekdayOf(d: LocalDate): number {
  const w = new Date(Date.UTC(d.y, d.m - 1, d.d)).getUTCDay()
  return w === 0 ? 7 : w
}

/** Calendar arithmetic on days — month and year ends included. */
export function addDays(d: LocalDate, n: number): LocalDate {
  const t = new Date(Date.UTC(d.y, d.m - 1, d.d + n))
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }
}

/** Minutes added to a local date-time, rolling over days. */
export function addMinutes(v: LocalDateTime, n: number): LocalDateTime {
  const t = new Date(Date.UTC(v.y, v.m - 1, v.d, v.hh, v.mm + n))
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), hh: t.getUTCHours(), mm: t.getUTCMinutes() }
}

/** A real day of the calendar? 31 February is not. */
export function isValidDate(d: LocalDate): boolean {
  if (!Number.isInteger(d.y) || !Number.isInteger(d.m) || !Number.isInteger(d.d)) return false
  if (d.m < 1 || d.m > 12 || d.d < 1) return false
  const t = new Date(Date.UTC(d.y, d.m - 1, d.d))
  return t.getUTCMonth() === d.m - 1 && t.getUTCDate() === d.d
}

export const sameDay = (a: LocalDate, b: LocalDate) => a.y === b.y && a.m === b.m && a.d === b.d

/** Negative if a is earlier, positive if later, 0 if the same minute. */
export function compare(a: LocalDateTime, b: LocalDateTime): number {
  return Date.UTC(a.y, a.m - 1, a.d, a.hh, a.mm) - Date.UTC(b.y, b.m - 1, b.d, b.hh, b.mm)
}

/** The zone's offset from UTC, in minutes, at a given instant. */
function offsetAt(instant: number, tz: string): number {
  const v = zonedNow(new Date(instant), tz)
  return Math.round((Date.UTC(v.y, v.m - 1, v.d, v.hh, v.mm) - Math.floor(instant / 60_000) * 60_000) / 60_000)
}

/**
 * The instant a local wall time happens in `tz`. Two passes, because the
 * offset to use is the one in force at the answer, not at the guess — the
 * difference only matters across a summer-time change, which is exactly when
 * it must be right.
 */
export function toInstant(v: LocalDateTime, tz: string): Date {
  const naive = Date.UTC(v.y, v.m - 1, v.d, v.hh, v.mm)
  const first = offsetAt(naive, tz)
  const second = offsetAt(naive - first * 60_000, tz)
  return new Date(naive - second * 60_000)
}

/** "2026-10-18T18:00:00+03:00" — the form the API takes for time ranges. */
export function rfc3339(v: LocalDateTime, tz: string): string {
  const off = offsetAt(toInstant(v, tz).getTime(), tz)
  const sign = off >= 0 ? '+' : '-'
  const a = Math.abs(off)
  return `${v.y}-${pad(v.m)}-${pad(v.d)}T${pad(v.hh)}:${pad(v.mm)}:00${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`
}

/** "2026-10-18T18:00:00" — a local time with no offset, sent with a timeZone. */
export const localIso = (v: LocalDateTime) => `${v.y}-${pad(v.m)}-${pad(v.d)}T${pad(v.hh)}:${pad(v.mm)}:00`

/** "2026-10-18" — the API's form for all-day events. */
export const dateIso = (d: LocalDate) => `${d.y}-${pad(d.m)}-${pad(d.d)}`

/**
 * A time the API sent back, read as the wall time it carries. Lists are asked
 * for in the user's zone, so "2026-10-18T18:00:00+03:00" means 18:00 there; the
 * offset is not applied a second time.
 */
export function parseApiTime(s: string): (LocalDateTime & { allDay: false }) | (LocalDate & { allDay: true }) | null {
  const dt = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s)
  if (dt) return { y: +dt[1], m: +dt[2], d: +dt[3], hh: +dt[4], mm: +dt[5], allDay: false }
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (d) return { y: +d[1], m: +d[2], d: +d[3], allDay: true }
  return null
}

// -- saying it ------------------------------------------------------------------

const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря']
const WEEKDAYS = ['понедельник', 'вторник', 'среду', 'четверг', 'пятницу', 'субботу', 'воскресенье']

/**
 * A day as he says it: "сегодня", "завтра", "в пятницу, 23 октября",
 * "18 марта 2027 года". The year only when it is not this one — and always
 * then, so a date carried into next year is heard, not assumed.
 */
export function sayDate(d: LocalDate, today: LocalDate): string {
  if (sameDay(d, today)) return 'сегодня'
  if (sameDay(d, addDays(today, 1))) return 'завтра'
  if (sameDay(d, addDays(today, 2))) return 'послезавтра'
  const date = `${d.d} ${MONTHS_GEN[d.m - 1]}${d.y !== today.y ? ` ${d.y} года` : ''}`
  const days = (Date.UTC(d.y, d.m - 1, d.d) - Date.UTC(today.y, today.m - 1, today.d)) / 86_400_000
  // Within the coming week the weekday is how people place it.
  if (days > 0 && days < 7) return `в ${WEEKDAYS[weekdayOf(d) - 1]}, ${date}`
  return date
}

export const sayTime = (t: LocalTime) => `${t.hh}:${pad(t.mm)}`
