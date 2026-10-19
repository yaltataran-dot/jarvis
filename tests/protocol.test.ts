import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { BRIDGE_FRAMES, ERROR_KINDS, PAGE_CLOSE_RANGE, PAGE_FRAMES, STT_CLOSE, STT_MESSAGES } from '../shared/protocol.mjs'
// @ts-expect-error — a plain .mjs module of the bridge, without type declarations
import { slim } from '../bridge/deepgramProxy.mjs'
import { CLOSE_AUDIO_BLOCKED, CLOSE_AUDIO_STALLED, CLOSE_CAPTURE_FAILED, CLOSE_WORKLET_STALLED, createDeepgramParser } from '../src/lib/deepgramVoice.ts'
import type { ScribeHooks } from '../src/lib/scribeVoice.ts'

/**
 * The page–bridge protocol (shared/protocol.mjs) against both sides' real code.
 *
 * The values are pinned to what was on the wire before the contract existed:
 * renaming a frame or renumbering a close code in the contract fails here
 * first. Then what the bridge sends and reads, and what the page sends and
 * reads, are taken from their sources and compared with the contract — in both
 * directions, so neither a name used outside the contract nor a contract name
 * nobody uses goes unnoticed.
 */

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r/g, '')
const values = (o: Record<string, string | number>) => new Set(Object.values(o))
const sorted = (s: Iterable<string>) => [...s].sort()
const all = (src: string, re: RegExp) => new Set([...src.matchAll(re)].map((m) => m[1]))

test('the contract carries exactly the values that were on the wire', () => {
  assert.deepEqual({ ...PAGE_FRAMES }, { ASK: 'ask', INTERRUPT: 'interrupt', REPLY: 'reply', RESUME: 'resume', PING: 'ping', TRACE: 'trace' })
  assert.deepEqual({ ...BRIDGE_FRAMES }, {
    READY: 'ready', SESSION: 'session', RESUMED: 'resumed', TEXT: 'text', TOOL: 'tool', EFFORT: 'effort', DONE: 'done',
    ERROR: 'error', RETRY: 'retry', PANEL: 'panel', BLADE: 'blade', UI: 'ui', CAPTURE: 'capture', PONG: 'pong',
  })
  assert.deepEqual({ ...ERROR_KINDS }, { RATE: 'rate', SERVICE: 'service' })
  assert.deepEqual({ ...STT_MESSAGES }, { READY: 'ready', RESULT: 'r', UTTERANCE_END: 'u', ERROR: 'err' })
  assert.deepEqual({ ...STT_CLOSE }, {
    NORMAL: 1000, TOO_LARGE: 1009, CLIENT_ERROR: 1011, SESSION_LIMIT: 4000, REPLACED: 4001, AUDIO_BLOCKED: 4010,
    CAPTURE_FAILED: 4011, WORKLET_STALLED: 4012, AUDIO_STALLED: 4013, IDLE: 4408, UPSTREAM: 4502, NO_KEY: 4503,
  })
  assert.deepEqual({ ...PAGE_CLOSE_RANGE }, { MIN: 4000, MAX: 4099 })
  for (const o of [PAGE_FRAMES, BRIDGE_FRAMES, ERROR_KINDS, STT_MESSAGES, STT_CLOSE, PAGE_CLOSE_RANGE]) assert.ok(Object.isFrozen(o))
  assert.equal(values(STT_CLOSE).size, Object.keys(STT_CLOSE).length, 'no two close reasons share a code')
})

