/**
 * Calendar commands in Russian, read in the page.
 *
 * Like musicIntent.ts this only says what was asked; nothing here touches the
 * calendar. The result is a structured request — what to do, which day, what
 * time, where, with whom — with every part the phrase did not give left out,
 * so the flow (calendarFlow.ts) can ask for exactly that and nothing else.
 *
 * The phrase is read word by word. Each expression that is recognised — a
 * date, a time, a duration, a place, "с кем" — claims its words, and what is
 * left over, in the user's own spelling, becomes the title. So "Запиши встречу
 * на 18 октября в 18:00, ресторан Батони" yields a meeting on 18 October at
 * 18:00 at "ресторан Батони", and "Добавь звонок с партнёром в понедельник в
 * 11 утра" a "Звонок с партнёром".
 *
 * Nothing is guessed that would change the meaning. A date with no year that
 * has already passed this year is moved to next year and flagged, so the
 * confirmation says the year out loud. An hour with no part of the day — "в
 * шесть" — is read as the waking-hours one (18:00, not 06:00), and the
 * confirmation says the time in full.
 *
 * Pure: "now" and the zone come in as arguments. No imports beyond the date
 * helpers, so the tests can run it directly.
 */

import { addDays, addMinutes, isValidDate, weekdayOf, type LocalDate, type LocalDateTime, type LocalTime } from './calendarTime'

export type DayPart = 'morning' | 'day' | 'evening' | 'night'

/** What a phrase said about when: any of these may be missing. */
export type When = {
  date?: LocalDate
  time?: LocalTime
  /** "утром", "вечером" — a time is still needed. */
  part?: DayPart
  /** "с 18 до 20" */
  end?: LocalTime
  durationMin?: number
  allDay?: boolean
  /** "на следующей неделе" — a day is still needed. */
  week?: 'this' | 'next'
  /** The date had no year and has passed this year: moved to next, to be said aloud. */
  yearRolled?: boolean
}

export type CalendarIntent =
  | ({
      action: 'create'
      title: string
      location?: string
      reminderMin?: number
      /**
       * Words of a length were heard but could not be read as one ("15 мин"
       * after the hour, "в 16:00 15 минут"): the length is asked for, never
       * replaced by the default hour.
       */
      durationUnclear?: true
      /**
       * "в 17 часов 15 минут", "в 17 15 минут": a start at 17:15, or 17:00 for
       * 15 minutes — the words cannot tell. Both are asked for again.
       */
      timeUnclear?: { hh: number; mm: number }
    } & When)
  | { action: 'list'; from: LocalDate; days: number; label: string }
  | { action: 'next' }
  /** "Во сколько встреча с Батони?" */
  | { action: 'when'; query: string }
  /** Move an event: found by query/date/time, to a new date and/or time, or shifted. */
  | {
      action: 'move'
      query: string
      on?: LocalDate
      at?: LocalTime
      to: When
      shiftMin?: number
    }
  | { action: 'relocate'; query: string; on?: LocalDate; location?: string }
  | { action: 'delete'; query: string; on?: LocalDate; at?: LocalTime }

export type Ctx = { now: LocalDateTime; today: LocalDate }

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

type Tok = { raw: string; n: string }

