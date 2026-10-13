/**
 * Text as it should be heard, not as it was written.
 *
 * Runs on every sentence after `shape()` in tts.ts has stripped the markdown.
 * A synthesiser reads exactly what it is given: "т.е." comes out as two
 * letters, "23°C" as a digit string and a symbol name, an emoji as its Unicode
 * description, and a line without a full stop ends on a rising, unfinished
 * pitch. The prompt asks Claude to write for the ear; this catches what still
 * slips through, plus whatever tool output and fillers carry in.
 *
 * Every Russian rule here answers something the Ruslan voice was heard (by its
 * phonemes) to get wrong: "1 000 000" as "один ноль ноль ноль", "2-е" as "два
 * е", "-5" with the minus lost, "км/ч" as "ка-эм слэш че", and Latin words in
 * English phonemes the Russian model was never trained on. Things it already
 * reads correctly — Russian acronyms like МГУ, "№", "+12", "8:00" — are left
 * alone.
 *
 * Kept free of imports so it runs under plain Node for the tests.
 */

/** Russian plural form for a whole number: 1 процент, 2 процента, 5 процентов. */
export function plural(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n) % 100
  const last = abs % 10
  if (abs > 10 && abs < 20) return many
  if (last === 1) return one
  if (last >= 2 && last <= 4) return few
  return many
}

type Forms = [string, string, string]

/** A number as written, and the plural form that follows it. Fractions take the genitive singular. */
const unit = (raw: string, forms: Forms) => {
  const n = Number(raw.replace(',', '.'))
  if (!Number.isFinite(n)) return `${raw} ${forms[2]}`
  if (!Number.isInteger(n)) return `${raw} ${forms[1]}`
  return `${raw} ${plural(n, ...forms)}`
}

const NUM = '(\\d+(?:[.,]\\d+)?)'
/** Not inside a word or a longer number. */
const START = '(?<![\\p{L}\\p{N}])'
const END = '(?![\\p{L}\\p{N}])'

// ---------------------------------------------------------------------------
// Ordinals. The voice reads digits as cardinals in the nominative, which is
// right for "23 градуса" and wrong for dates and for "2-е место".
// ---------------------------------------------------------------------------

type Case =
  | 'nom' | 'nomNeuter' | 'nomFem' | 'accFem'
  | 'gen' | 'genFem' | 'dat' | 'inst' | 'prep'
  | 'pl' | 'plGen' | 'plInst'

/** Ordinal stems, 1–19 and the tens. */
const ORD_STEM: Record<number, string> = {
  1: 'перв', 2: 'втор', 3: 'трет', 4: 'четвёрт', 5: 'пят', 6: 'шест', 7: 'седьм',
  8: 'восьм', 9: 'девят', 10: 'десят', 11: 'одиннадцат', 12: 'двенадцат',
  13: 'тринадцат', 14: 'четырнадцат', 15: 'пятнадцат', 16: 'шестнадцат',
  17: 'семнадцат', 18: 'восемнадцат', 19: 'девятнадцат', 20: 'двадцат',
  30: 'тридцат', 40: 'сороков', 50: 'пятидесят', 60: 'шестидесят',
  70: 'семидесят', 80: 'восьмидесят', 90: 'девяност',
}
/** Stems whose masculine nominative is stressed -ой rather than -ый. */
const ORD_STRESSED = new Set([2, 6, 7, 8, 40])
const TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто']

const ENDINGS: Record<Case, string> = {
  nom: 'ый', nomNeuter: 'ое', nomFem: 'ая', accFem: 'ую',
  gen: 'ого', genFem: 'ой', dat: 'ому', inst: 'ым', prep: 'ом',
  pl: 'ые', plGen: 'ых', plInst: 'ыми',
}
const THIRD: Record<Case, string> = {
  nom: 'третий', nomNeuter: 'третье', nomFem: 'третья', accFem: 'третью',
  gen: 'третьего', genFem: 'третьей', dat: 'третьему', inst: 'третьим', prep: 'третьем',
  pl: 'третьи', plGen: 'третьих', plInst: 'третьими',
}

function ordinalWord(n: number, c: Case): string {
  if (n === 3) return THIRD[c]
  const end = c === 'nom' && ORD_STRESSED.has(n) ? 'ой' : ENDINGS[c]
  return ORD_STEM[n] + end
}

