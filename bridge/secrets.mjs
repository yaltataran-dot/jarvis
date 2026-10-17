/**
 * Keeping the bridge's secrets to the bridge.
 *
 * The bridge holds keys the agent has no use for — Deepgram, ElevenLabs, the
 * fallback channel's API key — and it used to hand the agent its whole
 * environment, less only the fallback's settings. Everything a child process
 * is given can end up in a tool result, a log line or an error read aloud, so
 * each kind of child gets a list of what it needs instead:
 *
 *   agentEnv     Claude Code: the system's basics, the network settings, and
 *                its own ANTHROPIC_* / CLAUDE_* configuration and login.
 *   systemEnv    a program the bridge starts for the model (run_check,
 *                open_app): the system's basics and nothing else.
 *   withoutSecrets  the bridge's own fixed helpers (piper, the media and DPAPI
 *                scripts): everything except what looks like a secret, since
 *                what they need from the environment is not written down.
 *
 * Names are matched without regard to case: Windows has PATH and Path alike.
 *
 * This is not isolation. A process that can run a shell as the same user can
 * read the bridge's environment from the system directly; that is why
 * writesAllowed() refuses the shell to a bridge running as root, and why the
 * real boundary is a separate user for the agent.
 */

import { inspect } from 'node:util'

/** Names that hold secrets, whatever they belong to. */
export const SECRET_NAME = /KEY|TOKEN|SECRET|PASSW|CREDENTIAL|COOKIE|AUTH/i

/** The system's basics: enough to find programs, a home, a temp folder and a locale. */
const SYSTEM = new Set([
  'PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USER', 'USERNAME', 'USERDOMAIN',
  'LOGNAME', 'SHELL', 'COMPUTERNAME', 'TMPDIR', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'ALLUSERSPROFILE', 'PUBLIC', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'OS',
  'NUMBER_OF_PROCESSORS', 'LANG', 'LANGUAGE', 'TZ', 'TERM', 'COLORTERM',
])
const SYSTEM_PREFIX = /^(LC_|XDG_|PROCESSOR_)/

/** How the agent reaches the API through a proxy or a private CA. */
const NETWORK = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR'])

/**
 * Claude Code's own settings and login, as the Agent SDK and the CLI read
 * them (ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, CLAUDE_CONFIG_DIR,
 * CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CODE_USE_BEDROCK, …). Its key is its own:
 * the fallback channel's is JARVIS_FALLBACK_API_KEY and never one of these.
 */
const AGENT_PREFIX = /^(ANTHROPIC_|CLAUDE_|MCP_|DISABLE_)/
/** npm's settings, for MCP servers started through npx. Secret-named ones are still dropped. */
const NPM_PREFIX = /^NPM_CONFIG_/

/** The bridge's own, never passed on: its settings and the keys it alone uses. */
const BRIDGE_ONLY = /^(JARVIS_|VITE_)|^(DEEPGRAM_API_KEY|ELEVENLABS_API_KEY)$/

const truthy = (v) => v != null && v !== '' && v !== '0' && String(v).toLowerCase() !== 'false'

/** The cloud credentials Claude Code reads when it is pointed at Bedrock or Vertex instead. */
function cloudPrefix(env) {
  const parts = []
  if (truthy(env.CLAUDE_CODE_USE_BEDROCK)) parts.push('AWS_')
  if (truthy(env.CLAUDE_CODE_USE_VERTEX)) parts.push('GOOGLE_', 'CLOUDSDK_', 'CLOUD_ML_REGION', 'VERTEX_REGION_')
  return parts.length ? new RegExp(`^(${parts.join('|')})`) : null
}

const pick = (env, keep) => {
  const out = {}
  for (const [k, v] of Object.entries(env ?? {})) {
    if (typeof v === 'string' && keep(k.toUpperCase())) out[k] = v
  }
  return out
}
const isSystem = (n) => SYSTEM.has(n) || SYSTEM_PREFIX.test(n)

/** The environment for Claude Code. */
export function agentEnv(env = process.env) {
  const cloud = cloudPrefix(env)
  return pick(env, (n) => {
    if (BRIDGE_ONLY.test(n)) return false
    // Its own settings, login included.
    if (AGENT_PREFIX.test(n)) return true
    if (cloud?.test(n)) return true
    if (SECRET_NAME.test(n)) return false
    return isSystem(n) || NETWORK.has(n) || NPM_PREFIX.test(n)
  })
}

/** The environment for a program started on the model's behalf: the basics only. */
export function systemEnv(env = process.env) {
  return pick(env, (n) => !BRIDGE_ONLY.test(n) && !SECRET_NAME.test(n) && isSystem(n))
}

