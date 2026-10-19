import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MASK,
  agentEnv,
  clearRegisteredSecrets,
  installLogRedaction,
  redactSecrets,
  registerSecrets,
  secretValuesFrom,
  systemEnv,
  withoutSecrets,
  writesAllowed,
} from '../bridge/secrets.mjs'
import { createComputer, redact } from '../bridge/computer.mjs'
import { FallbackError } from '../bridge/fallback.mjs'

// Made-up values. None of them is, or was ever, a real key.
const BRIDGE_SECRETS = {
  DEEPGRAM_API_KEY: 'JRV-CANARY-deepgram-0f3a9c1e5b7d',
  ELEVENLABS_API_KEY: 'JRV-CANARY-eleven-7b2d4e6f8a1c',
  JARVIS_FALLBACK_API_KEY: 'JRV-CANARY-fallback-1c8e5a3b9d2f',
  VITE_ANTHROPIC_API_KEY: 'JRV-CANARY-vite-4a7c1e9b3d5f',
  GITHUB_TOKEN: 'JRV-CANARY-github-2a6c9e4f1b8d',
  DB_PASSWORD: 'JRV-CANARY-password-8f3b1d6a2c4e',
  AWS_SECRET_ACCESS_KEY: 'JRV-CANARY-aws-5d9f2b7e1a3c',
  NPM_CONFIG__AUTHTOKEN: 'JRV-CANARY-npm-3e8a6c2f9b1d',
}
const AGENT_LOGIN = {
  ANTHROPIC_API_KEY: 'JRV-AGENT-own-key-6b1e4d8a',
  CLAUDE_CODE_OAUTH_TOKEN: 'JRV-AGENT-own-login-9c3f7a2e',
}
const ENV = {
  ...BRIDGE_SECRETS,
  ...AGENT_LOGIN,
  Path: 'C:\\Windows\\system32;C:\\Program Files\\nodejs',
  PATHEXT: '.COM;.EXE',
  USERPROFILE: 'C:\\Users\\someone',
  HOME: '/home/someone',
  SystemRoot: 'C:\\Windows',
  TEMP: 'C:\\Temp',
  LC_ALL: 'ru_RU.UTF-8',
  HTTPS_PROXY: 'http://proxy.local:3128',
  NODE_EXTRA_CA_CERTS: '/etc/ca.pem',
  CLAUDE_CONFIG_DIR: '/home/someone/.claude',
  CLAUDE_CODE_SKIP_VERTEX_AUTH: '1',
  ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
  MCP_TIMEOUT: '30000',
  NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org',
  JARVIS_ALLOW_WRITES: '1',
  JARVIS_PC_ROOTS: '/',
  JARVIS_FALLBACK_MODEL: 'claude-haiku-5-5',
  SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
  PSModulePath: 'C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\Modules',
  ComSpec: 'C:\\Windows\\system32\\cmd.exe',
  FOO: 'bar',
}

const canaries = Object.values(BRIDGE_SECRETS)
const leaks = (obj) => canaries.filter((v) => JSON.stringify(obj).includes(v))

afterEach(() => clearRegisteredSecrets())

