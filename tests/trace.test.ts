import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { setTraceSink, trace } from '../src/lib/trace.ts'

test('a breadcrumb with no sink goes nowhere; with one, it reaches it as given', () => {
  trace('before', { a: 1 }) // nothing registered: must not throw
  const seen: Array<[string, unknown]> = []
  setTraceSink((step, info) => void seen.push([step, info]))
  trace('voice:mic-failed', { name: 'NotAllowedError', kind: 'denied' })
  trace('bare')
  assert.deepEqual(seen, [
    ['voice:mic-failed', { name: 'NotAllowedError', kind: 'denied' }],
    ['bare', {}],
  ])
  setTraceSink(() => {})
})

test('wiring: the transport is the sink; the voice loop and the knowledge client no longer import the transport', () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')
  assert.match(read('../src/lib/bridge.ts'), /setTraceSink\(trace\)/)
  for (const f of ['../src/lib/voice.ts', '../src/lib/knowledgeClient.ts']) {
    const src = read(f)
    assert.match(src, /import \{ trace \} from '\.\/trace'/)
    assert.doesNotMatch(src, /from '\.\/bridge'/)
  }
})
