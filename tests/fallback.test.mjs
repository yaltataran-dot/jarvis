import { test } from 'node:test'
import assert from 'node:assert/strict'
import Anthropic from '@anthropic-ai/sdk'
import { classifyFallbackError, createBudget, createFallback, fallbackConfig } from '../bridge/fallback.mjs'
import { fallbackDownMessage, limitMidTurnMessage } from '../bridge/failures.mjs'

const FULL = {
  JARVIS_FALLBACK: 'anthropic-api',
  JARVIS_FALLBACK_API_KEY: 'sk-ant-api03-test',
  JARVIS_FALLBACK_MODEL: 'claude-sonnet-5-5',
  JARVIS_FALLBACK_BUDGET_USD: '1',
}

test('the fallback is off unless every part of it is stated', () => {
  assert.deepEqual(fallbackConfig({}), { ok: false, reason: null })
  for (const key of ['JARVIS_FALLBACK_API_KEY', 'JARVIS_FALLBACK_MODEL', 'JARVIS_FALLBACK_BUDGET_USD']) {
    const env = { ...FULL }
    delete env[key]
    const c = fallbackConfig(env)
    assert.equal(c.ok, false, key)
    assert.match(c.reason, new RegExp(key))
  }
  assert.equal(fallbackConfig({ ...FULL, JARVIS_FALLBACK: 'other' }).ok, false)
  assert.equal(fallbackConfig({ ...FULL, JARVIS_FALLBACK_BUDGET_USD: '0' }).ok, false)
  const c = fallbackConfig(FULL)
  assert.equal(c.ok, true)
  assert.equal(c.cfg.priceIn, 2)
  assert.equal(c.cfg.priceOut, 10)
})

test('a subscription login token is refused: the fallback never borrows a Claude account', () => {
  const c = fallbackConfig({ ...FULL, JARVIS_FALLBACK_API_KEY: 'sk-ant-oat01-xyz' })
  assert.equal(c.ok, false)
  assert.match(c.reason, /subscription/)
})

test('a model the price table does not know needs its prices stated', () => {
  assert.equal(fallbackConfig({ ...FULL, JARVIS_FALLBACK_MODEL: 'claude-new' }).ok, false)
  const c = fallbackConfig({ ...FULL, JARVIS_FALLBACK_MODEL: 'claude-new', JARVIS_FALLBACK_PRICE_IN: '1', JARVIS_FALLBACK_PRICE_OUT: '2' })
  assert.equal(c.ok, true)
})

test('the budget is per local day and kept across restarts', () => {
  let saved = null
  const store = { read: () => saved, write: (v) => (saved = v) }
  let now = new Date(2026, 9, 17, 12).getTime()
  const b = createBudget({ limitUsd: 1, store, now: () => now })
  b.charge(0.9)
  assert.equal(b.allows(0.2), false)
  // A new budget object reads the same day's spend back.
  assert.equal(createBudget({ limitUsd: 1, store, now: () => now }).allows(0.2), false)
  now = new Date(2026, 9, 18, 0, 1).getTime()
  assert.equal(b.allows(0.2), true)
})

/** A client whose one stream the test drives. */
function fakeClient({ text = 'Четыре.', usage = { input_tokens: 1000, output_tokens: 10 }, fail = null, hang = false } = {}) {
  const seen = []
  return {
    seen,
    messages: {
      stream(body, opts) {
        seen.push({ body, opts })
        const handlers = []
        return {
          on(ev, cb) {
            if (ev === 'text') handlers.push(cb)
            return this
          },
          finalMessage() {
            if (hang) {
              return new Promise((_, reject) =>
                opts.signal.addEventListener('abort', () => reject(new Anthropic.APIUserAbortError())),
              )
            }
            if (fail) return Promise.reject(fail)
            for (const cb of handlers) cb(text)
            return Promise.resolve({ content: [{ type: 'text', text }], usage, stop_reason: 'end_turn' })
          },
        }
      },
    },
  }
}

const cfg = fallbackConfig(FULL).cfg

test('an answer streams its text, sends no tools and no retries, and is charged what it cost', async () => {
  const client = fakeClient()
  const budget = createBudget({ limitUsd: 1 })
  const fb = createFallback({ cfg, system: 'You are JARVIS.', budget, client })
  const got = []
  const res = await fb.answer({
    prompt: '2+2?',
    history: [{ q: 'привет', a: 'Здравствуйте.' }],
    signal: new AbortController().signal,
    onText: (d) => got.push(d),
  })
  assert.deepEqual(got, ['Четыре.'])
  assert.equal(res.text, 'Четыре.')
  const { body, opts } = client.seen[0]
  assert.equal(body.tools, undefined)
  assert.equal(opts.maxRetries, 0)
  assert.deepEqual(body.messages.map((m) => m.role), ['user', 'assistant', 'user'])
  // 1000 in × $2/M + 10 out × $10/M
  assert.ok(Math.abs(res.costUsd - 0.0021) < 1e-9)
  assert.ok(Math.abs(budget.spent() - 0.0021) < 1e-9)
})

test('a request the budget cannot cover at its worst is not sent', async () => {
  const client = fakeClient()
  const fb = createFallback({ cfg: { ...cfg, budgetUsd: 0.001 }, system: 'x', budget: createBudget({ limitUsd: 0.001 }), client })
  assert.deepEqual(fb.ready(), { ok: false, kind: 'budget' })
  await assert.rejects(fb.answer({ prompt: 'hi', signal: new AbortController().signal }), { kind: 'budget' })
  assert.equal(client.seen.length, 0)
})

test('an abort cancels the request in flight, and its reserve stays charged', async () => {
  const budget = createBudget({ limitUsd: 1 })
  const fb = createFallback({ cfg, system: 'x', budget, client: fakeClient({ hang: true }) })
  const ac = new AbortController()
  const p = fb.answer({ prompt: 'hi', signal: ac.signal })
  ac.abort()
  await assert.rejects(p, { kind: 'cancelled' })
  assert.ok(budget.spent() > 0)
})

test('auth, limit, timeout, cancel and network failures are told apart', () => {
  const h = new Headers()
  assert.equal(classifyFallbackError(new Anthropic.AuthenticationError(401, undefined, 'bad key', h)), 'auth')
  assert.equal(classifyFallbackError(new Anthropic.PermissionDeniedError(403, undefined, 'no', h)), 'forbidden')
  assert.equal(classifyFallbackError(new Anthropic.RateLimitError(429, undefined, 'slow down', h)), 'rate')
  assert.equal(classifyFallbackError(new Anthropic.APIConnectionTimeoutError()), 'timeout')
  assert.equal(classifyFallbackError(new Anthropic.APIConnectionError({ message: 'ECONNRESET' })), 'network')
  assert.equal(classifyFallbackError(new Anthropic.APIUserAbortError()), 'cancelled')
  assert.equal(classifyFallbackError(new Anthropic.InternalServerError(529, undefined, 'overloaded', h)), 'service')
  const ac = new AbortController()
  ac.abort()
  assert.equal(classifyFallbackError(new Error('whatever'), ac.signal), 'cancelled')
})

test('each fallback failure has its own words', () => {
  assert.equal(fallbackDownMessage('budget'), 'Лимит Claude исчерпан, а дневной бюджет резервного канала исчерпан. Команды без модели работают.')
  assert.match(fallbackDownMessage('auth', 'en'), /did not accept its key/)
  assert.notEqual(fallbackDownMessage('timeout'), fallbackDownMessage('network'))
  assert.match(limitMidTurnMessage(), /проверьте/)
})
