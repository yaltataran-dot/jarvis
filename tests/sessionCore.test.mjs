import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import WebSocket from 'ws'
import { transcriptPath } from '../bridge/resumable.mjs'

/**
 * The agent socket's session core, through the bridge's real connection
 * handler, with the Agent SDK's `query()` stood in for (tests/support): no
 * Claude Code process, no model. Each session the bridge opens reports to the
 * test, which plays the SDK's side — init, the stream, the result, a 429, a
 * stream that ends or throws, a start that fails.
 *
 * Written against the session core while it was all in server.mjs, so moving
 * it can be checked against the same frames, sessions and log lines.
 *
 * What this cannot show: anything of the real SDK or Claude Code — how they
 * stream, resume from a transcript, or report a limit. The messages here are
 * shaped like the SDK's as the bridge reads them, no more.
 */
const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const HOOK = new URL('./support/sdkHook.mjs', import.meta.url).href
const ORIGIN = 'http://localhost:5173'

const S1 = '11111111-1111-4111-8111-111111111111'
const S2 = '22222222-2222-4222-8222-222222222222'
const S3 = '33333333-3333-4333-8333-333333333333'

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

const health = (port) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/health', headers: { Host: 'localhost' } }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (d) => (body += d))
      res.on('end', () => resolve({ status: res.statusCode, body }))
      res.on('error', reject)
    })
    req.setTimeout(2000, () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end()
  })

/** Resolves when `list` (which grows) has an item matching `match`, at or after `from`. */
const waitIn = (list, subscribe, match, { from = 0, ms = 5000, what = 'item' } = {}) =>
  new Promise((resolve, reject) => {
    const hit = () => list.slice(from).find(match)
    const found = hit()
    if (found) return resolve(found)
    const off = subscribe(() => {
      const f = hit()
      if (!f) return
      clearTimeout(t)
      off()
      resolve(f)
    })
    const t = setTimeout(() => {
      off()
      reject(new Error(`no ${what} matching ${match} within ${ms} ms; got ${JSON.stringify(list.slice(from))}`))
    }, ms)
  })

const homes = []
const children = []

/** A bridge on the stand-in SDK, with its own home; its log and its sessions' reports. */
async function boot(env = {}) {
  const home = mkdtempSync(join(tmpdir(), 'jarvis-core-'))
  homes.push(home)
  const port = await freePort()
  const child = spawn(process.execPath, ['--import', HOOK, 'bridge/server.mjs'], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, JARVIS_BRIDGE_PORT: String(port), JARVIS_KB: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  children.push(child)
  let log = ''
  const logWatchers = new Set()
  const onLog = (d) => {
    log += d
    for (const w of [...logWatchers]) w()
  }
  child.stdout.on('data', onLog)
  child.stderr.on('data', onLog)
  child.on('error', (e) => onLog(`\n[test] child process error: ${e.message}\n`))
  const events = []
  const eventWatchers = new Set()
  child.on('message', (m) => {
    events.push(m)
    for (const w of [...eventWatchers]) w()
  })
  const alive = () => child.exitCode === null && child.signalCode === null
  await new Promise((resolve, reject) => {
    let settled = false
    let probing = false
    const settle = (err) => {
      if (settled) return
      settled = true
      clearInterval(poll)
      clearTimeout(deadline)
      child.off('exit', onExit)
      if (err) reject(err)
      else resolve()
    }
    const onExit = (code, signal) => settle(new Error(`bridge exited before it was ready (code ${code}, signal ${signal}):\n${log}`))
    const deadline = setTimeout(() => settle(new Error(`bridge was not ready within 20 s:\n${log}`)), 20000)
    const poll = setInterval(async () => {
      if (settled || probing || !/bridge listening/.test(log) || !alive()) return
      probing = true
      try {
        const { status, body } = await health(port)
        if (status === 200 && JSON.parse(body)?.ok === true && alive()) settle()
      } catch {
        // Not ready yet.
      } finally {
        probing = false
      }
    }, 50)
    child.on('exit', onExit)
  })
  const sub = (set) => (fn) => {
    set.add(fn)
    return () => set.delete(fn)
  }
  return {
    port,
    home,
    child,
    events,
    log: () => log,
    cmd: (c) => child.send(c),
    event: (match, opts) => waitIn(events, sub(eventWatchers), match, { what: 'SDK event', ...opts }),
    logLine: (re, ms = 5000) => waitIn([true], sub(logWatchers), () => re.test(log), { ms, what: `log line ${re}` }).catch(() => {
      throw new Error(`no log line matching ${re} within ${ms} ms:\n${log}`)
    }),
  }
}

/** A page's socket on `b`, with every frame it receives, and the session the bridge opened for it. */
async function connect(b) {
  const from = b.events.length
  const ws = new WebSocket(`ws://127.0.0.1:${b.port}/`, { headers: { Host: 'localhost', Origin: ORIGIN } })
  const frames = []
  const watchers = new Set()
  let closedWith = null
  ws.on('message', (raw) => {
    frames.push(JSON.parse(raw.toString()))
    for (const w of [...watchers]) w()
  })
  ws.on('close', (code) => {
    closedWith = code
    for (const w of [...watchers]) w()
  })
  ws.on('error', () => {})
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('unexpected-response', (_q, res) => reject(new Error(`handshake ${res.statusCode}`)))
  })
  const opened = await b.event((e) => e.ev === 'query', { from })
  const sub = (fn) => {
    watchers.add(fn)
    return () => watchers.delete(fn)
  }
  return {
    ws,
    frames,
    session: opened.session,
    send: (f) => ws.send(JSON.stringify(f)),
    frame: (match, opts) => waitIn(frames, sub, match, { what: 'frame', ...opts }),
    closed: () => waitIn([true], sub, () => closedWith !== null, { what: 'socket close' }).then(() => closedWith),
    close: () =>
      new Promise((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) return resolve()
        ws.once('close', resolve)
        ws.close(1000)
      }),
  }
}

