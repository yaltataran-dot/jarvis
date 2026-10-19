import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve, sep } from 'node:path'
import { backupLoginDirs, configuredServers, createVoiceKeys, fileRoots, languageFrom, pcRoots } from '../bridge/settings.mjs'

/**
 * Start-up settings (bridge/settings.mjs) on their own. The running bridge is
 * checked against the same rules in tests/bridgeSettings.test.mjs, written
 * while they were read in server.mjs; JARVIS_FILE_ROOTS is checked only here.
 */

const withHome = (t, claudeJson) => {
  const home = mkdtempSync(join(tmpdir(), 'jarvis-settings-unit-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  if (claudeJson !== undefined) writeFileSync(join(home, '.claude.json'), typeof claudeJson === 'string' ? claudeJson : JSON.stringify(claudeJson(home)))
  return home
}

test('language: ru by default and for "ru"; "en" in any case and spacing; VITE_LANG when JARVIS_LANG is unset', (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  assert.equal(languageFrom({}), 'ru')
  assert.equal(languageFrom({ JARVIS_LANG: ' RU ' }), 'ru')
  assert.equal(languageFrom({ JARVIS_LANG: ' En ' }), 'en')
  assert.equal(languageFrom({ VITE_LANG: 'en' }), 'en')
  assert.equal(languageFrom({ JARVIS_LANG: 'ru', VITE_LANG: 'en' }), 'ru', 'JARVIS_LANG first')
  assert.equal(languageFrom({ JARVIS_LANG: '', VITE_LANG: 'en' }), 'ru', 'an empty JARVIS_LANG is still set')
  assert.equal(warn.mock.callCount(), 0)
  assert.equal(languageFrom({ JARVIS_LANG: 'De' }), 'ru')
  assert.deepEqual(warn.mock.calls[0].arguments, ['[jarvis] JARVIS_LANG="de" is not ru or en — using ru.'])
})

test('MCP servers: the global block, then the home project\'s; nothing when the config is missing or broken', (t) => {
  const home = withHome(t, (h) => ({
    mcpServers: { a: { command: 'x' }, shared: { command: 'global' } },
    projects: { [h]: { mcpServers: { b: { command: 'y' }, shared: { command: 'project' } } }, '/elsewhere': { mcpServers: { c: {} } } },
  }))
  const servers = configuredServers(() => home)
  assert.deepEqual(Object.keys(servers), ['a', 'shared', 'b'])
  assert.equal(servers.shared.command, 'project', 'the project scope wins')
  assert.deepEqual(configuredServers(() => withHome(t)), {})
  assert.deepEqual(configuredServers(() => withHome(t, '{ not json')), {})
  assert.deepEqual(configuredServers(() => withHome(t, () => ({}))), {})
})

test('ElevenLabs key: the environment first, else the elevenlabs MCP server\'s env, else none', (t) => {
  const home = withHome(t, () => ({ mcpServers: { elevenlabs: { env: { ELEVENLABS_API_KEY: 'from-config' } } } }))
  assert.equal(createVoiceKeys({ env: { ELEVENLABS_API_KEY: 'from-env' }, homedir: () => home }).elevenKey(), 'from-env')
  assert.equal(createVoiceKeys({ env: {}, homedir: () => home }).elevenKey(), 'from-config')
  assert.equal(createVoiceKeys({ env: { ELEVENLABS_API_KEY: '' }, homedir: () => home }).elevenKey(), 'from-config', 'blank is unset')
  assert.equal(createVoiceKeys({ env: {}, homedir: () => withHome(t) }).elevenKey(), null)
})

test('Deepgram key: the environment only, trimmed; blank or unusable is none', (t) => {
  const home = withHome(t)
  const dg = (v) => createVoiceKeys({ env: { DEEPGRAM_API_KEY: v }, homedir: () => home }).deepgramKey()
  assert.equal(dg(' abc123 '), 'abc123')
  assert.equal(dg(''), null)
  assert.equal(dg(undefined), null)
  assert.equal(dg('has space'), null)
  assert.equal(dg('"quoted"'), null)
})

test('recognition engine: Deepgram over ElevenLabs; JARVIS_STT pins one, and a pinned one without its key is none', (t) => {
  const home = withHome(t)
  const engine = (env) => createVoiceKeys({ env, homedir: () => home }).sttEngine()
  const both = { DEEPGRAM_API_KEY: 'dg', ELEVENLABS_API_KEY: 'el' }
  assert.equal(engine({}), null)
  assert.equal(engine(both), 'deepgram')
  assert.equal(engine({ ELEVENLABS_API_KEY: 'el' }), 'elevenlabs')
  assert.equal(engine({ ...both, JARVIS_STT: ' ElevenLabs ' }), 'elevenlabs')
  assert.equal(engine({ ...both, JARVIS_STT: 'deepgram' }), 'deepgram')
  assert.equal(engine({ ELEVENLABS_API_KEY: 'el', JARVIS_STT: 'deepgram' }), null)
  assert.equal(engine({ DEEPGRAM_API_KEY: 'dg', JARVIS_STT: 'elevenlabs' }), null)
  assert.equal(engine({ ...both, JARVIS_STT: 'whisper' }), 'deepgram', 'an unknown pin is no pin')
})

test('the voice keys are read on every call, not once', (t) => {
  const home = withHome(t)
  const env = {}
  const keys = createVoiceKeys({ env, homedir: () => home })
  assert.equal(keys.sttEngine(), null)
  env.DEEPGRAM_API_KEY = 'dg'
  assert.equal(keys.sttEngine(), 'deepgram')
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { elevenlabs: { env: { ELEVENLABS_API_KEY: 'later' } } } }))
  assert.equal(keys.elevenKey(), 'later')
})

