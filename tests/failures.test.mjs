import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { allLoginsLimitedMessage, describeFailure, isAuthFailure, isRateLimit, rateLimitMessage, rateLimitReset, turnFailed } from '../bridge/failures.mjs'

test('an API error reported as a "successful" result is a failure', () => {
  // The shape that used to reach the page as an ordinary, unspoken answer.
  const r = { subtype: 'success', is_error: true, result: 'API Error: 403 {"error":{"type":"forbidden","message":"Request not allowed"}}' }
  assert.equal(turnFailed(r), true)
  assert.match(describeFailure(r), /VPN/)
})

test('a plain successful answer is not a failure', () => {
  assert.equal(turnFailed({ subtype: 'success', is_error: false, result: 'Пятьдесят один, сэр.' }), false)
})

test('error subtypes and assistant errors are failures', () => {
  assert.equal(turnFailed({ subtype: 'error_during_execution', errors: ['[ede_diagnostic] result_type=user'] }), true)
  assert.equal(turnFailed({ subtype: 'success', is_error: false, result: '' }, 'unknown'), true)
})

test('the status Claude Code recorded decides the message', () => {
  assert.match(describeFailure({ subtype: 'success', is_error: true, api_error_status: 403 }), /VPN/)
  assert.match(describeFailure({ subtype: 'success', is_error: true, api_error_status: 401 }), /войти/)
  assert.match(describeFailure({ subtype: 'success', is_error: true, api_error_status: 429 }), /Лимит/)
  assert.match(describeFailure({ subtype: 'success', is_error: true, api_error_status: 529 }), /перегружен/)
})

test('a network failure with no HTTP status is named as one', () => {
  const r = { subtype: 'success', is_error: true, result: 'API Error: Connection error. getaddrinfo ENOTFOUND api.anthropic.com' }
  assert.match(describeFailure(r), /Нет связи/)
})

test('an assistant error kind is used when there is no status', () => {
  assert.match(describeFailure({ subtype: 'success', is_error: true }, 'authentication_failed'), /войти/)
})

test('anything unrecognised gets the general message, in either language', () => {
  assert.equal(describeFailure({ subtype: 'error_during_execution' }), 'Запрос прервался на полпути.')
  assert.equal(describeFailure({ subtype: 'error_during_execution' }, undefined, 'en'), 'The turn failed part way through.')
})

test('the usage limit is told apart from other failures, in every shape it arrives', () => {
  const limit = { subtype: 'success', is_error: true, api_error_status: 429, result: "You've hit your session limit · resets 10:50pm (Europe/Moscow)" }
  assert.equal(isRateLimit(limit, null), true)
  assert.equal(isRateLimit({ subtype: 'success', is_error: true }, 'rate_limit'), true)
  assert.equal(isRateLimit({ subtype: 'success', is_error: true, result: 'API Error: 429 rate_limit_error' }, null), true)
  assert.equal(isRateLimit({ subtype: 'success', is_error: true, api_error_status: 403 }, null), false)
  assert.equal(isRateLimit({ subtype: 'error_during_execution' }, null), false)
})

test('a refused login is told apart from the limit and from other failures', () => {
  assert.equal(isAuthFailure({ api_error_status: 401 }, null), true)
  assert.equal(isAuthFailure({ subtype: 'success', is_error: true }, 'authentication_failed'), true)
  assert.equal(isAuthFailure({ subtype: 'success', is_error: true }, 'oauth_org_not_allowed'), true)
  assert.equal(isAuthFailure({ result: 'API Error: 401 {"type":"authentication_error"}' }, null), true)
  assert.equal(isAuthFailure({ api_error_status: 429, result: 'resets 2am' }, 'rate_limit'), false)
  assert.equal(isAuthFailure({ api_error_status: 403 }, null), false)
  assert.equal(isAuthFailure({ result: 'API Error: 4010' }, null), false)
  assert.equal(isAuthFailure({ subtype: 'error_during_execution' }, null), false)
})

