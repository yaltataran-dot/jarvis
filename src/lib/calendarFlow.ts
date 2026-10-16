/**
 * A calendar operation as a conversation: prepare it, ask for what is
 * missing, read it back, wait for a yes, carry it out, and say what the
 * calendar answered.
 *
 *   preparing -> asking (a date, a time, which one) -> confirming -> running
 *            -> done | failed | cancelled
 *
 * The rules that keep it safe:
 *
 *   - Each write has its own word — «записывай», «переноси», «меняй»,
 *     «удаляй» — and only that word carries it out. A plain "да", "давай",
 *     "конечно" or another write's word is asked again and runs nothing, and
 *     the read-back's 30 seconds are not extended by asking again.
 *   - Nothing is written without a yes to *this* draft. Every draft carries an
 *     operation id; a correction ("измени время на 19:00") makes a new draft
 *     that is read back again; a yes after the question has expired, after the
 *     draft was refused, or after the user moved on to something else does not
 *     reach the calendar.
 *   - Anything that is not an answer ends the question. The phrase is then
 *     handled as the new command it is, so "да" two commands later is never
 *     taken as a yes to a meeting long gone.
 *   - Which event is meant is never guessed. Several matches are listed and
 *     asked about; none is said plainly.
 *   - Success is said only when the calendar has confirmed it. An answer that
 *     never came is "unknown", said as such, and the draft keeps its operation
 *     id, so saying yes again cannot create a second event (see the bridge's
 *     event ids).
 *
 * Pure apart from the `api` it is given, which the page backs with the
 * bridge's /calendar route and the tests with a fake.
 */

import {
  addDays,
  addMinutes,
  compare,
  dateIso,
  localIso,
  parseApiTime,
  rfc3339,
  sameDay,
  sayDate,
  sayTime,
  toInstant,
  zonedNow,
  type LocalDate,
  type LocalDateTime,
  type LocalTime,
} from './calendarTime'
import {
  CONFIRM_WORD,
  confirmAnswer,
  confirmFor,
  parseCalendarCommand,
  readAnswer,
  type CalendarIntent,
  type ConfirmOp,
  type Ctx,
  type DayPart,
  type When,
} from './calendarIntent'
import { mismatch } from './calendarCheck'
import { STOP_ONLY } from './stopWords'

// ---------------------------------------------------------------------------
// What the bridge answers
// ---------------------------------------------------------------------------

export type CalEvent = {
  id: string
  etag?: string
  summary: string
  location?: string
  /** dateTime or date, as the API sent them, in the calendar's zone. */
  start: string
  end: string
}

export type CalCode =
  | 'ok'
  | 'not-connected'
  /** The authorisation was revoked or expired for good: connect again. */
  | 'auth'
  | 'forbidden'
  | 'rate'
  | 'network'
  /** A write whose outcome could not be established. */
  | 'unknown'
  /** The event changed in the calendar since it was read. */
  | 'conflict'
  | 'not-found'
  | 'writes-disabled'
  | 'bridge'
  | 'failed'

export type CalResult = {
  code: CalCode
  events?: CalEvent[]
  event?: CalEvent
  /** The create found the event it was about to make already there (same id). */
  already?: boolean
  message?: string
}

export type CalStatus = { connected: boolean; writes: boolean; timeZone: string }

export type CalApi = {
  status(): Promise<CalStatus | null>
  list(timeMin: string, timeMax: string, query?: string): Promise<CalResult>
  create(e: {
    opId: string
    summary: string
    location?: string
    timeZone: string
    start: { dateTime?: string; date?: string }
    end: { dateTime?: string; date?: string }
    reminderMin?: number
  }): Promise<CalResult>
  update(e: {
    id: string
    etag?: string
    timeZone: string
    start?: { dateTime?: string; date?: string }
    end?: { dateTime?: string; date?: string }
    location?: string
  }): Promise<CalResult>
  remove(e: { id: string; etag?: string }): Promise<CalResult>
}

/** What he says, and whether he waits for an answer to it. */
export type Reply = {
  say: string
  expectAnswer: boolean
  /**
   * Set on a read-back. The page calls `heard(readBack)` once it has been
   * spoken to the end; until then its confirmation word is not accepted.
   */
  readBack?: string
}

/** How long a question (a date, which one, go on?) waits for its answer. */
export const ANSWER_MS = 60_000
/**
 * How long a write's read-back waits for its confirmation, counted from the
 * read-back itself. Asking again after a wrong answer does not extend it.
 */
export const CONFIRM_MS = 30_000
/** A meeting with no length given is this long, and the read-back says so. */
export const DEFAULT_MINUTES = 60
/** How many events are read out before he asks whether to go on. */
const READ_AT_ONCE = 5

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

type CreateDraft = {
  op: 'create'
  opId: string
  title: string
  location?: string
  date: LocalDate
  allDay: boolean
  time?: LocalTime
  end?: LocalTime
  /** Minutes; the end may fall on the next day. */
  durationMin: number
  reminderMin?: number
  yearRolled?: boolean
  /** The calendar already has a meeting by this name at this time. */
  duplicateOf?: CalEvent
  /** A write was sent and its outcome is not known: the same id is reused. */
  attempted?: boolean
  /** No length was named: DEFAULT_MINUTES, and the read-back says so. */
  defaultLength?: boolean
  /** The phrase this draft was made from, checked against it again before writing. */
  said: string
}
type MoveDraft = { op: 'move'; opId: string; event: CalEvent; start: LocalDateTime | LocalDate; end: LocalDateTime | LocalDate; allDay: boolean }
type RelocateDraft = { op: 'relocate'; opId: string; event: CalEvent; location: string }
type DeleteDraft = { op: 'delete'; opId: string; event: CalEvent }
type Draft = CreateDraft | MoveDraft | RelocateDraft | DeleteDraft

