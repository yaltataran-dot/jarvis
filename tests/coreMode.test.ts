import { test } from 'node:test'
import assert from 'node:assert/strict'
import { coreMode } from '../src/lib/coreMode.ts'

test('trouble outside JARVIS shows as its message, not as a broken core', () => {
  const limit = 'Лимит запросов Claude исчерпан до 22:50. Команды без модели работают.'
  // The core carries on in its phase: he still listens and still answers
  // what needs no model.
  assert.equal(coreMode('dormant', limit, 'service'), 'idle')
  assert.equal(coreMode('listening', limit, 'service'), 'listening')
  assert.equal(coreMode('speaking', limit, 'service'), 'speaking')
})

test('a failure of his own still puts the core into its error state', () => {
  assert.equal(coreMode('dormant', 'Микрофон не работает.', 'fault'), 'error')
  // The default, so every older caller keeps its meaning.
  assert.equal(coreMode('listening', 'Something went wrong.'), 'error')
})

test('no error, no start-up: the phase decides', () => {
  assert.equal(coreMode('thinking', null), 'processing')
  assert.equal(coreMode('tooling', null), 'processing')
  assert.equal(coreMode('boot', 'x', 'fault'), null)
  assert.equal(coreMode('offline', null), null)
})
