import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeFailure, isRateLimit, rateLimitMessage, rateLimitReset, turnFailed } from '../bridge/failures.mjs'

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

test('the time the limit lifts is read from the result, as the next time that clock comes round', () => {
  const at = (h, m) => new Date(2026, 9, 15, h, m)
  const r = rateLimitReset({ result: 'You\'ve hit your session limit · resets 10:50pm (Europe/Moscow)' }, at(20, 0))
  assert.equal(r.clock, '22:50')
  assert.equal(r.until, new Date(2026, 9, 15, 22, 50).getTime())
  // Already past today: tomorrow.
  const next = rateLimitReset({ result: 'resets 9am' }, at(20, 0))
  assert.equal(next.clock, '9:00')
  assert.equal(next.until, new Date(2026, 9, 16, 9, 0).getTime())
  assert.equal(rateLimitReset({ result: 'resets 12am' }, at(20, 0)).clock, '0:00')
  assert.equal(rateLimitReset({ result: 'You have hit a limit' }, at(20, 0)), null)
  assert.equal(rateLimitReset({}, at(20, 0)), null)
})

test('the limit sentence names the time when it is known', () => {
  assert.equal(rateLimitMessage('22:50'), 'Лимит запросов Claude исчерпан до 22:50. Команды без модели работают.')
  assert.equal(rateLimitMessage(null), 'Лимит запросов Claude исчерпан. Попробуйте чуть позже.')
})