test('only the limit moves a turn to the other login, and only a refused login sets one aside', () => {
  // What a login switch keys on: 429 for the limit, 401 for a refused login.
  // Everything else is the same for both logins, so neither is it.
  const cases = [
    [{ api_error_status: 429 }, null, 'rate'],
    [{ subtype: 'success', is_error: true }, 'rate_limit', 'rate'],
    [{ api_error_status: 401 }, null, 'auth'],
    [{ subtype: 'success', is_error: true }, 'authentication_failed', 'auth'],
    [{ api_error_status: 403, result: 'Request not allowed' }, null, null],
    [{ api_error_status: 529 }, 'overloaded', null],
    [{ api_error_status: 500 }, 'server_error', null],
    [{ subtype: 'success', is_error: true, result: 'API Error: Connection error. ECONNRESET' }, null, null],
    [{ subtype: 'success', is_error: true, result: 'fetch failed: ETIMEDOUT' }, null, null],
    [{ subtype: 'error_max_turns' }, null, null],
  ]
  for (const [result, kind, want] of cases) {
    const got = isRateLimit(result, kind) ? 'rate' : isAuthFailure(result, kind) ? 'auth' : null
    assert.equal(got, want, JSON.stringify([result, kind]))
  }
  // And the user still hears the right cause for the ones that do not switch.
  assert.match(describeFailure({ api_error_status: 403 }, null), /VPN/)
  assert.match(describeFailure({ subtype: 'success', is_error: true, result: 'API Error: Connection error. ECONNRESET' }, null), /интернет|VPN|сервер/i)
})

test('both logins held off: one plain sentence in Russian, with the time when it is known', () => {
  assert.equal(allLoginsLimitedMessage('2:00'), 'Оба аккаунта Claude недоступны до 2:00. Команды без модели работают.')
  assert.equal(allLoginsLimitedMessage(null), 'Оба аккаунта Claude недоступны. Попробуйте чуть позже.')
  assert.match(allLoginsLimitedMessage('2:00', 'en'), /^Both Claude accounts are unavailable until 2:00\./)
})

test('the time the limit lifts is read from the result, as the next time that clock comes round', () => {
  const at = (h, m) => new Date(2026, 9, 15, h, m)
  // Named zone: Moscow's clock, whatever this machine's is (UTC+3 all year).
  const r = rateLimitReset({ result: 'You\'ve hit your session limit · resets 10:50pm (Europe/Moscow)' }, new Date(Date.UTC(2026, 9, 15, 17, 0)))
  assert.equal(r.clock, '22:50')
  assert.equal(r.until, Date.UTC(2026, 9, 15, 19, 50))
  // No zone: this machine's clock, as before. Already past today: tomorrow.
  const next = rateLimitReset({ result: 'resets 9am' }, at(20, 0))
  assert.equal(next.clock, '9:00')
  assert.equal(next.until, new Date(2026, 9, 16, 9, 0).getTime())
  assert.equal(rateLimitReset({ result: 'resets 12am' }, at(20, 0)).clock, '0:00')
  assert.equal(rateLimitReset({ result: 'You have hit a limit' }, at(20, 0)), null)
  assert.equal(rateLimitReset({}, at(20, 0)), null)
})

