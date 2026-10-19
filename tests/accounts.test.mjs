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
  assert.deepEqual(a.blocked(T), { until: T + 10 * MIN, clock: '15:30', limited: true })
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
  assert.deepEqual(a.blocked(T), { until: T + 30 * MIN, clock: '15:50', limited: true })
  assert.equal(a.pick(T + 30 * MIN), 'backup')
  assert.equal(a.held('primary', T + 30 * MIN), true)
})

test('the soonest login back gave no time: no clock is shown, rather than a later one', () => {
  const a = createAccounts({ backupDir: '/b' })
  a.hold('primary', T + 120 * MIN, '17:20')
  a.hold('backup', T + 15 * MIN, null, 'down')
  // One limited, one set aside: not every login is at its limit, so it is not called one.
  assert.deepEqual(a.blocked(T), { until: T + 15 * MIN, clock: null, limited: false })
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
  const three = createAccounts({ backupDirs: ['/root/.claude-second-login', 'C:\\Users\\someone\\.claude-third'] })
  for (const l of three.labels()) three.hold(l, T + MIN, '15:21')
  assert.doesNotMatch(JSON.stringify([three.labels(), three.pick(T), three.blocked(T)]), /@|second-login|third|root|Users/)
})

test('three logins: labelled in the order given, each with its own directory', () => {
  const a = createAccounts({ backupDirs: ['/root/.claude-b', '/root/.claude-c'] })
  assert.deepEqual(a.labels(), ['primary', 'backup', 'backup2'])
  assert.equal(a.switchable(), true)
  const base = { PATH: '/usr/bin' }
  assert.equal(a.env('primary', base), base)
  assert.equal(a.env('backup', base).CLAUDE_CONFIG_DIR, '/root/.claude-b')
  assert.equal(a.env('backup2', base).CLAUDE_CONFIG_DIR, '/root/.claude-c')
})

test('one directory in the list is the same as backupDir: the label stays "backup"', () => {
  assert.deepEqual(createAccounts({ backupDirs: ['/b'] }).labels(), ['primary', 'backup'])
  assert.deepEqual(createAccounts({ backupDirs: [] }).labels(), ['primary'])
  // Empty entries are skipped, not given a label.
  assert.deepEqual(createAccounts({ backupDirs: ['', '/b', null] }).labels(), ['primary', 'backup'])
  // The list wins when both are given.
  assert.deepEqual(createAccounts({ backupDirs: ['/b', '/c'], backupDir: '/old' }).env('backup', {}), { CLAUDE_CONFIG_DIR: '/b' })
})

test('three logins: each taken in order while the ones before it are held, and the primary first again when it is back', () => {
  const a = createAccounts({ backupDirs: ['/b', '/c'] })
  assert.equal(a.pick(T), 'primary')
  a.hold('primary', T + 60 * MIN, '16:20')
  assert.equal(a.pick(T), 'backup')
  a.hold('backup', T + 30 * MIN, '15:50')
  assert.equal(a.pick(T), 'backup2')
  assert.equal(a.blocked(T), null)
  a.hold('backup2', T + 90 * MIN, '16:50')
  assert.equal(a.pick(T), null)
  assert.deepEqual(a.blocked(T), { until: T + 30 * MIN, clock: '15:50', limited: true })
  assert.equal(a.pick(T + 30 * MIN), 'backup')
  assert.equal(a.pick(T + 60 * MIN), 'primary')
})

test('pick leaves out the logins already tried, even when one of them is free again', () => {
  const a = createAccounts({ backupDirs: ['/b', '/c'] })
  assert.equal(a.pick(T, ['primary']), 'backup')
  assert.equal(a.pick(T, ['primary', 'backup']), 'backup2')
  assert.equal(a.pick(T, ['primary', 'backup', 'backup2']), null)
  a.hold('backup2', T + MIN, null)
  assert.equal(a.pick(T, ['primary', 'backup']), null)
})

test('every login set aside rather than limited: blocked, but not a limit', () => {
  const a = createAccounts({ backupDirs: ['/b', '/c'] })
  for (const l of a.labels()) a.hold(l, T + 15 * MIN, null, 'down')
  assert.deepEqual(a.blocked(T), { until: T + 15 * MIN, clock: null, limited: false })
  // The limit on one of them does not make the rest a limit either.
  a.hold('primary', T + 60 * MIN, '16:20', 'rate')
  assert.equal(a.blocked(T).limited, false)
})