/** 1–99 as an ordinal: "двадцать первого". Null outside that range. */
export function ordinal(n: number, c: Case): string | null {
  if (!Number.isInteger(n) || n < 1 || n > 99) return null
  if (n < 20 || n % 10 === 0) return ordinalWord(n, c)
  return `${TENS[Math.floor(n / 10)]} ${ordinalWord(n % 10, c)}`
}

/** 1901–2099 as an ordinal year: "две тысячи двадцать шестом". */
function ordinalYear(y: number, c: Case): string | null {
  const rest = y % 100
  const head = y >= 2000 && y < 2100 ? 'две тысячи' : y >= 1900 && y < 2000 ? 'тысяча девятьсот' : null
  if (!head || rest === 0) return null
  return `${head} ${ordinal(rest, c)}`
}

/** Any number this file knows how to say as an ordinal. */
const anyOrdinal = (n: number, c: Case) => ordinal(n, c) ?? ordinalYear(n, c)

const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря']

/** The last word before `offset`, lower-cased. */
const wordBefore = (all: string, offset: number) =>
  all.slice(0, offset).trim().split(/\s+/).pop()?.toLowerCase() ?? ''

/** The case a date takes from the word in front of it. Genitive is the default: "встреча 1 августа". */
function dateCase(before: string): Case {
  // "на" and "по" take the accusative, which for "число" is the nominative form: "на первое августа".
  if (/^(сегодня|завтра|вчера|послезавтра|было|будет|наступило|это|на|по)$/.test(before)) return 'nomNeuter'
  if (before === 'к' || before === 'ко') return 'dat'
  return 'gen'
}

function speakDates(t: string): string {
  return t
    // 01.08.2026 — a numeric date, read the way people say it.
    .replace(new RegExp(`${START}(\\d{1,2})\\.(\\d{1,2})\\.(\\d{4})${END}`, 'gu'), (m, d, mo, y, offset, all) => {
      const day = Number(d), month = Number(mo)
      if (day < 1 || day > 31 || month < 1 || month > 12) return m
      const year = ordinalYear(Number(y), 'gen')
      const dayWord = ordinal(day, dateCase(wordBefore(all, offset)))
      return year ? `${dayWord} ${MONTHS_GEN[month - 1]} ${year} года` : `${dayWord} ${MONTHS_GEN[month - 1]} ${y}`
    })
    .replace(new RegExp(`${START}(\\d{1,2})\\s+(${MONTHS_GEN.join('|')})`, 'giu'), (m, d, month, offset, all) => {
      const word = ordinal(Number(d), dateCase(wordBefore(all, offset)))
      return word && Number(d) <= 31 ? `${word} ${month}` : m
    })
    .replace(new RegExp(`${START}(\\d{4})\\s*(году|года|год|г\\.)(?![\\p{L}])`, 'giu'), (m, y, word) => {
      const c: Case = /^(г\.|году)$/i.test(word) ? 'prep' : /^года$/i.test(word) ? 'gen' : 'nom'
      const spoken = ordinalYear(Number(y), c)
      const noun = /^г\.$/i.test(word) ? 'году' : word
      return spoken ? `${spoken} ${noun}` : m
    })
}

/** "2-е место", "1-го", "на 3-м этаже", "5-я попытка", "90-е". */
const ORD_SUFFIX: Record<string, Case> = {
  й: 'nom', ый: 'nom', ой: 'nom',
  го: 'gen', ого: 'gen', му: 'dat', ому: 'dat',
  ым: 'inst', ом: 'prep',
  е: 'nomNeuter', ое: 'nomNeuter', ые: 'pl',
  я: 'nomFem', ая: 'nomFem', ю: 'accFem', ую: 'accFem',
  х: 'plGen', ых: 'plGen', ми: 'plInst', ыми: 'plInst',
}
const PREP_TRIGGERS = /^(в|во|на|о|об|обо|при)$/

