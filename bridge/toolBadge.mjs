/**
 * The tool badge on the HUD: which tool calls the page is told about, and
 * when. Moved out of server.mjs unchanged; one per socket. server.mjs builds
 * the frame (`show`), keeps the turn's list of tool names for its log line
 * (`called`), and calls `clear` wherever a turn ends.
 */

/**
 * @param {{
 *   decideTool: (name: string) => boolean,
 *   show: (name: string) => unknown,
 *   called: (name: string) => void,
 * }} o
 */
export function createToolBadge({ decideTool, show, called }) {
  /**
   * Announcing a tool on the HUD, once, and only if it actually runs.
   *
   * A tool_use block surfaces twice — as a partial stream event and again on
   * the completed assistant message — so ids are remembered. The harder part
   * is timing, because a refused tool that lights the badge, plays the sound
   * and provokes a "working on it" line, for work that never happens, reads as
   * a bug on camera.
   *
   * The SDK's order is: the block starts streaming, then canUseTool is asked,
   * then the tool runs. So nothing is known at content_block_start. Announcing
   * from inside canUseTool would know the verdict but miss tools entirely —
   * measured on this SDK, the callback is consulted only for calls the CLI
   * hasn't already settled, so a `Bash: echo` its own classifier waves through
   * never reaches us at all.
   *
   * So: announce immediately for anything decideTool permits, since those run.
   * Hold the rest, and let the tool_result settle it — a refusal comes back as
   * is_error, anything else really did execute and has earned its badge, a
   * beat late. Nothing is ever announced for work that didn't happen.
   */
  const seenTools = new Set()
  const heldTools = new Map()

  const announceTool = (id, name) => {
    if (!name || (id && seenTools.has(id))) return
    if (id) seenTools.add(id)
    called(name.replace(/^mcp__/, ''))
    // The display tool isn't work being done, it's the HUD drawing itself —
    // announcing it would put "jarvis · display" in the tool badge and trigger
    // a "working on it" filler for something already on screen.
    if (name === 'mcp__jarvis__display') return
    // The ui_* tools are the same case one step further: retinting the
    // interface is the interface talking about itself, not work being done for
    // the user, and the badge would be describing the very thing they can see.
    if (name.startsWith('mcp__jarvis_ui__')) return
    if (decideTool(name)) return show(name)
    if (id) heldTools.set(id, name)
  }

  const settleTool = (id, failed) => {
    const name = heldTools.get(id)
    if (name === undefined) return
    heldTools.delete(id)
    if (!failed) show(name)
  }

  /** One turn's tool ids are never referred to again; without this the sets grow for as long as the socket is open. */
  const clear = () => {
    seenTools.clear()
    heldTools.clear()
  }

  return { announceTool, settleTool, clear }
}