type Pending =
  /** A create waiting for its date, time or length. */
  | { kind: 'when'; base: Extract<CalendarIntent, { action: 'create' }>; need: 'date' | 'time' | 'day' | 'duration' }
  /** Several events match; which one. */
  | { kind: 'which'; intent: Extract<CalendarIntent, { action: 'move' | 'relocate' | 'delete' | 'when' }>; options: CalEvent[] }
  /** A relocate waiting for the new place. */
  | { kind: 'place'; event: CalEvent }
  | { kind: 'confirm'; draft: Draft }
  /** More events to read out. */
  | { kind: 'more'; rest: CalEvent[]; today: LocalDate }

/** `heard`: a read-back has been spoken in full — only then may it be confirmed. */
type Asked = { p: Pending; until: number; heard: boolean }

// ---------------------------------------------------------------------------

const plural = (n: number, one: string, few: string, many: string) => {
  const a = n % 100
  const b = n % 10
  if (a >= 11 && a <= 14) return many
  if (b === 1) return one
  if (b >= 2 && b <= 4) return few
  return many
}
const meetings = (n: number) => `${n} ${plural(n, 'встреча', 'встречи', 'встреч')}`

const fold = (s: string) =>
  s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** The words of a query, cut to their stems: "Иваном" finds "Иван". */
const stems = (q: string) =>
  fold(q)
    .split(' ')
    .filter((w) => w.length > 1 && !['с', 'со', 'в', 'на', 'у'].includes(w))
    .map((w) => (w.length > 5 ? w.slice(0, w.length - 2) : w.length > 3 ? w.slice(0, w.length - 1) : w))

export function matchesQuery(e: CalEvent, query: string): boolean {
  const words = stems(query)
  if (!words.length) return true
  const hay = fold(`${e.summary} ${e.location ?? ''}`)
  return words.every((w) => hay.includes(w))
}

/** "сегодня в 18:00", "в пятницу, 16 октября, в 18:00", "18 октября, весь день". */
function sayWhen(e: CalEvent, today: LocalDate): string {
  const s = parseApiTime(e.start)
  if (!s) return ''
  if (s.allDay) return `${sayDate(s, today)}, весь день`
  return `${sayDate(s, today)} в ${sayTime(s)}`
}

const nameOf = (title: string) => (fold(title) === 'встреча' ? 'встречу' : `«${title}»`)

/** "на завтра", "на 18 октября", "на воскресенье, 18 октября" — never "на в …". */
const onDay = (said: string) => `на ${said.startsWith('в ') ? said.slice(2) : said}`

function sayEvent(e: CalEvent, today: LocalDate, withDay: boolean): string {
  const s = parseApiTime(e.start)
  const at = !s ? '' : s.allDay ? 'весь день' : `в ${sayTime(s)}`
  const day = withDay && s ? `${sayDate(s, today)} ` : ''
  return `${day}${at} — ${e.summary || 'без названия'}${e.location ? `, ${e.location}` : ''}`
}

/** The infinitive each write is asked again with: "Чтобы удалить, скажите «удаляй»". */
const CONFIRM_VERB: Record<ConfirmOp, string> = {
  create: 'записать',
  move: 'перенести',
  relocate: 'изменить место',
  delete: 'удалить',
}

const sayConfirmWord = (op: ConfirmOp) => `Скажите «${CONFIRM_WORD[op]}».`

/** A failure in one short sentence. `op` is the write it concerns, when there is one. */
export function sayFailure(r: CalResult, writing: boolean, op?: ConfirmOp): string {
  switch (r.code) {
    case 'not-connected':
      return 'Google Календарь не подключён. Запустите npm run calendar:connect.'
    case 'auth':
      return 'Нужно заново подключить Google Календарь: запустите npm run calendar:connect.'
    case 'forbidden':
      return 'У JARVIS нет доступа к этому календарю.'
    case 'rate':
      return 'Google ограничил число запросов. Попробуйте через минуту.'
    case 'network':
    case 'bridge':
      return writing ? 'Не удалось подключиться к календарю — ничего не изменено.' : 'Не удалось подключиться к календарю.'
    case 'unknown':
      return op
        ? `Не удалось проверить результат: календарь не ответил. Ничего не повторяю, чтобы не создать дубль. Скажите «${CONFIRM_WORD[op]}» ещё раз, чтобы проверить и при необходимости повторить.`
        : 'Не удалось проверить результат: календарь не ответил. Ничего не повторяю, чтобы не создать дубль.'
    case 'conflict':
      return 'Эту встречу только что изменили в календаре. Повторите команду.'
    case 'not-found':
      return 'Не нашёл такую встречу — возможно, её уже удалили.'
    case 'writes-disabled':
      return 'Запись в календарь выключена. Чтобы разрешить, задайте JARVIS_CALENDAR_WRITES=1 и перезапустите JARVIS.'
    default:
      return `Не получилось: ${r.message ?? 'календарь не ответил'}.`
  }
}