function speakOrdinalSuffixes(t: string): string {
  return t.replace(
    new RegExp(`${START}(\\d{1,4})-(${[...Object.keys(ORD_SUFFIX), 'м'].join('|')})(?![\\p{L}])`, 'gu'),
    (m, d, suffix, offset, all) => {
      const n = Number(d)
      let c: Case
      // "-м" is prepositional after в/на/о, instrumental otherwise: "на 3-м", "с 3-м".
      if (suffix === 'м') c = PREP_TRIGGERS.test(wordBefore(all, offset)) ? 'prep' : 'inst'
      // "90-е", "1990-е" are decades, and plural.
      else if (suffix === 'е' && n >= 20 && n % 10 === 0) c = 'pl'
      else c = ORD_SUFFIX[suffix]
      return anyOrdinal(n, c) ?? m
    },
  )
}

// ---------------------------------------------------------------------------
// Units, signs and number formatting
// ---------------------------------------------------------------------------

/** Unit abbreviations after a number. The full stop is taken only mid-sentence. */
const UNITS: Array<[string, Forms, string?]> = [
  ['км/ч', ['километр', 'километра', 'километров'], ' в час'],
  ['м/с', ['метр', 'метра', 'метров'], ' в секунду'],
  ['км', ['километр', 'километра', 'километров']],
  ['кг', ['килограмм', 'килограмма', 'килограммов']],
  ['мм', ['миллиметр', 'миллиметра', 'миллиметров']],
  ['см', ['сантиметр', 'сантиметра', 'сантиметров']],
  ['м', ['метр', 'метра', 'метров']],
  ['г', ['грамм', 'грамма', 'граммов']],
  ['л', ['литр', 'литра', 'литров']],
  ['мин', ['минута', 'минуты', 'минут']],
  ['сек', ['секунда', 'секунды', 'секунд']],
  ['ч', ['час', 'часа', 'часов']],
  ['ТБ|Тб', ['терабайт', 'терабайта', 'терабайт']],
  ['ГБ|Гб', ['гигабайт', 'гигабайта', 'гигабайт']],
  ['МБ|Мб', ['мегабайт', 'мегабайта', 'мегабайт']],
  ['КБ|Кб', ['килобайт', 'килобайта', 'килобайт']],
]

function speakUnits(t: string): string {
  for (const [abbr, forms, tail = ''] of UNITS) {
    t = t.replace(
      // The abbreviation's full stop goes when the sentence carries on — before
      // a lower-case word or a comma ("25 мин., ветер" left "минут.," and a
      // falling, sentence-final pitch in mid-phrase).
      new RegExp(`${START}${NUM}\\s?(?:${abbr})(?:\\.(?=\\s+\\p{Ll}|\\s*[,;:]))?(?![\\p{L}\\p{N}/])`, 'gu'),
      (_, n) => unit(n, forms) + tail,
    )
  }
  return t
}

