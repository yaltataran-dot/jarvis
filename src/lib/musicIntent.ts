/**
 * Music commands, recognised in the page and carried out without the model.
 *
 * "Пауза", "следующий трек", "сделай громче" are actions with one meaning, and
 * sending them to Claude would cost seconds and a paid turn for an answer that
 * was never in doubt. They are matched here and handed to the bridge's /music
 * route (bridge/yandexMusic.mjs); everything else goes to the model as before.
 *
 * The grammar is deliberately narrow. "Включи" alone says nothing about music —
 * "включи камеру", "включи свет" — so a phrase is only taken as a music command
 * when it names music: a music noun ("песню", "трек", "альбом", "музыку"), a
 * transport word with its noun ("следующий трек"), the user's own playlists
 * ("мне нравится", "мой плейлист Дорога"), or Yandex Music itself. Anything
 * looser goes to the model, which has the same actions as tools and can ask
 * what was meant. A phrase that is plainly about music but does not say what
 * to play ("включи песню") asks rather than guesses.
 *
 * Songs and playlists are kept apart: "включи песню Мне нравится" searches for
 * a song; "включи Мне нравится" starts the user's own liked playlist, which is
 * never looked for in the public search.
 *
 * Kept free of imports so the tests can run it directly.
 */

export type MusicKind = 'track' | 'album' | 'artist' | 'playlist' | 'any'

export type MusicIntent =
  | { action: 'open' }
  | { action: 'play' }
  | { action: 'pause' }
  | { action: 'next' }
  | { action: 'prev' }
  | { action: 'volume'; delta: number }
  | { action: 'volume'; set: number }
  | { action: 'now' }
  | { action: 'restart' }
  | { action: 'search'; query: string; kind: MusicKind; play: boolean }
  /** One of the user's own playlists: "Мне нравится", or one by name. */
  | { action: 'playlist'; liked: true; play: boolean }
  | { action: 'playlist'; name: string; play: boolean }
  /** Plainly about music, but what to play is missing. */
  | { action: 'clarify'; kind: MusicKind; play: boolean }

