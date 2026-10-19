import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { sessionServers } from '../bridge/sessionServers.mjs'

/**
 * The MCP servers one connection's agent session is given
 * (bridge/sessionServers.mjs), moved out of server.mjs's session options
 * unchanged. Written after the move: these are only reached from inside a
 * model turn. The display tools are called through the MCP SDK's own handler
 * table, as tests/display.test.mjs does.
 */

const CARD = { title: 'ПОГОДА', html: '<div><span class="hud-metric">+9</span><span class="hud-unit">Москва</span></div>' }

function rig({ live = true, mayShow = true, configured = {} } = {}) {
  const sent = []
  const state = { live, mayShow }
  const servers = sessionServers({
    configured,
    send: (f) => sent.push(f),
    live: () => state.live,
    mayShow: () => state.mayShow,
    ask: async () => ({}),
    allowWrites: false,
    pcRoots: [process.cwd()],
    ym: {},
    cal: {},
  })
  const call = (server, tool, args) => servers[server].instance._registeredTools[tool].handler(args, {})
  return { servers, sent, state, call }
}

test('everything Claude Code has configured, then the bridge\'s own seven, which win a name clash', () => {
  const r = rig({ configured: { alpha: { command: 'a' }, jarvis: { command: 'impostor' } } })
  assert.deepEqual(Object.keys(r.servers), ['alpha', 'jarvis', 'jarvis_ui', 'jarvis_chrome', 'jarvis_eyes', 'jarvis_pc', 'jarvis_music', 'jarvis_calendar'])
  assert.equal(r.servers.alpha.command, 'a')
  assert.notEqual(r.servers.jarvis.command, 'impostor')
  for (const k of ['jarvis', 'jarvis_ui', 'jarvis_chrome', 'jarvis_eyes', 'jarvis_pc', 'jarvis_music', 'jarvis_calendar']) {
    assert.equal(r.servers[k].type, 'sdk', `${k} is an in-process server`)
  }
})

test('what the display draws reaches the page only while the turn is still wanted, read when the tool is called', async () => {
  const r = rig()
  await r.call('jarvis', 'display', CARD)
  assert.equal(r.sent.length, 1)
  // display composes its card as a blade (panels.mjs), sent through the same live() gate.
  assert.equal(r.sent[0].type, 'blade')
  r.state.live = false
  await r.call('jarvis', 'display', CARD)
  await r.call('jarvis', 'blade', { title: 'ПОГОДА', kind: 'markup', html: CARD.html })
  assert.equal(r.sent.length, 1, 'a stopped turn draws nothing')
  r.state.live = true
  await r.call('jarvis', 'blade', { title: 'ПОГОДА', kind: 'markup', html: CARD.html })
  assert.equal(r.sent.at(-1).type, 'blade')
})

test('a composed panel only when the question asked to see something, read when the tool is called', async (t) => {
  t.mock.method(console, 'log', () => {})
  const r = rig({ mayShow: false })
  await r.call('jarvis', 'display', CARD)
  assert.equal(r.sent.length, 0)
  r.state.mayShow = true
  await r.call('jarvis', 'display', CARD)
  assert.equal(r.sent.length, 1)
})

test('server.mjs builds the set per connection with its own send, the turn queue\'s live, the question\'s mayShow and the camera\'s ask', () => {
  const server = readFileSync(new URL('../bridge/server.mjs', import.meta.url), 'utf8').replace(/\r/g, '')
  assert.match(
    server,
    /mcpServers: sessionServers\(\{\n {8}configured: MCP_SERVERS,\n {8}send,\n(?: {8}\/\/.*\n)? {8}live: \(\) => turns\.live\(\),\n {8}mayShow: \(\) => s\.turnMayShow,\n {8}ask,\n {8}allowWrites: ALLOW_WRITES,\n {8}pcRoots: PC_ROOTS,\n {8}ym: YM,\n {8}cal: CAL,\n {6}\}\),/,
  )
  // Inside openSession, so a new set for every session, as before.
  const open = server.indexOf('const openSession = (resume) => query({')
  const end = server.indexOf('/** A new agent session, live from now on', open)
  assert.ok(server.indexOf('mcpServers: sessionServers({', open) > open && server.indexOf('mcpServers: sessionServers({', open) < end)
})