test('computer roots: the project, then JARVIS_PC_ROOTS on ";", trimmed, empties dropped', () => {
  assert.deepEqual(pcRoots({}, '/proj'), ['/proj'])
  assert.deepEqual(pcRoots({ JARVIS_PC_ROOTS: ' C:\\a ; ;D:\\b;' }, '/proj'), ['/proj', 'C:\\a', 'D:\\b'])
})

test('file roots: home, the temp folder, /tmp, then JARVIS_FILE_ROOTS on ",", each realpath\'d, or resolved when missing', (t) => {
  const home = withHome(t)
  const extra = join(home, 'pictures')
  mkdirSync(extra)
  const missing = join(home, 'not-there')
  const roots = fileRoots({ JARVIS_FILE_ROOTS: ` ${extra} ,, ${missing} ` }, { homedir: () => home, tmpdir: () => home })
  const real = (p) => {
    try {
      return realpathSync(p)
    } catch {
      return resolve(p)
    }
  }
  assert.deepEqual(roots, [realpathSync(home), realpathSync(home), real('/tmp'), realpathSync(extra), resolve(missing)])
})

test('backup logins: one directory as before, or several on the path delimiter, in order; nothing is created', (t) => {
  const home = withHome(t)
  const [a, b] = ['login-a', 'login-b'].map((n) => {
    const d = join(home, n)
    mkdirSync(d)
    return d
  })
  const primaryDir = join(home, '.claude')
  const warn = t.mock.method(console, 'warn', () => {})
  assert.deepEqual(backupLoginDirs({}, { primaryDir }), [])
  assert.deepEqual(backupLoginDirs({ JARVIS_CLAUDE_BACKUP_DIR: '  ' }, { primaryDir }), [])
  assert.deepEqual(backupLoginDirs({ JARVIS_CLAUDE_BACKUP_DIR: ` ${a} ` }, { primaryDir }), [a])
  assert.deepEqual(backupLoginDirs({ JARVIS_CLAUDE_BACKUP_DIR: [a, '', b].join(delimiter) }, { primaryDir }), [a, b])
  assert.deepEqual(backupLoginDirs({ JARVIS_CLAUDE_BACKUP_DIR: `${b}|${a}` }, { primaryDir, delimiter: '|' }), [b, a])
  assert.equal(warn.mock.callCount(), 0)
  const missing = join(home, 'no-such-login')
  assert.deepEqual(backupLoginDirs({ JARVIS_CLAUDE_BACKUP_DIR: missing }, { primaryDir }), [])
  assert.equal(existsSync(missing), false, 'never created')
})

test('backup logins: a missing directory, a repeat and the primary\'s own are left out, said by position and never by path', (t) => {
  const home = withHome(t)
  const a = join(home, 'login-a')
  const primaryDir = join(home, '.claude')
  mkdirSync(a)
  mkdirSync(primaryDir)
  const warn = t.mock.method(console, 'warn', () => {})
  const missing = join(home, 'no-such-login')
  const dirs = backupLoginDirs({ JARVIS_CLAUDE_BACKUP_DIR: [a, missing, `${a}${sep}`, primaryDir, join(a, '..', 'login-a')].join(delimiter) }, { primaryDir })
  assert.deepEqual(dirs, [a])
  const lines = warn.mock.calls.map((c) => c.arguments.join(' '))
  assert.deepEqual(lines, [
    '[jarvis] JARVIS_CLAUDE_BACKUP_DIR entry 2 of 5 is not a directory — skipped',
    '[jarvis] JARVIS_CLAUDE_BACKUP_DIR entry 3 of 5 repeats entry 1 — skipped',
    "[jarvis] JARVIS_CLAUDE_BACKUP_DIR entry 4 of 5 is the primary login's own directory — skipped",
    '[jarvis] JARVIS_CLAUDE_BACKUP_DIR entry 5 of 5 repeats entry 1 — skipped',
  ])
  for (const l of lines) assert.doesNotMatch(l, /login-a|no-such-login|\.claude|jarvis-settings-unit/)
})

test('backup logins: one entry keeps the old sentences; on Windows two spellings of one folder are one', (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  const isDirectory = () => true
  const realpath = (d) => d
  assert.deepEqual(backupLoginDirs({ JARVIS_CLAUDE_BACKUP_DIR: '/nope' }, { primaryDir: '/p', isDirectory: () => false, realpath }), [])
  assert.deepEqual(backupLoginDirs({ JARVIS_CLAUDE_BACKUP_DIR: '/p' }, { primaryDir: '/p', isDirectory, realpath }), [])
  assert.deepEqual(warn.mock.calls.map((c) => c.arguments[0]), [
    '[jarvis] JARVIS_CLAUDE_BACKUP_DIR is not a directory — backup login off',
    "[jarvis] JARVIS_CLAUDE_BACKUP_DIR is the primary login's own directory — backup login off",
  ])
  const win = { delimiter: ';', isDirectory, realpath: (d) => d }
  assert.deepEqual(backupLoginDirs({ JARVIS_CLAUDE_BACKUP_DIR: 'C:\\L\\B;c:\\l\\b' }, { primaryDir: 'C:\\P', platform: 'win32', ...win }), ['C:\\L\\B'])
  assert.deepEqual(backupLoginDirs({ JARVIS_CLAUDE_BACKUP_DIR: '/l/B;/l/b' }, { primaryDir: '/p', platform: 'linux', ...win }), ['/l/B', '/l/b'], 'case counts elsewhere')
})
