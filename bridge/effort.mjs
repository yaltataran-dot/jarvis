/**
 * How hard to think about one question.
 *
 * One fixed effort for every turn meant "сколько будет семнадцать на три" got
 * the same deliberation as "сравни три тарифа и посоветуй" — measured at
 * 'high', a bare multiplication took 9.6 s to its first word. The session's
 * effort can be changed between turns (applyFlagSettings), so each question is
 * sorted before it goes in:
 *
 *   low     short, and needs nothing looked up: greetings, thanks, arithmetic,
 *           small talk, commands to the interface
 *   medium  anything that may need current information — weather, prices,
 *           news, finding something — and the default for everything else
 *   high    asked to think: analyse, compare, explain why, plan, write; or a
 *           long, many-part request
 *
 * Deliberately conservative where it matters. Anything that might need a
 * lookup is never put on 'low', because the cost of thinking too little there
 * is not a slow answer but a made-up one: today's weather from memory.
 */

const THINK = new RegExp(
  [
    // Russian stems: analyse, compare, research, break down, explain, why,
    // prove, plan, strategy, write a text/letter/article/code, step by step.
    'подробн', 'проанализ', 'анализ', 'сравни', 'сравнен', 'исследу', 'разбер',
    'объясни', 'почему', 'докажи', 'план', 'стратеги', 'составь', 'напиши',
    'пошагов', 'плюсы и минусы', 'посоветуй', 'рассчитай', 'оцени',
    // English.
    'analy[sz]', 'compare', 'research', 'explain', 'why', 'in detail', 'step by step',
    'plan', 'strategy', 'write (a|an|me)', 'pros and cons', 'recommend',
  ].join('|'),
  'iu',
)

/** Things that change, or have to be found — never answered on 'low'. */
const LOOKUP = new RegExp(
  [
    'погод', 'курс', 'новост', 'что нового', 'нового', 'недавн', 'на этой неделе',
    'в этом месяце', 'в этом году', 'сегодня', 'сейчас', 'завтра', 'вчера', 'цен', 'стоит',
    'стоимост', 'найди', 'поищи', 'найти', 'поиск', 'где ', 'когда', 'расписан',
    'пробк', 'адрес', 'телефон', 'открой', 'покажи', 'какой сейчас', 'последн',
    'актуальн', 'расстояни', 'сколько ехать', 'маршрут', 'почт', 'календар',
    'weather', 'price', 'news', 'today', 'now', 'tomorrow', 'find', 'search', 'latest',
    'open ', 'show ', 'where', 'when', 'how far', 'route', 'mail', 'calendar',
  ].join('|'),
  'iu',
)

/** Words in a question. */
const words = (text) => text.trim().split(/\s+/).filter(Boolean).length

/** 'low' | 'medium' | 'high' for one question. */
export function effortFor(text) {
  const t = String(text ?? '')
  if (THINK.test(t) || words(t) > 25) return 'high'
  if (LOOKUP.test(t)) return 'medium'
  if (words(t) <= 8) return 'low'
  return 'medium'
}