const init = (session_id, servers = [{ name: 'alpha', status: 'connected' }, { name: 'beta', status: 'failed' }]) => ({
  type: 'system',
  subtype: 'init',
  session_id,
  mcp_servers: servers,
})
const text = (t) => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } })
const toolStart = (id, name) => ({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id, name } } })
const ok = (result, cost = 0.002) => ({ type: 'result', subtype: 'success', is_error: false, result, total_cost_usd: cost })
const limited = () => ({ type: 'result', subtype: 'success', is_error: true, api_error_status: 429, result: 'API Error: 429' })

const types = (frames) => frames.map((f) => f.type)
const quiet = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms))

let one
let two
let backupDir
before(async () => {
  backupDir = mkdtempSync(join(tmpdir(), 'jarvis-core-backup-'))
  homes.push(backupDir)
  ;[one, two] = await Promise.all([boot(), boot({ JARVIS_CLAUDE_BACKUP_DIR: backupDir })])
})

after(async () => {
  await Promise.all(
    children.map((c) =>
      c.exitCode !== null || c.signalCode !== null
        ? null
        : Promise.race([
            new Promise((resolve) => {
              c.once('exit', resolve)
              c.kill('SIGTERM')
            }),
            new Promise((resolve) => setTimeout(resolve, 5000)),
          ]),
    ),
  )
  for (const h of homes) rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

// -- 1, 8. a session opened, a turn answered, in order ---------------------------------

test('1, 8. a connection opens one session; init gives the page its id and the usable servers; a question is answered as effort, text, done', async () => {
  const p = await connect(one)
  const q = one.events.find((e) => e.ev === 'query' && e.session === p.session)
  assert.equal(q.resume, null)
  assert.equal(q.configDir, null, 'the primary login')
  assert.ok(q.servers.includes('jarvis') && q.servers.includes('jarvis_eyes'))
  one.cmd({ cmd: 'emit', session: p.session, msg: init(S1) })
  await p.frame((f) => f.type === 'ready' && p.frames.indexOf(f) > 0)
  assert.deepEqual(p.frames.slice(0, 3), [
    { type: 'ready', servers: [] },
    { type: 'session', id: S1 },
    { type: 'ready', servers: ['alpha'] },
  ])

  const at = p.frames.length
  const from = one.events.length
  p.send({ type: 'ask', id: 'q1', text: 'Сколько будет шесть на семь?' })
  const user = await one.event((e) => e.ev === 'user' && e.session === p.session, { from })
  assert.match(user.text, /^Сколько будет шесть на семь\?/)
  one.cmd({ cmd: 'emit', session: p.session, msg: text('Сорок ') })
  one.cmd({ cmd: 'emit', session: p.session, msg: text('два.') })
  one.cmd({ cmd: 'emit', session: p.session, msg: ok('Сорок два.') })
  await p.frame((f) => f.type === 'done', { from: at })
  assert.deepEqual(p.frames.slice(at), [
    { type: 'effort', level: p.frames[at].level, ask: 'q1' },
    { type: 'text', delta: 'Сорок ', ask: 'q1' },
    { type: 'text', delta: 'два.', ask: 'q1' },
    { type: 'done', text: 'Сорок два.', costUsd: 0.002, ask: 'q1' },
  ])
  await one.logLine(/\[jarvis\] turn ok in [\d.]+ s/)
  await one.logLine(/\[latency\] ask=q1 ok /)

  // 9. The page closing its socket: the session closed and its input generator ended.
  const closeFrom = one.events.length
  await p.close()
  await one.event((e) => e.ev === 'close' && e.session === p.session, { from: closeFrom })
  await one.event((e) => e.ev === 'prompt-ended' && e.session === p.session, { from: closeFrom })
  await one.logLine(/\[jarvis\] client disconnected \(code 1000\)/)
})

// -- 2, 3, 4. resume -------------------------------------------------------------------

test('3. resume of a session this bridge handed out, but with no transcript on disk: refused, the fresh session stays', async () => {
  const p = await connect(one)
  const from = one.events.length
  p.send({ type: 'resume', id: S1 })
  assert.deepEqual(await p.frame((f) => f.type === 'resumed'), { type: 'resumed', ok: false })
  await one.logLine(/resume refused \(no-transcript\) — new conversation/)
  await quiet()
  assert.equal(one.events.slice(from).filter((e) => e.ev === 'query').length, 0, 'no session opened for it')
  await p.close()
})

test('2. resume with its transcript: a new session opened on it, the old one closed, "resumed" once it has started; questions go to it', async () => {
  const transcript = transcriptPath(join(one.home, '.claude'), one.home, S1)
  mkdirSync(dirname(transcript), { recursive: true })
  writeFileSync(transcript, '{}\n')
  const p = await connect(one)
  const from = one.events.length
  p.send({ type: 'resume', id: S1 })
  const resumed = await one.event((e) => e.ev === 'query' && e.resume === S1, { from })
  await one.event((e) => e.ev === 'close' && e.session === p.session, { from })
  assert.deepEqual(await p.frame((f) => f.type === 'resumed'), { type: 'resumed', ok: true })
  await one.logLine(/conversation resumed after reconnect/)

  const at = one.events.length
  p.send({ type: 'ask', id: 'r1', text: 'А дальше?' })
  const user = await one.event((e) => e.ev === 'user', { from: at })
  assert.equal(user.session, resumed.session, 'the question goes to the resumed session')
  one.cmd({ cmd: 'emit', session: resumed.session, msg: ok('Дальше всё.') })
  assert.deepEqual(await p.frame((f) => f.type === 'done'), { type: 'done', text: 'Дальше всё.', costUsd: 0.002, ask: 'r1' })

  // Once a question is under way, the socket's session is its own: no resume any more.
  p.send({ type: 'resume', id: S1 })
  await p.frame((f) => f.type === 'resumed' && f.ok === false)
  await one.logLine(/resume refused \(already-asking\)/)
  await p.close()
})

test('4. a resumed session that will not start: the page is told no, and a fresh session takes its place', async () => {
  const p = await connect(one)
  const from = one.events.length
  one.cmd({ cmd: 'next-init', fail: 'transcript would not load' })
  await one.event((e) => e.ev === 'next-init-set', { from })
  p.send({ type: 'resume', id: S1 })
  const broken = await one.event((e) => e.ev === 'query' && e.resume === S1, { from })
  const fresh = await one.event((e) => e.ev === 'query' && e.resume === null && e.session > broken.session, { from })
  assert.ok(fresh.session > broken.session)
  assert.deepEqual(await p.frame((f) => f.type === 'resumed'), { type: 'resumed', ok: false })
  await one.logLine(/resume failed \(transcript would not load\) — new conversation/)
  // The fresh session takes the next question.
  const at = one.events.length
  p.send({ type: 'ask', id: 'f1', text: 'Привет' })
  const user = await one.event((e) => e.ev === 'user', { from: at })
  assert.equal(user.session, fresh.session)
  one.cmd({ cmd: 'emit', session: fresh.session, msg: ok('Здравствуйте.') })
  await p.frame((f) => f.type === 'done' && f.ask === 'f1')
  await p.close()
})

test('4b. a session that will not start on the primary, with a backup: the primary set aside, and the question goes to the backup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-core-backup-'))
  homes.push(dir)
  const b = await boot({ JARVIS_CLAUDE_BACKUP_DIR: dir })
  b.cmd({ cmd: 'next-init', fail: 'not logged in' })
  await b.event((e) => e.ev === 'next-init-set')
  const p = await connect(b)
  await b.logLine(/agent session warm-up failed \(primary\): not logged in/)
  await b.logLine(/login primary set aside for 15 min/)
  const from = b.events.length
  p.send({ type: 'ask', id: 'w1', text: 'Привет' })
  // Between turns the session moves to the first login not held off.
  const backup = await b.event((e) => e.ev === 'query' && e.configDir === dir, { from })
  await b.logLine(/claude login primary -> backup \(primary held off\)/)
  const user = await b.event((e) => e.ev === 'user', { from })
  assert.equal(user.session, backup.session)
  b.cmd({ cmd: 'emit', session: backup.session, msg: ok('Здравствуйте.') })
  assert.deepEqual(await p.frame((f) => f.type === 'done'), { type: 'done', text: 'Здравствуйте.', costUsd: 0.002, ask: 'w1' })
  await p.close()
})

