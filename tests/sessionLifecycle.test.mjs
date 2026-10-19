import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAccounts } from '../bridge/accounts.mjs'
import { createSessionLifecycle, sessionOptions } from '../bridge/sessionLifecycle.mjs'
import { createSocketState } from '../bridge/socketState.mjs'

/**
 * One socket's session (bridge/sessionLifecycle.mjs), moved out of server.mjs
 * unchanged, on stand-ins for opening a session and reading its stream. The
 * same code through the real connection handler: tests/sessionCore.test.mjs.
 */

test('the options: the bridge\'s values, and what is fixed — no settings files, 24 turns, the default permission mode, partial messages', () => {
  const v = { mcpServers: { a: {} }, disallowedTools: ['Bash'], systemPrompt: 'p', cwd: '/h', model: 'm', effort: 'medium', env: { PATH: '/p' }, canUseTool: () => {} }
  const fresh = sessionOptions({ resume: null, ...v })
  assert.deepEqual(Object.keys(fresh), ['mcpServers', 'disallowedTools', 'systemPrompt', 'cwd', 'settingSources', 'model', 'effort', 'env', 'maxTurns', 'permissionMode', 'includePartialMessages', 'canUseTool'])
  assert.deepEqual(fresh.settingSources, [])
  assert.equal(fresh.maxTurns, 24)
  assert.equal(fresh.permissionMode, 'default')
  assert.equal(fresh.includePartialMessages, true)
  assert.equal(fresh.canUseTool, v.canUseTool)
  assert.equal('resume' in fresh, false, 'no resume key for a fresh session')
  assert.equal(sessionOptions({ resume: 'abc', ...v }).resume, 'abc')
})

/** A lifecycle on a stand-in SDK: every session opened, every close, every turn ended, in order. */
function rig({ backups = [] } = {}) {
  const accounts = createAccounts({ backupDirs: backups })
  const s = createSocketState({ effort: 'medium', account: 'primary' })
  const log = []
  let n = 0
  const sessions = []
  const open = (resume) => {
    const q = { id: ++n, resume, account: s.account, init: Promise.resolve(), close: () => log.push(`close ${q.id}`) }
    q.initializationResult = () => q.init
    sessions.push(q)
    log.push(`open ${q.id}${resume ? ` resume=${resume}` : ''} on ${s.account}`)
    return q
  }
  const life = createSessionLifecycle({
    s,
    open,
    pump: async (q, gen) => log.push(`pump ${q.id} gen=${gen}`),
    accounts,
    effort: 'medium',
    waitCapMs: 30_000,
    endStuckTurn: () => log.push('end stuck turn'),
  })
  return { s, life, log, sessions, accounts }
}

test('startSession: a new generation, the session live on the state, its stream read', (t) => {
  t.mock.method(console, 'log', () => {})
  const r = rig()
  r.life.startSession()
  assert.equal(r.s.sessionGen, 1)
  assert.equal(r.s.session, r.sessions[0])
  assert.deepEqual(r.log, ['open 1 on primary', 'pump 1 gen=1'])
})

test('switchTo: the old inbox closed and replaced, the old session closed, the turn\'s login, id, effort and asides reset, then a fresh session there', (t) => {
  t.mock.method(console, 'log', () => {})
  const r = rig({ backups: ['/b'] })
  r.life.startSession()
  const oldInbox = r.s.chan
  const oldLedger = r.s.asideLedger
  r.s.sessionId = 'old-id'
  r.s.sessionEffort = 'high'
  r.life.switchTo('backup', 'primary limited')
  assert.equal(oldInbox.closed, true)
  assert.notEqual(r.s.chan, oldInbox)
  assert.notEqual(r.s.asideLedger, oldLedger)
  assert.equal(r.s.account, 'backup')
  assert.equal(r.s.sessionId, null)
  assert.equal(r.s.sessionEffort, 'medium')
  assert.equal(r.s.sessionGen, 3, 'one for the old stream, one for the new session')
  assert.deepEqual(r.log, ['open 1 on primary', 'pump 1 gen=1', 'close 1', 'open 2 on backup', 'pump 2 gen=3'])
})

test('restart: the stuck session closed, then the turn ended, then a new session on the same conversation; asides kept when it resumes', (t) => {
  t.mock.method(console, 'warn', () => {})
  const r = rig()
  r.life.startSession()
  r.s.sessionId = 'conv-1'
  const ledger = r.s.asideLedger
  r.life.restart()
  assert.deepEqual(r.log, ['open 1 on primary', 'pump 1 gen=1', 'close 1', 'end stuck turn', 'open 2 resume=conv-1 on primary', 'pump 2 gen=3'])
  assert.equal(r.s.asideLedger, ledger, 'a resumed session has heard them')
  // No conversation id yet: a fresh session, which has heard none of the asides.
  const q = rig()
  q.life.startSession()
  const before = q.s.asideLedger
  q.life.restart()
  assert.notEqual(q.s.asideLedger, before)
  assert.equal(q.log.at(-2), 'open 2 on primary')
})

test('replace (resume): the old session closed, the id taken, effort reset, the new generation returned', (t) => {
  t.mock.method(console, 'log', () => {})
  const r = rig()
  r.life.startSession()
  r.s.sessionEffort = 'high'
  const gen = r.life.replace('conv-2')
  assert.equal(gen, r.s.sessionGen)
  assert.equal(r.s.sessionId, 'conv-2')
  assert.equal(r.s.sessionEffort, 'medium')
  assert.deepEqual(r.log.slice(2), ['close 1', 'open 2 resume=conv-2 on primary', `pump 2 gen=${gen}`])
})

/**
 * A lifecycle whose sessions never start, with `backups`; `after` runs once
 * the session is started and before its start has failed.
 */
async function failingStart({ backups, resume = null, after = () => {} }) {
  const accounts = createAccounts({ backupDirs: backups })
  const s = createSocketState({ effort: 'medium', account: 'primary' })
  const life = createSessionLifecycle({
    s,
    open: () => ({ initializationResult: () => Promise.reject(new Error('not logged in')), close() {} }),
    pump: async () => {},
    accounts,
    effort: 'medium',
    waitCapMs: 30_000,
    endStuckTurn: () => {},
  })
  life.startSession(resume)
  after(s)
  await new Promise((resolve) => setImmediate(resolve))
  return accounts
}

test('a session that will not start: its login set aside for 15 min, with another to go to', async (t) => {
  t.mock.method(console, 'log', () => {})
  const warn = t.mock.method(console, 'warn', () => {})
  const accounts = await failingStart({ backups: ['/b'] })
  assert.equal(accounts.held('primary'), true)
  assert.equal(accounts.pick(), 'backup')
  assert.deepEqual(
    warn.mock.calls.map((c) => c.arguments[0]),
    ['[jarvis] agent session warm-up failed (primary): not logged in', '[jarvis] login primary set aside for 15 min'],
  )
})

test('...but never with one login, for a resume, on a closed socket, or for a session already replaced', async (t) => {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'warn', () => {})
  const cases = {
    'one login': { backups: [] },
    'a resume': { backups: ['/b'], resume: 'conv' },
    'a closed socket': { backups: ['/b'], after: (s) => (s.closed = true) },
    'a session already replaced': { backups: ['/b'], after: (s) => s.sessionGen++ },
  }
  for (const [name, c] of Object.entries(cases)) {
    const accounts = await failingStart(c)
    assert.equal(accounts.held('primary'), false, name)
  }
})