/** "с 16:00 до 16:15"; an end on the next day says so: "с 23:30 до 0:30 следующего дня". */
function sayRange(s: LocalDateTime, e: LocalDateTime, today: LocalDate): string {
  const until = sameDay(e, s) ? sayTime(e) : sameDay(e, addDays(s, 1)) ? `${sayTime(e)} следующего дня` : `${sayTime(e)}, ${sayDate(e, today)}`
  return `с ${sayTime(s)} до ${until}`
}

/** What a create draft gets wrong about the phrase it was made from (calendarCheck.ts), or null. */
function checkDraft(d: CreateDraft): string | null {
  if (d.allDay || !d.time) return null
  const end = addMinutes({ ...d.date, ...d.time }, d.durationMin)
  return mismatch(d.said, {
    start: d.time,
    end: { hh: end.hh, mm: end.mm },
    durationMin: d.durationMin,
    defaultLength: !!d.defaultLength,
    ...(d.reminderMin !== undefined ? { reminderMin: d.reminderMin } : {}),
  })
}

/** An API time as a moment: with its offset as written, without one in the calendar's zone (never the browser's). */
function instantOf(s: string, tz: string): number {
  if (/(?:[zZ]|[+-]\d{2}:\d{2})$/.test(s)) return Date.parse(s)
  const v = parseApiTime(s)
  return v && !v.allDay ? toInstant(v, tz).getTime() : NaN
}

/**
 * What the calendar says it wrote — its own start and end, not the draft's —
 * and a plain warning when they are not what was read back and confirmed.
 */
function sayCreated(d: CreateDraft, r: CalResult, tz: string, today: LocalDate): string {
  const done = r.already ? 'Эта встреча уже была записана' : nameOf(d.title) === 'встречу' ? 'Встреча записана' : `Записал «${d.title}»`
  const place = d.location ? `, ${d.location}` : ''
  const ev = r.event
  if (d.allDay) {
    const got = ev ? parseApiTime(ev.start) : null
    if (got?.allDay && sameDay(got, d.date)) return `Готово. ${done} ${onDay(sayDate(got, today))}, на весь день${place}.`
    return `${done}, но календарь не подтвердил дату. Проверьте событие в календаре.`
  }
  const startAt = { ...d.date, ...d.time! }
  const want = [toInstant(startAt, tz).getTime(), toInstant(addMinutes(startAt, d.durationMin), tz).getTime()]
  const got = ev ? [instantOf(ev.start, tz), instantOf(ev.end, tz)] : [NaN, NaN]
  if (got.some((x) => Number.isNaN(x))) return `${done}, но календарь не вернул время события. Проверьте его в календаре.`
  // Compared as instants, and said in the calendar's zone, whatever offset Google wrote them with.
  const s = zonedNow(new Date(got[0]), tz)
  const e = zonedNow(new Date(got[1]), tz)
  const said = `${onDay(sayDate(s, today))} ${sayRange(s, e, today)}`
  if (got[0] === want[0] && got[1] === want[1]) return `Готово. ${done} ${said}${place}.`
  return `${done}, но календарь сохранил другое время: ${said}. Проверьте событие в календаре.`
}

