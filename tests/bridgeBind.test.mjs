import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'

/**
 * The bridge as a process: where it listens, and whose Host header it answers to.
 *
 * This is a regression test for something that happened — the bind address and
 * the Host check were lost from server.mjs once, silently, and the bridge ended
 * up on every interface answering to any Host. Unit tests of a helper would not
 * have noticed; only the running server does. Claude is never called (DRY mode),
 * and the home folder is empty so no MCP server is started.
 */
const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

let home
const running = []

async function boot(extraEnv = {}) {
  const port = await freePort()
  const child = spawn(process.execPath, ['bridge/server.mjs'], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, JARVIS_BRIDGE_PORT: String(port), JARVIS_DRY_ASK: '1', JARVIS_KB: '0', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (d) => (log += d))
  child.stderr.on('data', (d) => (log += d))
  // Kept for the child's whole life: an 'error' with no listener would throw in
  // the test process. Before the bridge is ready, boot() also rejects on it.
  child.on('error', (e) => (log += `\n[test] child process error: ${e.message}\n`))
  running.push(child)
  const alive = () => child.exitCode === null && child.signalCode === null
  // Ready means: the "listening" line, then a real GET /health answered 200 with
  // { ok: true } — while the process is still running, before and after.
  await new Promise((resolve, reject) => {
    let settled = false
    let probing = false
    let probe = null
    let lastProbe = 'none yet'
    const settle = (err) => {
      if (settled) return
      settled = true
      clearInterval(poll)
      clearTimeout(deadline)
      child.off('exit', onExit)
      child.off('error', onError)
      probe?.destroy()
      if (err) reject(err)
      else resolve()
    }
    const onExit = (code, signal) => settle(new Error(`bridge exited before it was ready (code ${code}, signal ${signal}):\n${log}`))
    const onError = (e) => settle(new Error(`bridge could not be started: ${e.message}\n${log}`))
    const deadline = setTimeout(() => settle(new Error(`bridge was not ready within 20 s (last /health probe: ${lastProbe}):\n${log}`)), 20000)
    const poll = setInterval(async () => {
      if (settled || probing || !/bridge listening/.test(log) || !alive()) return
      probing = true
      try {
        const { status, body } = await health(port, (req) => (probe = req))
        lastProbe = `${status} ${body.slice(0, 200)}`
        let ok = false
        try {
          ok = JSON.parse(body)?.ok === true
        } catch {
          ok = false
        }
        if (status === 200 && ok && alive()) settle()
      } catch (e) {
        // ECONNREFUSED and the like: not ready yet; tried again until the deadline.
        lastProbe = e.code ?? e.message
      } finally {
        probe = null
        probing = false
      }
    }, 50)
    child.on('exit', onExit)
    child.on('error', onError)
  })
  return { port, child, log: () => log }
}

/** One GET /health with Host: localhost; resolves with the status and the body. */
const health = (port, onRequest) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/health', method: 'GET', headers: { Host: 'localhost' } }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (d) => (body += d))
      res.on('end', () => resolve({ status: res.statusCode, body }))
      res.on('error', reject)
    })
    req.setTimeout(2000, () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end()
    onRequest(req)
  })

/**
 * Waits until the bridge's log matches `re`. stdout and stderr are separate
 * pipes, so a line can arrive after the response that caused it, or after a
 * line written on the other stream before it.
 */
const waitForLog = (bridge, re, ms = 5000) =>
  new Promise((resolve, reject) => {
    if (re.test(bridge.log())) return resolve()
    const { child } = bridge
    const check = () => {
      if (re.test(bridge.log())) done()
    }
    const onExit = () => {
      // Output written just before exit can still be in the pipe; one last look.
      setImmediate(() => done(re.test(bridge.log()) ? undefined : new Error(`bridge exited before logging ${re}:\n${bridge.log()}`)))
    }
    const t = setTimeout(() => done(new Error(`no log line matching ${re} within ${ms} ms:\n${bridge.log()}`)), ms)
    let finished = false
    const done = (err) => {
      if (finished) return
      finished = true
      clearTimeout(t)
      child.stdout.off('data', check)
      child.stderr.off('data', check)
      child.off('exit', onExit)
      if (err) reject(err)
      else resolve()
    }
    child.stdout.on('data', check)
    child.stderr.on('data', check)
    child.once('exit', onExit)
  })

/** GET with an exact Host header (fetch cannot set one). */
const get = ({ port, host, path = '/health', headers = {}, address = '127.0.0.1' }) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: address, port, path, method: 'GET', headers: { ...(host === undefined ? {} : { Host: host }), ...headers } }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    req.setTimeout(4000, () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end()
  })

