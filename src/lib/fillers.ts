/**
 * Filler speech.
 *
 * A tool call can take ten seconds, and silence that long reads as a crash. So
 * JARVIS says something the instant work starts — then goes quiet until he has
 * an answer. One acknowledgement, no progress chatter.
 *
 * The phrasing follows the character's actual grammar rather than generic
 * assistant-speak, which matters more than it sounds:
 *
 *   - Working lines are subjectless present participles: "Compiling.",
 *     "Cross-referencing." Not "I'm now checking" and never "let me".
 *   - There is no snap-to compliance formula. "Right away" and "At once" are
 *     not in his vocabulary; acknowledgement is deferential, not eager.
 *   - No filler words, no enthusiasm, no apology, no exclamation marks.
 *   - "Sir" fronted means urgency; final means routine. These are all routine,
 *     so it goes at the end, and only sometimes.
 */

import { LANG } from '../config'

/**
 * Every pool comes in both languages; LANG picks one. The Russian lines keep
 * the same grammar where Russian allows it: short, impersonal, "сэр" at the
 * end and only sometimes, no "сию минуту" eagerness.
 */
const tr = (en: string[], ru: string[]) => (LANG === 'ru' ? ru : en)

/** Said as soon as the first tool fires, before any answer exists. */
const WORKING = tr(
  [
    'Working on it, sir.',
    'Compiling.',
    'Retrieving.',
    'Accessing the archive.',
    'Cross-referencing.',
    'Running the query now.',
    'Searching.',
    'Under way.',
  ],
  [
    'Работаю, сэр.',
    'Собираю данные.',
    'Извлекаю.',
    'Обращаюсь к архиву.',
    'Сверяю.',
    'Выполняю запрос.',
    'Ищу.',
    'Приступаю.',
  ],
)

/** Acknowledging an order where no tool is involved. */
const ACKNOWLEDGE = tr(
  [
    'As you wish, sir.',
    'Very good, sir.',
    'Certainly.',
    'Understood.',
    'Consider it done.',
    'Directly, sir.',
  ],
  [
    'Как пожелаете, сэр.',
    'Хорошо, сэр.',
    'Разумеется.',
    'Понял.',
    'Будет сделано.',
    'Слушаюсь, сэр.',
  ],
)

/**
 * Said once at power-up, in Russian mode, in place of the recorded intro.
 *
 * The intro is baked into public/audio/boot-music.mp3 — "Allow me to
 * introduce myself. I am JARVIS, a virtual artificial intelligence… Systems
 * are now fully operational." — mixed with its sound effects, so the English
 * voice cannot be taken out of the file. In Russian mode the file is not
 * played and this line is spoken instead; null keeps the recording, which is
 * what English mode does.
 */
export const STARTUP_GREETING: string | null =
  LANG === 'ru'
    ? 'Здравствуйте! Я Юг-Трансфер, ваш персональный голосовой помощник. ' +
      'Система успешно запущена и готова к работе. Чем могу помочь?'
    : null

/** Answering to his name, before the user has said what they want. */
const ATTENTION = tr(
  ['Yes, sir?', 'Sir?', 'At your service, sir.', 'Standing by.', 'Awake, sir.'],
  ['Да, сэр?', 'Сэр?', 'К вашим услугам, сэр.', 'Слушаю.', 'На связи, сэр.'],
)

/**
 * Avoids repeating the same phrase twice running, which is what makes canned
 * lines sound canned. Keeps one slot of history per pool.
 */
function makePicker(pool: string[]) {
  let last = -1
  return () => {
    if (pool.length < 2) return pool[0] ?? ''
    let i = last
    while (i === last) i = Math.floor(Math.random() * pool.length)
    last = i
    return pool[i]
  }
}

export const working = makePicker(WORKING)
export const acknowledge = makePicker(ACKNOWLEDGE)
export const attention = makePicker(ATTENTION)

/**
 * Naming the task is warmer than a generic acknowledgement and shows the
 * integration off on camera. Still participial, still under five words.
 *
 * MCP tool names are `mcp__<server>__<tool>`, and the two halves say different
 * things: the server is who is being asked, the tool is what is being asked
 * for. Matching one flat substring against the whole string gets both wrong —
 * `mcp__playwright__browser_click` announced a web search because "browse"
 * appeared earlier in the table than "browser", `Get-Report` looked like a code
 * repository, `Get-Events` like a calendar entry, and "highlight" like a lamp.
 *
 * So: split the name, match the halves separately, order the table so the
 * specific beats the general, and put word boundaries on the short words that
 * hide inside longer ones. Either half matching is enough — the server is the
 * better signal when a name gives one, but plenty of them don't.
 */
type Rule = {
  /** Matched against the server segment, if there is one. */
  server?: RegExp
  /** Matched against the tool segment, or the whole name for a built-in. */
  tool?: RegExp
  lines: string[]
}

const FOOTAGE = tr(
  ['Assembling the footage.', 'Rendering the sequence.'],
  ['Монтирую видео.', 'Собираю ролик.'],
)