/** A short random id for one operation — the event id is derived from it. */
const newOpId = () =>
  Array.from({ length: 20 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('')

// ---------------------------------------------------------------------------

export type CalendarFlow = {
  /**
   * Handle a phrase. The reply, or null if the phrase is not about the
   * calendar (and no calendar question was waiting for it) — the caller then
   * sends it on as before.
   */
  handle(text: string): Promise<Reply | null>
  /** Drop any question or draft: the user has stood down or moved on. */
  cancel(): void
  /** Is a calendar question waiting for an answer? */
  waiting(): boolean
  /** The read-back `Reply.readBack` names has been spoken to the end. */
  heard(readBack: string): void
}

export function createCalendarFlow(o: { api: CalApi; now?: () => Date; zone?: string; opId?: () => string }): CalendarFlow {
  const api = o.api
  const now = o.now ?? (() => new Date())
  const opId = o.opId ?? newOpId
  let asked: Asked | null = null
  let cachedStatus: { s: CalStatus; at: number } | null = null

  const status = async (): Promise<CalStatus | null> => {
    if (cachedStatus && now().getTime() - cachedStatus.at < 30_000) return cachedStatus.s
    const s = await api.status().catch(() => null)
    if (s) cachedStatus = { s, at: now().getTime() }
    return s
  }

  const zone = async () => (await status())?.timeZone || o.zone || Intl.DateTimeFormat().resolvedOptions().timeZone
  const ctxIn = (tz: string): Ctx => {
    const z = zonedNow(now(), tz)
    return { now: { y: z.y, m: z.m, d: z.d, hh: z.hh, mm: z.mm }, today: { y: z.y, m: z.m, d: z.d } }
  }

  /**
   * Wait for an answer. A read-back (`confirm`) is not `heard` until the page
   * says it was spoken to the end — unless `heard` is passed, for a question
   * about a read-back already heard.
   */
  const ask = (p: Pending, say: string, o: { heard?: boolean } = {}): Reply => {
    // A read-back is frozen as it was said — a copy, so nothing that still
    // holds the event can change it: the confirmation runs exactly what was
    // read out.
    if (p.kind === 'confirm') p = { kind: 'confirm', draft: deepFreeze(structuredClone(p.draft)) }
    const heard = p.kind !== 'confirm' || !!o.heard
    asked = { p, until: now().getTime() + (p.kind === 'confirm' ? CONFIRM_MS : ANSWER_MS), heard }
    return { say, expectAnswer: true, ...(p.kind === 'confirm' && !heard ? { readBack: p.draft.opId } : {}) }
  }
  const tell = (say: string): Reply => {
    asked = null
    return { say, expectAnswer: false }
  }

  /** Events between two days (end exclusive), in the calendar's zone. */
  const listDays = async (from: LocalDate, days: number, tz: string, query?: string) =>
    api.list(rfc3339({ ...from, hh: 0, mm: 0 }, tz), rfc3339({ ...addDays(from, days), hh: 0, mm: 0 }, tz), query)

  // -- create -----------------------------------------------------------------

  /**
   * A create with everything it needs, or the question for what it lacks.
   * `said` is the phrase that gave this step its values; the draft is checked
   * against it before it is ever read back.
   */
  const prepareCreate = async (base: Extract<CalendarIntent, { action: 'create' }>, tz: string, c: Ctx, said: string): Promise<Reply> => {
    const st = await status()
    if (!st) return tell(sayFailure({ code: 'bridge' }, true))
    if (!st.connected) return tell(sayFailure({ code: 'not-connected' }, true))
    if (!st.writes) return tell(sayFailure({ code: 'writes-disabled' }, true))

    if (!base.date && base.week) return ask({ kind: 'when', base, need: 'day' }, `В какой день ${base.week === 'next' ? 'следующей' : 'этой'} недели и во сколько?`)
    if (!base.date && !base.time) return ask({ kind: 'when', base, need: 'date' }, `На какую дату и время записать ${nameOf(base.title)}?`)
    const date = base.date ?? c.today
    // "в 17 часов 15 минут": 17:15, or 17:00 for a quarter of an hour. Never chosen — both asked for.
    if (base.timeUnclear) {
      const { hh, mm } = base.timeUnclear
      const { timeUnclear: _u, time: _t, ...rest } = base
      void _u
      void _t
      return ask(
        { kind: 'when', base: { ...rest, date, durationUnclear: true }, need: 'time' },
        `Не понял: начало в ${hh}:${String(mm).padStart(2, '0')} или в ${hh}:00 на ${mm} минут? Скажите начало и длительность, например: «в ${hh}:00 на ${mm} минут».`,
      )
    }
    if (!base.time && !base.allDay) return ask({ kind: 'when', base: { ...base, date }, need: 'time' }, 'Во сколько именно?')
    // A length was spoken but not understood: ask for it, never put the default hour in its place.
    const noLength = !!base.end && !!base.time && base.end.hh === base.time.hh && base.end.mm === base.time.mm
    if ((base.durationUnclear && !base.end && !base.allDay) || noLength) {
      return ask({ kind: 'when', base: { ...base, date }, need: 'duration' }, 'Не понял длительность. Сколько продлится встреча? Например: «на 15 минут» или «до 16:30».')
    }

    const draft: CreateDraft = {
      op: 'create',
      opId: opId(),
      title: base.title,
      ...(base.location ? { location: base.location } : {}),
      date,
      allDay: !!base.allDay && !base.time,
      ...(base.time ? { time: base.time } : {}),
      ...(base.end ? { end: base.end } : {}),
      durationMin: base.end && base.time ? minutesBetween(base.time, base.end) : (base.durationMin ?? DEFAULT_MINUTES),
      ...(!base.allDay && !base.end && base.durationMin === undefined ? { defaultLength: true } : {}),
      ...(base.reminderMin !== undefined ? { reminderMin: base.reminderMin } : {}),
      ...(base.yearRolled ? { yearRolled: true } : {}),
      said,
    }
    // Read the phrase a second time, independently: anything said that the
    // draft does not carry stops it here, before it is read back or written.
    const wrong = checkDraft(draft)
    if (wrong) {
      const { time: _t, durationMin: _d, end: _e, timeUnclear: _u, ...rest } = base
      void _t
      void _d
      void _e
      void _u
      return ask(
        { kind: 'when', base: { ...rest, date, durationUnclear: true }, need: 'time' },
        `Не записываю: ${wrong}. Скажите начало и длительность ещё раз, например: «в 17:00 на 15 минут».`,
      )
    }
    if (draft.time && compare({ ...date, ...draft.time }, c.now) < 0) {
      return ask({ kind: 'when', base: { ...base, date: undefined, time: undefined }, need: 'date' }, `${sayDate(date, c.today)} в ${sayTime(draft.time)} уже прошло. На какое время записать?`)
    }
    // The same meeting at the same time already there: say so before writing a twin.
    if (draft.time) {
      const day = await listDays(date, 1, tz)
      const twin = day.code === 'ok' ? day.events?.find((e) => fold(e.summary) === fold(draft.title) && sameStart(e, { ...date, ...draft.time! })) : undefined
      if (twin) draft.duplicateOf = twin
    }
    return ask({ kind: 'confirm', draft }, readBack(draft, c.today))
  }

  /** The read-back, ending with the one word that carries it out. */
  const readBack = (d: Draft, today: LocalDate): string => `${question(d, today)} ${sayConfirmWord(d.op)}`

  const question = (d: Draft, today: LocalDate): string => {
    switch (d.op) {
      case 'create': {
        const startAt = d.allDay ? null : { ...d.date, ...d.time! }
        const when = !startAt
          ? `${sayDate(d.date, today)} на весь день`
          : `${sayDate(d.date, today)} ${sayRange(startAt, addMinutes(startAt, d.durationMin), today)}`
        // The hour put in for a length nobody named is said, so a length lost
        // on the way is heard before it is written.
        const length = d.defaultLength ? ' — длительность не названа, ставлю час' : ''
        const year = d.yearRolled ? ` — это ${d.date.y} год` : ''
        const remind = d.reminderMin === undefined ? '' : d.reminderMin === 0 ? ', с уведомлением в начале' : `, с уведомлением за ${d.reminderMin} мин.`
        const twin = d.duplicateOf ? ' Такая встреча уже есть в календаре на это время — всё равно записать?' : ''
        return `Записать ${nameOf(d.title)} ${when}${length}${d.location ? `, ${d.location}` : ''}${remind}${year}?${twin}`
      }
      case 'move': {
        const to = 'hh' in d.start ? `${sayDate(d.start, today)} в ${sayTime(d.start)}` : `${sayDate(d.start, today)}, весь день`
        return `Перенести ${nameOf(d.event.summary)}, ${sayWhen(d.event, today)}, ${onDay(to)}?`
      }
      case 'relocate': {
        const of = fold(d.event.summary) === 'встреча' ? 'встречи' : `«${d.event.summary}»`
        return `Изменить место ${of} ${sayWhen(d.event, today)} на «${d.location}»?`
      }
      case 'delete':
        return `Удалить ${nameOf(d.event.summary)} ${sayWhen(d.event, today)}?`
    }
  }

  /** Carry out a confirmed draft, and say what the calendar answered. */
  const run = async (d: Draft, tz: string, c: Ctx): Promise<Reply> => {
    if (d.op === 'create') {
      // Once more, at the last moment: a draft that does not match what was said is not sent.
      const wrong = checkDraft(d)
      if (wrong) return tell(`Не записываю: ${wrong}. Повторите команду.`)
      const start = d.allDay ? { date: dateIso(d.date) } : { dateTime: localIso({ ...d.date, ...d.time! }) }
      const end = d.allDay ? { date: dateIso(addDays(d.date, 1)) } : { dateTime: localIso(addMinutes({ ...d.date, ...d.time! }, d.durationMin)) }
      const r = await api.create({
        opId: d.opId,
        summary: d.title,
        ...(d.location ? { location: d.location } : {}),
        timeZone: tz,
        start,
        end,
        ...(d.reminderMin !== undefined ? { reminderMin: d.reminderMin } : {}),
      })
      if (r.code === 'unknown') {
        // Keep the draft, and its id, for a second yes.
        return ask({ kind: 'confirm', draft: { ...d, attempted: true } }, sayFailure(r, true, d.op), { heard: true })
      }
      if (r.code !== 'ok') return tell(sayFailure(r, true))
      return tell(sayCreated(d, r, tz, c.today))
    }
    if (d.op === 'delete') {
      const r = await api.remove({ id: d.event.id, etag: d.event.etag })
      if (r.code === 'unknown') return ask({ kind: 'confirm', draft: d }, sayFailure(r, true, d.op), { heard: true })
      if (r.code !== 'ok') return tell(sayFailure(r, true))
      return tell(`Готово. Удалил ${nameOf(d.event.summary)} ${sayWhen(d.event, c.today)}.`)
    }
    const patch =
      d.op === 'move'
        ? d.allDay
          ? { start: { date: dateIso(d.start) }, end: { date: dateIso(d.end) } }
          : { start: { dateTime: localIso(d.start as LocalDateTime) }, end: { dateTime: localIso(d.end as LocalDateTime) } }
        : { location: d.location }
    const r = await api.update({ id: d.event.id, etag: d.event.etag, timeZone: tz, ...patch })
    if (r.code === 'unknown') return ask({ kind: 'confirm', draft: d }, sayFailure(r, true, d.op), { heard: true })
    if (r.code !== 'ok') return tell(sayFailure(r, true))
    const ev = r.event ?? d.event
    if (d.op === 'move') return tell(`Готово. Перенёс ${nameOf(ev.summary)} ${onDay(sayWhen(ev, c.today))}.`)
    return tell(`Готово. Место изменено: ${d.location}.`)
  }

  // -- finding the event meant --------------------------------------------------

  /** Candidates for "встреча с Батони" / "встреча сегодня в 18:00". */
  const findEvents = async (query: string, on: LocalDate | undefined, at: LocalTime | undefined, tz: string, c: Ctx) => {
    const r = on ? await listDays(on, 1, tz) : await listDays(c.today, 60, tz)
    if (r.code !== 'ok') return r
    let events = (r.events ?? []).filter((e) => matchesQuery(e, query))
    if (at) events = events.filter((e) => {
      const s = parseApiTime(e.start)
      return s && !s.allDay && s.hh === at.hh && s.mm === at.mm
    })
    // Without a name or a day, only what is still ahead.
    if (!query && !on) events = events.filter((e) => {
      const s = parseApiTime(e.end)
      return !s || s.allDay || compare(s, c.now) > 0
    })
    return { code: 'ok' as const, events }
  }

  /** One event decided, or a question about which. */
  const pick = async (
    intent: Extract<CalendarIntent, { action: 'move' | 'relocate' | 'delete' | 'when' }>,
    tz: string,
    c: Ctx,
    then: (e: CalEvent) => Promise<Reply>,
  ): Promise<Reply> => {
    const on = 'on' in intent ? intent.on : undefined
    const at = 'at' in intent ? intent.at : undefined
    const r = await findEvents(intent.query, on, at, tz, c)
    if (r.code !== 'ok') return tell(sayFailure(r, intent.action !== 'when'))
    const events = r.events ?? []
    if (!events.length) return tell(intent.action === 'when' ? 'Не нашёл такую встречу.' : 'Не нашёл такую встречу.')
    if (events.length === 1) return then(events[0])
    if (intent.action === 'when') {
      return tell(`Нашёл ${meetings(events.length)}: ${events.slice(0, 3).map((e) => sayEvent(e, c.today, true)).join('; ')}.`)
    }
    const verb = intent.action === 'delete' ? 'удалить' : intent.action === 'relocate' ? 'изменить' : 'перенести'
    const options = events.slice(0, 4)
    const list = options.map((e) => sayWhen(e, c.today)).join(', ')
    const what = intent.query ? ` ${intent.query.startsWith('с ') ? '' : 'с '}${intent.query}` : ''
    return ask(
      { kind: 'which', intent, options },
      `Я нашёл ${meetings(events.length)}${what}: ${list}${events.length > options.length ? ' и другие' : ''}. Какую ${verb}?`,
    )
  }

  const onPicked = async (intent: Extract<CalendarIntent, { action: 'move' | 'relocate' | 'delete' | 'when' }>, e: CalEvent, c: Ctx): Promise<Reply> => {
    if (intent.action === 'when') return tell(`${cap(e.summary || 'Встреча')} — ${sayWhen(e, c.today)}${e.location ? `, ${e.location}` : ''}.`)
    const st = await status()
    if (!st?.writes) return tell(sayFailure({ code: st ? 'writes-disabled' : 'bridge' }, true))
    if (intent.action === 'delete') return ask({ kind: 'confirm', draft: { op: 'delete', opId: opId(), event: e } }, readBack({ op: 'delete', opId: '', event: e }, c.today))
    if (intent.action === 'relocate') {
      if (!intent.location) return ask({ kind: 'place', event: e }, 'Какое новое место?')
      const draft: RelocateDraft = { op: 'relocate', opId: opId(), event: e, location: intent.location }
      return ask({ kind: 'confirm', draft }, readBack(draft, c.today))
    }
    const draft = moveDraft(e, intent.to, intent.shiftMin, c)
    if (!draft) return tell('Не понял, на когда перенести.')
    if ('hh' in draft.start && compare(draft.start, c.now) < 0) return tell(`${sayDate(draft.start, c.today)} в ${sayTime(draft.start)} уже прошло. Назовите другое время.`)
    return ask({ kind: 'confirm', draft }, readBack(draft, c.today))
  }

  // -- reading ----------------------------------------------------------------

  const readList = async (from: LocalDate, days: number, label: string, tz: string, c: Ctx): Promise<Reply> => {
    const st = await status()
    if (!st) return tell(sayFailure({ code: 'bridge' }, false))
    if (!st.connected) return tell(sayFailure({ code: 'not-connected' }, false))
    const r = await listDays(from, days, tz)
    if (r.code !== 'ok') return tell(sayFailure(r, false))
    const events = r.events ?? []
    const head = label ? cap(label) : cap(sayDate(from, c.today))
    if (!events.length) return tell(`${head} встреч нет.`)
    const multi = days > 1
    const first = events.slice(0, READ_AT_ONCE).map((e) => sayEvent(e, c.today, multi))
    const rest = events.slice(READ_AT_ONCE)
    const text = `${head} ${meetings(events.length)}: ${first.join('; ')}.`
    if (rest.length) return ask({ kind: 'more', rest, today: c.today }, `${text} И ещё ${rest.length}. Продолжить?`)
    return tell(text)
  }

  const readNext = async (tz: string, c: Ctx): Promise<Reply> => {
    const st = await status()
    if (!st) return tell(sayFailure({ code: 'bridge' }, false))
    if (!st.connected) return tell(sayFailure({ code: 'not-connected' }, false))
    const r = await api.list(rfc3339(c.now, tz), rfc3339({ ...addDays(c.today, 30), hh: 0, mm: 0 }, tz))
    if (r.code !== 'ok') return tell(sayFailure(r, false))
    // The next one to begin — not one already under way, and a timed meeting
    // before a whole-day entry.
    const events = r.events ?? []
    const next =
      events.find((e) => {
        const s = parseApiTime(e.start)
        return !!s && !s.allDay && compare(s, c.now) >= 0
      }) ?? events.find((e) => parseApiTime(e.start)?.allDay)
    if (!next) return tell('Ближайших встреч в календаре нет.')
    return tell(`Следующая встреча — ${next.summary || 'без названия'}, ${sayWhen(next, c.today)}${next.location ? `, ${next.location}` : ''}.`)
  }

  // -- answers ------------------------------------------------------------------

  /** An answer to the question waiting, or null if the phrase is not one. */
  const answer = async (p: Pending, text: string, tz: string, c: Ctx): Promise<Reply | null> => {
    const yesNo = confirmAnswer(text)
    if (p.kind === 'confirm') {
      const op = p.draft.op
      const verdict = confirmFor(text, op)
      const current = asked?.p === p ? asked : null
      if (verdict === 'yes' && !current?.heard) {
        // The word came before the read-back was heard to the end — over it,
        // or after it was cut off. Nothing is written without the date, the
        // start and the end said first: say them again, same deadline.
        asked = { p, until: current?.until ?? now().getTime(), heard: false }
        return { say: `Сначала дослушайте. ${readBack(p.draft, c.today)}`, expectAnswer: true, readBack: p.draft.opId }
      }
      if (verdict === 'yes') {
        asked = null
        return run(p.draft, tz, c)
      }
      if (verdict === 'mismatch') {
        // Agreement, but not this operation's word: ask again, run nothing,
        // and keep the deadline the read-back set — asking buys no time.
        asked = { p, until: current?.until ?? now().getTime(), heard: current?.heard ?? false }
        return { say: `Чтобы ${CONFIRM_VERB[op]}, скажите «${CONFIRM_WORD[op]}». Или «нет» — чтобы отменить.`, expectAnswer: true }
      }
      if (verdict === 'no') return tell(p.draft.op === 'delete' ? 'Хорошо, не удаляю.' : p.draft.op === 'create' ? 'Хорошо, не записываю.' : 'Хорошо, оставляю как было.')
      // A correction to a meeting being created: a new draft, read back again.
      const fix = readAnswer(text, c)
      if (fix && p.draft.op === 'create') {
        const d = p.draft
        const base: Extract<CalendarIntent, { action: 'create' }> = {
          action: 'create',
          title: d.title,
          date: fix.date ?? d.date,
          ...(fix.time ?? d.time ? { time: fix.time ?? d.time } : {}),
          // A new end or length replaces the old; otherwise the length read
          // back is kept — and a default stays a default, said as such again.
          ...(fix.end ? { end: fix.end } : fix.durationMin ? { durationMin: fix.durationMin } : d.defaultLength ? {} : { durationMin: d.durationMin }),
          ...((fix.location ?? d.location) ? { location: fix.location ?? d.location } : {}),
          ...(d.reminderMin !== undefined ? { reminderMin: d.reminderMin } : {}),
          ...(fix.allDay ? { allDay: true } : {}),
          ...(fix.date ? (fix.yearRolled ? { yearRolled: true } : {}) : d.yearRolled ? { yearRolled: true } : {}),
        }
        if (fix.part && !fix.time && base.time) base.time = withPart(base.time, fix.part)
        return prepareCreate(base, tz, c, text)
      }
      if (fix && p.draft.op === 'move') {
        const draft = moveDraft(p.draft.event, fix, undefined, c)
        if (draft) return ask({ kind: 'confirm', draft }, readBack(draft, c.today))
      }
      return null
    }
    if (yesNo === 'no') return tell('Хорошо, отменил.')
    if (p.kind === 'more') {
      if (yesNo === 'yes') {
        const now5 = p.rest.slice(0, READ_AT_ONCE).map((e) => sayEvent(e, p.today, true))
        const rest = p.rest.slice(READ_AT_ONCE)
        if (rest.length) return ask({ kind: 'more', rest, today: p.today }, `${now5.join('; ')}. И ещё ${rest.length}. Продолжить?`)
        return tell(`${now5.join('; ')}.`)
      }
      return null
    }
    if (p.kind === 'when') {
      const fix = readAnswer(text, c)
      if (!fix) return null
      const b = p.base
      let time = fix.time ?? b.time
      const part = fix.part ?? b.part
      if (time && part && !fix.part && b.part) time = withPart(time, b.part)
      const next: Extract<CalendarIntent, { action: 'create' }> = {
        ...b,
        ...(fix.date ?? b.date ? { date: fix.date ?? b.date } : {}),
        ...(time ? { time } : {}),
        ...(part && !time ? { part } : {}),
        ...(fix.durationMin ? { durationMin: fix.durationMin } : {}),
        ...(fix.end ? { end: fix.end } : {}),
        ...(fix.location ? { location: fix.location } : {}),
        ...(fix.allDay ? { allDay: true } : {}),
        ...(fix.yearRolled ? { yearRolled: true } : {}),
      }
      if (fix.durationMin || fix.end) delete next.durationUnclear
      if (fix.durationMin && !fix.end) delete next.end
      if (fix.date || fix.week) delete next.week
      if (time) delete next.part
      return prepareCreate(next, tz, c, text)
    }
    if (p.kind === 'place') {
      const place = text.trim().replace(/^(?:на|в)\s+/i, '').replace(/[.!?]+$/, '')
      // "Хватит" is not a place: it was read back as one, «Изменить место на
      // «Хватит»?». A stop ends the question like any non-answer.
      if (!place || yesNo || STOP_ONLY.test(text)) return null
      const draft: RelocateDraft = { op: 'relocate', opId: opId(), event: p.event, location: place }
      return ask({ kind: 'confirm', draft }, readBack(draft, c.today))
    }
    if (p.kind === 'which') {
      const chosen = choose(p.options, text, c)
      if (!chosen) return null
      asked = null
      return onPicked(p.intent, chosen, c)
    }
    return null
  }

  return {
    async handle(text) {
      // Most phrases are not about the calendar: tell that from the words
      // alone, before asking the bridge anything.
      if (!asked || now().getTime() > asked.until) {
        const local = o.zone || Intl.DateTimeFormat().resolvedOptions().timeZone
        if (!parseCalendarCommand(text, ctxIn(local))) {
          asked = null
          return null
        }
      }
      const tz = await zone()
      const c = ctxIn(tz)
      if (asked && now().getTime() > asked.until) asked = null
      if (asked) {
        const p = asked.p
        const r = await answer(p, text, tz, c).catch(() => tell(sayFailure({ code: 'bridge' }, p.kind === 'confirm')))
        if (r) return r
        // Not an answer: the question is over, and the phrase is a command of its own.
        asked = null
      }
      const intent = parseCalendarCommand(text, c)
      if (!intent) return null
      try {
        switch (intent.action) {
          case 'create':
            return await prepareCreate(intent, tz, c, text)
          case 'list':
            return await readList(intent.from, intent.days, intent.label, tz, c)
          case 'next':
            return await readNext(tz, c)
          case 'when':
          case 'move':
          case 'relocate':
          case 'delete': {
            if (intent.action !== 'when') {
              const st = await status()
              if (!st) return tell(sayFailure({ code: 'bridge' }, true))
              if (!st.connected) return tell(sayFailure({ code: 'not-connected' }, true))
              if (!st.writes) return tell(sayFailure({ code: 'writes-disabled' }, true))
            }
            return await pick(intent, tz, c, (e) => onPicked(intent, e, c))
          }
        }
      } catch {
        return tell(sayFailure({ code: 'bridge' }, intent.action !== 'list' && intent.action !== 'next' && intent.action !== 'when'))
      }
    },
    cancel() {
      asked = null
    },
    waiting: () => !!asked && now().getTime() <= asked.until,
    heard(readBack) {
      if (asked?.p.kind === 'confirm' && asked.p.draft.opId === readBack) asked.heard = true
    },
  }
}

// ---------------------------------------------------------------------------

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v)
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k])
  }
  return v
}