test('the agent gets its own settings and login, the basics and the network — none of the bridge’s keys', () => {
  const env = agentEnv(ENV)
  assert.deepEqual(leaks(env), [])
  for (const name of ['Path', 'PATHEXT', 'USERPROFILE', 'HOME', 'SystemRoot', 'TEMP', 'LC_ALL', 'HTTPS_PROXY', 'NODE_EXTRA_CA_CERTS',
    'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_SKIP_VERTEX_AUTH', 'ANTHROPIC_BASE_URL', 'MCP_TIMEOUT', 'NPM_CONFIG_REGISTRY',
    'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) {
    assert.equal(env[name], ENV[name], `${name} should reach the agent`)
  }
  for (const name of ['JARVIS_ALLOW_WRITES', 'JARVIS_PC_ROOTS', 'JARVIS_FALLBACK_MODEL', 'SSH_AUTH_SOCK', 'FOO', 'PSModulePath', ...Object.keys(BRIDGE_SECRETS)]) {
    assert.ok(!(name in env), `${name} should not reach the agent`)
  }
})

test('cloud credentials go to the agent only when it is pointed at that cloud', () => {
  assert.ok(!('AWS_SECRET_ACCESS_KEY' in agentEnv(ENV)))
  const bedrock = agentEnv({ ...ENV, CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'eu-west-1' })
  assert.equal(bedrock.AWS_REGION, 'eu-west-1')
  assert.equal(bedrock.AWS_SECRET_ACCESS_KEY, ENV.AWS_SECRET_ACCESS_KEY)
  assert.ok(!('DEEPGRAM_API_KEY' in bedrock))
  assert.ok(!('AWS_REGION' in agentEnv({ ...ENV, CLAUDE_CODE_USE_BEDROCK: '0', AWS_REGION: 'x' })))
})

test('a program started for the model gets the basics and nothing else', () => {
  const env = systemEnv(ENV)
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LC_ALL', 'PATHEXT', 'Path', 'SystemRoot', 'TEMP', 'USERPROFILE', 'ComSpec'].sort())
  assert.ok(!JSON.stringify(env).includes('JRV-'), 'not even the agent’s own login')
})

test('the bridge’s own helpers keep their environment, less anything secret', () => {
  const env = withoutSecrets(ENV)
  for (const name of ['Path', 'PSModulePath', 'ComSpec', 'FOO', 'JARVIS_PC_ROOTS']) assert.equal(env[name], ENV[name])
  assert.deepEqual(leaks(env), [])
  // The SSH agent's socket is a way to use the keys without reading them.
  assert.ok(!('SSH_AUTH_SOCK' in env))
  assert.ok(!('ANTHROPIC_API_KEY' in env) && !('JARVIS_FALLBACK_MODEL' in env))
})

test('a real child process sees only what it was given', () => {
  const print = ['-e', 'process.stdout.write(JSON.stringify(process.env))']
  // Windows needs SystemRoot to start a process at all; take the real one.
  const base = { ...ENV, SystemRoot: process.env.SystemRoot ?? '', Path: process.env.PATH ?? process.env.Path ?? '' }
  for (const [name, env] of [['systemEnv', systemEnv(base)], ['agentEnv', agentEnv(base)], ['withoutSecrets', withoutSecrets(base)]]) {
    const r = spawnSync(process.execPath, print, { env, encoding: 'utf8' })
    assert.equal(r.status, 0, `${name}: ${r.stderr}`)
    const seen = JSON.parse(r.stdout)
    assert.deepEqual(leaks(seen), [], `${name} leaked`)
    assert.ok(!Object.keys(seen).some((k) => /^JARVIS_FALLBACK|^DEEPGRAM|^ELEVENLABS/i.test(k)), name)
  }
})

test('run_check gets the basics only, not the bridge’s environment', async () => {
  const saved = { ...process.env }
  Object.assign(process.env, BRIDGE_SECRETS, AGENT_LOGIN)
  const root = mkdtempSync(join(tmpdir(), 'jarvis-secrets-'))
  try {
    const calls = []
    const spawn = (cmd, args, opts) => {
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = () => {}
      calls.push(opts)
      setTimeout(() => child.emit('close', 0), 1)
      return child
    }
    await createComputer({ roots: [root], spawn }).runCheck('lint')
    const env = calls[0].env
    assert.deepEqual(leaks(env), [])
    assert.ok(!JSON.stringify(env).includes(AGENT_LOGIN.ANTHROPIC_API_KEY))
    assert.equal(env.NO_COLOR, '1')
    assert.ok(env.PATH ?? env.Path, 'still finds programs')
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
    rmSync(root, { recursive: true, force: true })
  }
})

test('registered values are masked wherever they appear', () => {
  registerSecrets(secretValuesFrom(ENV))
  const text = `deepgram said ${BRIDGE_SECRETS.DEEPGRAM_API_KEY}; fallback ${BRIDGE_SECRETS.JARVIS_FALLBACK_API_KEY}; agent ${AGENT_LOGIN.ANTHROPIC_API_KEY}`
  const out = redactSecrets(text)
  assert.ok(!out.includes('JRV-'))
  assert.equal(out.split(MASK).length - 1, 3)
  // Short or non-secret values are not registered.
  assert.deepEqual(secretValuesFrom({ SHORT_TOKEN: 'abc', PLAIN: 'longenoughvalue' }), [])
})

test('key formats are masked by shape', () => {
  const cases = {
    elevenlabs: `xi key sk_${'a1'.repeat(24)}`,
    anthropic: `key sk-ant-api03-${'Ab9'.repeat(10)}`,
    dashed: `or sk-or-v1-${'f0'.repeat(16)}`,
    deepgramHeader: `Authorization: Token ${'0f'.repeat(20)}`,
    bearer: `Authorization: Bearer ${'xY7'.repeat(10)}`,
    xiHeader: `xi-api-key: ${'k3'.repeat(10)}`,
    deepgramAssign: `DEEPGRAM_KEY="${'9a'.repeat(20)}"`,
    googleAccess: `ya29.${'Q'.repeat(30)}`,
    googleRefresh: `1//0${'g'.repeat(30)}`,
    googleApi: `AIza${'B'.repeat(35)}`,
  }
  for (const [name, text] of Object.entries(cases)) {
    const out = redactSecrets(text)
    assert.ok(out.includes(MASK), `${name} not masked: ${out}`)
    assert.ok(!/(a1){24}|(Ab9){10}|(f0){16}|(0f){20}|(xY7){10}|(k3){10}|(9a){20}|Q{30}|g{30}|B{35}/.test(out), `${name} left a trace`)
  }
  assert.equal(redactSecrets(`Authorization: Token ${'0f'.repeat(20)}`), `Authorization: Token ${MASK}`)
})

test('commit hashes, ids and token counts are left alone', () => {
  for (const text of [
    'commit 82d6e1f28e32a59de8912546b89a821884e247fb',
    'merged 82d6e1f into main',
    'session 3f2a9c1e-7b4d-4e8a-9c2f-1a6b3d5e7f90',
    '[jarvis] fallback answered · 120 in / 45 out · $0.0012',
    'tokens=1234 effort=low',
    '[latency] ask=k9x2m4p7q1 total=812ms',
    'sk-short',
  ]) {
    assert.equal(redactSecrets(text), text)
  }
})

test('the model-facing redact() keeps its stricter assignment rule and gains the registered values', () => {
  registerSecrets([BRIDGE_SECRETS.ELEVENLABS_API_KEY])
  assert.equal(redact('token: "abcd1234efgh"'), 'token: "[скрыто]"')
  assert.ok(!redact(`log: ${BRIDGE_SECRETS.ELEVENLABS_API_KEY}`).includes('JRV-'))
  assert.equal(redact('commit 82d6e1f28e32a59de8912546b89a821884e247fb'), 'commit 82d6e1f28e32a59de8912546b89a821884e247fb')
})

test('the log masks strings and objects, errors from the fallback included, and is installed once', () => {
  registerSecrets([BRIDGE_SECRETS.JARVIS_FALLBACK_API_KEY])
  const lines = []
  const con = { log: (...a) => lines.push(a), info: () => {}, warn: (...a) => lines.push(a), error: (...a) => lines.push(a), debug: () => {} }
  installLogRedaction(con)
  installLogRedaction(con)
  const cause = new Error(`401 invalid x-api-key ${BRIDGE_SECRETS.JARVIS_FALLBACK_API_KEY}`)
  con.error('[jarvis] request failed:', new FallbackError('auth', cause))
  con.warn(`header Authorization: Bearer ${'xY7'.repeat(10)}`)
  con.log({ nested: { key: BRIDGE_SECRETS.JARVIS_FALLBACK_API_KEY } }, 42)
  const all = JSON.stringify(lines)
  assert.ok(!all.includes('JRV-CANARY'), all)
  assert.ok(!all.includes('xY7xY7xY7'))
  assert.equal(lines[2][1], 42, 'numbers pass untouched')
  assert.equal(lines.length, 3, 'one line each: not wrapped twice')
})

const ON = { JARVIS_ALLOW_WRITES: '1' }

test('JARVIS_ALLOW_WRITES is refused to a bridge running as root', () => {
  assert.deepEqual(writesAllowed(ON, { uid: 0, platform: 'linux' }), { allowed: false, refused: 'root' })
  assert.deepEqual(writesAllowed(ON, { uid: 0, platform: 'darwin' }), { allowed: false, refused: 'root' })
})

test('an ordinary user may turn writes on', () => {
  assert.deepEqual(writesAllowed(ON, { uid: 1000, platform: 'linux' }), { allowed: true, refused: null })
  assert.deepEqual(writesAllowed(ON, { uid: 501, platform: 'darwin' }), { allowed: true, refused: null })
})

test('a uid that is missing or not a number is refused like root — never read as "not root"', () => {
  for (const uid of [undefined, null, NaN, -1, 1.5, '1000', '0']) {
    assert.deepEqual(writesAllowed(ON, { uid, platform: 'linux' }), { allowed: false, refused: 'unknown-uid' }, String(uid))
  }
  // Left out altogether: the old default turned this into process.getuid(), root on the server.
  assert.deepEqual(writesAllowed(ON, { platform: 'linux' }), { allowed: false, refused: 'unknown-uid' })
  assert.throws(() => writesAllowed(ON), TypeError, 'no defaults: the caller must say who it runs as')
})

test('Windows has no uids: the flag decides, as before', () => {
  assert.deepEqual(writesAllowed(ON, { uid: undefined, platform: 'win32' }), { allowed: true, refused: null })
})

test('without the flag writes stay off, and nothing is reported as refused', () => {
  for (const v of [undefined, '', '0', 'true', 'yes']) {
    for (const who of [{ uid: 1000, platform: 'linux' }, { uid: 0, platform: 'linux' }, { uid: undefined, platform: 'linux' }, { platform: 'win32' }]) {
      assert.deepEqual(writesAllowed({ JARVIS_ALLOW_WRITES: v }, who), { allowed: false, refused: null }, `${v} ${JSON.stringify(who)}`)
    }
  }
})

test('on this machine, called the way the bridge calls it, the real user decides', () => {
  // A separate process, so the answer comes from this system's own getuid().
  const src = new URL('../bridge/secrets.mjs', import.meta.url).href
  const r = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `import { writesAllowed } from ${JSON.stringify(src)}; process.stdout.write(JSON.stringify({ uid: process.getuid?.() ?? null, platform: process.platform, result: writesAllowed({ JARVIS_ALLOW_WRITES: '1' }, { uid: process.getuid?.(), platform: process.platform }) }))`],
    { encoding: 'utf8', env: { PATH: process.env.PATH ?? process.env.Path ?? '', SystemRoot: process.env.SystemRoot ?? '' } },
  )
  assert.equal(r.status, 0, r.stderr)
  const { uid, platform, result } = JSON.parse(r.stdout)
  const expected = platform === 'win32' ? { allowed: true, refused: null } : uid === 0 ? { allowed: false, refused: 'root' } : { allowed: true, refused: null }
  assert.deepEqual(result, expected, `uid=${uid} platform=${platform}`)
})

