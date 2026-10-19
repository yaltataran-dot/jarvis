import { displayServer } from './panels.mjs'
import { uiServer } from './ui.mjs'
import { chromeServer } from './chrome.mjs'
import { visionServer } from './vision.mjs'
import { pcServer } from './pc.mjs'
import { musicServer } from './music.mjs'
import { calendarServer } from './calendar.mjs'

/**
 * Everything Claude Code has configured, plus the HUD as an in-process
 * server. The HUD's handler closes over this socket, so a `display` call
 * lands on screen directly — which is also why this object is built per
 * connection rather than once.
 *
 * Moved out of server.mjs's session options unchanged. What it closes over is
 * passed in: the socket's send, whether the turn is still wanted (`live`) and
 * whether it asked to see something (`mayShow`) — both read when a tool is
 * called, as before — the camera's `ask`, and the bridge's own settings.
 *
 * @param {{
 *   configured: Record<string, object>,
 *   send: (frame: object) => void,
 *   live: () => boolean,
 *   mayShow: () => boolean,
 *   ask: (kind: string, args: object, timeoutMs?: number) => Promise<object>,
 *   allowWrites: boolean,
 *   pcRoots: string[],
 *   ym: object,
 *   cal: object,
 * }} o
 */
export function sessionServers({ configured, send, live, mayShow, ask, allowWrites, pcRoots, ym, cal }) {
  return {
    ...configured,
    // Drawn only for a turn still wanted: a panel from a stopped turn
    // would land in the middle of the next one.
    jarvis: displayServer(
      (panel) => live() && send({ type: 'panel', panel }),
      (blade) => live() && send({ type: 'blade', blade }),
      {
        // A composed panel only when this turn's question asked to see
        // something — see visual.mjs.
        mayShow,
        onRefused: (what) => console.log(`[jarvis] panel refused (${what}): not asked to see`),
      },
    ),
    // The interface controls, on the same socket. A separate key because
    // MCP tool names are `mcp__<key>__<tool>` and one key can only carry
    // one server; the underscore in it is why decideTool and announceTool
    // both name `jarvis_ui` explicitly.
    jarvis_ui: uiServer((op, args) => live() && send({ type: 'ui', op, args })),
    // The user's own Chrome, over the extension's native-host socket. It
    // holds no per-connection state, but it is built here with the rest so
    // the write gate is read once, at the same point as everything else.
    jarvis_chrome: chromeServer({ allowWrites }),
    // The camera, which unlike everything else here has to ask and wait.
    jarvis_eyes: visionServer(ask),
    // The computer: open an approved app, list, find, read, run a check.
    jarvis_pc: pcServer({ roots: pcRoots, log: (line) => console.log(line) }),
    // Yandex Music: play, pause, tracks, volume, search.
    jarvis_music: musicServer(ym),
    // Google Calendar, read-only for the model.
    jarvis_calendar: calendarServer(cal),
  }
}