test('a reset time with a zone is read in that zone, not on the server clock', () => {
  const moscow2am = { result: "You've hit your session limit · resets 2am (Europe/Moscow)" }
  // 15:20 UTC is 18:20 in Moscow: 2am Moscow comes round at 23:00 UTC the same day.
  const r = rateLimitReset(moscow2am, new Date(Date.UTC(2026, 9, 17, 15, 20)))
  assert.deepEqual(r, { until: Date.UTC(2026, 9, 17, 23, 0), clock: '2:00' })
  // 23:30 UTC is already 2:30 in Moscow: the next 2am is a day on.
  assert.equal(rateLimitReset(moscow2am, new Date(Date.UTC(2026, 9, 17, 23, 30))).until, Date.UTC(2026, 9, 18, 23, 0))
  // Exactly at the reset moment: it counts as passed, as without a zone.
  assert.equal(rateLimitReset(moscow2am, new Date(Date.UTC(2026, 9, 17, 23, 0))).until, Date.UTC(2026, 9, 18, 23, 0))
  // 24-hour times and minutes, in a zone behind UTC.
  assert.equal(rateLimitReset({ result: 'resets 14:05 (America/New_York)' }, new Date(Date.UTC(2026, 6, 1, 12, 0))).until, Date.UTC(2026, 6, 1, 18, 5))
  assert.equal(rateLimitReset({ result: 'resets 12pm (UTC)' }, new Date(Date.UTC(2026, 6, 1, 13, 0))).until, Date.UTC(2026, 6, 2, 12, 0))
})

test('a reset across a DST change lands on the zone\'s new offset', () => {
  // New York leaves summer time on 1 November 2026 at 2am: 9am that day is UTC-5.
  const r = rateLimitReset({ result: 'resets 9am (America/New_York)' }, new Date(Date.UTC(2026, 9, 31, 20, 0)))
  assert.equal(r.until, Date.UTC(2026, 10, 1, 14, 0))
  // And into summer time on 8 March 2026: 9am is UTC-4.
  assert.equal(rateLimitReset({ result: 'resets 9am (America/New_York)' }, new Date(Date.UTC(2026, 2, 7, 20, 0))).until, Date.UTC(2026, 2, 8, 13, 0))
})

test('an unknown zone is read on this machine\'s clock, as a time with none', () => {
  const now = new Date(2026, 9, 15, 20, 0)
  const plain = rateLimitReset({ result: 'resets 10:50pm' }, now)
  assert.deepEqual(rateLimitReset({ result: 'resets 10:50pm (Mars/Olympus)' }, now), plain)
  assert.deepEqual(rateLimitReset({ result: 'resets 10:50pm (not a zone)' }, now), plain)
  assert.equal(rateLimitReset({ result: 'resets 25:00 (Europe/Moscow)' }, now), null)
  assert.equal(rateLimitReset({ result: 'resets 10:75 (Europe/Moscow)' }, now), null)
  assert.equal(rateLimitReset({ result: 'resets soon (Europe/Moscow)' }, now), null)
})

test('a zoned reset gives the same instant whatever zone the machine is in', () => {
  const src = `import { rateLimitReset } from ${JSON.stringify(new URL('../bridge/failures.mjs', import.meta.url).href)}
    const r = rateLimitReset({ result: 'resets 2am (Europe/Moscow)' }, new Date(Date.UTC(2026, 9, 17, 15, 20)))
    process.stdout.write(String(r.until))`
  for (const TZ of ['UTC', 'Europe/Moscow', 'America/Los_Angeles', 'Asia/Tokyo']) {
    const out = spawnSync(process.execPath, ['--input-type=module', '-e', src], { env: { ...process.env, TZ }, encoding: 'utf8' })
    assert.equal(out.status, 0, out.stderr)
    assert.equal(Number(out.stdout), Date.UTC(2026, 9, 17, 23, 0), `TZ=${TZ}`)
  }
})

test('a far reset is reported as it is; capping the pause is the caller\'s', () => {
  // 18:20 in Moscow: 2pm is almost a day away, more than server.mjs will wait.
  const r = rateLimitReset({ result: 'resets 2pm (Europe/Moscow)' }, new Date(Date.UTC(2026, 9, 17, 15, 20)))
  assert.equal(r.until, Date.UTC(2026, 9, 18, 11, 0))
})

test('the limit sentence names the time when it is known', () => {
  assert.equal(rateLimitMessage('22:50'), 'Лимит запросов Claude исчерпан до 22:50. Команды без модели работают.')
  assert.equal(rateLimitMessage(null), 'Лимит запросов Claude исчерпан. Попробуйте чуть позже.')
})