test('the bridge is wired to all of it', () => {
  const server = readFileSync(new URL('../bridge/server.mjs', import.meta.url), 'utf8')
  assert.match(server, /const AGENT_ENV = agentEnv\(process\.env\)/)
  // Built from AGENT_ENV alone; the login adds only its config directory (accounts.mjs).
  assert.match(server, /env: ACCOUNTS\.env\(account, \{ \.\.\.AGENT_ENV, ENABLE_TOOL_SEARCH: 'false' \}\)/)
  assert.match(server, /writesAllowed\(process\.env, \{ uid: process\.getuid\?\.\(\), platform: process\.platform \}\)/)
  assert.match(server, /WRITES\.refused === 'root'/)
  assert.match(server, /WRITES\.refused === 'unknown-uid'/)
  assert.match(server, /const ALLOW_WRITES = WRITES\.allowed/)
  assert.doesNotMatch(server, /process\.env\.JARVIS_ALLOW_WRITES === '1'/)
  assert.match(server, /registerSecrets\(secretValuesFrom\(process\.env\)\)/)
  assert.match(server, /installLogRedaction\(console\)/)
  assert.match(server, /send\(\{ type: 'error', message: redactSecrets\(/)
  // Both shells are out of the model's reach in the default mode, and denied if they turn up.
  // The lists live in the tool policy (policy.mjs; behaviour in policy.test.mjs).
  const policy = readFileSync(new URL('../bridge/policy.mjs', import.meta.url), 'utf8')
  const disallowed = /: \[('Read'[^\]]*)\]/.exec(policy.slice(policy.indexOf('const DISALLOWED_BUILTINS')))?.[1] ?? ''
  for (const shell of ["'Bash'", "'PowerShell'"]) assert.ok(disallowed.includes(shell), `${shell} not disallowed`)
  const writeSet = policy.slice(policy.indexOf('const WRITE_BUILTINS'), policy.indexOf('])', policy.indexOf('const WRITE_BUILTINS')))
  assert.ok(writeSet.includes("'PowerShell'") && writeSet.includes("'Bash'"))
  for (const f of ['server.mjs', 'computer.mjs', 'piper.mjs', 'yandexMusic.mjs', 'googleCalendar.mjs']) {
    const src = readFileSync(new URL(`../bridge/${f}`, import.meta.url), 'utf8')
    assert.doesNotMatch(src, /\{\s*\.\.\.process\.env\b/, `${f} still spreads process.env into a child`)
  }
})