/** Everything except what looks like a secret — for the bridge's own fixed helpers. */
export function withoutSecrets(env = process.env) {
  return pick(env, (n) => !SECRET_NAME.test(n) && !/^(JARVIS_FALLBACK|DEEPGRAM_|ELEVENLABS_)/.test(n))
}

/** The values worth masking wherever they turn up: any secret-named variable's, eight characters or more. */
export function secretValuesFrom(env = process.env) {
  return Object.entries(env ?? {})
    .filter(([k, v]) => SECRET_NAME.test(k) && typeof v === 'string' && v.trim().length >= 8)
    .map(([, v]) => v.trim())
}

const registered = new Set()

/** Values to mask from now on — the bridge's own keys, registered once at start. */
export function registerSecrets(values) {
  for (const v of values ?? []) if (typeof v === 'string' && v.length >= 8) registered.add(v)
}

/** For the tests. */
export function clearRegisteredSecrets() {
  registered.clear()
}

export const MASK = '[скрыто]'

/**
 * Key-shaped strings, by their format. A 40-character hex string alone is not
 * one of them: Deepgram's keys look exactly like a git commit hash, so they
 * are caught by what surrounds them — "Token …", a deepgram assignment — or
 * by their registered value.
 */
export const KEY_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, MASK],
  [/\bsk-ant-[\w-]{10,}/g, MASK],
  // Other "sk-" keys: OpenAI-style, and the dashed ones (sk-or-v1-…, sk-proj-…).
  [/\bsk-[A-Za-z0-9]{20,}/g, MASK],
  [/\bsk-[A-Za-z0-9]+-[\w-]{16,}/g, MASK],
  // ElevenLabs.
  [/\bsk_[A-Za-z0-9]{32,}\b/g, MASK],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, MASK],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, MASK],
  [/\bAKIA[0-9A-Z]{16}\b/g, MASK],
  [/\bxox[abprs]-[\w-]{10,}/g, MASK],
  [/\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g, MASK],
  // Google: OAuth access and refresh tokens, API keys, client secrets.
  [/\bya29\.[\w-]{20,}/g, MASK],
  [/\b1\/\/0[\w-]{20,}/g, MASK],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, MASK],
  [/\bGOCSPX-[\w-]{20,}/g, MASK],
  // A credential in an Authorization header — Deepgram's "Token <key>" among them.
  [/\b(Token|Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{20,}/g, `$1 ${MASK}`],
  [/((?:xi-api-key|x-api-key|api-key)["']?\s*[:=]\s*)(["']?)[^\s"',;]{8,}\2/gi, `$1$2${MASK}$2`],
  [/((?:deepgram|elevenlabs)[\w-]*["']?\s*[:=]\s*)(["']?)[A-Za-z0-9_-]{20,}\2/gi, `$1$2${MASK}$2`],
]

/** Text with every registered secret and every key-shaped string masked. */
export function redactSecrets(text) {
  let out = String(text)
  // Longest first, so a value that contains another is masked whole.
  for (const v of [...registered].sort((a, b) => b.length - a.length)) out = out.split(v).join(MASK)
  for (const [re, to] of KEY_PATTERNS) out = out.replace(re, to)
  return out
}

const WRAPPED = Symbol('jarvis.redacted')

/**
 * Mask secrets in everything the bridge prints. An error from the SDK can
 * carry the CLI's stderr; an API error can echo a header. Objects are printed
 * the way console would print them, then masked.
 */
export function installLogRedaction(con = console) {
  if (con[WRAPPED]) return
  for (const name of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = con[name].bind(con)
    con[name] = (...args) =>
      original(
        ...args.map((a) =>
          typeof a === 'string' ? redactSecrets(a) : a !== null && typeof a === 'object' ? redactSecrets(inspect(a, { depth: 4 })) : a,
        ),
      )
  }
  con[WRAPPED] = true
}

/**
 * Whether JARVIS_ALLOW_WRITES may take effect. It gives the agent a shell and
 * the file tools; as root that is the whole machine — every key, every login,
 * every other service — so a bridge running as root keeps them off whatever
 * the flag says. Checking the uid is a floor, not isolation: as any user the
 * shell still reaches what that user can.
 *
 * `uid` is process.getuid?.(): undefined on Windows, where there is no root
 * to refuse.
 */
export function writesAllowed(env = process.env, uid = process.getuid?.()) {
  const asked = env.JARVIS_ALLOW_WRITES === '1'
  if (!asked) return { allowed: false, refusedAsRoot: false }
  if (uid === 0) return { allowed: false, refusedAsRoot: true }
  return { allowed: true, refusedAsRoot: false }
}
