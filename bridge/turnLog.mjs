import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The trace frames from the page, kept on disk as JSON lines.
 *
 * Off the voice path by construction: `add()` only pushes to an in-memory
 * queue and returns; a single async flush writes it out. A failing disk costs
 * log lines, never a turn. Size is bounded — `maxBytes` per file, `files`
 * files (trace.jsonl, .1, .2) — and the queue is bounded too.
 *
 * The page already strips dialogue words unless VITE_DIALOG_LOG=1; this
 * repeats the stripping on the bridge side, which has its own switch
 * (JARVIS_DIALOG_LOG=1), so a page cannot turn it on by itself.
 */

const DIALOG_KEYS = new Set(['text', 'said', 'heard'])
const SECRET = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:api[_-]?key|token|secret|password)\s*[=:]\s*\S+/gi,
  /\b[A-Za-z0-9_-]{32,}\b/g,
]

export function cleanValue(value, dialog) {
  let v = String(value).replace(/\s+/g, ' ')
  for (const re of SECRET) v = v.replace(re, '***')
  if (!dialog) v = v.replace(/["«“].*?["»”]/g, '"…"')
  return v.slice(0, 80)
}

export function cleanInfo(info, dialog) {
  const out = {}
  if (!info || typeof info !== 'object') return out
  for (const [k, v] of Object.entries(info)) {
    if (Object.keys(out).length >= 10) break
    if (!dialog && DIALOG_KEYS.has(k)) continue
    if (typeof v === 'number' || typeof v === 'boolean') out[String(k).slice(0, 20)] = v
    else if (typeof v === 'string') out[String(k).slice(0, 20)] = cleanValue(v, dialog)
  }
  return out
}

/**
 * A `trace` frame from the page: a diagnostic breadcrumb. Whitelisted shape,
 * every field truncated, so nothing the page sends can flood or forge the
 * log. Only while tracing is on (`on`), and only with a string step; written
 * to the turn log, when there is one, and printed as one `[trace]` line.
 * Moved from server.mjs's frame dispatch unchanged.
 *
 * @param {{ step?: unknown, at?: unknown, info?: unknown }} msg
 * @param {{ on: boolean, dialog: boolean, turnLog: { add(step: string, info: object, at: number): void } | null }} o
 */
export function recordTrace(msg, { on, dialog, turnLog }) {
  if (on && typeof msg.step === 'string') {
    const at = typeof msg.at === 'number' ? msg.at : Date.now()
    const info = cleanInfo(msg.info, dialog)
    turnLog?.add(msg.step, info, at)
    const line = Object.entries(info)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')
    console.log(`[trace] ${msg.step.slice(0, 40)} ${line}`)
  }
}

export function createTurnLog({ dir, maxBytes = 2 * 1024 * 1024, files = 3, dialog = false, maxQueue = 2000 }) {
  const base = join(dir, 'trace.jsonl')
  const nth = (i) => (i === 0 ? base : `${base}.${i}`)
  let queue = []
  let dropped = 0
  let flushing = null
  let size = null

  const rotate = async () => {
    await rm(nth(files - 1), { force: true })
    for (let i = files - 2; i >= 0; i--) {
      await rename(nth(i), nth(i + 1)).catch(() => {})
    }
    size = 0
  }

  const flush = async () => {
    await mkdir(dir, { recursive: true })
    if (size === null) size = await stat(base).then((s) => s.size, () => 0)
    while (queue.length) {
      const batch = queue
      queue = []
      let chunk = ''
      for (const line of batch) {
        if ((size > 0 || chunk) && size + Buffer.byteLength(chunk) + Buffer.byteLength(line) > maxBytes) {
          if (chunk) await appendFile(base, chunk)
          chunk = ''
          await rotate()
        }
        chunk += line
      }
      if (chunk) {
        await appendFile(base, chunk)
        size += Buffer.byteLength(chunk)
      }
    }
  }

  const kick = () => {
    if (flushing) return
    flushing = flush()
      .catch(() => {
        queue = []
      })
      .finally(() => {
        flushing = null
        if (queue.length) kick()
      })
  }

  return {
    /** Queue one page trace frame. Never throws, never waits. */
    add(step, info, at = Date.now()) {
      if (typeof step !== 'string') return
      if (queue.length >= maxQueue) {
        dropped++
        return
      }
      const lost = dropped
      dropped = 0
      const line = { t: at, step: cleanValue(step, false).slice(0, 40), ...cleanInfo(info, dialog), ...(lost ? { lost } : {}) }
      queue.push(`${JSON.stringify(line)}\n`)
      kick()
    },
    /** Resolves when everything queued so far is on disk. For tests and shutdown. */
    async idle() {
      while (flushing) await flushing
    },
    path: base,
  }
}