test('the declarations (protocol.d.mts) say the same as the module', () => {
  const d = read('../shared/protocol.d.mts')
  for (const [name, o] of Object.entries({ PAGE_FRAMES, BRIDGE_FRAMES, ERROR_KINDS, STT_MESSAGES, STT_CLOSE, PAGE_CLOSE_RANGE })) {
    const block = new RegExp(`export declare const ${name}: Readonly<\\{([\\s\\S]*?)\\}>`).exec(d)
    assert.ok(block, `${name} is declared`)
    const declared = Object.fromEntries([...block[1].matchAll(/([A-Z_]+): '?([^'\s;]+)'?/g)].map((m) => [m[1], /^\d+$/.test(m[2]) ? Number(m[2]) : m[2]]))
    assert.deepEqual(declared, { ...o }, `${name} declared as defined`)
  }
})

// -- the agent socket ---------------------------------------------------------------

const server = read('../bridge/server.mjs')
const turns = read('../bridge/turns.mjs')
const vision = read('../bridge/vision.mjs')
const pageRequests = read('../bridge/pageRequests.mjs')
// Frames the session stream builds outside server.mjs: a turn's result (turnResult.mjs), and the
// frame for a question no login takes (noLoginFrame, failures.mjs).
const turnResult = read('../bridge/turnResult.mjs')
const failures = read('../bridge/failures.mjs')
// The HUD's own servers on each connection draw panels, blades and the interface (sessionServers.mjs).
const sessionServers = read('../bridge/sessionServers.mjs')
const pageBridge = read('../src/lib/bridge.ts')
const pageResume = read('../src/lib/resume.ts')

test('the bridge sends exactly the bridge frames of the contract', () => {
  // `type: 'user'` is the Agent SDK's input message, not a frame; `subtype:` is not `type:`.
  const sent = all(server, /(?<![A-Za-z_])type: '([a-z_]+)'/g)
  sent.delete('user')
  for (const t of all(turns + turnResult + failures + sessionServers, /(?<![A-Za-z_])type: '([a-z_]+)'/g)) sent.add(t)
  // The bridge's one request of the page goes out through ask(kind) (pageRequests.mjs, built per
  // socket in server.mjs), from the camera tool.
  for (const t of all(vision, /ask\(\s*'([a-z_]+)'/g)) sent.add(t)
  assert.equal(all(pageRequests, /(?<![A-Za-z_])type: '([a-z_]+)'/g).size, 0, 'pageRequests sends no frame of its own')
  assert.match(pageRequests, /send\(\{ type: kind, id, \.\.\.args \}\)/, 'ask(kind) sends the kind as the frame type')
  assert.match(server, /const \{ ask, reply: replied \} = createPageRequests\(\{ socket, send \}\)/)
  assert.match(sessionServers, /jarvis_eyes: visionServer\(ask\)/)
  assert.match(server, /mcpServers: sessionServers\(\{[^}]*\n\s+ask,\n/)
  assert.deepEqual(sorted(sent), sorted(values(BRIDGE_FRAMES) as Set<string>))
})

test('the bridge reads exactly the page frames of the contract', () => {
  assert.deepEqual(sorted(all(server, /msg\.type === '([a-z_]+)'/g)), sorted(values(PAGE_FRAMES) as Set<string>))
})

test('the page sends exactly the page frames of the contract', () => {
  const sent = all(pageBridge + pageResume, /\{ type: '([a-z_]+)'/g)
  assert.deepEqual(sorted(sent), sorted(values(PAGE_FRAMES) as Set<string>))
})

test('the page reads every bridge frame of the contract, and nothing else', () => {
  const readByPage = all(pageBridge, /msg\.type === '([a-z_]+)'/g)
  for (const t of all(pageBridge, /case '([a-z_]+)':/g)) readByPage.add(t)
  assert.deepEqual(sorted(readByPage), sorted(values(BRIDGE_FRAMES) as Set<string>))
  // And the compiler holds it there: the page's frame type takes the contract's names.
  assert.match(pageBridge, /type Frame = BridgeFrame/)
  assert.match(read('../shared/protocol.d.mts'), /type\?: BridgeFrameType/)
})

test('error kinds: the bridge sends only the contract kinds, and the page reads exactly them', () => {
  const sent = all(server + turns + turnResult + failures, /kind: '(rate|service|[a-z]+)'(?=[,\s}])/g)
  for (const k of ['ok', 'failed', 'config', 'cancelled']) sent.delete(k) // internal outcome kinds, not error frames
  assert.deepEqual(sorted(sent), sorted(values(ERROR_KINDS) as Set<string>))
  assert.match(pageBridge, /msg\.kind === 'rate' \|\| msg\.kind === 'service'/)
})

// -- the recognition socket --------------------------------------------------------

test("what the bridge's proxy makes of Deepgram is what the page's parser reads", () => {
  const log: string[] = []
  const hooks: ScribeHooks = {
    onStarted: () => void log.push('started'),
    onPartial: (t) => void log.push(`partial:${t}`),
    onCommitted: (t) => void log.push(`committed:${t}`),
    onPhraseEnd: () => void log.push('phrase-end'),
    onError: (r) => void log.push(`error:${r}`),
    onClose: () => void log.push('closed'),
  }
  const page = createDeepgramParser(hooks)
  const deliver = (deepgram: unknown) => {
    const m = slim(JSON.stringify(deepgram))
    if (m) page.handle(JSON.stringify(m))
    return m
  }
  page.handle(JSON.stringify({ t: STT_MESSAGES.READY })) // the proxy sends this itself on upstream open
  assert.deepEqual(deliver({ type: 'Results', is_final: false, speech_final: false, channel: { alternatives: [{ transcript: 'Джарвис' }] } }), { t: 'r', text: 'Джарвис', final: false, speech: false })
  deliver({ type: 'Results', is_final: true, speech_final: true, channel: { alternatives: [{ transcript: 'который час' }] } })
  assert.deepEqual(deliver({ type: 'UtteranceEnd' }), { t: 'u' })
  assert.deepEqual(deliver({ type: 'Error', message: 'x' }), { t: 'err' })
  assert.equal(deliver({ type: 'Metadata' }), null, 'anything else is dropped by the proxy')
  assert.deepEqual(log, ['started', 'partial:Джарвис', 'committed:который час', 'phrase-end', 'error:deepgram'])
  for (const t of all(read('../bridge/deepgramProxy.mjs'), /STT_MESSAGES\.([A-Z_]+)/g)) assert.ok(t in STT_MESSAGES)
  for (const t of all(read('../src/lib/deepgramVoice.ts'), /m\.t === '([a-z]+)'/g)) assert.ok(values(STT_MESSAGES).has(t), `the page reads '${t}' from the contract`)
})

test('close codes: the page closes with the contract codes, inside the page range; the bridge names every code from the contract', () => {
  assert.deepEqual([CLOSE_AUDIO_BLOCKED, CLOSE_CAPTURE_FAILED, CLOSE_WORKLET_STALLED, CLOSE_AUDIO_STALLED], [4010, 4011, 4012, 4013])
  for (const c of [CLOSE_AUDIO_BLOCKED, CLOSE_CAPTURE_FAILED, CLOSE_WORKLET_STALLED, CLOSE_AUDIO_STALLED]) {
    assert.ok(c >= PAGE_CLOSE_RANGE.MIN && c <= PAGE_CLOSE_RANGE.MAX, `${c} is a page reason the bridge logs as given`)
  }
  const proxy = read('../bridge/deepgramProxy.mjs')
  assert.doesNotMatch(proxy, /(end|close)\(\d{4}/, 'no bare close code left in the proxy')
  for (const name of all(proxy, /STT_CLOSE\.([A-Z_]+)/g)) assert.ok(name in STT_CLOSE, name)
  assert.doesNotMatch(read('../src/lib/deepgramVoice.ts'), /close\(\d{4}\)/, 'no bare close code left in the page')
})

test('the bridge can load the contract at run time, as plain Node, without the page build', async () => {
  const m = await import('../shared/protocol.mjs')
  assert.equal(m.STT_CLOSE.IDLE, 4408)
  assert.match(read('../bridge/deepgramProxy.mjs'), /from '\.\.\/shared\/protocol\.mjs'/)
})
