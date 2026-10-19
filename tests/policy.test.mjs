import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createToolPolicy } from '../bridge/policy.mjs'

/**
 * Which tools the agent may run (bridge/policy.mjs), in the default mode and
 * with writes allowed. Written against the policy as it stood in server.mjs,
 * before it moved, so a change in what is allowed shows up here.
 */

const off = createToolPolicy({ allowWrites: false })
const on = createToolPolicy({ allowWrites: true })

test('read-only built-ins run in both modes; write built-ins only with writes allowed', () => {
  for (const t of ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite', 'Task', 'Agent', 'ToolSearch',
    'ListMcpResources', 'ListMcpResourcesTool', 'ReadMcpResource', 'ReadMcpResourceTool', 'BashOutput', 'TaskOutput']) {
    assert.equal(off.decideTool(t), true, t)
    assert.equal(on.decideTool(t), true, t)
  }
  for (const t of ['Bash', 'PowerShell', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'KillShell', 'TaskStop']) {
    assert.equal(off.decideTool(t), false, t)
    assert.equal(on.decideTool(t), true, t)
  }
  assert.equal(off.decideTool('SomeFutureBuiltin'), false, 'an unknown built-in is a write')
  assert.equal(on.decideTool('SomeFutureBuiltin'), true)
})

