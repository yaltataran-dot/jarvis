import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAccounts } from '../bridge/accounts.mjs'

const T = Date.UTC(2026, 9, 17, 15, 20)
const MIN = 60_000

test('with no backup directory there is one login, and nothing to switch to', () => {
  const a = createAccounts()
  assert.deepEqual(a.labels(), ['primary'])
  assert.equal(a.switchable(), false)
  assert.equal(a.pick(T), 'primary')
  a.hold('primary', T + 10 * MIN, '15:30')
  assert.equal(a.pick(T), null)
  assert.deepEqual(a.blocked(T), { until: T + 10 * MIN, clock: '15:30' })
  // Past its time: back, exactly as the single pause behaved before.
  assert.equal(a.pick(T + 10 * MIN), 'primary')
  assert.equal(a.blocked(T + 10 * MIN), null)
})

test('the primary is preferred, the backup taken only while the primary is held off', () => {
  const a = createAccounts({ backupDir: '/root/.claude-backup' })
  assert.deepEqual(a.labels(), ['primary', 'backup'])
  assert.equal(a.switchable(), true)
  assert.equal(a.pick(T), 'primary')
  a.hold('primary', T + 60 * MIN, '16:20')
  assert.equal(a.pick(T), 'backup')
  assert.equal(a.blocked(T), null)
  // The primary's time passes: it is the first choice again.
  assert.equal(a.pick(T + 60 * MIN), 'primary')
})

test('each login has its own limit and its own time', () => {
  const a = createAccounts({ backupDir: '/b' })
  a.hold('primary', T + 60 * MIN, '16:20')
  a.hold('backup', T + 30 * MIN, '15:50')
  assert.equal(a.held('primary', T), true)
  assert.equal(a.held('backup', T), true)
  // Both held: the wait is the sooner of the two, with that one's clock.
  assert.deepEqual(a.blocked(T), { until: T + 30 * MIN, clock: '15:50' })
  assert.equal(a.pick(T + 30 * MIN), 'backup')
  assert.equal(a.held('primary', T + 30 * MIN), true)
})

test('the soonest login back gave no time: no clock is shown, rather than a later one', () => {
  const a = createAccounts({ backupDir: '/b' })
  a.hold('primary', T + 120 * MIN, '17:20')
  a.hold('backup', T + 15 * MIN, null, 'down')
  assert.deepEqual(a.blocked(T), { until: T + 15 * MIN, clock: null })
})

test('a shorter hold never cuts a longer one short', () => {
  const a = createAccounts({ backupDir: '/b' })
  a.hold('primary', T + 60 * MIN, '16:20')
  a.hold('primary', T + 1 * MIN, null)
  assert.equal(a.held('primary', T + 30 * MIN), true)
  a.hold('primary', T + 90 * MIN, '16:50')
  assert.equal(a.held('primary', T + 80 * MIN), true)
})

test('only the backup gets a config directory; the primary environment is passed as it is', () => {
  const a = createAccounts({ backupDir: '/root/.claude-backup' })
  const base = { PATH: '/usr/bin', HOME: '/root', ENABLE_TOOL_SEARCH: 'false' }
  assert.equal(a.env('primary', base), base)
  assert.deepEqual(a.env('backup', base), { ...base, CLAUDE_CONFIG_DIR: '/root/.claude-backup' })
  // The primary's own CLAUDE_CONFIG_DIR, when the bridge was given one, is left alone.
  const own = { ...base, CLAUDE_CONFIG_DIR: '/srv/claude' }
  assert.equal(a.env('primary', own).CLAUDE_CONFIG_DIR, '/srv/claude')
  assert.equal(createAccounts().env('backup', base), base)
})

test('labels are all the state ever holds: no email, no path in what it reports', () => {
  const a = createAccounts({ backupDir: '/root/.claude-second-login' })
  a.hold('primary', T + MIN, '15:21')
  a.hold('backup', T + MIN, '15:21')
  const seen = JSON.stringify([a.labels(), a.pick(T), a.blocked(T)])
  assert.doesNotMatch(seen, /@|second-login|\/root/)
})