/** WebSocket handshake outcome: 101 or the refusing status. */
const handshake = ({ port, host, origin }) =>
  new Promise((resolve) => {
    const headers = {}
    if (host !== undefined) headers.Host = host
    if (origin !== undefined) headers.Origin = origin
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers })
    const t = setTimeout(() => (ws.terminate(), resolve('timeout')), 4000)
    ws.on('open', () => (clearTimeout(t), ws.close(), resolve(101)))
    ws.on('unexpected-response', (_q, res) => (clearTimeout(t), resolve(res.statusCode)))
    ws.on('error', () => {})
  })

let plain
let withHosts
before(async () => {
  home = mkdtempSync(join(tmpdir(), 'jarvis-bind-'))
  ;[plain, withHosts] = await Promise.all([
    boot(),
    boot({ JARVIS_ALLOWED_ORIGINS: 'http://box.example:15173', JARVIS_ALLOWED_HOSTS: 'Jarvis.Example' }),
  ])
})
after(async () => {
  // Windows keeps the folder busy until the bridges using it are gone, so wait
  // for them to exit (capped, in case one never does) before removing it; the
  // retries cover the moment after that while their handles close.
  await Promise.all(
    running.map((c) =>
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
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

test('the bridge says it listens on loopback, by default', () => {
  assert.match(plain.log(), new RegExp(`bridge listening on ws://127\\.0\\.0\\.1:${plain.port}`))
})

const external = Object.values(networkInterfaces())
  .flat()
  .find((i) => i && i.family === 'IPv4' && !i.internal)

test('it does not answer on the machine’s other addresses', { skip: external ? false : 'no non-loopback address on this machine' }, async () => {
  await assert.rejects(get({ port: plain.port, address: external.address, host: 'localhost' }), /ECONNREFUSED/)
  assert.equal(await get({ port: plain.port, host: 'localhost' }), 200, 'and still answers on loopback')
})

test('loopback names are served, on any port (a tunnel may remap it)', async () => {
  for (const host of ['localhost', 'localhost:8787', '127.0.0.1', '127.0.0.1:15173', '[::1]:8787', 'LOCALHOST:8787']) {
    assert.equal(await get({ port: plain.port, host }), 200, host)
  }
})

test('any other Host is refused — the DNS-rebinding guard', async () => {
  for (const host of ['evil.example', 'evil.example:8787', 'localhost.evil.example', 'evil-localhost', '10.0.0.5:8787', 'a b']) {
    assert.equal(await get({ port: plain.port, host }), 403, JSON.stringify(host))
  }
})

/** A request written by hand, so the Host header is exactly what is typed (or absent). */
const raw = (port, head) =>
  new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.write(head))
    let out = ''
    sock.setTimeout(4000, () => sock.destroy(new Error('timeout')))
    sock.on('data', (d) => (out += d))
    sock.on('close', () => resolve(Number(/^HTTP\/1\.[01] (\d{3})/.exec(out)?.[1])))
    sock.on('error', reject)
  })

test('an empty Host, or none at all, is refused', async () => {
  assert.equal(await raw(plain.port, 'GET /health HTTP/1.1\r\nHost: \r\nConnection: close\r\n\r\n'), 403, 'empty')
  assert.equal(await raw(plain.port, 'GET /health HTTP/1.0\r\n\r\n'), 403, 'absent')
  assert.equal(await raw(plain.port, 'GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'), 200, 'control: a proper Host passes')
})

test('the Host check comes first: a good Origin does not save a bad Host', async () => {
  assert.equal(await get({ port: plain.port, host: 'evil.example', headers: { Origin: 'http://localhost:5173' } }), 403)
  assert.equal(await get({ port: plain.port, host: 'localhost', headers: { Origin: 'http://localhost:5173' } }), 200)
  assert.equal(await get({ port: plain.port, host: 'localhost', headers: { Origin: 'http://evil.example' } }), 403, 'and a bad Origin is still refused')
})

test('the WebSocket handshake checks Host too', async () => {
  assert.equal(await handshake({ port: plain.port, host: 'localhost', origin: 'http://localhost:5173' }), 101)
  assert.equal(await handshake({ port: plain.port, host: 'evil.example', origin: 'http://localhost:5173' }), 403)
  assert.equal(await handshake({ port: plain.port, host: 'localhost', origin: 'http://localhost:15174' }), 403, 'the Origin rule is unchanged')
  assert.equal(await handshake({ port: plain.port, host: 'localhost' }), 403, 'no Origin, no socket')
})

test('hosts named in JARVIS_ALLOWED_ORIGINS or JARVIS_ALLOWED_HOSTS are served, nothing else', async () => {
  for (const host of ['box.example', 'box.example:15173', 'jarvis.example', 'localhost']) {
    assert.equal(await get({ port: withHosts.port, host }), 200, host)
  }
  assert.equal(await get({ port: withHosts.port, host: 'evil.example' }), 403)
  assert.equal(await get({ port: withHosts.port, host: 'box.example.evil.example' }), 403)
  assert.equal(await get({ port: plain.port, host: 'box.example' }), 403, 'and not on a bridge that was not told about them')
  assert.equal(await handshake({ port: withHosts.port, host: 'box.example', origin: 'http://box.example:15173' }), 101)
})

test('Origin: the local dev ports are let in; other ports, schemes and hosts are not', async () => {
  const allowed = ['http://localhost:5173', 'http://localhost:5199', 'http://localhost:4173', 'http://localhost:4199', 'http://127.0.0.1:5180', 'http://[::1]:5173']
  const refused = [
    'http://localhost:5172',
    'http://localhost:5200',
    'http://localhost:4172',
    'http://localhost:4200',
    'http://localhost',
    'http://localhost:8787',
    'https://localhost:5173',
    'http://evil.example:5173',
    'http://localhost.evil.example:5173',
    'null',
    'not a url',
  ]
  for (const origin of allowed) assert.equal(await get({ port: plain.port, host: 'localhost', headers: { Origin: origin } }), 200, origin)
  for (const origin of refused) assert.equal(await get({ port: plain.port, host: 'localhost', headers: { Origin: origin } }), 403, origin)
})

test('Origin: one named in JARVIS_ALLOWED_ORIGINS is let in, with or without a trailing slash, and only that one', async () => {
  for (const origin of ['http://box.example:15173', 'http://box.example:15173/', 'http://localhost:5173']) {
    assert.equal(await get({ port: withHosts.port, host: 'box.example', headers: { Origin: origin } }), 200, origin)
  }
  for (const origin of ['http://box.example:15174', 'https://box.example:15173', 'http://box.example']) {
    assert.equal(await get({ port: withHosts.port, host: 'box.example', headers: { Origin: origin } }), 403, origin)
  }
  assert.equal(await get({ port: plain.port, host: 'localhost', headers: { Origin: 'http://box.example:15173' } }), 403, 'not on a bridge that was not told')
})

test('Origin: no Origin opens no socket unless JARVIS_ALLOW_NO_ORIGIN=1; listed origins are trimmed, and the banner says what is accepted', async () => {
  assert.match(plain.log(), /accepting local dev origins\n/, 'nothing more on a bridge told nothing')
  assert.match(withHosts.log(), /accepting local dev origins plus http:\/\/box\.example:15173\n/)
  const open = await boot({ JARVIS_ALLOW_NO_ORIGIN: '1', JARVIS_ALLOWED_ORIGINS: ' http://a.example:9000/ ,, http://b.example// ' })
  assert.match(open.log(), /accepting local dev origins plus http:\/\/a\.example:9000, http:\/\/b\.example and clients that send no origin\n/)
  assert.equal(await handshake({ port: open.port, host: 'localhost' }), 101, 'no Origin, a socket')
  assert.equal(await handshake({ port: plain.port, host: 'localhost' }), 403, 'and still none by default')
  assert.equal(await handshake({ port: open.port, host: 'localhost', origin: 'http://evil.example' }), 403, 'a bad Origin is still refused')
  assert.equal(await handshake({ port: open.port, host: 'a.example:9000', origin: 'http://a.example:9000' }), 101)
  assert.equal(await get({ port: open.port, host: 'b.example', headers: { Origin: 'http://b.example' } }), 200)
  assert.equal(await get({ port: open.port, host: 'c.example' }), 403)
})

test('refusals are logged with the host that was refused, without secrets', async () => {
  await get({ port: plain.port, host: 'logged.example' })
  await waitForLog(plain, /refused http request for host logged\.example/)
  assert.match(plain.log(), /refused http request for host logged\.example/)
})

test('a backup login directory is taken by label, and a missing one turns the backup off', async () => {
  assert.doesNotMatch(plain.log(), /claude logins|JARVIS_CLAUDE_BACKUP_DIR/)
  const backupDir = mkdtempSync(join(home, 'login-backup-'))
  const withBackup = await boot({ JARVIS_CLAUDE_BACKUP_DIR: backupDir })
  assert.match(withBackup.log(), /claude logins: primary, backup/)
  const missing = await boot({ JARVIS_CLAUDE_BACKUP_DIR: join(home, 'no-such-login') })
  // A warning on stderr; "listening" came on stdout and may have won the race.
  await waitForLog(missing, /JARVIS_CLAUDE_BACKUP_DIR is not a directory — backup login off/)
  assert.match(missing.log(), /JARVIS_CLAUDE_BACKUP_DIR is not a directory — backup login off/)
  assert.doesNotMatch(missing.log(), /claude logins/)
  // The directory is the user's: neither path reaches the log.
  for (const b of [withBackup, missing]) assert.doesNotMatch(b.log(), /login-backup-|no-such-login/)
})
