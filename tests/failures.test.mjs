import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeFailure, turnFailed } from '../bridge/failures.mjs'

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