/** Words, each with its own spelling kept and a folded form to match on. */
function tokenize(text: string): Tok[] {
  return text
    .replace(/[«»"“”„()!?;]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^[,.\s-]+|[,.\s]+$/g, ''))
    .filter(Boolean)
    .map((raw) => ({ raw, n: raw.toLowerCase().replace(/ё/g, 'е') }))
}

const NUM: Record<string, number> = {
  ноль: 0, один: 1, одна: 1, одну: 1, одного: 1, два: 2, две: 2, двух: 2, три: 3, трех: 3, четыре: 4, четырех: 4,
  пять: 5, пяти: 5, шесть: 6, шести: 6, семь: 7, семи: 7, восемь: 8, восьми: 8, девять: 9, девяти: 9,
  десять: 10, десяти: 10, одиннадцать: 11, одиннадцати: 11, двенадцать: 12, двенадцати: 12, тринадцать: 13,
  четырнадцать: 14, пятнадцать: 15, шестнадцать: 16, семнадцать: 17, восемнадцать: 18, девятнадцать: 19,
  двадцать: 20, двадцати: 20, тридцать: 30, сорок: 40, пятьдесят: 50,
}

/** A number at i — digits, or words up to "двадцать три" — and how many words it took. */
function numberAt(t: Tok[], i: number): { v: number; len: number } | null {
  const w = t[i]?.n
  if (!w) return null
  if (/^\d{1,4}$/.test(w)) return { v: Number(w), len: 1 }
  if (!(w in NUM)) return null
  const v = NUM[w]
  const next = t[i + 1]?.n
  if ((v === 20 || v === 30 || v === 40 || v === 50) && next && next in NUM && NUM[next] < 10 && NUM[next] > 0) {
    return { v: v + NUM[next], len: 2 }
  }
  return { v, len: 1 }
}

/** "первого" … "тридцать первого", for days of the month and "половина седьмого". */
const ORD: Record<string, number> = {
  первого: 1, второго: 2, третьего: 3, четвертого: 4, пятого: 5, шестого: 6, седьмого: 7, восьмого: 8,
  девятого: 9, десятого: 10, одиннадцатого: 11, двенадцатого: 12, тринадцатого: 13, четырнадцатого: 14,
  пятнадцатого: 15, шестнадцатого: 16, семнадцатого: 17, восемнадцатого: 18, девятнадцатого: 19, двадцатого: 20,
  тридцатого: 30,
}
function ordinalAt(t: Tok[], i: number): { v: number; len: number } | null {
  const w = t[i]?.n
  if (!w) return null
  if (w in ORD) return { v: ORD[w], len: 1 }
  if ((w === 'двадцать' || w === 'тридцать') && t[i + 1]?.n in ORD && ORD[t[i + 1].n] < 10) {
    return { v: NUM[w] + ORD[t[i + 1].n], len: 2 }
  }
  return null
}

const MONTHS: Array<[RegExp, number]> = [
  [/^январ/, 1], [/^феврал/, 2], [/^март/, 3], [/^апрел/, 4], [/^ма[йяю]$/, 5], [/^июн/, 6],
  [/^июл/, 7], [/^август/, 8], [/^сентябр/, 9], [/^октябр/, 10], [/^ноябр/, 11], [/^декабр/, 12],
]
const monthOf = (w?: string) => (w ? MONTHS.find(([re]) => re.test(w))?.[1] : undefined)

const WEEKDAY: Array<[RegExp, number]> = [
  [/^понедельник/, 1], [/^вторник/, 2], [/^сред[ауые]$/, 3], [/^четверг/, 4], [/^пятниц/, 5], [/^суббот/, 6], [/^воскресень/, 7],
]
const weekdayWord = (w?: string) => (w ? WEEKDAY.find(([re]) => re.test(w))?.[1] : undefined)

const PART: Array<[RegExp, DayPart]> = [
  [/^(?:утра|утром|утро)$/, 'morning'],
  [/^(?:дня|днем|днём|день)$/, 'day'],
  [/^(?:вечера|вечером|вечер)$/, 'evening'],
  [/^(?:ночи|ночью)$/, 'night'],
]
const partOf = (w?: string) => (w ? PART.find(([re]) => re.test(w))?.[1] : undefined)

/**
 * An hour as meant. With a part of the day it is exact ("6 вечера" = 18).
 * Without one, 1–7 are the afternoon/evening hours people mean for meetings
 * and 8–11 the morning — and the confirmation says the result in full.
 */
function hourOf(h: number, part?: DayPart): number | null {
  if (h < 0 || h > 24) return null
  if (h === 24) return 0
  if (part === 'morning') return h === 12 ? 0 : h
  if (part === 'day') return h < 12 ? h + 12 : h
  if (part === 'evening') return h < 12 ? h + 12 : h
  if (part === 'night') return h === 12 ? 0 : h >= 6 && h < 12 ? h + 12 : h
  if (h >= 1 && h <= 7) return h + 12
  return h
}

// ---------------------------------------------------------------------------
// Expressions: each reads at a position and says how many words it took
// ---------------------------------------------------------------------------

type Hit<T> = { v: T; at: number; len: number }

/** A date at i: сегодня, завтра, через N дней, 18 октября [2026 года], 18-го, 18.10, (следующую) пятницу. */
function dateAt(t: Tok[], i: number, c: Ctx): Hit<{ date?: LocalDate; week?: 'this' | 'next'; yearRolled?: boolean; plus?: number }> | null {
  let j = i
  if (['на', 'в', 'во', 'к'].includes(t[j]?.n)) j++
  const w = t[j]?.n
  if (!w) return null
  const len = (k: number) => k - i
  if (/^сегодня|^сегодняшн/.test(w)) return { v: { date: c.today }, at: i, len: len(j + 1) }
  if (/^послезавтра/.test(w)) return { v: { date: addDays(c.today, 2) }, at: i, len: len(j + 1) }
  if (/^завтра|^завтрашн/.test(w)) return { v: { date: addDays(c.today, 1) }, at: i, len: len(j + 1) }

  // "на следующей неделе", "на этой неделе"
  if ((w === 'следующей' || w === 'этой') && t[j + 1]?.n === 'неделе') {
    return { v: { week: w === 'этой' ? 'this' : 'next' }, at: i, len: len(j + 2) }
  }

  // "(в) (следующую|эту|ближайшую) пятницу"
  let mod: 'next' | 'this' | undefined
  let k = j
  if (/^следующ/.test(t[k]?.n)) {
    mod = 'next'
    k++
  } else if (/^(?:эт[уоа]|этот|ближайш)/.test(t[k]?.n)) {
    mod = 'this'
    k++
  }
  const wd = weekdayWord(t[k]?.n)
  if (wd) {
    const todayWd = weekdayOf(c.today)
    let ahead = (wd - todayWd + 7) % 7
    // "в пятницу" said on a Friday means the next one; "в эту пятницу", today.
    if (ahead === 0 && mod !== 'this') ahead = 7
    // "в следующую пятницу": the one in next week.
    if (mod === 'next') ahead = 7 - todayWd + wd
    return { v: { date: addDays(c.today, ahead) }, at: i, len: len(k + 1) }
  }

  // dd.mm(.yyyy)
  const dm = /^(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?$/.exec(w)
  // "18.11" is a date unless "в" makes it a time ("в 18.30").
  if (dm && Number(dm[2]) <= 12 && (Number(dm[1]) > 23 || dm[3] || !['в', 'во'].includes(t[i]?.n))) {
    return finishDate(Number(dm[1]), Number(dm[2]), dm[3] ? Number(dm[3].length === 2 ? `20${dm[3]}` : dm[3]) : undefined, c, i, len(j + 1))
  }

  // "18 октября [2026 года]", "18-го", "18 числа", "восемнадцатого октября"
  const day = /^(\d{1,2})(?:-?(?:го|е|ое))?$/.exec(w)
  const ord = day ? null : ordinalAt(t, j)
  if (day || ord) {
    const d = day ? Number(day[1]) : ord!.v
    const after = j + (day ? 1 : ord!.len)
    const month = monthOf(t[after]?.n)
    if (month) {
      let end = after + 1
      let year: number | undefined
      if (/^\d{4}$/.test(t[end]?.n ?? '')) {
        year = Number(t[end].n)
        end++
        if (/^(?:года|г|год)$/.test(t[end]?.n ?? '')) end++
      }
      return finishDate(d, month, year, c, i, len(end))
    }
    // "18-го", "18 числа": this month, or next if it has passed.
    const suffixed = day && /-?(?:го|е|ое)$/.test(w)
    if (suffixed || ord || t[after]?.n === 'числа') {
      const end = t[after]?.n === 'числа' ? after + 1 : after
      let m = c.today.m
      let y = c.today.y
      if (d < c.today.d) {
        // Passed this month: the next month's, across the year if need be.
        if (m === 12) {
          m = 1
          y++
        } else m++
      }
      const date = { y, m, d }
      if (!isValidDate(date)) return null
      return { v: { date }, at: i, len: len(end) }
    }
  }
  return null
}

function finishDate(d: number, m: number, year: number | undefined, c: Ctx, at: number, len: number): Hit<{ date: LocalDate; yearRolled?: boolean }> | null {
  let date = { y: year ?? c.today.y, m, d }
  let yearRolled = false
  if (!year && Date.UTC(date.y, m - 1, d) < Date.UTC(c.today.y, c.today.m - 1, c.today.d)) {
    date = { ...date, y: date.y + 1 }
    yearRolled = true
  }
  if (!isValidDate(date)) return null
  return { v: { date, ...(yearRolled ? { yearRolled } : {}) }, at, len }
}

/** A time at i: в 18:00, в 18, в шесть вечера, в два часа, в половине седьмого, в полдень, 18:30. */
function timeAt(t: Tok[], i: number): Hit<{ time?: LocalTime; part?: DayPart }> | null {
  let j = i
  const prep = ['в', 'во', 'к', 'на'].includes(t[j]?.n)
  if (prep) j++
  const w = t[j]?.n
  if (!w) return null
  if (w === 'полдень') return { v: { time: { hh: 12, mm: 0 } }, at: i, len: j + 1 - i }
  if (w === 'полночь') return { v: { time: { hh: 0, mm: 0 } }, at: i, len: j + 1 - i }

  // "в половине седьмого (вечера)"
  if (/^половин[еуа]$/.test(w)) {
    const o = ordinalAt(t, j + 1)
    if (!o || o.v > 12) return null
    let end = j + 1 + o.len
    const part = partOf(t[end]?.n)
    if (part) end++
    const hh = hourOf(o.v - 1 === 0 ? 12 : o.v - 1, part)
    if (hh === null) return null
    return { v: { time: { hh, mm: 30 }, ...(part ? { part } : {}) }, at: i, len: end - i }
  }

  // "18:00", "18.30", "18-00"
  const hm = /^(\d{1,2})[:.-](\d{2})$/.exec(w)
  if (hm) {
    const h = Number(hm[1])
    const mm = Number(hm[2])
    if (h > 23 || mm > 59) return null
    let end = j + 1
    const part = partOf(t[end]?.n)
    if (part) end++
    const hh = h > 12 ? h : hourOf(h, part) ?? h
    // Written with a colon, a 1–7 hour without a part is taken as written: "8:30".
    return { v: { time: { hh: part ? hh : h, mm } }, at: i, len: end - i }
  }

  // "в 18", "в шесть вечера", "в два часа", "в 6 30", "в шесть тридцать"
  if (!prep) {
    // A bare part of the day: "утром", "вечером".
    const part = partOf(w)
    if (part && /ом$|ью$|ем$/.test(w)) return { v: { part }, at: i, len: 1 }
    return null
  }
  const n = numberAt(t, j)
  if (!n || n.v > 24) return null
  let end = j + n.len
  const hourWord = /^час(?:а|ов)?$/.test(t[end]?.n ?? '')
  if (hourWord) end++
  let mm = 0
  const mins = numberAt(t, end)
  const unit = t[end + (mins?.len ?? 0)]?.n ?? ''
  // A number followed by "минут" is never taken as the minutes of the hour
  // here. "в 17 часов 15 минут" is how speech recognition writes both 17:15
  // and "в 17 часов, 15 минут" (17:00 for a quarter of an hour) — the comma is
  // gone — so the create command flags it and asks (see `timeUnclear`).
  const minutesOfHour = !/^(?:час|мин)/.test(unit) && ((mins?.v ?? 0) >= 10 || t[end]?.n === '00')
  if (mins && mins.v < 60 && minutesOfHour) {
    mm = mins.v
    end += mins.len
    if (/^мин/.test(t[end]?.n ?? '')) end++
  }
  const part = partOf(t[end]?.n)
  if (part) end++
  // "в 2" alone, with nothing to mark it as a time, is not taken as one.
  if (!part && n.len === 1 && /^\d+$/.test(w) && t[j + 1]?.n !== 'часа' && t[j + 1]?.n !== 'часов' && end === j + 1 && t[i]?.n === 'на') return null
  const hh = hourOf(n.v, part)
  if (hh === null) return null
  return { v: { time: { hh, mm }, ...(part ? { part } : {}) }, at: i, len: end - i }
}

/** Words a length begins with: "на 15 минут", "длительностью 15 минут". */
const DURATION_LEAD = /^(?:на|длительностью|продолжительностью|длительность|продолжительность)$/

/**
 * "на час", "на два часа", "на полчаса", "на 30 минут", "на 15 мин", "на
 * четверть часа", "на полтора часа", "длительностью 15 минут",
 * "продолжительностью в 2 часа".
 */
function durationAt(t: Tok[], i: number): Hit<number> | null {
  if (!DURATION_LEAD.test(t[i]?.n ?? '')) return null
  let j = i + 1
  if (t[i].n !== 'на' && (t[j]?.n === 'в' || t[j]?.n === 'на')) j++
  const w = t[j]?.n
  if (!w) return null
  const hit = (v: number, end: number) => ({ v, at: i, len: end - i })
  if (w === 'полчаса') return hit(30, j + 1)
  if (w === 'час') return hit(60, j + 1)
  if (w === 'четверть' && /^час/.test(t[j + 1]?.n ?? '')) return hit(15, j + 2)
  if (w === 'полтора' && /^час/.test(t[j + 1]?.n ?? '')) return hit(90, j + 2)
  const n = numberAt(t, j)
  if (!n || n.v <= 0) return null
  const unit = t[j + n.len]?.n ?? ''
  if (/^час/.test(unit)) return hit(n.v * 60, j + n.len + 1)
  if (/^мин/.test(unit)) return hit(n.v, j + n.len + 1)
  return null
}

/** A word of length, left over once everything readable was read. */
const LENGTH_WORD = /^(?:мин|минут[ауы]?|час|часа|часов|полчаса|четверть|полтора|длительност\p{L}*|продолжительност\p{L}*)$/u

/** "через два часа", "через полчаса", "через 15 минут", "через 3 дня". */
function relativeAt(t: Tok[], i: number, c: Ctx): Hit<{ at?: LocalDateTime; date?: LocalDate }> | null {
  if (t[i]?.n !== 'через') return null
  const w = t[i + 1]?.n
  if (w === 'полчаса') return { v: { at: addMinutes(c.now, 30) }, at: i, len: 2 }
  if (w === 'час') return { v: { at: addMinutes(c.now, 60) }, at: i, len: 2 }
  if (w === 'день' || w === 'неделю') return { v: { date: addDays(c.today, w === 'день' ? 1 : 7) }, at: i, len: 2 }
  const n = numberAt(t, i + 1)
  if (!n) return null
  const unit = t[i + 1 + n.len]?.n ?? ''
  if (/^минут/.test(unit)) return { v: { at: addMinutes(c.now, n.v) }, at: i, len: 2 + n.len }
  if (/^час/.test(unit)) return { v: { at: addMinutes(c.now, n.v * 60) }, at: i, len: 2 + n.len }
  if (/^(?:дн|день)/.test(unit)) return { v: { date: addDays(c.today, n.v) }, at: i, len: 2 + n.len }
  return null
}

/** "с 18 до 20", "с 18:00 до 19:30". */
function rangeAt(t: Tok[], i: number): Hit<{ time: LocalTime; end: LocalTime }> | null {
  if (t[i]?.n !== 'с') return null
  const start = timeAt([{ raw: 'в', n: 'в' }, ...t.slice(i + 1)], 0)
  if (!start?.v.time) return null
  const k = i + start.len // index of the word after the start (the extra "в" offsets the length by one)
  if (t[k]?.n !== 'до') return null
  const end = timeAt([{ raw: 'в', n: 'в' }, ...t.slice(k + 1)], 0)
  if (!end?.v.time) return null
  const part = end.v.part ?? start.v.part
  const fix = (x: LocalTime, raw: Hit<{ time?: LocalTime; part?: DayPart }>) =>
    raw.v.part || !part ? x : { hh: hourOf(x.hh > 12 ? x.hh - 12 : x.hh, part) ?? x.hh, mm: x.mm }
  return { v: { time: fix(start.v.time, start), end: fix(end.v.time, end) }, at: i, len: k + end.len - i }
}

/** Places, with the form a title would use: "в ресторане Батони" -> "ресторан Батони". */
const PLACE: Array<[RegExp, string]> = [
  [/^ресторан(?:е|а)?$/, 'ресторан'], [/^каф[еэ]$/, 'кафе'], [/^кофейн[еяи]$/, 'кофейня'], [/^бар(?:е|а)?$/, 'бар'],
  [/^офис(?:е|а)?$/, 'офис'], [/^клуб(?:е|а)?$/, 'клуб'], [/^отел(?:е|ь|я)$/, 'отель'], [/^гостиниц[еаы]$/, 'гостиница'],
  [/^парк(?:е|а)?$/, 'парк'], [/^театр(?:е|а)?$/, 'театр'], [/^кинотеатр(?:е|а)?$/, 'кинотеатр'],
  [/^(?:тц|трц)$/, 'ТЦ'], [/^улиц[еаы]$/, 'улица'], [/^адрес(?:у)?$/, 'адрес'], [/^ресторанчик(?:е)?$/, 'ресторан'],
  [/^пиццери[ия]$/, 'пиццерия'], [/^столов(?:ой|ая)$/, 'столовая'], [/^спортзал(?:е)?$/, 'спортзал'],
]

/** What a meeting is called, in the nominative the title uses. */
const EVENT_NOUN: Array<[RegExp, string]> = [
  [/^встреч[аиуе]$/, 'Встреча'], [/^звон(?:ок|ка)$/, 'Звонок'], [/^созвон(?:а)?$/, 'Созвон'],
  [/^совещани[еяи]$/, 'Совещание'], [/^событи[еяи]$/, 'Событие'], [/^мероприяти[еяи]$/, 'Мероприятие'],
  [/^планерк[аиуе]$/, 'Планёрка'], [/^обед(?:а)?$/, 'Обед'], [/^ужин(?:а)?$/, 'Ужин'], [/^завтрак(?:а)?$/, 'Завтрак'],
  [/^тренировк[аиуе]$/, 'Тренировка'], [/^(?:прием|приём)(?:а)?$/, 'Приём'], [/^визит(?:а)?$/, 'Визит'],
  [/^собеседовани[еяи]$/, 'Собеседование'], [/^стрижк[аиуе]$/, 'Стрижка'], [/^урок(?:а)?$/, 'Урок'],
  [/^переговор(?:ы|ов)$/, 'Переговоры'], [/^конференци[июя]$/, 'Конференция'],
]
const eventNoun = (w?: string) => (w ? EVENT_NOUN.find(([re]) => re.test(w))?.[1] : undefined)

/** Words with no content of their own in a calendar command. */
const FILLER = new Set([
  'мою', 'мой', 'мне', 'мои', 'моих', 'у', 'меня', 'пожалуйста', 'календарь', 'календаре', 'в', 'на', 'и', 'а',
  'новую', 'новый', 'новое', 'эту', 'этот', 'это', 'там', 'плиз', 'будет', 'есть',
])

// ---------------------------------------------------------------------------

/** All the "when" in a run of words, claiming them in `used`. */
function readWhen(t: Tok[], from: number, to: number, used: boolean[], c: Ctx): When & { at?: LocalDateTime } {
  const out: When & { at?: LocalDateTime } = {}
  for (let i = from; i < to; i++) {
    if (used[i]) continue
    const take = (len: number) => {
      for (let k = i; k < i + len && k < to; k++) used[k] = true
      i += len - 1
    }
    const rel = relativeAt(t, i, c)
    if (rel) {
      if (rel.v.at) {
        const { y, m, d, hh, mm } = rel.v.at
        out.date = { y, m, d }
        out.time = { hh, mm }
      }
      if (rel.v.date) out.date = rel.v.date
      take(rel.len)
      continue
    }
    const range = rangeAt(t, i)
    if (range) {
      out.time = range.v.time
      out.end = range.v.end
      take(range.len)
      continue
    }
    // "в 16:00 до 16:15", or "до 16:15" alone as a correction: an end.
    if (t[i].n === 'до' && !out.end) {
      const e = timeAt([{ raw: 'в', n: 'в' }, ...t.slice(i + 1, to)], 0)
      if (e?.v.time) {
        out.end = e.v.time
        take(e.len) // the stand-in "в" counts as "до"
        continue
      }
    }
    const dur = durationAt(t, i)
    if (dur) {
      out.durationMin = dur.v
      take(dur.len)
      continue
    }
    const d = dateAt(t, i, c)
    if (d && !out.date) {
      if (d.v.date) out.date = d.v.date
      if (d.v.week) out.week = d.v.week
      if (d.v.yearRolled) out.yearRolled = true
      take(d.len)
      continue
    }
    const tm = timeAt(t, i)
    if (tm && !out.time) {
      if (tm.v.time) out.time = tm.v.time
      if (tm.v.part) out.part = tm.v.part
      take(tm.len)
      continue
    }
    if ((t[i].n === 'весь' && t[i + 1]?.n === 'день') || t[i].n === 'целый') {
      out.allDay = true
      take(t[i + 1]?.n === 'день' ? 2 : 1)
      continue
    }
    if (t[i].n === 'на' && t[i + 1]?.n === 'весь' && t[i + 2]?.n === 'день') {
      out.allDay = true
      take(3)
    }
  }
  // A part of the day with a time already set says nothing more.
  if (out.time && out.part && !out.date) delete out.part
  return out
}

/** A place in a run of words: its noun and the name after it. */
function readPlace(t: Tok[], from: number, to: number, used: boolean[]): string | undefined {
  for (let i = from; i < to; i++) {
    if (used[i]) continue
    const p = PLACE.find(([re]) => re.test(t[i].n))
    if (!p) continue
    let start = i
    if (start > from && ['в', 'во', 'на', 'у'].includes(t[start - 1].n) && !used[start - 1]) start--
    let end = i + 1
    while (end < to && !used[end] && !FILLER.has(t[end].n)) end++
    for (let k = start; k < end; k++) used[k] = true
    const name = t.slice(i + 1, end).map((x) => x.raw).join(' ')
    return name ? `${p[1]} ${name}` : p[1]
  }
  return undefined
}

/** "с Иваном", "с партнёром" after the event noun: whom it is with, as spoken. */
function readWith(t: Tok[], from: number, to: number, used: boolean[]): string | undefined {
  for (let i = from; i < to; i++) {
    if (used[i] || t[i].n !== 'с' && t[i].n !== 'со') continue
    let end = i + 1
    while (end < to && !used[end] && !FILLER.has(t[end].n) && !PLACE.some(([re]) => re.test(t[end].n))) end++
    if (end === i + 1) continue
    for (let k = i; k < end; k++) used[k] = true
    return t.slice(i + 1, end).map((x) => x.raw).join(' ')
  }
  return undefined
}

const leftover = (t: Tok[], from: number, to: number, used: boolean[]) =>
  t.slice(from, to).filter((x, k) => !used[from + k] && !FILLER.has(x.n)).map((x) => x.raw).join(' ')

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** Words that make a phrase a calendar one, not a note or a list. */
const isCalendarish = (t: Tok[]) => t.some((x) => eventNoun(x.n) || /^календар/.test(x.n))

// ---------------------------------------------------------------------------

/** A question word after "напомни (мне, пожалуйста)": "что", "о чём", "как", "кто"… */
const RECALL_WORD = /^(?:что|чего|чем|как|какой|какая|какое|какие|какую|каким|кто|кого|кому|где|куда|откуда|когда|сколько|зачем|почему|чей|чья|чье|чьё)$/
function recallQuestion(n: string[]): boolean {
  let k = 1
  while (k < n.length && /^(?:мне|нам|пожалуйста|еще|ещё|ка)$/.test(n[k])) k++
  if (RECALL_WORD.test(n[k] ?? '')) return true
  // "о чём", "про что", "об этом"
  return /^(?:о|об|про)$/.test(n[k] ?? '') && /^(?:чем|чём|что|том|этом|нем|нём|ней|них)$/.test(n[k + 1] ?? '')
}

/** The calendar request in a phrase, or null if it is not one. */
export function parseCalendarCommand(text: string, c: Ctx): CalendarIntent | null {
  let t = tokenize(text)
  // His name or the brand, at the front.
  while (t.length && /^(?:джарвис|jarvis|юг-трансфер|эй|слушай)$/.test(t[0].n)) t = t.slice(1)
  if (t[0]?.n === 'юг' && t[1]?.n === 'трансфер') t = t.slice(2)
  if (!t.length) return null
  const n = t.map((x) => x.n)
  const used = t.map(() => false)
  const first = n[0]

  // -- reading ----------------------------------------------------------------

  // "Когда (у меня) следующая встреча?", "Какая следующая встреча?"
  if (/^(?:когда|какая)$/.test(first) && n.some((w) => /^следующ/.test(w)) && n.some((w) => eventNoun(w))) return { action: 'next' }
  if (/^следующ/.test(first) && eventNoun(n[1]) && t.length <= 3) return { action: 'next' }

  // "Во сколько встреча с Батони?", "Когда у меня встреча с Иваном?"
  if ((first === 'во' && n[1] === 'сколько') || first === 'когда') {
    const noun = n.findIndex((w) => eventNoun(w))
    if (noun >= 0) {
      const q = readWith(t, noun + 1, t.length, used) ?? leftover(t, noun + 1, t.length, used)
      if (q) return { action: 'when', query: q }
    }
  }

  // "Что у меня сегодня?", "Какие встречи на этой неделе?", "Покажи мои планы на понедельник"
  const listy =
    (first === 'что' && (n.includes('меня') || n.includes('календаре') || n.includes('планах'))) ||
    (/^(?:какие|какая)$/.test(first) && n.some((w) => /^(?:встреч|план|дел|событи|мероприят)/.test(w))) ||
    (/^(?:покажи|прочитай|расскажи|озвучь)$/.test(first) && n.some((w) => /^(?:план|встреч|календар|расписани|дел|событи)/.test(w))) ||
    (/^(?:мои|мое|моё|расписание|планы)$/.test(first) && n.some((w) => /^(?:план|расписани|встреч|дел)/.test(w)))
  if (listy) {
    const w = readWhen(t, 0, t.length, used, c)
    if (w.week === 'this') {
      const left = 7 - weekdayOf(c.today) + 1
      return { action: 'list', from: c.today, days: left, label: 'на этой неделе' }
    }
    if (w.week === 'next') {
      const mon = addDays(c.today, 7 - weekdayOf(c.today) + 1)
      return { action: 'list', from: mon, days: 7, label: 'на следующей неделе' }
    }
    if (n.includes('неделю') || n.includes('неделе')) {
      return { action: 'list', from: c.today, days: 7 - weekdayOf(c.today) + 1, label: 'на этой неделе' }
    }
    const date = w.date ?? c.today
    return { action: 'list', from: date, days: 1, label: '' }
  }

  // -- writing ----------------------------------------------------------------

  const noun = n.findIndex((w) => !!eventNoun(w))

  // "Отмени встречу с Батони", "Удали встречу с Иваном завтра", "Отмени встречу сегодня в 18:00"
  if (/^(?:отмени|удали|убери|отменить|удалить|снеси)$/.test(first) && noun >= 0) {
    const w = readWhen(t, noun + 1, t.length, used, c)
    const q = readWith(t, noun + 1, t.length, used) ?? leftover(t, noun + 1, t.length, used)
    return { action: 'delete', query: q, ...(w.date ? { on: w.date } : {}), ...(w.time ? { at: w.time } : {}) }
  }

  // "Измени место встречи с Батони (на кафе Пушкин)"
  if (/^(?:измени|поменяй|смени|обнови)$/.test(first) && /^мест[оа]$/.test(n[1] ?? '') && noun >= 0) {
    const split = n.indexOf('на', noun + 1)
    const end = split > 0 ? split : t.length
    const w = readWhen(t, noun + 1, end, used, c)
    const q = readWith(t, noun + 1, end, used) ?? leftover(t, noun + 1, end, used)
    let location: string | undefined
    if (split > 0) {
      for (let k = split; k < t.length; k++) used[k] = false
      location = readPlace(t, split + 1, t.length, used) ?? (leftover(t, split + 1, t.length, used) || undefined)
    }
    return { action: 'relocate', query: q, ...(w.date ? { on: w.date } : {}), ...(location ? { location } : {}) }
  }

  // "Перенеси встречу с Батони на 19:00 / на завтра / на пятницу в 15:00", "Поставь встречу на час позже"
  const shiftWord = n.findIndex((w) => w === 'позже' || w === 'раньше')
  if ((/^(?:перенеси|передвинь|сдвинь|перенести|подвинь)$/.test(first) || (shiftWord > 0 && /^(?:поставь|сделай)$/.test(first))) && noun >= 0) {
    if (shiftWord > 0) {
      const dur = durationAt(t, shiftWord - 2 >= 0 && n[shiftWord - 2] === 'на' ? shiftWord - 2 : shiftWord - 3)
      const mins = dur?.v ?? (n[shiftWord - 1] === 'полчаса' ? 30 : 60)
      const until = dur ? dur.at : shiftWord
      const q = readWith(t, noun + 1, until, used) ?? leftover(t, noun + 1, until, used)
      return { action: 'move', query: q, to: {}, shiftMin: n[shiftWord] === 'позже' ? mins : -mins }
    }
    // The first "на" after the selector starts the new time.
    let split = -1
    for (let k = noun + 1; k < t.length; k++) {
      if (n[k] === 'на' && (dateAt(t, k, c) || timeAt(t, k) || /^\d/.test(n[k + 1] ?? ''))) {
        split = k
        break
      }
    }
    const end = split > 0 ? split : t.length
    const sel = readWhen(t, noun + 1, end, used, c)
    const q = readWith(t, noun + 1, end, used) ?? leftover(t, noun + 1, end, used)
    const to: When = {}
    if (split > 0) {
      // "на 19:00" — a time after "на" is a time, not a duration.
      const tt = [{ raw: 'в', n: 'в' }, ...t.slice(split + 1)]
      const u2 = tt.map(() => false)
      Object.assign(to, readWhen(tt, 0, tt.length, u2, c))
      if (to.time && !to.date && /^(?:завтра|сегодня|послезавтра)/.test(n[split + 1] ?? '')) delete to.time
    }
    return { action: 'move', query: q, ...(sel.date ? { on: sel.date } : {}), ...(sel.time ? { at: sel.time } : {}), to }
  }

  // "Запиши встречу …", "Поставь встречу …", "Создай …", "Добавь звонок …", "Запланируй …", "Напомни …"
  const createVerb = /^(?:запиши|записать|запишите|поставь|создай|добавь|запланируй|назначь|внеси|напомни|забей)$/.test(first)
  if (createVerb) {
    const reminder = first === 'напомни'
    let reminderMin: number | undefined
    if (reminder) {
      // "напомни за 30 минут", "за час"
      const za = n.indexOf('за')
      if (za > 0) {
        const d = durationAt([{ raw: 'на', n: 'на' }, ...t.slice(za + 1)], 0)
        if (d) {
          reminderMin = d.v
          for (let k = za; k < za + d.len; k++) used[k] = true
        }
      }
      reminderMin ??= 0
    }
    const w = readWhen(t, 1, t.length, used, c)
    const hasWhen = !!(w.date || w.time || w.part || w.week || w.allDay)
    if (!reminder && !isCalendarish(t) && !hasWhen) return null
    // "Напомни, что мы решили", "напомни, о чём мы говорили", "напомни, как его
    // зовут" — asking to be reminded of something, now, not for a reminder in
    // the calendar. With no time in it, a question word straight after the verb
    // makes it a question, and it goes to the model. "Напомни завтра, что…"
    // has a time and is still a reminder.
    if (reminder && !hasWhen && recallQuestion(n)) return null
    // A note, a list, a file, an alarm, a song — "запиши в заметки", "поставь
    // будильник на 7" — is not a meeting.
    if (noun < 0 && n.some((w2) => /^(?:заметк|список|списк|файл|блокнот|документ|таблиц|будильник|таймер|песн|трек|музык|альбом|плейлист)/.test(w2))) return null
    used[0] = true
    // "с названием Проверка календаря", "под названием …": the title as said.
    const naming = n.findIndex((w2, k) => k > 0 && !used[k] && /^(?:названием|название|называется)$/.test(w2))
    let named = ''
    if (naming > 0) {
      used[naming] = true
      if (naming > 1 && !used[naming - 1] && (n[naming - 1] === 'с' || n[naming - 1] === 'под')) used[naming - 1] = true
      const words: string[] = []
      for (let k = naming + 1; k < t.length && !used[k]; k++) {
        words.push(t[k].raw)
        used[k] = true
      }
      named = words.join(' ')
    }
    // A length that was spoken but not read — "15 мин" after the hour, "в
    // 16:00 15 минут" — is never left to the default hour, nor to the title.
    let durationUnclear = false
    let timeUnclear: { hh: number; mm: number } | undefined
    for (let k = 1; k < t.length; k++) {
      if (used[k] || !LENGTH_WORD.test(n[k])) continue
      durationUnclear = true
      used[k] = true
      let p = k - 1
      const num = p > 0 && !used[p] ? numberAt(t, p) : null
      while (p > 0 && !used[p] && (numberAt(t, p) || DURATION_LEAD.test(n[p]) || n[p] === 'в')) used[p--] = true
      // Straight after a whole hour ("в 17 часов", "в 17") with nothing between:
      // the minutes of that hour, or a length — ask, do not choose.
      const before = n[p] ?? ''
      if (num && num.v < 60 && w.time && w.time.mm === 0 && p === k - 2 && (/^час(?:а|ов)?$/.test(before) || numberAt(t, p))) {
        timeUnclear = { hh: w.time.hh, mm: num.v }
      }
    }
    const location = readPlace(t, 1, t.length, used)
    let title: string
    if (named) {
      if (noun >= 0) used[noun] = true
      title = named
    } else if (noun >= 0) {
      used[noun] = true
      const withWhom = readWith(t, noun + 1, t.length, used)
      const rest = leftover(t, 1, t.length, used)
      title = [eventNoun(n[noun])!, withWhom ? `с ${withWhom}` : '', rest].filter(Boolean).join(' ')
    } else {
      const rest = leftover(t, 1, t.length, used)
      title = rest ? cap(rest) : reminder ? 'Напоминание' : 'Встреча'
    }
    const { at: _at, ...when } = w
    void _at
    return {
      action: 'create',
      title: cap(title.trim()),
      ...when,
      ...(location ? { location } : {}),
      ...(reminder ? { reminderMin } : {}),
      ...(durationUnclear ? { durationUnclear: true as const } : {}),
      ...(timeUnclear ? { timeUnclear } : {}),
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Answers to his questions
// ---------------------------------------------------------------------------

/** Only a plain, whole-phrase yes counts — a half-heard one must not write to the calendar. */
export function confirmAnswer(text: string): 'yes' | 'no' | null {
  const t = text.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\s-]+/gu, ' ').replace(/\s+/g, ' ').trim()
  if (/^(?:да|подтверждаю|да подтверждаю|да записывай|записывай|да верно|верно|да давай|давай|да конечно|конечно|да удаляй|удаляй|да переноси|переноси|все верно|всё верно|ага да|да да)$/u.test(t)) return 'yes'
  if (/^(?:нет|не надо|не нужно|отмена|отмени|отменить|не записывай|не удаляй|не переноси|нет спасибо|стоп|не)$/u.test(t)) return 'no'
  return null
}

/** The calendar writes, each with a confirmation of its own. */
export type ConfirmOp = 'create' | 'move' | 'relocate' | 'delete'

/** The one word that carries out each write. */
export const CONFIRM_WORD: Record<ConfirmOp, string> = {
  create: 'записывай',
  move: 'переноси',
  relocate: 'меняй',
  delete: 'удаляй',
}

const CONFIRM_FOR: Record<ConfirmOp, RegExp> = {
  create: /^(?:да )?записывай$/u,
  move: /^(?:да )?переноси$/u,
  relocate: /^(?:да )?меняй$/u,
  delete: /^(?:да )?удаляй$/u,
}

/**
 * The answer to a write's read-back. Only that operation's own word carries it
 * out: a plain "да", "давай", "конечно" — the words a television or a nearby
 * conversation supplies — or another operation's word is 'mismatch', which is
 * asked again and never runs anything.
 */
export function confirmFor(text: string, op: ConfirmOp): 'yes' | 'no' | 'mismatch' | null {
  const t = text.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\s-]+/gu, ' ').replace(/\s+/g, ' ').trim()
  if (CONFIRM_FOR[op].test(t)) return 'yes'
  const plain = confirmAnswer(text)
  if (plain === 'no') return 'no'
  if (plain === 'yes' || Object.values(CONFIRM_FOR).some((re) => re.test(t))) return 'mismatch'
  return null
}

/** The "when" in an answer to "На какую дату и время?" or a correction — "измени время на 19:00". */
export function readAnswer(text: string, c: Ctx): (When & { location?: string }) | null {
  let t = tokenize(text)
  // "измени время на …", "лучше …", "давай …"
  while (t.length && /^(?:измени|поменяй|смени|сделай|пусть|будет|только|лучше|давай|тогда|нет|а|время|дату|день|на)$/.test(t[0].n) && t.length > 1) {
    if (t[0].n === 'на' && t.length > 1) break
    t = t.slice(1)
  }
  if (!t.length) return null
  // An answer is a fragment: let "15 минут" or "полчаса" read as a length,
  // and "18:00" or "шесть вечера" as a time.
  const lengthLead =
    ((/^\d{1,4}$/.test(t[0].n) || t[0].n in NUM) && /^(?:мин|час)/.test(t[numberAt(t, 0)?.len ?? 1]?.n ?? '')) ||
    /^(?:полчаса|час|полтора|четверть)$/.test(t[0].n)
  const lead = !lengthLead && (/^(?:\d{1,2}(?:[:.-]\d{2})?|полдень|полночь|половин[еуа])$/.test(t[0].n) || t[0].n in NUM)
  const tt = lengthLead ? [{ raw: 'на', n: 'на' }, ...t] : lead ? [{ raw: 'в', n: 'в' }, ...t] : t
  const used = tt.map(() => false)
  const w = readWhen(tt, 0, tt.length, used, c)
  const location = readPlace(tt, 0, tt.length, used)
  const { at: _at, ...when } = w
  void _at
  const any = Object.keys(when).length > 0 || !!location
  // Only an answer if nothing of substance was left unread: "Что у меня
  // завтра?" names a day too, and is a question of its own, not a correction.
  if (!any) return null
  if (leftover(tt, 0, tt.length, used).split(' ').filter(Boolean).length > 0) return null
  return { ...when, ...(location ? { location } : {}) }
}
