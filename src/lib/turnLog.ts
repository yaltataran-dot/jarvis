import { OVERRIDE } from './stopWords'
import { norm } from './echo'

/**
 * One voice request, traced from the microphone to the spoken answer.
 *
 * Every trace() step is stamped with a turn id (`tid`, born at the first
 * recogniser result of a phrase) and `dt`, the milliseconds since the previous
 * step of the same tid. Four detectors turn the stream into warnings:
 * a phrase emitted twice, a run of words repeated inside one phrase, a stop
 * heard while he was busy that nothing acted on, and an ask that never got a
 * first word. Pure and clock-injected so the tests can drive it.
 *
 * What is kept: step names, lengths, codes. What is not: the words of the
 * dialogue (the `text` field, anything quoted in `why`) unless `dialog` is on,
 * and never anything that looks like a key or token.
 */

export type Info = Record<string, string | number | boolean>

export type Stamped = { t: number; tid: string; dt: number; step: string; info: Info }

/** Fields that carry what was said. Dropped unless dialog logging is on. */
const DIALOG_KEYS = new Set(['text', 'said', 'heard'])
const MAX_KEYS = 10
const MAX_VALUE = 80

const SECRET = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:api[_-]?key|token|secret|password)\s*[=:]\s*\S+/gi,
  /\b[A-Za-z0-9_-]{32,}\b/g,
]

/** A value safe to write down: secrets masked, quoted speech cut, length capped. */
export function clean(value: string, dialog: boolean): string {
  let v = value.replace(/\s+/g, ' ')
  for (const re of SECRET) v = v.replace(re, '***')
  if (!dialog) v = v.replace(/["«“].*?["»”]/g, '"…"')
  return v.slice(0, MAX_VALUE)
}

export function sanitize(info: Record<string, unknown>, dialog: boolean): Info {
  const out: Info = {}
  for (const [k, v] of Object.entries(info)) {
    if (Object.keys(out).length >= MAX_KEYS) break
    if (!dialog && DIALOG_KEYS.has(k)) continue
    if (typeof v === 'number' || typeof v === 'boolean') out[k.slice(0, 20)] = v
    else if (typeof v === 'string') out[k.slice(0, 20)] = clean(v, dialog)
  }
  return out
}

/** A run of two or more words said twice in a row: "отмени 23 15 23 15". */
export function repeatedRun(text: string): boolean {
  const w = norm(text).split(' ').filter(Boolean)
  for (let n = 2; n * 2 <= w.length; n++) {
    for (let i = 0; i + n * 2 <= w.length; i++) {
      let same = true
      for (let j = 0; j < n && same; j++) same = w[i + j] === w[i + n + j]
      if (same) return true
    }
  }
  return false
}

export type TurnLogOptions = {
  out: (e: Stamped) => void
  dialog?: boolean
  now?: () => number
  /** An ask with no first word after this long is hung. */
  hangMs?: number
  /** A stop heard while busy with no reaction after this long is missed. */
  stopMs?: number
  /** The same phrase emitted twice within this long is a duplicate. */
  dupMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (h: unknown) => void
}

export function makeTurnLog(o: TurnLogOptions) {
  const now = o.now ?? Date.now
  const hangMs = o.hangMs ?? 20_000
  const stopMs = o.stopMs ?? 2_000
  const dupMs = o.dupMs ?? 10_000
  const setT = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearT = o.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const dialog = o.dialog === true

  let n = 0
  let tid = '-'
  let last = 0
  let askOpen = false
  let speaking = 0
  let hangTimer: unknown = null
  let stopTimer: unknown = null
  let lastEmit = { text: '', at: 0 }
  const warnings: Stamped[] = []

  const put = (step: string, info: Record<string, unknown>) => {
    const t = now()
    const e: Stamped = { t, tid, dt: last ? t - last : 0, step, info: sanitize(info, dialog) }
    last = t
    o.out(e)
    return e
  }
  const warn = (code: string, info: Record<string, unknown> = {}) => {
    const e = put(`warn:${code}`, info)
    warnings.push(e)
    if (warnings.length > 20) warnings.shift()
  }
  const stopHang = () => {
    askOpen = false
    if (hangTimer) clearT(hangTimer)
    hangTimer = null
  }
  const stopStopTimer = () => {
    if (stopTimer) clearT(stopTimer)
    stopTimer = null
  }
  const stopSeen = () => {
    if (!askOpen && !speaking) return
    stopStopTimer()
    stopTimer = setT(() => {
      stopTimer = null
      warn('stop-missed', { waitedMs: stopMs })
    }, stopMs)
  }

  return {
    event(step: string, info: Record<string, unknown> = {}) {
      if (step === 'rec:start') {
        tid = `t${++n}`
        last = 0
      }
      const text = typeof info.text === 'string' ? info.text : ''
      put(step, info)

      switch (step) {
        case 'ask:sent':
          stopHang()
          askOpen = true
          hangTimer = setT(() => {
            hangTimer = null
            warn('hung', { waitedMs: hangMs })
          }, hangMs)
          break
        case 'ask:first-delta':
        case 'app:answer':
        case 'cancel':
        case 'ask:connect-failed':
        case 'ask:cancelled-while-dialling':
          stopHang()
          break
        case 'floor:speak:start':
          speaking++
          break
        case 'floor:speak:end':
          speaking = Math.max(0, speaking - 1)
          break
        case 'floor:speak:cut':
        case 'floor:ask:interrupt':
        case 'floor:turn:begin':
          stopStopTimer()
          break
        case 'voice:stop-heard':
          stopSeen()
          break
        case 'voice:emit':
          if (!text) break
          if (OVERRIDE.test(text)) stopSeen()
          if (repeatedRun(text)) warn('repeat-in-phrase', { len: text.length })
          if (lastEmit.text && norm(text) === lastEmit.text && now() - lastEmit.at < dupMs) {
            warn('duplicate', { len: text.length })
          }
          lastEmit = { text: norm(text), at: now() }
          break
      }
    },
    warnings: () => warnings.slice(),
    tid: () => tid,
  }
}
