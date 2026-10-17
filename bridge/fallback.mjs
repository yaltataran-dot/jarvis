/**
 * The fallback channel: the Claude API on its own key, for when the primary —
 * Claude Code on the user's subscription — has hit its usage limit.
 *
 * Off unless every part of it is stated. It never borrows a login: the primary
 * runs on the subscription, and switching to another subscription account to
 * get round its limit is exactly what this does not do. An OAuth token
 * (sk-ant-oat…) is refused for that reason — only an API key, which is billed
 * per request to whoever owns it, and capped here by a daily budget.
 *
 *   JARVIS_FALLBACK=anthropic-api        the switch; nothing else turns it on
 *   JARVIS_FALLBACK_API_KEY=sk-ant-api…  its own key, never ANTHROPIC_API_KEY
 *   JARVIS_FALLBACK_MODEL=claude-…       the model, named
 *   JARVIS_FALLBACK_BUDGET_USD=1         spend per local day, then it stops
 *   JARVIS_FALLBACK_PRICE_IN / _OUT      $ per million tokens, for a model the
 *                                        table below does not know
 *   JARVIS_FALLBACK_MAX_TOKENS=2000      per answer
 *   JARVIS_FALLBACK_TIMEOUT_MS=30000     per request; no retries
 *   JARVIS_FALLBACK_EFFORT=low           optional, output_config.effort
 *
 * Text only. It has no tools: no search, no screen, no calendar, nothing that
 * can change anything — so nothing it does can repeat an action, and the
 * system prompt it is given says so, so it does not claim one either.
 * Cancelled through an AbortSignal, which the SDK honours mid-stream.
 */

import Anthropic from '@anthropic-ai/sdk'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** $ per million tokens, input / output — Anthropic's list prices (2026-10). */
const PRICES = {
  'claude-fable-5-1': [10, 50],
  'claude-fable-5': [10, 50],
  'claude-opus-5-5': [4, 20],
  'claude-opus-5': [5, 25],
  'claude-opus-4-8': [5, 25],
  'claude-sonnet-5-5': [2, 10],
  'claude-sonnet-5': [2, 10],
  'claude-sonnet-4-6': [3, 15],
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-haiku-4-5': [1, 5],
}

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

/**
 * The fallback's settings, or why there are none. `reason` is for the log.
 * @returns {{ ok: true, cfg: object } | { ok: false, reason: string | null }}
 */
export function fallbackConfig(env = process.env) {
  const kind = env.JARVIS_FALLBACK
  if (!kind) return { ok: false, reason: null }
  if (kind !== 'anthropic-api') return { ok: false, reason: `JARVIS_FALLBACK=${kind} is not a known channel` }
  const apiKey = env.JARVIS_FALLBACK_API_KEY ?? ''
  if (!apiKey) return { ok: false, reason: 'JARVIS_FALLBACK_API_KEY is not set' }
  if (apiKey.startsWith('sk-ant-oat')) {
    return { ok: false, reason: 'JARVIS_FALLBACK_API_KEY is a subscription login token, not an API key' }
  }
  const model = env.JARVIS_FALLBACK_MODEL ?? ''
  if (!model) return { ok: false, reason: 'JARVIS_FALLBACK_MODEL is not set' }
  const budgetUsd = Number(env.JARVIS_FALLBACK_BUDGET_USD)
  if (!(budgetUsd > 0)) return { ok: false, reason: 'JARVIS_FALLBACK_BUDGET_USD must be a positive number' }
  const listed = PRICES[model]
  const priceIn = env.JARVIS_FALLBACK_PRICE_IN != null ? Number(env.JARVIS_FALLBACK_PRICE_IN) : listed?.[0]
  const priceOut = env.JARVIS_FALLBACK_PRICE_OUT != null ? Number(env.JARVIS_FALLBACK_PRICE_OUT) : listed?.[1]
  if (!(priceIn >= 0) || !(priceOut > 0)) {
    return { ok: false, reason: `no price known for ${model}: set JARVIS_FALLBACK_PRICE_IN and JARVIS_FALLBACK_PRICE_OUT` }
  }
  const maxTokens = Math.floor(Number(env.JARVIS_FALLBACK_MAX_TOKENS ?? 2000))
  if (!(maxTokens > 0)) return { ok: false, reason: 'JARVIS_FALLBACK_MAX_TOKENS must be a positive number' }
  const timeoutMs = Math.floor(Number(env.JARVIS_FALLBACK_TIMEOUT_MS ?? 30_000))
  if (!(timeoutMs > 0)) return { ok: false, reason: 'JARVIS_FALLBACK_TIMEOUT_MS must be a positive number' }
  const effort = env.JARVIS_FALLBACK_EFFORT || null
  if (effort && !EFFORTS.has(effort)) return { ok: false, reason: `JARVIS_FALLBACK_EFFORT=${effort} is not an effort level` }
  return { ok: true, cfg: { apiKey, model, budgetUsd, priceIn, priceOut, maxTokens, timeoutMs, effort } }
}

