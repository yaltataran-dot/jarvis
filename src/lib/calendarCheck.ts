/**
 * A second reading of what was said, against what is about to be written.
 *
 * calendarIntent.ts reads a phrase into a draft. This file does not trust
 * that reading: it looks at the same words with a few plain rules of its own
 * — every clock time said must be the start or the end, every length said
 * must be the length — and names anything the draft does not match. A
 * mismatch stops the write; the user is asked again instead.
 *
 * It shares no code with the parser on purpose. A fault in one reading is then
 * unlikely to be repeated by the other, which is the whole point of reading
 * twice.
 */

export type Checked = {
  /** Start and end as wall-clock times in the calendar's zone. */
  start: { hh: number; mm: number }
  end: { hh: number; mm: number }
  durationMin: number
  /** The length was not said; the default was put in. */
  defaultLength: boolean
  reminderMin?: number
}

const WORDS: Record<string, number> = {
  ноль: 0, один: 1, одну: 1, одна: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, восемь: 8,
  девять: 9, десять: 10, одиннадцать: 11, двенадцать: 12, тринадцать: 13, четырнадцать: 14, пятнадцать: 15,
  шестнадцать: 16, семнадцать: 17, восемнадцать: 18, девятнадцать: 19, двадцать: 20, тридцать: 30, сорок: 40,
  пятьдесят: 50,
}

/**
 * Lower case, ё as е, number words as digits ("сорок пять" -> "45"),
 * punctuation as spaces — except inside a clock time: "17:00" and "17-00"
 * become "17:00", "17.30" becomes "17;30" (a time only after в/с/до, since
 * "18.11" is also a date).
 */
function normalise(text: string): string[] {
  const raw = text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/(\d)[:-](\d{2})(?!\d)/g, '$1:$2')
    .replace(/(\d)\.(\d{2})(?![\d.])/g, '$1;$2')
    .replace(/[^\p{L}\d:;\s]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
  const out: string[] = []
  for (let i = 0; i < raw.length; i++) {
    const w = raw[i]
    if (w in WORDS) {
      let v = WORDS[w]
      const next = raw[i + 1]
      if (v >= 20 && v % 10 === 0 && next && next in WORDS && WORDS[next] > 0 && WORDS[next] < 10) {
        v += WORDS[next]
        i++
      }
      out.push(String(v))
    } else out.push(w)
  }
  return out
}

const sameClock = (a: { hh: number; mm: number }, hh: number, mm: number) => a.mm === mm && (a.hh === hh || a.hh % 12 === hh % 12)
const clock = (t: { hh: number; mm: number }) => `${t.hh}:${String(t.mm).padStart(2, '0')}`

/**
 * What the draft gets wrong about the phrase, in a few words to say aloud, or
 * null when everything said is in it.
 */
export function mismatch(text: string, d: Checked): string | null {
  const w = normalise(text)
  const lengths: number[] = []
  for (let i = 0; i < w.length; i++) {
    const prev = w[i - 1] ?? ''
    // "через 15 минут" is a start, "за 15 минут" a reminder: neither is a length.
    const relative = prev === 'через' || prev === 'за' || w[i - 2] === 'через' || w[i - 2] === 'за'

    // A clock time: "17:00", and "17.30" after в/с/до/к (otherwise "18.11" is a date).
    const hm = /^(\d{1,2})([:;])(\d{2})$/.exec(w[i])
    if (hm) {
      const hh = Number(hm[1])
      const mm = Number(hm[3])
      if (hm[2] === ';' && !['в', 'во', 'с', 'со', 'до', 'к', 'на'].includes(prev)) continue
      if (!sameClock(d.start, hh, mm) && !sameClock(d.end, hh, mm)) return `в запросе ${hh}:${hm[3]}, а в записи ${clock(d.start)}–${clock(d.end)}`
      continue
    }

    // Lengths: "на 15 минут", "15 мин", "2 часа", "на час", "полчаса", "четверть часа", "полтора часа".
    if (w[i] === 'полчаса') {
      if (!relative) lengths.push(30)
      continue
    }
    if (w[i] === 'четверть' && /^час/.test(w[i + 1] ?? '')) {
      if (!relative) lengths.push(15)
      i++
      continue
    }
    if (w[i] === 'полтора' && /^час/.test(w[i + 1] ?? '')) {
      if (!relative) lengths.push(90)
      i++
      continue
    }
    if (w[i] === 'час' && (prev === 'на' || /^(?:длительност|продолжительност)/.test(prev))) {
      lengths.push(60)
      continue
    }
    if (/^\d{1,3}$/.test(w[i])) {
      const n = Number(w[i])
      const unit = w[i + 1] ?? ''
      if (/^мин/.test(unit)) {
        if (!relative) lengths.push(n)
        i++
        continue
      }
      if (/^час/.test(unit)) {
        if (relative) {
          i++
          continue
        }
        // "в 17 часов", "к 5 часам": the hour of the start, not a length.
        if (['в', 'во', 'к', 'с'].includes(prev)) {
          if (d.start.hh !== n && d.start.hh % 12 !== n % 12) return `в запросе ${n} часов, а начало в ${clock(d.start)}`
        } else lengths.push(n * 60)
        i++
        continue
      }
    }
  }
  for (const n of lengths) {
    if (d.reminderMin === n) continue
    if (d.defaultLength) return `в запросе длительность ${n} мин., а в записи стандартный час`
    if (d.durationMin !== n) return `в запросе длительность ${n} мин., а в записи ${d.durationMin} мин.`
  }
  return null
}