function minutesBetween(a: LocalTime, b: LocalTime): number {
  const m = b.hh * 60 + b.mm - (a.hh * 60 + a.mm)
  return m > 0 ? m : m + 24 * 60
}

/** An hour heard without its part of the day, put into the part already given. */
function withPart(t: LocalTime, part: DayPart): LocalTime {
  if ((part === 'evening' || part === 'day') && t.hh < 12) return { ...t, hh: t.hh + 12 }
  if (part === 'morning' && t.hh >= 12 && t.hh < 24) return { ...t, hh: t.hh - 12 }
  return t
}

function sameStart(e: CalEvent, v: LocalDateTime): boolean {
  const s = parseApiTime(e.start)
  return !!s && !s.allDay && compare(s, v) === 0
}

/**
 * Where an event goes: a new time keeps its day, a new day keeps its time, a
 * shift moves both; the length is kept either way.
 */
function moveDraft(e: CalEvent, to: When, shiftMin: number | undefined, c: Ctx): MoveDraft | null {
  const s = parseApiTime(e.start)
  const en = parseApiTime(e.end)
  if (!s || !en) return null
  if (s.allDay || en.allDay) {
    if (!to.date) return null
    const days = Math.round((Date.UTC(en.y, en.m - 1, en.d) - Date.UTC(s.y, s.m - 1, s.d)) / 86_400_000)
    return { op: 'move', opId: newOpId(), event: e, start: to.date, end: addDays(to.date, days), allDay: true }
  }
  const length = Math.round((Date.UTC(en.y, en.m - 1, en.d, en.hh, en.mm) - Date.UTC(s.y, s.m - 1, s.d, s.hh, s.mm)) / 60_000)
  let start: LocalDateTime
  if (shiftMin) start = addMinutes(s, shiftMin)
  else if (to.date || to.time) {
    const time = to.time ? (to.part ? withPart(to.time, to.part) : to.time) : { hh: s.hh, mm: s.mm }
    const date = to.date ?? { y: s.y, m: s.m, d: s.d }
    start = { ...date, ...time }
  } else return null
  void c
  return { op: 'move', opId: newOpId(), event: e, start, end: addMinutes(start, length), allDay: false }
}

