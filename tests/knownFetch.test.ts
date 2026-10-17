import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KNOWN_DEADLINE_MS, fetchKnown } from '../src/lib/knownFetch.ts'

const json = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status })
const run = (fetcher: typeof fetch, extra: object = {}) => {
  const steps: Array<Record<string, unknown>> = []
  const p = fetchKnown('вопрос', { url: 'http://x/knowledge/answer', fetcher, trace: (_s, i) => steps.push(i), ...extra })
  return { p, steps }
}

test('a hit returns the answer and is traced with its timing', async () => {
  const { p, steps } = run(json({ hit: true, answer: 'Капучино', id: 3 }) as typeof fetch)
  assert.equal(await p, 'Капучино')
  assert.equal(steps[0].hit, true)
  assert.equal(typeof steps[0].ms, 'number')
})

test('a miss, with the bridge’s reason in the trace', async () => {
  const { p, steps } = run(json({ hit: false, reason: 'unverified' }) as typeof fetch)
  assert.equal(await p, null)
  assert.deepEqual([steps[0].hit, steps[0].why], [false, 'unverified'])
})

test('anything odd is a miss, never an error: bad status, bad body, empty or non-string answer, network failure', async () => {
  const cases: Array<typeof fetch> = [
    json({}, 500) as typeof fetch,
    (async () => new Response('not json', { status: 200 })) as typeof fetch,
    json({ hit: true, answer: '   ' }) as typeof fetch,
    json({ hit: true, answer: 42 }) as typeof fetch,
    json({ hit: 'yes', answer: 'x' }) as typeof fetch,
    json(null) as typeof fetch,
    (async () => { throw new TypeError('Failed to fetch') }) as typeof fetch,
  ]
  for (const f of cases) assert.equal(await run(f).p, null)
})

test('a bridge that hangs costs at most the deadline, then the question goes to the model', async () => {
  const hang = ((_u: string, init?: RequestInit) =>
    new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(init.signal!.reason)))) as unknown as typeof fetch
  const t0 = performance.now()
  const { p, steps } = run(hang, { deadlineMs: 60 })
  assert.equal(await p, null)
  const took = performance.now() - t0
  assert.ok(took >= 55 && took < 400, `${took.toFixed(0)} ms`)
  assert.equal(steps[0].why, 'timeout')
  assert.ok(KNOWN_DEADLINE_MS <= 500, 'the default deadline is short')
})
