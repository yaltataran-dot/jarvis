/**
 * Questions the page can answer itself, at once, without asking the model.
 *
 * Measured on the bridge, each of these was a full model turn of 1.7–4.8 s to
 * its first word — and "который час" was answered wrongly or not at all
 * ("точного времени у меня нет"): the model does not know the local time, and
 * it does not know which voice it is being spoken with. The page knows both.
 *
 * Deliberately narrow. A phrase is answered here only when the WHOLE of it is
 * one of these questions, give or take a "скажи" in front and a "пожалуйста"
 * or "сэр" behind. "Как тебя зовут по-английски" or "который час в Токио" is
 * not, and goes to the model as before. Nothing here changes anything.
 */

export type LocalState = {
  now: Date
  /** The voice he speaks with, as the HUD shows it: "Руслан (Piper)". */
  voice: string
  /** Whether the bridge — and so the model — is reachable. */
  connected: boolean
}

export type LocalKind = 'name' | 'time' | 'date' | 'voice' | 'hearing' | 'link'

/** Lower case, ё as е, no punctuation, no polite padding. */
export function normalise(said: string): string {
  return said
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[.,!?;:«»"“”…()-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:джарвис |юг трансфер )?(?:скажи(?:те)? |подскажи(?:те)? )?(?:пожалуйста )?/, '')
    .replace(/(?: пожалуйста| сэр| джарвис)+$/, '')
    .trim()
}

const RULES: Array<[LocalKind, RegExp]> = [
  ['name', /^(?:как тебя зовут|как твое имя|кто ты(?: такой)?|представься)$/],
  ['time', /^(?:который (?:сейчас )?час|сколько (?:сейчас )?времени|сколько времени сейчас|какое сейчас время)$/],
  [
    'date',
    /^(?:какое (?:сегодня |сейчас )?число(?: сегодня)?|какая (?:сегодня |сейчас )?дата(?: сегодня)?|какой (?:сегодня )?день недели(?: сегодня)?|какой сегодня день)$/,
  ],
  [
    'voice',
    /^(?:какой (?:у тебя )?голос(?: ты (?:сейчас )?используешь)?|каким голосом ты (?:сейчас )?(?:говоришь|разговариваешь)|какой голос ты (?:сейчас )?используешь)$/,
  ],
  ['hearing', /^(?:ты меня слышишь|слышишь меня|ты слышишь меня|микрофон работает|работает ли микрофон)$/],
  ['link', /^(?:ты на связи|ты подключен|ты онлайн)$/],
]

/** Which local question a phrase is, if it is one. */
export function localKind(said: string): LocalKind | null {
  const t = normalise(said)
  for (const [kind, re] of RULES) if (re.test(t)) return kind
  return null
}

const UNITS = ['ноль', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять']
const TEENS = ['десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать']
const TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят']

/** 0–59 in words; minutes take the feminine "одна", "две". */
function cardinal(n: number, feminine = false): string {
  const unit = (u: number) => (feminine && u === 1 ? 'одна' : feminine && u === 2 ? 'две' : UNITS[u])
  if (n < 10) return unit(n)
  if (n < 20) return TEENS[n - 10]
  const u = n % 10
  return u ? `${TENS[Math.floor(n / 10)]} ${unit(u)}` : TENS[Math.floor(n / 10)]
}

/** "шестнадцать сорок две", "девять ноль пять", "двадцать один ноль-ноль". */
export function sayClock(h: number, m: number): string {
  const hours = cardinal(h)
  if (m === 0) return `${hours} ноль-ноль`
  return m < 10 ? `${hours} ноль ${cardinal(m, true)}` : `${hours} ${cardinal(m, true)}`
}

const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота']
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря']
/** The day of the month as it is said after "сегодня": "шестнадцатое". */
const DAYS = [
  '', 'первое', 'второе', 'третье', 'четвертое', 'пятое', 'шестое', 'седьмое', 'восьмое', 'девятое', 'десятое',
  'одиннадцатое', 'двенадцатое', 'тринадцатое', 'четырнадцатое', 'пятнадцатое', 'шестнадцатое', 'семнадцатое',
  'восемнадцатое', 'девятнадцатое', 'двадцатое', 'двадцать первое', 'двадцать второе', 'двадцать третье',
  'двадцать четвертое', 'двадцать пятое', 'двадцать шестое', 'двадцать седьмое', 'двадцать восьмое',
  'двадцать девятое', 'тридцатое', 'тридцать первое',
]

/**
 * The spoken answer, or null when the phrase is not one of these questions —
 * or is, but the page has nothing true to say (no voice known yet), in which
 * case the model is asked as before.
 */
export function localAnswer(said: string, s: LocalState): string | null {
  const kind = localKind(said)
  switch (kind) {
    case 'name':
      return 'Юг-Трансфер, ваш голосовой помощник.'
    case 'time':
      return `${capital(sayClock(s.now.getHours(), s.now.getMinutes()))}.`
    case 'date':
      return `Сегодня ${WEEKDAYS[s.now.getDay()]}, ${DAYS[s.now.getDate()]} ${MONTHS[s.now.getMonth()]}.`
    case 'voice': {
      const name = s.voice.replace(/\(.*?\)/g, '').trim()
      if (!name) return null
      return /piper/i.test(s.voice)
        ? `Голос ${name}, локальный синтезатор Пайпер.`
        : `Сейчас голос ${name}: локальный синтезатор недоступен.`
    }
    case 'hearing':
      // This phrase came through the microphone, so it works.
      return 'Слышу вас хорошо.'
    case 'link':
      return s.connected ? 'На связи, сэр.' : 'Связь с мостом потеряна, восстанавливаю.'
    default:
      return null
  }
}

const capital = (t: string) => t.charAt(0).toUpperCase() + t.slice(1)
