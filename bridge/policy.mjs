/**
 * Which tools the agent may run — the bridge's one place for that decision.
 *
 * Moved out of server.mjs, unchanged: the lists, the MCP policy and
 * decideTool are the same code, given the writes switch instead of reading a
 * module constant, so they can be tested without starting the bridge
 * (tests/policy.test.mjs). server.mjs builds one policy from ALLOW_WRITES and
 * passes `disallowedBuiltins` to the SDK and `decideTool` to canUseTool and
 * the HUD's tool announcements.
 */

/**
 * @param {{ allowWrites: boolean }} o — JARVIS_ALLOW_WRITES, as secrets.mjs decided it (never as root)
 */
export function createToolPolicy({ allowWrites }) {
  const ALLOW_WRITES = allowWrites === true

  /**
   * Both spellings of every renamed built-in are listed on purpose. The SDK
   * presents several tools to the model under newer names — Task is Agent,
   * BashOutput is TaskOutput, KillShell is TaskStop, and the MCP resource tools
   * gained a "Tool" suffix — so a set holding only the old names never matches
   * and the tool falls through to the write branch, which is the opposite of
   * what these lists mean. Keep both until the old names are certainly gone.
   */
  const READ_ONLY_BUILTINS = new Set([
    'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite',
    'Task', 'Agent', 'ToolSearch',
    'ListMcpResources', 'ListMcpResourcesTool',
    'ReadMcpResource', 'ReadMcpResourceTool',
    'BashOutput', 'TaskOutput',
  ])
  const WRITE_BUILTINS = new Set([
    // PowerShell is the CLI's other shell, on Windows (CLAUDE_CODE_USE_POWERSHELL_TOOL).
    'Bash', 'PowerShell', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
    'KillShell', 'TaskStop',
  ])

  /**
   * Built-ins taken out of the model's hands entirely in the default mode.
   *
   * Read, Glob and Grep were on the read-only list above, and run from the home
   * directory with no boundary: the SSH keys, Claude Code's own credentials and
   * every .env on the machine were one call away. A deny in canUseTool is not
   * enough on its own — calls the CLI settles itself never reach it (see the
   * note on canUseTool below) — so they are removed, and the jarvis_pc tools
   * (pc.mjs) do the same jobs inside the allowed folders. Bash and the editors
   * go too: they were already denied, and a tool the model cannot see is one it
   * cannot try. A subagent would inherit none of these limits, so it goes as
   * well. JARVIS_ALLOW_WRITES=1 restores the previous, unrestricted behaviour.
   */
  const DISALLOWED_BUILTINS = ALLOW_WRITES
    ? []
    : ['Read', 'Glob', 'Grep', 'Bash', 'PowerShell', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Task', 'Agent']

  /** MCP tools arrive as `mcp__<server>__<tool>`. */
  const mcpServerOf = (toolName) =>
    toolName.startsWith('mcp__') ? toolName.split('__')[1] : null

  /** The tool half, which can itself contain underscores: `mcp__x__a__b` -> `a__b`. */
  const mcpToolOf = (toolName) => toolName.split('__').slice(2).join('__')

  /**
   * MCP policy, and why it is shaped this way.
   *
   * A short list of "servers that can change things" is the wrong default,
   * because it is a list of what we happened to think of. Every server not on it
   * runs unconditionally — and on a real machine that quietly includes placing a
   * phone call, spending an advertising budget, deleting a generated character
   * and writing files to disk. A voice assistant cannot ask "are you sure", so
   * the bridge has to be the one that is sure.
   *
   * So the default is deny, softened in two ways so the demo stays usable:
   *
   *   1. READ_ONLY_MCP is an explicit allowlist of servers whose whole surface is
   *      lookups and generation — search, registries, analytics reads. Anything
   *      there runs in read-only mode.
   *   2. Everywhere else, the tool has to argue for itself: its own name must
   *      begin with a read verb. `list_devices` runs; `install_apk` does not.
   *
   * On top of both sits a veto: a name containing a plainly effectful verb needs
   * ALLOW_WRITES no matter which server it came from, which is what keeps
   * `make_outbound_call` and `download_lottie` still until you ask for them.
   */
  const READ_ONLY_MCP = new Set([
    'exa', 'exa-code', 'serper', 'serpapi', 'lottie-search', 'mcp-registry',
    'openrouter', 'openrouter-image', 'Microsoft_Clarity',
    // The generation servers belong here too, and leaving them out was a real
    // regression: `generate_image` begins with no read verb, so it fell to the
    // deny branch and "generate an image of the Mark VII suit" — the headline
    // demo — stopped working in the default mode.
    //
    // Putting them on the allowlist is safe because the veto below still applies
    // to allowlisted servers: it is what continues to withhold
    // make_outbound_call, delete_character, create_* and edit_image. Generation
    // runs; acting on the world does not.
    'higgsfield', 'heygen', 'elevenlabs',
  ])

  /**
   * Anchored on the tool name, so it reads the verb rather than the noun.
   * `screenshot` is in here because it is a read that doesn't sound like one,
   * and the persona is told in as many words to put screenshots on the display.
   */
  const READ_VERB =
    /^(get|list|read|search|find|query|fetch|check|describe|inspect|show|view|explain|screenshot)/i

  /**
   * Unanchored on purpose — `make_outbound_call` and `Bulk-Edit-Events` both
   * hide their verb in the middle. `download` is here because it writes a file
   * even though it sounds like a read.
   */
  const EFFECTFUL_VERB =
    /(send|call|post|create|delete|remove|update|edit|write|install|launch|tap|swipe|press|type|buy|pay|charge|publish|deploy|outbound|download)/i

  /**
   * Tools whose names trip the veto without deserving it.
   *
   * The veto reads verbs out of names, which is the right instinct and
   * occasionally the wrong answer. `openrouter send-message` sends a prompt to a
   * language model and gets text back — nothing in the world changes — but it is
   * indistinguishable by name from sending mail. Asking a second model a question
   * is one of the better things this assistant can do, so it is named here
   * instead of being lost to a regex.
   *
   * Full `server__tool` keys, so an exemption can never leak across servers.
   */
  const VETO_EXEMPT = new Set([
    'openrouter__send-message',
    'openrouter__send-feedback',
  ])

  function decideTool(name) {
    if (READ_ONLY_BUILTINS.has(name)) return true
    if (WRITE_BUILTINS.has(name)) return ALLOW_WRITES

    const server = mcpServerOf(name)
    if (server) {
      // The HUD, and the interface controls beside it. Both run in this process
      // and draw on our own screen, so neither is something to withhold —
      // without them JARVIS has no display at all. They also have to be named
      // here rather than left to the verb rules below, which read `ui_theme` as
      // a write and would hold the whole surface back behind ALLOW_WRITES.
      if (server === 'jarvis' || server === 'jarvis_ui') return true

      // The browser server gates itself, at construction: chromeServer() only
      // builds the acting tools — click, type, form input, close tab — when
      // ALLOW_WRITES is set, so anything that reaches here at all is something
      // the same policy has already permitted. Deciding it a second time by
      // reading verbs out of the name would only get it wrong: `chrome_navigate`
      // begins with no read verb and would fall to the write branch, which would
      // withhold the one tool the whole server is for.
      if (server === 'jarvis_chrome') return true

      // The camera. Not withheld behind ALLOW_WRITES: looking changes nothing,
      // and the real gate is the browser's own camera permission plus an
      // indicator the user can see for as long as it is live.
      if (server === 'jarvis_eyes') return true

      // The computer. Like the browser server it gates itself: every tool is a
      // fixed operation over checked paths (computer.mjs), and none of them
      // changes anything. Its names would trip the verb rules — `pc_open_app`
      // reads as a launch — which is why it is named here.
      if (server === 'jarvis_pc') return true

      // Yandex Music: fixed player actions on the user's own app, nothing on
      // disk or the network. `music_control`'s "play" would trip the verb rules.
      if (server === 'jarvis_music') return true

      // The calendar, for the model: reading only — the server has no write tool.
      if (server === 'jarvis_calendar') return true

      const tool = mcpToolOf(name)
      if (EFFECTFUL_VERB.test(tool) && !VETO_EXEMPT.has(`${server}__${tool}`)) {
        return ALLOW_WRITES
      }
      // The session tools this bridge is developed inside count as read-only too.
      if (READ_ONLY_MCP.has(server) || server.startsWith('ccd_session')) return true
      return READ_VERB.test(tool) ? true : ALLOW_WRITES
    }
    return ALLOW_WRITES
  }

  return { decideTool, disallowedBuiltins: DISALLOWED_BUILTINS, mcpServerOf, mcpToolOf }
}