test('in the default mode the file, shell, editing and subagent built-ins are taken away entirely', () => {
  assert.deepEqual(off.disallowedBuiltins, ['Read', 'Glob', 'Grep', 'Bash', 'PowerShell', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Task', 'Agent'])
  assert.deepEqual(on.disallowedBuiltins, [], 'writes allowed: nothing taken away')
  // Both shells, explicitly: they must never be reachable in the default mode.
  for (const shell of ['Bash', 'PowerShell']) {
    assert.ok(off.disallowedBuiltins.includes(shell))
    assert.equal(off.decideTool(shell), false)
  }
})

test("the bridge's own servers always run: they draw on our screen or gate themselves", () => {
  for (const t of ['mcp__jarvis__display', 'mcp__jarvis__blade', 'mcp__jarvis_ui__ui_theme', 'mcp__jarvis_chrome__chrome_navigate',
    'mcp__jarvis_eyes__look', 'mcp__jarvis_pc__pc_open_app', 'mcp__jarvis_music__music_control', 'mcp__jarvis_calendar__calendar_list']) {
    assert.equal(off.decideTool(t), true, t)
  }
})

test('other MCP servers: an effectful verb is vetoed without writes, even on an allowlisted server', () => {
  for (const t of ['mcp__elevenlabs__make_outbound_call', 'mcp__heygen__delete_character', 'mcp__higgsfield__create_video',
    'mcp__android__install_apk', 'mcp__lottie-search__download_lottie', 'mcp__x__Bulk-Edit-Events']) {
    assert.equal(off.decideTool(t), false, t)
    assert.equal(on.decideTool(t), true, t)
  }
  // Named exemptions, by server and tool together.
  assert.equal(off.decideTool('mcp__openrouter__send-message'), true)
  assert.equal(off.decideTool('mcp__openrouter__send-feedback'), true)
  assert.equal(off.decideTool('mcp__other__send-message'), false, 'an exemption does not leak across servers')
})

test('other MCP servers: allowlisted servers and read verbs run; anything else needs writes', () => {
  for (const t of ['mcp__higgsfield__generate_image', 'mcp__exa__web_search_exa', 'mcp__serper__google_search', 'mcp__ccd_session_x__anything']) {
    assert.equal(off.decideTool(t), true, t)
  }
  for (const t of ['mcp__android__list_devices', 'mcp__any__get_status', 'mcp__any__screenshot', 'mcp__any__Search-Things']) {
    assert.equal(off.decideTool(t), true, t)
  }
  assert.equal(off.decideTool('mcp__any__frobnicate'), false, 'no read verb: a write')
  assert.equal(on.decideTool('mcp__any__frobnicate'), true)
})

test('MCP names are split on the first two separators; the tool half may hold more', () => {
  assert.equal(off.mcpServerOf('mcp__a__b__c'), 'a')
  assert.equal(off.mcpToolOf('mcp__a__b__c'), 'b__c')
  assert.equal(off.mcpServerOf('Bash'), null)
})

test('the switch is read once, strictly: only `true` allows writes', () => {
  for (const v of [undefined, 1, '1', 'true', null]) assert.equal(createToolPolicy({ allowWrites: v }).decideTool('Bash'), false, String(v))
})

test('the last gate (canUseTool): an SDK PermissionResult from decideTool, logged; a denial says nothing to read out', async (t) => {
  const log = t.mock.method(console, 'log', () => {})
  const off = createToolPolicy({ allowWrites: false })
  assert.deepEqual(await off.canUseTool('WebSearch'), { behavior: 'allow' })
  assert.deepEqual(await off.canUseTool('Bash', { command: 'touch x' }, {}), {
    behavior: 'deny',
    message:
      'Blocked: JARVIS is running in read-only mode and cannot take actions that change anything. Tell the user this action is unavailable until they enable write access on the machine.',
  })
  assert.deepEqual(await createToolPolicy({ allowWrites: true }).canUseTool('Bash'), { behavior: 'allow' })
  assert.deepEqual(
    log.mock.calls.map((c) => c.arguments[0]),
    ['[jarvis] tool WebSearch -> allow', '[jarvis] tool Bash -> deny', '[jarvis] tool Bash -> allow'],
  )
})

test('wiring: the bridge builds one policy from its writes switch and uses it at every gate; the old definitions are gone', () => {
  const server = readFileSync(new URL('../bridge/server.mjs', import.meta.url), 'utf8').replace(/\r/g, '')
  assert.match(server, /import \{ createToolPolicy \} from '\.\/policy\.mjs'/)
  assert.match(server, /const \{ decideTool, canUseTool, disallowedBuiltins: DISALLOWED_BUILTINS \} = createToolPolicy\(\{ allowWrites: ALLOW_WRITES \}\)/)
  assert.match(server, /const ALLOW_WRITES = WRITES\.allowed/)
  assert.match(server, /disallowedTools: DISALLOWED_BUILTINS,/, 'taken from the model through the SDK')
  // The last gate: the policy's own canUseTool, deciding with the same decideTool.
  // Handed to the session's options (sessionLifecycle.mjs), which pass it to the SDK as canUseTool.
  assert.match(server, /options: sessionOptions\(\{[\s\S]*?\n {10}canUseTool,\n {8}\}\),/, 'the last gate')
  const life = readFileSync(new URL('../bridge/sessionLifecycle.mjs', import.meta.url), 'utf8').replace(/\r/g, '')
  assert.match(life, /^ {4}canUseTool,\n {2}\}\n\}/m)
  const policy = readFileSync(new URL('../bridge/policy.mjs', import.meta.url), 'utf8').replace(/\r/g, '')
  assert.match(policy, /const canUseTool = async \(toolName\) => \{\n\s+const ok = decideTool\(toolName\)/)
  // The HUD announces only what may run: the badge (toolBadge.mjs) asks the same decideTool, and
  // server.mjs hands it that one and the tool frame.
  const badge = readFileSync(new URL('../bridge/toolBadge.mjs', import.meta.url), 'utf8').replace(/\r/g, '')
  assert.match(badge, /if \(decideTool\(name\)\) return show\(name\)/, 'the HUD announces only what may run')
  assert.match(server, /createToolBadge\(\{\n {4}decideTool,\n {4}show: \(name\) => sendTurn\(\{ type: 'tool', name \}\),/)
  for (const gone of ['const READ_ONLY_BUILTINS', 'const WRITE_BUILTINS', 'const READ_ONLY_MCP', 'const READ_VERB', 'const EFFECTFUL_VERB', 'const VETO_EXEMPT', 'function decideTool']) {
    assert.ok(!server.includes(gone), `${gone} lives in policy.mjs only`)
  }
})