// -- 9. the stream ending under the socket ------------------------------------------------

test('9. the session\'s stream ending or throwing: an error frame, and the socket closed so the page reconnects', async () => {
  const a = await connect(one)
  one.cmd({ cmd: 'end', session: a.session })
  assert.deepEqual(await a.frame((f) => f.type === 'error'), { type: 'error', message: 'the agent session ended' })
  assert.notEqual(await a.closed(), null)
  await one.logLine(/\[jarvis\] session error: Error: the agent session ended/)

  const b = await connect(one)
  one.cmd({ cmd: 'fail', session: b.session, message: 'spawn claude ENOENT' })
  assert.deepEqual(await b.frame((f) => f.type === 'error'), { type: 'error', message: 'spawn claude ENOENT' })
  assert.notEqual(await b.closed(), null)
  // The bridge itself carries on.
  const c = await connect(one)
  await c.frame((f) => f.type === 'ready')
  await c.close()
})

// -- 6, 7. the usage limit with a backup login ---------------------------------------------

test('6. a 429 on the primary: the same question asked again on the backup in a new session, the page never sees the limit', async () => {
  const p = await connect(two)
  await two.logLine(/claude logins: primary, backup\n/)
  two.cmd({ cmd: 'emit', session: p.session, msg: init(S2) })
  await p.frame((f) => f.type === 'ready' && p.frames.indexOf(f) > 0)
  const at = p.frames.length
  const from = two.events.length
  p.send({ type: 'ask', id: 'a1', text: 'Какая погода в Москве?' })
  const first = await two.event((e) => e.ev === 'user' && e.session === p.session, { from })
  two.cmd({ cmd: 'emit', session: p.session, msg: limited() })
  const backup = await two.event((e) => e.ev === 'query' && e.configDir === backupDir, { from })
  assert.equal(backup.resume, null, 'a new session: the conversation does not cross logins')
  await two.event((e) => e.ev === 'close' && e.session === p.session, { from })
  const again = await two.event((e) => e.ev === 'user' && e.session === backup.session, { from })
  assert.equal(again.text, first.text, 'the same question')
  await two.logLine(/claude login primary -> backup \(primary limited\)/)
  await two.logLine(/ask a1 asked again on login backup/)
  two.cmd({ cmd: 'emit', session: backup.session, msg: text('Солнечно.') })
  two.cmd({ cmd: 'emit', session: backup.session, msg: ok('Солнечно.') })
  await p.frame((f) => f.type === 'done', { from: at })
  // An effort frame for each hand-over (one per session the question went into), and no error frame.
  assert.deepEqual(types(p.frames.slice(at)), ['effort', 'effort', 'text', 'done'], 'no error frame between')
  assert.equal(p.frames.at(-1).ask, 'a1')
  p.backup = backup.session
  two.socket = p
})