const BY_TOOL: Rule[] = [
  // Video sits above image because higgsfield and palmier both do either, so
  // the verb in the tool name is the only thing separating them — a rule on the
  // server alone would send every generate_video to "Rendering."
  { tool: /video|footage|\bclip\b|\breel\b|talking_head/, lines: FOOTAGE },
  {
    server: /higgsfield|openrouter-image|dalle|flux|midjourney/,
    tool: /image|photo|thumbnail|render|upscale|seedream/,
    lines: tr(['Rendering.', 'Composing it now.'], ['Рисую.', 'Создаю изображение.']),
  },
  // The editors, once the two rules that read the verb have had their turn.
  { server: /palmier|heygen|runway|descript/, lines: FOOTAGE },
  {
    server: /playwright|puppeteer|browserbase|chrome/,
    tool: /\bbrowser\b|navigate/,
    lines: tr(['Opening the browser.', 'Navigating.'], ['Открываю браузер.', 'Перехожу на страницу.']),
  },
  {
    server: /android|\badb\b|simulator/,
    tool: /\bdevice\b|\bapk\b|\bphone\b/,
    lines: tr(
      ['Reaching the device.', 'Connecting to your phone.'],
      ['Подключаюсь к устройству.', 'Связываюсь с вашим телефоном.'],
    ),
  },
  {
    server: /gmail|\bmail\b/,
    tool: /gmail|\bmail\b|email|inbox/,
    lines: tr(['Checking your mail.', 'Reading the inbox.'], ['Проверяю почту.', 'Читаю входящие.']),
  },
  // Calendar keys off "calendar" alone. "event" used to live here, which is how
  // a Mixpanel event query came out as "Checking your calendar."
  {
    tool: /calendar|\bdiary\b|\bmeeting\b/,
    lines: tr(
      ['Checking your calendar.', 'Consulting the diary.'],
      ['Проверяю календарь.', 'Сверяюсь с расписанием.'],
    ),
  },
  {
    server: /elevenlabs|openai-tts/,
    tool: /speech|\bvoice\b|\btts\b|text_to_sound/,
    lines: tr(['Synthesising.', 'Working on it, sir.'], ['Синтезирую.', 'Работаю, сэр.']),
  },
  {
    server: /spotify|sonos/,
    tool: /\bplay\b|\bmusic\b|playlist|\btrack\b/,
    lines: tr(['Queuing it up.', 'Putting it on.'], ['Ставлю в очередь.', 'Включаю.']),
  },
  {
    server: /^home|homeassistant|\bhue\b|\bhass\b/,
    tool: /\blights?\b|thermostat|\bdimmer\b/,
    lines: tr(['Adjusting it now.', 'Seeing to it, sir.'], ['Настраиваю.', 'Займусь этим, сэр.']),
  },
  {
    server: /github|linear|jira|sentry/,
    tool: /\brepo\b|repository|\bissues?\b|pull_request|\bcommit\b/,
    lines: tr(
      ['Checking the repository.', 'Consulting the tracker.'],
      ['Проверяю репозиторий.', 'Смотрю трекер задач.'],
    ),
  },
  // Also where the anonymously named analytics servers land — theirs are bare
  // UUIDs, so only the tool half says anything: Get-Report, Get-Events,
  // Run-Query. "report" is safe from the repository rule above because that one
  // is bounded.
  {
    server: /mixpanel|clarity|posthog|amplitude/,
    tool: /analytic|\bmetrics?\b|\breports?\b|\bevents?\b|cohort|funnel|dashboard|\bquery\b/,
    lines: tr(['Running the query.', 'Pulling the figures.'], ['Выполняю запрос.', 'Собираю цифры.']),
  },
  {
    server: /\bexa\b|serper|serpapi|perplexity|tavily|brave/,
    tool: /search|\bweb\b|\bfetch\b|crawl|research/,
    lines: tr(['Searching.', 'Consulting the record.'], ['Ищу.', 'Сверяюсь с источниками.']),
  },
]

const pickers = BY_TOOL.map((r) => ({ ...r, pick: makePicker(r.lines) }))

/**
 * `mcp__<server>__<tool>`, split on the first separator so tool names keep
 * their own underscores (`browser_click`, `text_to_speech`). A built-in like
 * WebSearch or Bash has no server half.
 *
 * The second form matters more than it looks: the bridge client prettifies
 * names for the HUD badge before handing them on, so what actually arrives
 * here is `higgsfield · generate image`. Parsing only the raw form meant every
 * rule below silently missed and every tool got the generic line.
 */
function split(toolName: string): { server: string; tool: string } {
  const raw = /^mcp__(.+?)__(.+)$/.exec(toolName)
  if (raw) return { server: raw[1].toLowerCase(), tool: raw[2].toLowerCase() }

  const pretty = toolName.split(' · ')
  if (pretty.length === 2) {
    return { server: pretty[0].toLowerCase(), tool: pretty[1].toLowerCase() }
  }

  return { server: '', tool: toolName.toLowerCase() }
}

/** A phrase suited to the tool that just fired. */
export function forTool(toolName: string): string {
  const { server, tool } = split(toolName)
  for (const r of pickers) {
    const hit =
      (r.server !== undefined && server !== '' && r.server.test(server)) ||
      (r.tool !== undefined && r.tool.test(tool))
    if (hit) return r.pick()
  }
  // Read, Bash, Grep and anything unrecognised: better a neutral line than a
  // confident wrong one.
  return working()
}
