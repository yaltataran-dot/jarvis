import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname, normalize } from 'node:path'

/**
 * The module boundaries of docs/ARCHITECTURE.md, checked on every run.
 *
 * Files stay where they are; this map says which logical module each belongs
 * to and which way the dependencies may point. A new import across a boundary
 * fails here instead of being found later as a tangle. The few crossings that
 * exist today are listed as debts: each must still exist (so a fixed one is
 * struck off the list) and no new one may appear.
 */

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

type Module = 'config' | 'state' | 'contracts' | 'lang' | 'platform' | 'voice' | 'core' | 'integrations' | 'ui' | 'app'

const LIB: Record<string, Module> = {
  stopWords: 'lang', echo: 'lang',
  capabilities: 'platform', faultLog: 'platform', trace: 'platform',
  voice: 'voice', voiceCore: 'voice', voiceSupervisor: 'voice', voiceSlot: 'voice', scribeVoice: 'voice',
  deepgramVoice: 'voice', browserVoice: 'voice', pcm: 'voice', pcmCapture: 'voice', audio: 'voice',
  audioStart: 'voice', vad: 'voice', bargeIn: 'voice', ledger: 'voice', micErrors: 'voice', lifecycle: 'voice',
  tts: 'voice', kokoro: 'voice', speechText: 'voice', sentences: 'voice', screenWake: 'voice', sfx: 'voice',
  clap: 'voice', voiceWaves: 'voice', fillers: 'voice',
  brain: 'core', bridge: 'core', anthropic: 'core', redial: 'core', resume: 'core', linkStatus: 'core',
  floor: 'core', turnRoute: 'core', turnLog: 'core', aside: 'core', localAnswer: 'core',
  calendarFlow: 'integrations', calendarIntent: 'integrations', calendarTime: 'integrations',
  calendarCheck: 'integrations', calendarClient: 'integrations', music: 'integrations', musicIntent: 'integrations',
  yandexMusic: 'integrations', knowledgeClient: 'integrations', knownFetch: 'integrations', camera: 'integrations',
  hands: 'integrations', oneEuro: 'integrations',
  coreMode: 'ui', bootTimeline: 'ui',
}

function moduleOf(file: string): Module {
  if (file === 'src/config.ts') return 'config'
  if (file === 'src/store.ts') return 'state'
  if (file === 'src/App.tsx' || file === 'src/main.tsx') return 'app'
  if (file.startsWith('shared/')) return 'contracts'
  if (file.startsWith('src/ui/') || file.startsWith('src/scene/')) return 'ui'
  const m = /^src\/lib\/([A-Za-z]+)\.tsx?$/.exec(file)
  if (m && LIB[m[1]]) return LIB[m[1]]
  throw new Error(`${file} belongs to no module: add it to the map in tests/architecture.test.ts and docs/ARCHITECTURE.md`)
}

/** Which modules each module may import (itself always allowed). The app is the composition root. */
const MAY: Record<Module, Module[]> = {
  contracts: [],
  config: [],
  state: ['contracts'],
  lang: ['contracts'],
  platform: ['config', 'contracts'],
  voice: ['lang', 'platform', 'config', 'contracts'],
  core: ['lang', 'platform', 'config', 'contracts'],
  integrations: ['lang', 'platform', 'config', 'contracts'],
  ui: ['state', 'config', 'contracts', 'core', 'voice', 'integrations', 'lang', 'platform'],
  app: ['config', 'state', 'contracts', 'lang', 'platform', 'voice', 'core', 'integrations', 'ui'],
}

/** Crossings that exist today, to be removed (docs/ARCHITECTURE.md, "Debts"). Never add to this list. */
const DEBTS = new Set<string>([])

type Edge = { from: string; to: string; typeOnly: boolean }

function sources(): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    if (!existsSync(join(ROOT, d))) return
    for (const e of readdirSync(join(ROOT, d), { withFileTypes: true })) {
      const p = `${d}/${e.name}`
      if (e.isDirectory()) walk(p)
      else if (/\.(ts|tsx|mjs)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p)
    }
  }
  walk('src')
  walk('bridge')
  walk('shared')
  return out
}

function edges(files: string[]): Edge[] {
  const set = new Set(files)
  const resolve = (from: string, spec: string) => {
    const base = normalize(join(dirname(from), spec)).replace(/\\/g, '/')
    for (const ext of ['', '.ts', '.tsx', '.mjs', '.js']) if (set.has(base + ext)) return base + ext
    return null
  }
  const out: Edge[] = []
  for (const f of files) {
    const src = readFileSync(join(ROOT, f), 'utf8')
    for (const m of src.matchAll(/^\s*(import|export)\s+(type\s+)?([^'"]*?)\s*from\s+['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/gm)) {
      const spec = m[4] ?? m[5]
      const to = resolve(f, spec)
      if (!to) continue
      const typeOnly = Boolean(m[2]) || /^\{\s*(type\s+[A-Za-z_]+\s*,?\s*)+\}$/.test((m[3] ?? '').trim())
      out.push({ from: f, to, typeOnly })
    }
  }
  return out
}

const files = sources()
const all = edges(files)

test('every client file belongs to a module', () => {
  for (const f of files.filter((x) => x.startsWith('src/'))) moduleOf(f)
})

test('client and bridge never import each other; both may use shared contracts', () => {
  const cross = all.filter((e) => (e.from.startsWith('src/') && e.to.startsWith('bridge/')) || (e.from.startsWith('bridge/') && e.to.startsWith('src/')))
  assert.deepEqual(cross, [])
  const bad = all.filter((e) => e.from.startsWith('shared/') && !e.to.startsWith('shared/'))
  assert.deepEqual(bad, [], 'contracts depend on nothing else')
})

test('dependencies point only the allowed ways (known debts listed, none new)', () => {
  const found = new Set<string>()
  const violations: string[] = []
  for (const e of all.filter((x) => x.from.startsWith('src/') && x.to.startsWith('src/'))) {
    const a = moduleOf(e.from), b = moduleOf(e.to)
    if (a === b || MAY[a].includes(b)) continue
    const key = `${e.from} -> ${e.to}`
    if (DEBTS.has(key)) found.add(key)
    else violations.push(`${key} (${a} -> ${b})`)
  }
  assert.deepEqual(violations, [], 'new import across a module boundary')
  assert.deepEqual([...DEBTS].filter((d) => !found.has(d)), [], 'a debt was paid: strike it off DEBTS and the doc')
})

test('no import cycles at run time (type-only imports are erased and do not count)', () => {
  const g = new Map<string, string[]>()
  for (const e of all) if (!e.typeOnly) g.set(e.from, [...(g.get(e.from) ?? []), e.to])
  const state = new Map<string, 1 | 2>()
  const stack: string[] = []
  const cycles: string[] = []
  const visit = (v: string) => {
    state.set(v, 1)
    stack.push(v)
    for (const w of g.get(v) ?? []) {
      if (state.get(w) === 1) cycles.push(stack.slice(stack.indexOf(w)).concat(w).join(' -> '))
      else if (!state.has(w)) visit(w)
    }
    stack.pop()
    state.set(v, 2)
  }
  for (const f of files) if (!state.has(f)) visit(f)
  assert.deepEqual(cycles, [])
})

test('the map and the architecture document agree', () => {
  const doc = readFileSync(join(ROOT, 'docs/ARCHITECTURE.md'), 'utf8')
  for (const m of Object.keys(MAY)) assert.match(doc, new RegExp(`\\*\\*${m}\\*\\*`), `module ${m} is described in the doc`)
})
