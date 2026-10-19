import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAccounts } from '../bridge/accounts.mjs'
import { describeFailure, noLoginFrame, rateLimitMessage, resultFailures } from '../bridge/failures.mjs'
import { ACCOUNT_DOWN_MS, LIMIT_PAUSE_FALLBACK_MS, LIMIT_PAUSE_MAX_MS, createTurnOutcome } from '../bridge/turnResult.mjs'

/**
 * What a turn's `result` means (bridge/turnResult.mjs), moved out of
 * server.mjs's session stream unchanged. Written after the move: a running
 * bridge in DRY mode never has a model turn, so these drive the decision with
 * result messages shaped like the SDK's, on real login state (accounts.mjs).
 */

const T = Date.UTC(2026, 9, 19, 12, 0)

/** The tests whose clock and console are already stood in for. */
const mocked = new WeakMap()

/** The decision as server.mjs builds it, on `accounts`, with the log captured. */
function rig(t, { backups = [] } = {}) {
  if (!mocked.has(t)) {
    t.mock.timers.enable({ apis: ['Date'], now: T })
    const sink = { lines: [] }
    for (const level of ['log', 'warn', 'error']) t.mock.method(console, level, (...a) => sink.lines.push(`${level}: ${a.filter((x) => x !== '').join(' ')}`))
    mocked.set(t, sink)
  }
  const sink = mocked.get(t)
  sink.lines.length = 0
  const lines = sink.lines
  const accounts = createAccounts({ backupDirs: backups })
  const lang = 'ru'
  const noLogin = (clock, blocked) => noLoginFrame({ clock, blocked, logins: accounts.labels().length, lang })
  const outcomeOf = createTurnOutcome({ accounts, lang, failures: resultFailures(lang), noLogin })
  const turn = (over = {}) => ({ apiError: null, interrupted: false, account: 'primary', seconds: () => '2.5', tools: [], ...over })
  return { accounts, lines, outcomeOf, turn }
}

test('a success is "done" with its text and cost, logged with the tools it called', (t) => {
  const r = rig(t)
  const out = r.outcomeOf({ subtype: 'success', is_error: false, result: 'Сорок два.', total_cost_usd: 0.01 }, r.turn({ tools: ['WebSearch', 'jarvis_pc__read'] }))
  assert.deepEqual(out, { kind: 'ok', frame: { type: 'done', text: 'Сорок два.', costUsd: 0.01 } })
  assert.deepEqual(r.lines, ['log: [jarvis] turn ok in 2.5 s · tools: WebSearch, jarvis_pc__read'])
  const bare = r.outcomeOf({ subtype: 'success', is_error: false }, r.turn())
  assert.deepEqual(bare.frame, { type: 'done', text: '', costUsd: null })
  assert.equal(r.lines.at(-1), 'log: [jarvis] turn ok in 2.5 s')
})

test('a turn the page stopped is "failed" with the plain sentence, logged as interrupted, not as a failure', (t) => {
  const r = rig(t)
  const out = r.outcomeOf({ subtype: 'error_during_execution', is_error: true }, r.turn({ interrupted: true }))
  assert.deepEqual(out, { kind: 'failed', frame: { type: 'error', message: 'Запрос прервался на полпути.' } })
  assert.deepEqual(r.lines, ['log: [jarvis] turn interrupted after 2.5 s'])
  // An API error on it as well: a real failure, not a stop.
  r.outcomeOf({ subtype: 'error_during_execution', is_error: true }, r.turn({ interrupted: true, apiError: 'server_error' }))
  assert.match(r.lines.at(-1), /^error: \[jarvis\] turn failed after 2\.5 s: error_during_execution/)
})

test('the limit with no time given: this login held a minute, the limit frame, and the model paused in the log', (t) => {
  const r = rig(t)
  const out = r.outcomeOf({ subtype: 'success', is_error: true, api_error_status: 429, result: 'API Error: 429' }, r.turn())
  assert.equal(out.kind, 'rate')
  assert.deepEqual(out.frame, { type: 'error', kind: 'rate', resetAt: null, message: rateLimitMessage(null) })
  assert.equal(r.accounts.held('primary', T + LIMIT_PAUSE_FALLBACK_MS - 1), true)
  assert.equal(r.accounts.held('primary', T + LIMIT_PAUSE_FALLBACK_MS), false)
  assert.deepEqual(r.lines, [`error: [jarvis] turn failed after 2.5 s: usage limit (429) · model paused until ${new Date(T + LIMIT_PAUSE_FALLBACK_MS).toLocaleTimeString()}`])
})

