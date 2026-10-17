/**
 * What went wrong with a turn, in words the user can act on.
 *
 * Claude Code reports a failed API call in more than one shape, and the bridge
 * used to recognise only one of them. A non-success `result` subtype was caught;
 * but an API error that ends the turn — "API Error: 403 … Request not allowed"
 * when the VPN drops out of a supported country, a DNS failure when the network
 * goes — comes back as subtype 'success' with `is_error: true` and the error as
 * the result text, never streamed. That was sent to the page as an ordinary
 * answer; the page speaks only streamed text, so the turn ended in silence:
 * the search ran, the weather blade went up, and no answer ever came.
 *
 * Kept free of imports so the tests can run it.
 */

/** Was this turn a failure, whatever shape it arrived in? */
export function turnFailed(result, assistantError) {
  return result?.subtype !== 'success' || result?.is_error === true || Boolean(assistantError)
}

const NETWORK = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|getaddrinfo|fetch failed|socket hang up|Connection error|network/i

const RU = {
  auth: 'Claude не принял авторизацию. Нужно заново войти в Claude Code.',
  forbidden: 'Сервер Claude отклонил запрос. Обычно это значит, что VPN отключился или сменил страну.',
  network: 'Нет связи с сервером Claude. Проверьте интернет и VPN.',
  rate: 'Лимит запросов Claude исчерпан. Попробуйте чуть позже.',
  busy: 'Сервер Claude перегружен или недоступен. Попробуйте ещё раз.',
  billing: 'Проблема с подпиской Claude.',
  max_turns: 'Запрос шёл слишком долго и был остановлен.',
  default: 'Запрос прервался на полпути.',
}
const EN = {
  auth: 'Claude did not accept the login. Sign in to Claude Code again.',
  forbidden: 'The Claude server refused the request. Usually the VPN dropped or changed country.',
  network: 'Cannot reach the Claude server. Check the internet connection and the VPN.',
  rate: 'The Claude usage limit is reached. Try again a little later.',
  busy: 'The Claude server is overloaded or unavailable. Try again.',
  billing: 'There is a problem with the Claude subscription.',
  max_turns: 'The turn ran too long and was stopped.',
  default: 'The turn failed part way through.',
}

/** Is this failure the usage limit (HTTP 429), rather than any other fault? */
export function isRateLimit(result, assistantError) {
  const text = String(result?.result ?? '')
  return result?.api_error_status === 429 || assistantError === 'rate_limit' || /API Error:\s*429/.test(text)
}

/** Did the login itself fail (HTTP 401 or an auth error kind), rather than the request? */
export function isAuthFailure(result, assistantError) {
  const text = String(result?.result ?? '')
  return (
    result?.api_error_status === 401 ||
    assistantError === 'authentication_failed' ||
    assistantError === 'oauth_org_not_allowed' ||
    /API Error:\s*401\b/.test(text)
  )
}

/**
 * When the limit lifts, as Claude Code writes it into the result:
 * "You've hit your session limit · resets 10:50pm (Europe/Moscow)".
 *
 * `clock` is the wall-clock time as written ("22:50"); `until` the next moment
 * that time comes round in the zone named after it. A bridge on a server in
 * UTC would otherwise read Moscow's 2am as its own, hours late. With no zone
 * named, or one this Node does not know, the time is read on this machine's
 * clock, as before.
 * Null when the text gives no time — the caller then pauses briefly instead.
 */
export function rateLimitReset(result, now = new Date()) {
  const m = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([A-Za-z][\w+-]*(?:\/[\w+-]+)*)\))?/i.exec(String(result?.result ?? ''))
  if (!m) return null
  let h = Number(m[1])
  const min = Number(m[2] ?? 0)
  const ap = m[3]?.toLowerCase()
  if (ap === 'pm' && h < 12) h += 12
  if (ap === 'am' && h === 12) h = 0
  if (h > 23 || min > 59) return null
  const clock = `${h}:${String(min).padStart(2, '0')}`
  const zone = m[4] && knownZone(m[4])
  if (zone) return { until: nextInZone(zone, h, min, now.getTime()), clock }
  const at = new Date(now)
  at.setHours(h, min, 0, 0)
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1)
  return { until: at.getTime(), clock }
}

/** The zone's own spelling when Intl knows it, else null. */
function knownZone(name) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone
  } catch {
    return null
  }
}

/** The wall clock in `zone` at instant `t`, as a UTC timestamp of the same digits. */
function wallClock(zone, t) {
  const parts = {}
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  })
  for (const p of fmt.formatToParts(new Date(t))) parts[p.type] = Number(p.value)
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
}

/**
 * The instant `zone`'s clocks read the given wall time. Intl only formats, so
 * guess with the offset at the wall time read as UTC, then correct once with
 * the offset at the guess — that second step is what crosses a DST change.
 */