test('7. after a tool has been called, a 429 is never asked again on another login: the mid-turn sentence instead', async () => {
  const p = two.socket
  const session = p.backup
  const at = p.frames.length
  const from = two.events.length
  p.send({ type: 'ask', id: 'a2', text: 'Найди новости про космос' })
  await two.event((e) => e.ev === 'user' && e.session === session, { from })
  two.cmd({ cmd: 'emit', session, msg: toolStart('t1', 'WebSearch') })
  await p.frame((f) => f.type === 'tool', { from: at })
  two.cmd({ cmd: 'emit', session, msg: limited() })
  const err = await p.frame((f) => f.type === 'error', { from: at })
  assert.equal(err.ask, 'a2')
  assert.equal(err.kind, 'rate')
  assert.match(err.message, /^Лимит Claude исчерпан посреди запроса\./)
  await quiet(500)
  const after = two.events.slice(from)
  assert.equal(after.filter((e) => e.ev === 'query').length, 0, 'no new session')
  assert.equal(after.filter((e) => e.ev === 'user').length, 1, 'asked once')
  assert.deepEqual(types(p.frames.slice(at)), ['effort', 'tool', 'error'])
  await p.close()
})

// -- 5. a stopped turn that never ends --------------------------------------------------------

test('5. a stopped turn that never reports its end: after 30 s the session is replaced, resuming the conversation, and the next question goes there', { timeout: 60_000 }, async () => {
  const b = await boot()
  const p = await connect(b)
  b.cmd({ cmd: 'emit', session: p.session, msg: init(S3) })
  await p.frame((f) => f.type === 'session')
  const from = b.events.length
  p.send({ type: 'ask', id: 's1', text: 'Расскажи длинную историю' })
  await b.event((e) => e.ev === 'user' && e.session === p.session, { from })
  b.cmd({ cmd: 'emit', session: p.session, msg: text('Жил-был…') })
  await p.frame((f) => f.type === 'text')
  p.send({ type: 'interrupt' })
  await b.event((e) => e.ev === 'interrupt' && e.session === p.session, { from })
  // No result ever comes for it.
  const replaced = await b.event((e) => e.ev === 'query' && e.session > p.session, { from, ms: 40_000 })
  assert.equal(replaced.resume, S3, 'the conversation picked up from its transcript')
  await b.event((e) => e.ev === 'close' && e.session === p.session, { from })
  await b.logLine(/turn still running 30 s after it was stopped — restarting the agent session/)
  await b.logLine(/\[latency\] ask=s1 stuck /)
  const at = b.events.length
  p.send({ type: 'ask', id: 's2', text: 'Теперь коротко' })
  const user = await b.event((e) => e.ev === 'user', { from: at })
  assert.equal(user.session, replaced.session)
  b.cmd({ cmd: 'emit', session: replaced.session, msg: ok('Коротко.') })
  assert.deepEqual(await p.frame((f) => f.type === 'done'), { type: 'done', text: 'Коротко.', costUsd: 0.002, ask: 's2' })
  await p.close()
})
