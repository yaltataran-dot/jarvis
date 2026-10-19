import { readFileSync, realpathSync } from 'node:fs'
import { homedir as osHomedir, tmpdir as osTmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { cleanKey } from './deepgramProxy.mjs'

/**
 * What the bridge reads at start-up from its environment and from Claude
 * Code's own config (~/.claude.json): the language, the MCP servers, the voice
 * keys and the recognition engine, the computer roots and the file roots.
 *
 * Moved out of server.mjs unchanged, as functions of the environment and the
 * home directory so each can be tested on its own. server.mjs calls each where
 * it read it before, with process.env, so start-up does the same things in
 * the same order; the voice keys are still read afresh on every call.
 */

/**
 * The language he answers in. Reads JARVIS_LANG, or the frontend's VITE_LANG
 * when only that is set, so one variable in the shell switches both halves.
 * Russian by default; 'en' restores the original English JARVIS.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {'ru' | 'en'}
 */
export function languageFrom(env = process.env) {
  const raw = (env.JARVIS_LANG ?? env.VITE_LANG ?? '').trim().toLowerCase()
  if (raw === '' || raw === 'ru') return 'ru'
  if (raw === 'en') return 'en'
  console.warn(`[jarvis] JARVIS_LANG="${raw}" is not ru or en — using ru.`)
  return 'ru'
}

/**
 * Every MCP server Claude Code has configured, read out of its own config.
 *
 * This does two jobs. The HUD wants the names while the boot animation plays,
 * and the agent doesn't emit its init message — and therefore its server
 * list — until the first user message flows through, which is far too late.
 * More importantly, this bridge turns filesystem settings off (see
 * settingSources in server.mjs) and the SDK stops discovering these servers on its
 * own, so handing them over explicitly is what keeps the local stdio ones —
 * the whole reason the bridge exists — in play.
 *
 * Only the global block and the home-directory project scope, because
 * homedir() is our cwd. That makes the list a close but not exact match for
 * the agent's own: the 'ready' sent on connect comes from here and the second
 * one, sent from the init message a turn later, carries live status. Expect
 * the two to differ, and treat the later one as authoritative.
 *
 * @param {() => string} [homedir]
 */
export function configuredServers(homedir = osHomedir) {
  try {
    const cfg = JSON.parse(
      readFileSync(join(homedir(), '.claude.json'), 'utf8'),
    )
    return {
      ...(cfg.mcpServers ?? {}),
      // Servers scoped to the home directory apply too, since that's our cwd.
      ...(cfg.projects?.[homedir()]?.mcpServers ?? {}),
    }
  } catch {
    return {}
  }
}

/**
 * The voice keys, read afresh on every call.
 *
 * @param {{ env?: Record<string, string | undefined>, homedir?: () => string }} [o]
 */
export function createVoiceKeys({ env = process.env, homedir = osHomedir } = {}) {
  /**
   * ElevenLabs credentials, borrowed from the MCP server config.
   *
   * If you've set up the elevenlabs MCP server, the key is already on this
   * machine — no reason to make you paste it into a second .env file. The browser
   * never sees it: it POSTs text to /tts here and gets audio back.
   */
  function elevenKey() {
    if (env.ELEVENLABS_API_KEY) return env.ELEVENLABS_API_KEY
    try {
      const cfg = JSON.parse(
        readFileSync(join(homedir(), '.claude.json'), 'utf8'),
      )
      return cfg.mcpServers?.elevenlabs?.env?.ELEVENLABS_API_KEY ?? null
    } catch {
      return null
    }
  }

  /**
   * Deepgram credential, from the environment only (systemd loads
   * /opt/jarvis/.env.bridge). Never read from a file here, never sent to the
   * browser, never logged. Blank counts as missing.
   */
  const deepgramKey = () => cleanKey(env.DEEPGRAM_API_KEY)

  /**
   * Which engine does realtime recognition. JARVIS_STT=elevenlabs|deepgram pins
   * it (a pinned engine without its key means the browser engine); unset, a
   * Deepgram key wins over an ElevenLabs one.
   */
  function sttEngine() {
    const pin = (env.JARVIS_STT ?? '').trim().toLowerCase()
    const dg = Boolean(deepgramKey())
    const eleven = Boolean(elevenKey())
    if (pin === 'elevenlabs') return eleven ? 'elevenlabs' : null
    if (pin === 'deepgram') return dg ? 'deepgram' : null
    return dg ? 'deepgram' : eleven ? 'elevenlabs' : null
  }

  return { elevenKey, deepgramKey, sttEngine }
}

/**
 * Where the computer tools may work: the project, then JARVIS_PC_ROOTS.
 *
 * @param {Record<string, string | undefined>} env
 * @param {string} projectRoot
 */
export function pcRoots(env, projectRoot) {
  return [
    projectRoot,
    ...(env.JARVIS_PC_ROOTS ?? '').split(';').map((s) => s.trim()).filter(Boolean),
  ]
}

/**
 * Where GET /file may read from, each root realpath'd once, here.
 *
 * @param {Record<string, string | undefined>} env
 * @param {{ homedir?: () => string, tmpdir?: () => string }} [o]
 */
export function fileRoots(env, { homedir = osHomedir, tmpdir = osTmpdir } = {}) {
  return [
    homedir(),
    // Both temp directories, because on macOS os.tmpdir() is the per-user
    // $TMPDIR under /var/folders while half the tools that take a screenshot
    // still write it to /tmp. Dropping one of them loses real panels.
    tmpdir(),
    '/tmp',
    ...(env.JARVIS_FILE_ROOTS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  ].map((root) => {
    try {
      return realpathSync(root)
    } catch {
      return resolvePath(root)
    }
  })
}