/** "вторую", "сегодняшнюю", "которая в 19:00", "в ресторане" — which of the options. */
function choose(options: CalEvent[], text: string, c: Ctx): CalEvent | null {
  const t = fold(text)
  const ordinals: Array<[RegExp, number]> = [
    [/^(?:первую|первая|первый|первое|1)/, 0], [/^(?:вторую|вторая|второй|второе|2)/, 1],
    [/^(?:третью|третья|третий|третье|3)/, 2], [/^(?:четвертую|четвертая|4)/, 3],
  ]
  for (const [re, i] of ordinals) if (re.test(t) && options[i]) return options[i]
  if (/^(?:последн)/.test(t)) return options[options.length - 1]
  const byDay = (d: LocalDate) => options.filter((e) => {
    const s = parseApiTime(e.start)
    return s && sameDay(s, d)
  })
  if (/сегодн/.test(t)) {
    const m = byDay(c.today)
    if (m.length === 1) return m[0]
  }
  if (/послезавтр/.test(t)) {
    const m = byDay(addDays(c.today, 2))
    if (m.length === 1) return m[0]
  } else if (/завтр/.test(t)) {
    const m = byDay(addDays(c.today, 1))
    if (m.length === 1) return m[0]
  }
  const a = readAnswer(text, c)
  if (a?.time || a?.date) {
    const m = options.filter((e) => {
      const s = parseApiTime(e.start)
      if (!s) return false
      if (a.date && !sameDay(s, a.date)) return false
      if (a.time && (s.allDay || s.hh !== a.time.hh || s.mm !== a.time.mm)) return false
      return true
    })
    if (m.length === 1) return m[0]
  }
  const named = options.filter((e) => matchesQuery(e, text))
  if (named.length === 1 && stems(text).length) return named[0]
  return null
}