/** Lower case, ё folded, punctuation gone, the assistant's name and "please" dropped. */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}%\s-]+/gu, ' ')
    .replace(/(^|\s)-+|-+(\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:(?:эй|слушай|окей|ок)\s+)?(?:юг[\s-]*трансфер|джарвис|jarvis)\s*/u, '')
    .replace(/(^|\s)пожалуйста(?=\s|$)/gu, ' ')
    .replace(/^(?:а|ну|давай|так)\s+/u, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const YM = '(?:яндекс[\\s-]?музык[ауие]|музык[ау] яндекс)'
const PLAY_VERB = '(?:включи|включай|вруби|поставь|запусти|сыграй|играй|проиграй|воспроизведи)'
const FIND_VERB = '(?:найди|поищи|ищи|покажи)'
const TRACK_NOUN = '(?:трек|песн[июяе]|композици[июя])'

/**
 * The user's "Мне нравится" — by its name or by what it is. Its own phrases
 * only: "включи песню мне нравится" names a song, and goes to search.
 */
const LIKED =
  '(?:мне нравится|мои (?:любимые|избранные|понравившиеся) (?:песни|треки)|мои лайки|' +
  'любимые (?:песни|треки)|понравившиеся(?: (?:песни|треки))?|избранное|' +
  '(?:мой )?плейлист (?:с лайками|лайков|мне нравится)|плейлист (?:любимых|понравившихся) (?:песен|треков))'
/** A playlist name that means "Мне нравится" itself. */
const LIKED_NAME = /^(?:мне нравится|с лайками|лайков|лайки)$/u

/** The noun that says what kind of thing is wanted. */
const KIND_NOUNS: Array<[RegExp, MusicKind]> = [
  [/^(?:песню|песня|трек|композицию|композиция|сингл)$/u, 'track'],
  [/^(?:альбом|пластинку)$/u, 'album'],
  [/^(?:исполнителя|группу|артиста|певца|певицу|песни|треки|музыку)$/u, 'artist'],
]
const KIND_WORD =
  '(?:песню|песня|трек|композицию|композиция|сингл|альбом|пластинку|исполнителя|группу|артиста|певца|певицу|песни|треки|музыку)'

const kindOf = (noun: string): MusicKind => KIND_NOUNS.find(([re]) => re.test(noun))?.[1] ?? 'any'

/** Words that may surround a volume word without changing what it means. */
const VOLUME_FILLER = new Set([
  'сделай', 'сделайте', 'включи', 'можно', 'еще', 'ещё', 'немного', 'чуть', 'чуть-чуть', 'капельку',
  'музыку', 'музыка', 'звук', 'громкость', 'песню', 'трек', 'по', 'на',
])

const re = (src: string) => new RegExp(`^(?:${src})$`, 'u')

const OPEN = re(`(?:открой|запусти|разверни)(?: приложение)? ${YM}`)
const RESTART = re(`перезапусти ${YM}`)
const PLAY = re(
  [
    `${PLAY_VERB}(?: мне)? (?:${YM}|музыку|какую-нибудь музыку|что-нибудь|мою волну)`,
    `(?:продолжи|продолжай|возобнови|верни)(?: играть)? (?:музыку|воспроизведение|песню|трек)`,
    `(?:сними|сними музыку|сними трек) с паузы`,
    `(?:играй|продолжай) дальше`,
    `музыку`,
  ].join('|'),
)
const PAUSE = re(
  [
    `пауза`,
    `(?:поставь )?(?:музыку |песню |трек )?на паузу`,
    `поставь на паузу (?:музыку|песню|трек)`,
    `(?:останови|выключи|отключи|приостанови|заглуши|стоп|убери) (?:музыку|музыка|песню|трек|воспроизведение|${YM})`,
    `(?:музыку|песню|трек) (?:выключи|останови|на паузу)`,
  ].join('|'),
)
const NEXT = re(
  [
    `(?:включи |поставь |давай )?следующ(?:ий|ая|ую|ее) ${TRACK_NOUN}`,
    `(?:переключи|пропусти|смени)(?: этот)? (?:трек|песню)`,
    `(?:другой трек|другую песню)`,
  ].join('|'),
)
const PREV = re(
  [
    `(?:включи |поставь |верни )?(?:предыдущ(?:ий|ая|ую|ее)|прошл(?:ый|ая|ую|ое)) ${TRACK_NOUN}`,
    `(?:верни|вернись|включи) (?:трек|песню) назад`,
    `(?:трек|песню) назад`,
  ].join('|'),
)
const NOW = re(
  [
    `(?:что|какая песня|какой трек)(?: сейчас)? (?:играет|звучит)`,
    `что (?:это )?за (?:песня|трек|музыка)(?: играет)?`,
    `как называется (?:эта |этот )?(?:песня|трек)`,
    `кто (?:это )?(?:поет|исполняет)`,
    `кто (?:сейчас )?(?:исполнитель|поет)`,
    `какая (?:сейчас )?песня(?: сейчас)?(?: играет)?`,
  ].join('|'),
)
const VOLUME_SET = /^(?:(?:поставь|сделай|выставь) )?громкость(?: музыки)?(?: на)? (\d{1,3})(?: ?%| процент(?:ов|а)?)?$/u

/** "Громче", "сделай музыку погромче", "прибавь громкость". */
function volumeDelta(t: string): number | null {
  const words = t.split(' ')
  const up = /^(?:громче|погромче)$/u
  const down = /^(?:тише|потише)$/u
  // "Громче"/"тише" surrounded only by words that cannot change the meaning:
  // "говори громче" is about his voice, so "говори" keeps it out.
  const core = words.filter((w) => !VOLUME_FILLER.has(w))
  if (core.length === 1 && up.test(core[0])) return +1
  if (core.length === 1 && down.test(core[0])) return -1
  if (/^(?:прибавь|увеличь|подними|добавь|повысь)(?: (?:еще|ещё|немного|чуть))? (?:громкость|звук)(?: музыки)?$/u.test(t)) return +1
  if (/^(?:убавь|уменьши|понизь|снизь|убери)(?: (?:еще|ещё|немного|чуть))? (?:громкость|звук)(?: музыки)?$/u.test(t)) return -1
  if (/^громкость (?:выше|больше|громче)$/u.test(t)) return +1
  if (/^громкость (?:ниже|меньше|тише)$/u.test(t)) return -1
  return null
}

/**
 * Words that are music commands only while music is the subject — right after
 * he has played, paused or skipped something. "Продолжи" otherwise asks him to
 * go on talking, "дальше" to go on with whatever he was doing.
 */
const IN_CONTEXT: Array<[RegExp, MusicIntent]> = [
  [/^(?:продолжи|продолжай|играй|играй дальше|включай)$/u, { action: 'play' }],
  [/^(?:следующий|следующую|следующая|дальше|пропусти|другую|другой)$/u, { action: 'next' }],
  [/^(?:предыдущий|предыдущую|предыдущая|назад)$/u, { action: 'prev' }],
  [/^(?:останови|выключи)$/u, { action: 'pause' }],
]

/** What remains of a search phrase once the destination ("в яндекс музыке") is dropped. */
const cleanQuery = (q: string) =>
  q
    .replace(new RegExp(`\\s+(?:на|в|из) ${YM}$`, 'u'), '')
    // "трек X исполнителя Y" — the search wants the words, not the grammar.
    .replace(/\s+(?:исполнителя|группы|в исполнении)\s+/u, ' ')
    .trim()

/**
 * The intent in a phrase, or null if it is not a music command. `inMusic`:
 * music is the subject right now, so the bare words in IN_CONTEXT count.
 */
export function parseMusicCommand(text: string, opts: { inMusic?: boolean } = {}): MusicIntent | null {
  const t = normalise(text)
  if (!t) return null

  if (RESTART.test(t)) return { action: 'restart' }
  if (OPEN.test(t)) return { action: 'open' }

  const set = VOLUME_SET.exec(t)
  if (set) return { action: 'volume', set: Math.min(100, Number(set[1])) }
  const delta = volumeDelta(t)
  if (delta !== null) return { action: 'volume', delta }

  if (PAUSE.test(t)) return { action: 'pause' }
  if (NEXT.test(t)) return { action: 'next' }
  if (PREV.test(t)) return { action: 'prev' }
  if (NOW.test(t)) return { action: 'now' }
  if (PLAY.test(t)) return { action: 'play' }

  // "Включи Мне нравится", "включи мои любимые песни", "продолжи мой плейлист
  // Мне нравится" — the user's own liked playlist, never a search.
  if (new RegExp(`^(?:${PLAY_VERB}|продолжи|продолжай)(?: мне)? ${LIKED}(?: (?:в|на|из) ${YM})?$`, 'u').test(t)) {
    return { action: 'playlist', liked: true, play: true }
  }
  // "Включи мой плейлист Дорога", "запусти плейлист Для работы", "найди мой
  // плейлист Любимые песни": the user's own playlists, by name.
  const own = new RegExp(
    `^(${PLAY_VERB}|${FIND_VERB}|открой|продолжи)(?: мне)? (?:мой |мою |из моих )?(?:плейлист|подборку)(?: (.+))?$`,
    'u',
  ).exec(t)
  if (own) {
    const play = !new RegExp(`^(?:${FIND_VERB}|открой)$`, 'u').test(own[1])
    const name = cleanQuery(own[2] ?? '')
    if (!name) return { action: 'clarify', kind: 'playlist', play }
    if (LIKED_NAME.test(name)) return { action: 'playlist', liked: true, play }
    return { action: 'playlist', name, play }
  }

  // "Включи песню Кино", "поставь альбом Nevermind", "найди песни Земфиры".
  const named = new RegExp(`^(${PLAY_VERB}|${FIND_VERB})(?: мне)? (${KIND_WORD})(?: (.+))?$`, 'u').exec(t)
  if (named) {
    const play = !new RegExp(`^${FIND_VERB}$`, 'u').test(named[1])
    const kind = kindOf(named[2])
    const query = cleanQuery(named[3] ?? '')
    if (!query) return { action: 'clarify', kind, play }
    return { action: 'search', query, kind, play }
  }

  // "Включи Земфиру в Яндекс Музыке", "найди Кино на Яндекс Музыке".
  // "Мне" here belongs to the verb ("включи мне …"), not to the title.
  const there = new RegExp(`^(${PLAY_VERB}|${FIND_VERB})(?: мне| нам)? (.+) (?:на|в) ${YM}$`, 'u').exec(t)
  if (there) {
    const play = !new RegExp(`^${FIND_VERB}$`, 'u').test(there[1])
    return { action: 'search', query: cleanQuery(there[2]), kind: 'any', play }
  }

  if (opts.inMusic) for (const [pattern, intent] of IN_CONTEXT) if (pattern.test(t)) return intent

  return null
}

/** A yes to "включить?" after a search, or a no. */
export function parseYesNo(text: string): 'yes' | 'no' | null {
  const t = normalise(text)
  if (/^(?:да|ага|угу|давай|включай|включи|ставь|поставь|конечно|да включи|да давай|играй)$/u.test(t)) return 'yes'
  if (/^(?:нет|не надо|не нужно|не включай|отмена|не)$/u.test(t)) return 'no'
  return null
}

// ---------------------------------------------------------------------------
// What the bridge reports, and what he says about it
// ---------------------------------------------------------------------------

export type MusicCode =
  | 'ok'
  /** The app is not installed where it should be. */
  | 'not-installed'
  /** The app is not running, and this action does not start it. */
  | 'not-running'
  /** The app is running but was not started with the control port. */
  | 'no-control'
  /** Nothing is loaded in the player — said by a source that can see it. */
  | 'nothing-playing'
  /** The app is open, and Windows sees no playback in it. */
  | 'idle'
  /** No source could tell what is playing. */
  | 'unknown'
  /** The search found nothing, or the user has no playlist by that name. */
  | 'not-found'
  /** Several of the user's playlists answer to the name. */
  | 'ambiguous'
  /** The playlist was found, and has no tracks to play. */
  | 'empty'
  /** The action ran but the player did not change the way it should have. */
  | 'unconfirmed'
  /** The bridge could not be reached at all. */
  | 'bridge'
  | 'failed'

export type MusicResult = {
  code: MusicCode
  playing?: boolean
  title?: string | null
  artist?: string | null
  /** 0–100. */
  volume?: number
  /** The first result of a search. */
  found?: { title: string; artist?: string | null; kind?: string } | null
  /** The user's playlist that was found or started. */
  playlist?: string
  /** The playlists that tie, when the name was ambiguous. */
  options?: string[]
  /** The user's playlists, when the one asked for is not among them. */
  playlists?: string[]
  /** A player other than the Yandex Music app, when it is the one reporting. */
  source?: string
  message?: string
}

const KIND_ASK: Record<MusicKind, string> = {
  track: 'Какую песню включить?',
  album: 'Какой альбом включить?',
  artist: 'Чью музыку включить?',
  playlist: 'Какой из ваших плейлистов включить?',
  any: 'Что включить?',
}

const track = (title?: string | null, artist?: string | null) =>
  title ? `«${title}»${artist ? `, ${artist}` : ''}` : ''

/** The one short sentence he says once the bridge has answered. */
export function musicReply(intent: MusicIntent, r: MusicResult): string {
  switch (r.code) {
    case 'bridge':
      return 'Нет связи с модулем управления — музыкой сейчас управлять не могу.'
    case 'not-installed':
      return 'Приложение Яндекс Музыки не найдено на этом компьютере.'
    case 'not-running':
      return 'Яндекс Музыка не запущена. Скажите «включи Яндекс Музыку».'
    case 'no-control':
      return 'Яндекс Музыка открыта без доступа для ассистента. Скажите «перезапусти Яндекс Музыку».'
    case 'nothing-playing':
      return 'Сейчас ничего не играет.'
    case 'idle':
      return 'Яндекс Музыка открыта, но воспроизведение в ней не запущено.'
    case 'unknown':
      return 'Не удалось определить состояние воспроизведения.'
    case 'ambiguous':
      return `Нашёл несколько плейлистов: ${(r.options ?? []).join(', ')}. Какой включить?`
    case 'empty':
      return `Плейлист «${r.playlist ?? ''}» пуст — включать нечего.`
    case 'not-found':
      if (intent.action === 'playlist') {
        if ('liked' in intent) return 'Не нашёл плейлист «Мне нравится» в вашей коллекции.'
        const list = r.playlists?.length ? ` Ваши плейлисты: ${r.playlists.join(', ')}.` : ''
        return `У вас нет плейлиста «${intent.name}».${list}`
      }
      return intent.action === 'search' ? `По запросу «${intent.query}» ничего не нашёл.` : 'Ничего не нашёл.'
    case 'unconfirmed':
      switch (intent.action) {
        case 'pause':
          return 'Не получилось поставить на паузу — музыка всё ещё играет.'
        case 'next':
        case 'prev':
          return 'Трек не переключился.'
        case 'volume':
          return 'Громкость не изменилась.'
        case 'playlist':
          return 'Плейлист нашёл, но воспроизведение не началось.'
        default:
          return 'Команду отправил, но музыка не включилась.'
      }
    case 'failed':
      return `Не получилось: ${r.message ?? 'Яндекс Музыка не ответила'}.`
  }

  const now = track(r.title, r.artist)
  // Another player than the app reported it — a browser tab, say: name it.
  const where = r.source ? ` (${r.source})` : ''
  switch (intent.action) {
    case 'open':
      return 'Открываю Яндекс Музыку.'
    case 'restart':
      return 'Перезапустил Яндекс Музыку.'
    case 'play':
      return now ? `Включаю: ${now}${where}.` : `Включаю музыку${where}.`
    case 'pause':
      return `Пауза${where}.`
    case 'next':
      return now ? `Следующий трек: ${now}${where}.` : `Переключил на следующий трек${where}.`
    case 'prev':
      return now ? `Предыдущий трек: ${now}${where}.` : `Переключил на предыдущий трек${where}.`
    case 'volume':
      return typeof r.volume === 'number' ? `Громкость ${r.volume} процентов.` : 'Громкость изменил.'
    case 'now':
      // Never "nothing" from a missing title: the bridge says 'nothing-playing'
      // itself, and only when a source that can see the player is sure.
      if (r.playing) return now ? `Сейчас играет ${now}${where}.` : `Музыка играет, но название трека определить не удалось${where}.`
      return now ? `На паузе: ${now}${where}.` : `Музыка на паузе${where}.`
    case 'search': {
      const found = r.found ? track(r.found.title, r.found.artist) : ''
      if (intent.play) return now ? `Включаю: ${now}.` : found ? `Включаю: ${found}.` : 'Включаю.'
      return found ? `Нашёл: ${found}. Включить?` : 'Открыл результаты поиска.'
    }
    case 'playlist': {
      const name = r.playlist ?? ('liked' in intent ? 'Мне нравится' : intent.name)
      if (!intent.play) return `Нашёл ваш плейлист «${name}». Включить?`
      return now ? `Включаю плейлист «${name}»: ${now}.` : `Включаю плейлист «${name}».`
    }
    case 'clarify':
      return KIND_ASK[intent.kind]
  }
}