function instantInZone(zone, wall) {
  const guess = wall - (wallClock(zone, wall) - wall)
  return wall - (wallClock(zone, guess) - guess)
}

/** The next instant after `now` that `zone`'s clocks read h:min. */
function nextInZone(zone, h, min, now) {
  const today = new Date(wallClock(zone, now))
  const wall = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), h, min)
  const at = instantInZone(zone, wall)
  return at > now ? at : instantInZone(zone, wall + 24 * 60 * 60_000)
}

/** The limit's sentence, with the time it lifts when that is known. */
export function rateLimitMessage(clock, lang = 'ru') {
  if (lang === 'en') {
    return clock
      ? `The Claude usage limit is reached until ${clock}. Commands that need no model still work.`
      : EN.rate
  }
  return clock
    ? `Лимит запросов Claude исчерпан до ${clock}. Команды без модели работают.`
    : RU.rate
}

/** Both Claude logins held off (accounts.mjs): the same sentence, saying it is both. */
export function allLoginsLimitedMessage(clock, lang = 'ru') {
  if (lang === 'en') {
    return clock
      ? `Both Claude accounts are unavailable until ${clock}. Commands that need no model still work.`
      : 'Both Claude accounts are unavailable. Try again a little later.'
  }
  return clock
    ? `Оба аккаунта Claude недоступны до ${clock}. Команды без модели работают.`
    : 'Оба аккаунта Claude недоступны. Попробуйте чуть позже.'
}

/**
 * Why the fallback channel (fallback.mjs) could not answer, as the end of the
 * limit's sentence. Each kind is its own words, so a wrong key, a spent budget
 * and a dead network are not all "unavailable".
 */
const FALLBACK_RU = {
  config: 'резервный канал не настроен',
  budget: 'дневной бюджет резервного канала исчерпан',
  auth: 'резервный канал не принял ключ',
  forbidden: 'резервный канал отклонил запрос',
  rate: 'резервный канал тоже упёрся в лимит',
  billing: 'у резервного канала проблема с оплатой',
  timeout: 'резервный канал не ответил вовремя',
  network: 'до резервного канала нет связи',
  service: 'резервный канал недоступен',
}
const FALLBACK_EN = {
  config: 'the fallback channel is not set up',
  budget: "the fallback channel's daily budget is spent",
  auth: 'the fallback channel did not accept its key',
  forbidden: 'the fallback channel refused the request',
  rate: 'the fallback channel is rate limited too',
  billing: 'the fallback channel has a billing problem',
  timeout: 'the fallback channel did not answer in time',
  network: 'the fallback channel cannot be reached',
  service: 'the fallback channel is unavailable',
}

/** The limit is reached and the fallback could not take the question either. */
export function fallbackDownMessage(kind, lang = 'ru') {
  if (lang === 'en') {
    return `The Claude usage limit is reached, and ${FALLBACK_EN[kind] ?? FALLBACK_EN.service}. Commands that need no model still work.`
  }
  return `Лимит Claude исчерпан, а ${FALLBACK_RU[kind] ?? FALLBACK_RU.service}. Команды без модели работают.`
}

/**
 * The limit hit part way through a turn that had already called tools. Not
 * retried anywhere: some of what was asked may already have happened.
 */
export function limitMidTurnMessage(lang = 'ru') {
  return lang === 'en'
    ? 'The Claude usage limit was reached part way through. Some of it may already be done — check before asking again.'
    : 'Лимит Claude исчерпан посреди запроса. Часть действий могла выполниться — проверьте, прежде чем повторять.'
}

/**
 * A short sentence for the screen. Reads, in order of how specific it is: the
 * HTTP status Claude Code recorded, the assistant message's error kind, a
 * status or network error written into the result text, the result subtype.
 */
export function describeFailure(result, assistantError, lang = 'ru') {
  const m = lang === 'en' ? EN : RU
  const text = String(result?.result ?? '') + ' ' + (Array.isArray(result?.errors) ? result.errors.join(' ') : '')
  const status = result?.api_error_status ?? Number(/API Error:\s*(\d{3})/.exec(text)?.[1] ?? NaN)

  if (status === 401 || assistantError === 'authentication_failed' || assistantError === 'oauth_org_not_allowed') return m.auth
  if (status === 403) return m.forbidden
  if (status === 429 || assistantError === 'rate_limit') return m.rate
  if (assistantError === 'billing_error' || status === 402) return m.billing
  if (status === 529 || (status >= 500 && status < 600) || assistantError === 'overloaded' || assistantError === 'server_error') return m.busy
  if (NETWORK.test(text)) return m.network
  if (result?.subtype === 'error_max_turns') return m.max_turns
  return m.default
}
