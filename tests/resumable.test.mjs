import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { RESUME_TTL_MS, createResumable, transcriptPath } from '../bridge/resumable.mjs'

const A = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d'
const B = '1b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d'

function rig(opts = {}) {
  let t = 1_000_000
  const r = createResumable({ now: () => t, ...opts })
  return { r, tick: (ms) => (t += ms) }
}

test('a session this bridge handed out can be resumed on the same login', () => {
  const { r } = rig()
  const pc = { close() {} }
  r.issue(A, 'primary', pc)
  assert.deepEqual(r.check(A, 'primary'), { ok: true, holder: pc })
})

test('an id the page made up, or a malformed one, is refused', () => {
  const { r } = rig()
  r.issue(A, 'primary', null)
  assert.deepEqual(r.check(B, 'primary'), { ok: false, reason: 'unknown' })
  for (const id of ['', 'x', '../../etc/passwd', `${A} `, 42, null, undefined, { id: A }]) {
    assert.equal(r.check(id, 'primary').ok, false, String(id))
  }
  r.issue('not-a-uuid', 'primary', null)
  assert.equal(r.size(), 1, 'nothing malformed is ever issued')
})

test('a session from the other login is refused: its transcript is not there', () => {
  const { r } = rig()
  r.issue(A, 'backup', null)
  assert.deepEqual(r.check(A, 'primary'), { ok: false, reason: 'other-login' })
})

test('thirty minutes after the last use the session is gone', () => {
  const { r, tick } = rig()
  const page = { close() {} }
  r.issue(A, 'primary', page)
  r.release(A, page)
  tick(RESUME_TTL_MS - 1)
  assert.equal(r.check(A, 'primary').ok, true)
  tick(1)
  assert.deepEqual(r.check(A, 'primary'), { ok: false, reason: 'unknown' })
})

test('each question renews the thirty minutes', () => {
  const { r, tick } = rig()
  r.issue(A, 'primary', null)
  tick(RESUME_TTL_MS - 1000)
  r.issue(A, 'primary', null)
  tick(RESUME_TTL_MS - 1000)
  assert.equal(r.check(A, 'primary').ok, true)
})

test('a closed connection leaves the session resumable with no holder', () => {
  const { r } = rig()
  const page = { close() {} }
  r.issue(A, 'primary', page)
  r.release(A, page)
  assert.deepEqual(r.check(A, 'primary'), { ok: true, holder: null })
})

test('a stale connection closing after another took the session over does not release it', () => {
  const { r } = rig()
  const old = { close() {} }
  const fresh = { close() {} }
  r.issue(A, 'primary', old)
  r.issue(A, 'primary', fresh)
  r.release(A, old)
  assert.deepEqual(r.check(A, 'primary'), { ok: true, holder: fresh })
})

test('a fresh bridge (after a restart) knows no sessions: the page starts a new conversation', () => {
  const { r } = rig()
  r.issue(A, 'primary', null)
  const restarted = createResumable()
  assert.deepEqual(restarted.check(A, 'primary'), { ok: false, reason: 'unknown' })
})

test('the transcript is looked for where Claude Code keeps it, per login', () => {
  assert.equal(transcriptPath('/root/.claude', '/root', A), `/root/.claude/projects/-root/${A}.jsonl`)
  assert.equal(transcriptPath('/root/.claude-backup/', '/root', A), `/root/.claude-backup/projects/-root/${A}.jsonl`)
  assert.equal(transcriptPath('/home/u/.claude', '/home/u', A), `/home/u/.claude/projects/-home-u/${A}.jsonl`)
})

test('memory is bounded: past the cap the oldest session goes', () => {
  const { r, tick } = rig({ max: 2 })
  const ids = ['a', 'b', 'c'].map((c) => `${c.repeat(8)}-0000-4000-8000-000000000000`)
  for (const id of ids) {
    r.issue(id, 'primary', null)
    tick(1)
  }
  assert.equal(r.size(), 2)
  assert.equal(r.check(ids[0], 'primary').ok, false)
  assert.equal(r.check(ids[2], 'primary').ok, true)
})

test('wiring: the bridge resumes only before a question, ends a stale socket, and never replays a turn', () => {
  const src = readFileSync(new URL('../bridge/server.mjs', import.meta.url), 'utf8').replace(/\r/g, '')
  assert.match(src, /const RESUMABLE = createResumable\(\)/)
  assert.match(src, /sessionId = msg\.session_id\n {16}\/\/ .*\n {16}RESUMABLE\.issue\(sessionId, account, owner\)\n {16}send\(\{ type: 'session', id: sessionId \}\)/, 'the id is handed to the page at init')
  assert.match(src, /let verdict = asked \? \{ ok: false, reason: 'already-asking' \} : RESUMABLE\.check\(msg\.id, account\)/, 'never once a question is under way')
  assert.match(src, /send\(\{ type: 'resumed', ok: false \}\)/)
  assert.match(src, /send\(\{ type: 'resumed', ok: true \}\)/)
  assert.match(src, /if \(verdict\.holder && verdict\.holder !== owner\) verdict\.holder\.close\(\)/, 'two sockets never share a session')
  assert.match(src, /if \(!existsSync\(transcriptPath\(dir, homedir\(\), msg\.id\)\)\) verdict = \{ ok: false, reason: 'no-transcript' \}/, 'no transcript, no resume')
  assert.match(src, /void Promise\.resolve\(session\?\.initializationResult\?\.\(\)\)\.then\(/, '"resumed" only once the session has started')
  assert.match(src, /if \(!asked\) replace\(null\)\n {10}send\(\{ type: 'resumed', ok: false \}\)/, 'a session that will not start falls back to a fresh one')
  assert.match(src, /!closed && !resume\) \{/, 'a failed resume does not set the login aside')
  assert.match(src, /if \(msg\.type === 'ask' && typeof msg\.text === 'string'\) \{\n {6}asked = true/)
  assert.match(src, /if \(sessionId\) RESUMABLE\.release\(sessionId, owner\)/, 'released on close')
  // The resume handler starts a session; it does not hand anything to turns.
  const handler = src.slice(src.indexOf("if (msg.type === 'resume') {"), src.indexOf("if (msg.type === 'ask' && typeof msg.text === 'string') {"))
  assert.doesNotMatch(handler, /turns\.ask|chan\.inbox\.push|chan\.put/, 'no question is replayed')
})