function speakNumbers(t: string): string {
  return t
    // "1 000 000" — digit groups split by spaces were read as separate numbers.
    .replace(/(?<![\d.,])(\d{1,3})((?:[   ]\d{3})+)(?!\d)/g, (_, head, groups) => head + groups.replace(/\D/g, ''))
    // A minus straight before a digit: "-5" lost its sign.
    .replace(/(^|[\s(])[-−](\d)/g, '$1минус $2')
    // "1.5" was "один точка пять". Not versions like "2.0.1".
    .replace(/(?<![\d.])(\d+)\.(\d+)(?![.\d])/g, '$1,$2')
    .replace(/№\s?/g, 'номер ')
    // "2 тыс." as 2000, which the voice already declines: "две тысячи".
    .replace(/(?<![\d,])(\d+(?:,\d+)?)\s?(тыс|млн|млрд)(?:\.(?=\s+\p{Ll}|\s*[,;:]))?(?![\p{L}])/gu, (m, n, scale) => {
      const value = Number(n.replace(',', '.')) * { тыс: 1e3, млн: 1e6, млрд: 1e9 }[scale as 'тыс' | 'млн' | 'млрд']
      return Number.isInteger(value) && value < 1e13 ? String(value) : m
    })
}

/**
 * The voice says "один" and "два" whatever follows, so "2 минуты" was "два
 * минуты" and "1 место" "один место". Only nouns known to be feminine or
 * neuter are touched — a guess from the ending would turn "до 1 часа" into
 * "до одна часа".
 */
const FEMININE = /^(?:минут|секунд|недел|тысяч|штук|копе[йе]к|страниц|задач|попытк|ошибк|книг|машин|комнат|игр|песн|встреч|ссылк|вкладк|программ|букв|строк|заметк|картинк|фотографи|верси|сесси|ноч)[а-яё]*$/i
const NEUTER = /^(?:мест|окн|письм|сообщени|приложени|устройств|слов|предложени|задани|уведомлени|обновлени|правил|числ|видео)[а-яё]*$/i

function agreeGender(t: string): string {
  return t.replace(/(?<![\d,.])(\d+)\s+([а-яё]+)/giu, (m, digits, noun) => {
    const n = Number(digits)
    const last = n % 10
    if (n % 100 === 11 || n % 100 === 12 || (last !== 1 && last !== 2)) return m
    let word: string | null = null
    if (FEMININE.test(noun)) {
      if (last === 2) word = 'две'
      else if (/[ая]$/i.test(noun) || /ь$/i.test(noun)) word = 'одна'
      else if (/[ую]$/i.test(noun)) word = 'одну'
      else word = 'одной'
    } else if (NEUTER.test(noun) && last === 1 && /[ое]$/i.test(noun)) {
      word = 'одно'
    }
    if (!word) return m
    const rest = n - last
    return `${rest ? `${rest} ` : ''}${word} ${noun}`
  })
}

// ---------------------------------------------------------------------------
// Abbreviations and the letter ё
// ---------------------------------------------------------------------------

/** Abbreviations a Russian reader expands without noticing. Order matters: longest first. */
const RU_ABBREVIATIONS: Array<[RegExp, string]> = [
  // Its full stop doubles as the end of the sentence when a new one follows,
  // or the text ends — keep it there, or two sentences run together.
  [/(^|[\s(])и т\.\s?д\.(?=\s+\p{Lu}|\s*$)/gu, '$1и так далее.'],
  [/(^|[\s(])и т\.\s?п\.(?=\s+\p{Lu}|\s*$)/gu, '$1и тому подобное.'],
  [/(^|[\s(])и т\.\s?д\./giu, '$1и так далее'],
  [/(^|[\s(])и т\.\s?п\./giu, '$1и тому подобное'],
  [/(^|[\s(])т\.\s?е\./giu, '$1то есть'],
  [/(^|[\s(])т\.\s?к\./giu, '$1так как'],
  [/(^|[\s(])напр\./giu, '$1например'],
  [/(^|[\s(])см\.(?=\s+\p{L})/giu, '$1смотрите'],
  [/(^|[\s(])США(?![\p{L}])/gu, '$1сэ-шэ-а'],
]

/**
 * "е" where only "ё" is possible. Russian text drops the dots, and the voice
 * then reads "всё готово" as "все готово" — every one of them. Only the
 * unambiguous cases: "еще" is always "ещё"; "все" before a short neuter
 * predicate, before "равно", or ending a sentence is "всё".
 */
const YO_FIXES: Array<[RegExp, string]> = [
  [/(^|[^\p{L}])еще(?=$|[^\p{L}])/gu, '$1ещё'],
  [/(^|[^\p{L}])Еще(?=$|[^\p{L}])/gu, '$1Ещё'],
  [/(^|[^\p{L}])([Вв])се(?=[-\s]+(?:равно|таки|ещё|готово|понятно|ясно|хорошо|верно|сделано|нормально|правильно|в порядке|получилось|работает)(?=$|[^\p{L}]))/gu, '$1$2сё'],
  [/(^|[^\p{L}])([Вв])се(?=\s*[.!?]|\s*$)/gu, '$1$2сё'],
]

// ---------------------------------------------------------------------------
// Latin script. The Russian voice phonemises it as English — θ, ɹ, eɪ — sounds
// its model never learned, so "Python" and "API" came out mumbled. Known names
// get their Russian form, acronyms are spelled, anything else transliterated.
// ---------------------------------------------------------------------------

/** How Russians say these. Matched case-insensitively, whole words. */
const LATIN_WORDS: Record<string, string> = {
  jarvis: 'Джарвис', claude: 'Клод', anthropic: 'Антропик', github: 'Гитхаб',
  youtube: 'Ютуб', google: 'Гугл', telegram: 'Телеграм', whatsapp: 'Вотсап',
  windows: 'Виндоус', chrome: 'Хром', microsoft: 'Майкрософт', apple: 'Эппл',
  iphone: 'айфон', ipad: 'айпад', android: 'Андроид', python: 'Пайтон',
  javascript: 'джаваскрипт', typescript: 'тайпскрипт', linux: 'Линукс',
  openai: 'Опен Эй-Ай', chatgpt: 'Чат Джи-Пи-Ти', spotify: 'Спотифай',
  netflix: 'Нетфликс', tesla: 'Тесла', zoom: 'Зум', excel: 'Эксель',
  email: 'имейл', 'e-mail': 'имейл', online: 'онлайн', offline: 'офлайн',
  wifi: 'вай-фай', 'wi-fi': 'вай-фай', bluetooth: 'блютус', ok: 'окей', okay: 'окей',
  vpn: 'ви-пи-эн', ai: 'ИИ', pdf: 'пэ-дэ-эф', bmw: 'бэ-эм-вэ', mp3: 'эм-пэ-три',
  nasa: 'НАСА', nato: 'НАТО', ikea: 'Икеа', asus: 'Асус', amazon: 'Амазон',
  instagram: 'Инстаграм', twitter: 'Твиттер', facebook: 'Фейсбук', tiktok: 'Тикток',
  docker: 'Докер', piper: 'Пайпер', node: 'Ноуд', react: 'Риакт',
}

/** English letter names, as Russians spell Latin acronyms: USB — ю-эс-би. */
const LETTER: Record<string, string> = {
  a: 'эй', b: 'би', c: 'си', d: 'ди', e: 'и', f: 'эф', g: 'джи', h: 'эйч', i: 'ай',
  j: 'джей', k: 'кей', l: 'эл', m: 'эм', n: 'эн', o: 'оу', p: 'пи', q: 'кью', r: 'ар',
  s: 'эс', t: 'ти', u: 'ю', v: 'ви', w: 'дабл-ю', x: 'икс', y: 'уай', z: 'зед',
}

/** Rough English-to-Cyrillic for names nobody listed: Docker → докер, Figma → фигма. */
const TRANSLIT: Array<[RegExp, string]> = [
  [/tion/g, 'шн'], [/sh/g, 'ш'], [/ch/g, 'ч'], [/th/g, 'т'], [/ph/g, 'ф'],
  [/ck/g, 'к'], [/qu/g, 'кв'], [/oo/g, 'у'], [/ee|ea/g, 'и'], [/ou/g, 'ау'],
  [/ow/g, 'оу'], [/ai|ay/g, 'эй'], [/oa/g, 'оу'], [/kh/g, 'х'], [/zh/g, 'ж'],
  [/ts/g, 'ц'], [/x/g, 'кс'], [/j/g, 'дж'], [/w/g, 'в'], [/^y/g, 'й'], [/y/g, 'и'],
  [/c(?=[eiy])/g, 'с'], [/c/g, 'к'], [/^e/g, 'э'], [/(?<=\w{3})e$/g, ''],
]
const LATIN_LETTER: Record<string, string> = {
  a: 'а', b: 'б', d: 'д', e: 'е', f: 'ф', g: 'г', h: 'х', i: 'и', k: 'к', l: 'л',
  m: 'м', n: 'н', o: 'о', p: 'п', q: 'к', r: 'р', s: 'с', t: 'т', u: 'у', v: 'в', z: 'з',
}

function transliterate(word: string): string {
  let w = word.toLowerCase()
  for (const [re, to] of TRANSLIT) w = w.replace(re, to)
  w = w.replace(/[a-z]/g, (ch) => LATIN_LETTER[ch] ?? '')
  return /^\p{Lu}/u.test(word) ? w.charAt(0).toUpperCase() + w.slice(1) : w
}

function speakLatin(t: string): string {
  // "J.A.R.V.I.S." before the letters are taken one at a time.
  t = t.replace(/(?<![\p{L}])J\.?A\.?R\.?V\.?I\.?S\.?(?=\s|$|[,!?])/gu, 'Джарвис')
  return t.replace(/(?<![\p{L}\p{N}])[A-Za-z][A-Za-z0-9]*(?:[-'’][A-Za-z0-9]+)*(?![\p{L}])/gu, (word) => {
    const known = LATIN_WORDS[word.toLowerCase()]
    if (known) return known
    // An acronym: two to five capitals, spelled out letter by letter.
    if (/^[A-Z]{2,5}$/.test(word)) return word.toLowerCase().split('').map((ch) => LETTER[ch]).join('-')
    // A lone letter — "план B" — is its name.
    if (/^[A-Za-z]$/.test(word)) return LETTER[word.toLowerCase()]
    return word.split(/[-'’]/).map(transliterate).join('-')
  })
}

// ---------------------------------------------------------------------------

export function prepareForSpeech(input: string, lang: 'ru' | 'en'): string {
  let t = input

  // Emoji and pictographs are read aloud by name, or not at all.
  t = t.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '')

  if (lang === 'ru') {
    // Numeric dates and digit groups first, while the digits are still intact.
    t = speakDates(t)
    t = speakNumbers(t)
    // Units before abbreviations, so "5 см." is centimetres, not "смотрите".
    t = speakUnits(t)
    for (const [re, to] of RU_ABBREVIATIONS) t = t.replace(re, to)
    t = speakOrdinalSuffixes(t)
    for (const [re, to] of YO_FIXES) t = t.replace(re, to)
    t = t
      .replace(new RegExp(`${NUM}\\s?%`, 'g'), (_, n) => unit(n, ['процент', 'процента', 'процентов']))
      .replace(new RegExp(`${NUM}\\s?°\\s?[CС]?`, 'g'), (_, n) => unit(n, ['градус', 'градуса', 'градусов']))
      .replace(new RegExp(`${NUM}\\s?(?:₽|руб\\.?)(?=\\s|$|[,.!?])`, 'g'), (_, n) => unit(n, ['рубль', 'рубля', 'рублей']))
      .replace(new RegExp(`\\$\\s?${NUM}`, 'g'), (_, n) => unit(n, ['доллар', 'доллара', 'долларов']))
      .replace(new RegExp(`${NUM}\\s?\\$`, 'g'), (_, n) => unit(n, ['доллар', 'доллара', 'долларов']))
      .replace(new RegExp(`${NUM}\\s?€`, 'g'), (_, n) => `${n} евро`)
      .replace(/\s&\s/g, ' и ')
    // After units, so "2 мин" has already become "2 минуты".
    t = agreeGender(t)
    t = speakLatin(t)
  } else {
    t = t
      .replace(/(^|\s)e\.g\./gi, '$1for example')
      .replace(/(^|\s)i\.e\./gi, '$1that is')
      .replace(new RegExp(`${NUM}\\s?%`, 'g'), '$1 percent')
      .replace(new RegExp(`${NUM}\\s?°\\s?C`, 'g'), '$1 degrees')
  }

  t = t
    // A dash between words is a pause in speech; a comma is the pause every
    // engine honours. Hyphens inside words ("кто-то") are left alone.
    .replace(/\s+[—–-]+\s+/g, ', ')
    // Brackets are an aside, said with a small pause either side.
    .replace(/\s*\(([^()]{1,120})\)\s*/g, ', $1, ')
    // Quotation marks are not pronounced.
    .replace(/["«»“”„]/g, '')
    .replace(/…/g, '...')
    // "!!!" and "?!?" carry no more than one mark does.
    .replace(/([!?])[!?]+/g, '$1')
    // A semicolon is a comma's pause to the ear.
    .replace(/;/g, ',')
    // Tidy what the substitutions above can leave behind.
    .replace(/\s+([,.!?:])/g, '$1')
    .replace(/,\s*([.!?:])/g, '$1')
    // An abbreviation's stop left in front of a comma is not a sentence end.
    .replace(/\.(?=\s*[,;:])/g, '')
    .replace(/,{2,}/g, ',')
    .replace(/^[\s,]+/, '')
    .replace(/\s+/g, ' ')
    .trim()

  // A line with no terminator ends on a rising, unfinished pitch, which is
  // most noticeable on short lines like "Готово" or "Слушаю".
  if (t && /[\p{L}\p{N}]$/u.test(t)) t += '.'
  else if (t.endsWith(',')) t = `${t.slice(0, -1)}.`

  return t
}