test('the limit with its time: held until then, never more than six hours, and the time in the frame', (t) => {
  const r = rig(t)
  const soon = r.outcomeOf({ subtype: 'success', is_error: true, api_error_status: 429, result: "You've hit your session limit · resets 2pm (UTC)" }, r.turn())
  assert.deepEqual(soon.frame, { type: 'error', kind: 'rate', resetAt: '14:00', message: rateLimitMessage('14:00') })
  assert.equal(r.accounts.held('primary', Date.UTC(2026, 9, 19, 13, 59)), true)
  assert.equal(r.accounts.held('primary', Date.UTC(2026, 9, 19, 14, 0)), false)
  // A time far off is capped: the model is tried again after six hours at most.
  const q = rig(t)
  q.outcomeOf({ subtype: 'success', is_error: true, result: 'API Error: 429 · resets 11am (UTC)' }, q.turn())
  assert.equal(q.accounts.held('primary', T + LIMIT_PAUSE_MAX_MS - 1), true)
  assert.equal(q.accounts.held('primary', T + LIMIT_PAUSE_MAX_MS), false)
})

test('several logins: the limit names the login; one free is the plain limit, every one at it is "all"', (t) => {
  const r = rig(t, { backups: ['/b', '/c'] })
  const first = r.outcomeOf({ subtype: 'success', is_error: true, api_error_status: 429 }, r.turn())
  assert.match(r.lines.at(-1), / · login primary · model paused until /)
  assert.deepEqual(first.frame, { type: 'error', kind: 'rate', resetAt: null, message: rateLimitMessage(null) }, 'a login is still free')
  r.outcomeOf({ subtype: 'success', is_error: true, api_error_status: 429 }, r.turn({ account: 'backup' }))
  const last = r.outcomeOf({ subtype: 'success', is_error: true, api_error_status: 429, result: 'resets 1pm (UTC)' }, r.turn({ account: 'backup2' }))
  assert.equal(last.kind, 'rate')
  assert.deepEqual(last.frame, { type: 'error', kind: 'rate', resetAt: null, message: 'Все аккаунты Claude недоступны. Попробуйте чуть позже.' }, 'the soonest is back at a minute, with no time given')
})

test('several logins, all held but one only set aside: the outcome is still the limit, the frame says unavailable', (t) => {
  const r = rig(t, { backups: ['/b'] })
  r.accounts.hold('backup', T + ACCOUNT_DOWN_MS, null, 'down')
  const out = r.outcomeOf({ subtype: 'success', is_error: true, api_error_status: 429 }, r.turn())
  assert.equal(out.kind, 'rate', 'turns.mjs still treats it as the limit: no retry on a login set aside, the fallback may answer')
  assert.equal(out.frame.kind, 'service')
  assert.doesNotMatch(out.frame.message, /[Лл]имит/)
})

test('a login that refused itself: set aside for fifteen minutes when there is another, never when it is the only one', (t) => {
  const one = rig(t)
  one.outcomeOf({ subtype: 'success', is_error: true, api_error_status: 401, result: 'API Error: 401' }, one.turn())
  assert.equal(one.accounts.held('primary', T), false)
  const two = rig(t, { backups: ['/b'] })
  two.outcomeOf({ subtype: 'success', is_error: true, api_error_status: 401, result: 'API Error: 401' }, two.turn())
  assert.equal(two.accounts.held('primary', T + ACCOUNT_DOWN_MS - 1), true)
  assert.equal(two.accounts.held('primary', T + ACCOUNT_DOWN_MS), false)
  assert.equal(two.lines.at(-1), 'warn: [jarvis] login primary refused — set aside for 15 min')
  assert.equal(two.accounts.blocked(T)?.limited ?? null, null, 'the backup is free')
})

test('any other failure: a known outside cause is kind "service" with its sentence; otherwise the subtype\'s own, no kind', (t) => {
  const r = rig(t)
  const vpn = { subtype: 'success', is_error: true, result: 'API Error: 403 {"error":{"type":"forbidden","message":"Request not allowed"}}' }
  const out = r.outcomeOf(vpn, r.turn({ tools: ['WebSearch'] }))
  assert.deepEqual(out, { kind: 'failed', frame: { type: 'error', kind: 'service', message: describeFailure(vpn, null, 'ru') } })
  assert.match(r.lines.at(-1), /^error: \[jarvis\] turn failed after 2\.5 s: success · is_error=true · api_status=none · api_error=none · tools: WebSearch · result: API Error: 403/)
  const budget = r.outcomeOf({ subtype: 'error_max_budget_usd', is_error: true }, r.turn())
  assert.deepEqual(budget, { kind: 'failed', frame: { type: 'error', message: 'Бюджет на этот запрос исчерпан.' } })
  const odd = r.outcomeOf({ subtype: 'error_something_new', is_error: true }, r.turn())
  assert.deepEqual(odd.frame, { type: 'error', message: 'Запрос завершился без ответа.' })
})

test('the turn\'s time is read when the line is written', (t) => {
  const r = rig(t)
  let calls = 0
  r.outcomeOf({ subtype: 'success', is_error: false, result: 'x' }, r.turn({ seconds: () => `${++calls}.0` }))
  assert.equal(calls, 1)
  assert.equal(r.lines.at(-1), 'log: [jarvis] turn ok in 1.0 s')
})