/** The local calendar day, which is when the budget starts again. */
const dayOf = (now) => {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Spend kept in a file, so restarting the bridge does not reset the budget. */
export function fileStore(path) {
  return {
    read() {
      try {
        return JSON.parse(readFileSync(path, 'utf8'))
      } catch {
        return null
      }
    },
    write(value) {
      try {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, JSON.stringify(value))
      } catch {
        // Not fatal: the in-memory figure still caps this run.
      }
    },
  }
}

/** The daily budget. Costs are charged before a request at their worst case. */
export function createBudget({ limitUsd, store = null, now = Date.now }) {
  const saved = store?.read()
  let day = typeof saved?.day === 'string' ? saved.day : dayOf(now())
  let spent = Number.isFinite(saved?.usd) ? saved.usd : 0
  const roll = () => {
    const today = dayOf(now())
    if (today !== day) {
      day = today
      spent = 0
    }
  }
  return {
    allows(usd) {
      roll()
      return spent + usd <= limitUsd
    },
    charge(usd) {
      roll()
      spent += usd
      store?.write({ day, usd: spent })
    },
    spent() {
      roll()
      return spent
    },
  }
}

/** What went wrong with a fallback request, as one of failures.mjs's kinds. */
export class FallbackError extends Error {
  constructor(kind, cause) {
    super(`fallback ${kind}${cause?.message ? `: ${cause.message}` : ''}`)
    this.kind = kind
    this.cause = cause
  }
}

/** Most specific first: a timeout is also a connection error. */
export function classifyFallbackError(err, signal) {
  if (err instanceof FallbackError) return err.kind
  if (signal?.aborted || err instanceof Anthropic.APIUserAbortError) return 'cancelled'
  if (err instanceof Anthropic.APIConnectionTimeoutError) return 'timeout'
  if (err instanceof Anthropic.APIConnectionError) return 'network'
  if (err instanceof Anthropic.AuthenticationError) return 'auth'
  if (err instanceof Anthropic.PermissionDeniedError) return 'forbidden'
  if (err instanceof Anthropic.RateLimitError) return 'rate'
  if (err instanceof Anthropic.APIError && err.status === 402) return 'billing'
  return 'service'
}

/** Characters to tokens, on the high side: better to refuse a request than overspend. */
const tokensAtMost = (chars) => Math.ceil(chars / 2)

/**
 * The channel. `client` is for the tests; the real one is built from the key.
 * @returns {{ model: string, ready(): { ok: boolean, kind?: string }, answer(a): Promise<{ text: string, costUsd: number }> }}
 */
export function createFallback({ cfg, system, budget, client = null, log = () => {} }) {
  const api = client ?? new Anthropic({ apiKey: cfg.apiKey, maxRetries: 0, timeout: cfg.timeoutMs })
  const cost = (inTok, outTok) => (inTok * cfg.priceIn + outTok * cfg.priceOut) / 1e6
  const worst = (chars) => cost(tokensAtMost(chars), cfg.maxTokens)
  const smallest = worst(system.length + 200)

  return {
    model: cfg.model,

    /** Whether a short question can still be afforded today. */
    ready() {
      return budget.allows(smallest) ? { ok: true } : { ok: false, kind: 'budget' }
    },

    /**
     * One answer, streamed to `onText`. `prompt` is the question as the model
     * should see it; `history` the last few exchanges, oldest first.
     */
    async answer({ prompt, history = [], signal, onText = () => {} }) {
      const messages = []
      for (const h of history) {
        messages.push({ role: 'user', content: h.q }, { role: 'assistant', content: h.a })
      }
      messages.push({ role: 'user', content: prompt })
      const chars = system.length + messages.reduce((n, m) => n + m.content.length, 0)
      const reserved = worst(chars)
      if (!budget.allows(reserved)) throw new FallbackError('budget')
      // Charged up front at the worst case and settled after: a request that
      // is cut off part way still counts, and two can never both slip under.
      budget.charge(reserved)
      let settled = false
      const settle = (usd) => {
        if (settled) return
        settled = true
        budget.charge(usd - reserved)
      }
      try {
        const stream = api.messages.stream(
          {
            model: cfg.model,
            max_tokens: cfg.maxTokens,
            system,
            messages,
            ...(cfg.effort ? { output_config: { effort: cfg.effort } } : {}),
          },
          { signal, timeout: cfg.timeoutMs, maxRetries: 0 },
        )
        stream.on('text', (delta) => onText(delta))
        const msg = await stream.finalMessage()
        const u = msg.usage ?? {}
        const inTok = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
        const usd = cost(inTok, u.output_tokens ?? 0)
        settle(usd)
        if (msg.stop_reason === 'refusal') throw new FallbackError('service')
        const text = (msg.content ?? [])
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('')
          .trim()
        log(`[jarvis] fallback answered · ${u.input_tokens ?? 0} in / ${u.output_tokens ?? 0} out · $${usd.toFixed(4)} · today $${budget.spent().toFixed(4)} of $${cfg.budgetUsd}`)
        return { text, costUsd: usd }
      } catch (err) {
        // Whatever the reserve was stays charged: the request may have run.
        settle(reserved)
        throw new FallbackError(classifyFallbackError(err, signal), err)
      }
    },
  }
}
