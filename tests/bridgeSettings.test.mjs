import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'

/**
 * What the bridge reads at start-up from the environment and from Claude
 * Code's own config (~/.claude.json), as the running bridge shows it: the
 * language (in the DRY reply), the MCP servers (in "ready"), the voice keys
 * and the recognition engine (in /health and the banner), the computer roots
 * (in the banner). Written while all of it was read in server.mjs.
 *
 * Not reachable this way: JARVIS_FILE_ROOTS — the temp folder these bridges
 * live in is already one of the default roots, and nothing is written outside
 * it.
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

const getJson = (port, path) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers: { Host: 'localhost' } }, (res) => {
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

const homes = []
const running = []

/** A bridge with its own empty home (plus `claudeJson`, when given) and `env`. */
async function boot({ env = {}, claudeJson } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'jarvis-settings-'))
  homes.push(home)
  if (claudeJson) writeFileSync(join(home, '.claude.json'), JSON.stringify(claudeJson(home)))
  const port = await freePort()
  const child = spawn(process.execPath, ['bridge/server.mjs'], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, JARVIS_BRIDGE_PORT: String(port), JARVIS_DRY_ASK: '1', JARVIS_KB: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (d) => (log += d))
  child.stderr.on('data', (d) => (log += d))
  child.on('error', (e) => (log += `\n[test] child process error: ${e.message}\n`))
  running.push(child)
  const alive = () => child.exitCode === null && child.signalCode === null
  let health = null
  // Ready: the "listening" line, then GET /health answering 200 with { ok: true }.
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
        const { status, body } = await getJson(port, '/health')
        let parsed = null
        try {
          parsed = JSON.parse(body)
        } catch {
          parsed = null
        }
        if (status === 200 && parsed?.ok === true && alive()) {
          health = parsed
          settle()
        }
      } catch {
        // ECONNREFUSED and the like: not ready yet.
      } finally {
        probing = false
      }
    }, 50)
    child.on('exit', onExit)
  })
  return { port, home, health, log: () => log }
}

/** The "ready" frame, and the DRY reply to one question, on a new socket. */
async function talk(b) {
  const ws = new WebSocket(`ws://127.0.0.1:${b.port}/`, { headers: { Host: 'localhost', Origin: 'http://localhost:5173' } })
  const frames = []
  ws.on('error', () => {})
  const done = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no reply: ${JSON.stringify(frames)}`)), 8000)
    ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString())
      frames.push(f)
      if (f.type === 'ready' && frames.length === 1) ws.send(JSON.stringify({ type: 'ask', id: 'lang', text: '?' }))
      if (f.type === 'done') {
        clearTimeout(t)
        resolve()
      }
    })
  })
  await done
  await new Promise((resolve) => {
    ws.once('close', resolve)
    ws.close(1000)
  })
  return { ready: frames[0], reply: frames.find((f) => f.type === 'done').text }
}

const RU = /^Проверка связи, сэр\. Мост получил команду/
const EN = /^Connection check, sir\. The bridge received the command and is answering without the model\. /

let plain
let configured
let envKeys
before(async () => {
  ;[plain, configured, envKeys] = await Promise.all([
    boot(),
    boot({
      env: { JARVIS_LANG: 'EN', JARVIS_PC_ROOTS: ' C:\\pc-one ; ;D:\\pc-two' },
      claudeJson: (home) => ({
        mcpServers: { alpha: { command: 'jarvis-test-none' }, elevenlabs: { command: 'jarvis-test-none', env: { ELEVENLABS_API_KEY: 'el-from-config' } } },
        projects: { [home]: { mcpServers: { beta: { command: 'jarvis-test-none' } } } },
      }),
    }),
    boot({ env: { DEEPGRAM_API_KEY: 'dg-test-key', ELEVENLABS_API_KEY: 'el-test-key', JARVIS_LANG: 'xx' } }),
  ])
})

after(async () => {
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
  for (const home of homes) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

test('language: Russian by default; JARVIS_LANG=en (any case) is English; anything else is Russian, with a warning', async () => {
  assert.match((await talk(plain)).reply, RU)
  assert.doesNotMatch(plain.log(), /is not ru or en/)
  assert.match((await talk(configured)).reply, EN)
  assert.match((await talk(envKeys)).reply, RU)
  assert.match(envKeys.log(), /\[jarvis\] JARVIS_LANG="xx" is not ru or en — using ru\./)
})

test('MCP servers: none without ~/.claude.json; the global ones and this home\'s project ones, in that order, with it', async () => {
  assert.deepEqual((await talk(plain)).ready, { type: 'ready', servers: [] })
  assert.deepEqual((await talk(configured)).ready, { type: 'ready', servers: ['alpha', 'elevenlabs', 'beta'] })
})

test('voice keys: nothing configured is the browser\'s engines', () => {
  assert.equal(plain.health.stt, false)
  assert.equal(plain.health.sttRealtime, false)
  assert.equal(plain.health.sttEngine, null)
  assert.match(plain.log(), /\[jarvis\] recognition browser engine \(no Deepgram or ElevenLabs key\)/)
})

test('voice keys: the ElevenLabs key is borrowed from the elevenlabs MCP server\'s config', () => {
  assert.equal(configured.health.stt, true)
  assert.equal(configured.health.ttsEngine, 'elevenlabs')
  assert.equal(configured.health.sttEngine, 'elevenlabs')
  assert.match(configured.log(), /\[jarvis\] recognition elevenlabs\n/)
})

test('voice keys: with both keys in the environment, Deepgram recognises and ElevenLabs speaks', () => {
  assert.equal(envKeys.health.stt, true)
  assert.equal(envKeys.health.ttsEngine, 'elevenlabs')
  assert.equal(envKeys.health.sttRealtime, true)
  assert.equal(envKeys.health.sttEngine, 'deepgram')
  assert.match(envKeys.log(), /\[jarvis\] recognition deepgram\n/)
})

test('JARVIS_STT pins the engine, and a pinned engine without its key is none; an unusable Deepgram key is said so', async () => {
  const [pinnedEleven, pinnedMissing] = await Promise.all([
    boot({ env: { DEEPGRAM_API_KEY: 'dg-test-key', ELEVENLABS_API_KEY: 'el-test-key', JARVIS_STT: ' ElevenLabs ' } }),
    boot({ env: { DEEPGRAM_API_KEY: 'has a space', ELEVENLABS_API_KEY: 'el-test-key', JARVIS_STT: 'deepgram' } }),
  ])
  assert.equal(pinnedEleven.health.sttEngine, 'elevenlabs')
  assert.equal(pinnedMissing.health.sttEngine, null)
  assert.equal(pinnedMissing.health.sttRealtime, false)
  assert.equal(pinnedMissing.health.stt, true, 'Scribe for single segments still rides the ElevenLabs key')
  assert.match(pinnedMissing.log(), /\[jarvis\] DEEPGRAM_API_KEY is set but unusable \(spaces, quotes or non-ASCII characters\)/)
  assert.doesNotMatch(pinnedEleven.log(), /DEEPGRAM_API_KEY is set but unusable/)
})

test('computer roots: the project, then JARVIS_PC_ROOTS split on ";" and trimmed, empties dropped', () => {
  assert.match(plain.log(), /\[jarvis\] computer tools in: [^;\n]+\n/, 'the project alone')
  assert.match(configured.log(), /\[jarvis\] computer tools in: [^;\n]+; C:\\pc-one; D:\\pc-two\n/)
})
