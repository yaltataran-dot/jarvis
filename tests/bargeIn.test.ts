import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isBargeIn } from '../src/lib/bargeIn.ts'

test('an interim guess, however long, does not cut in', () => {
  // What a cough or the television looks like before it is withdrawn.
  assert.equal(isBargeIn('', 'да так'), false)
  assert.equal(isBargeIn('', 'ну и что там дальше было'), false)
})

test('two final words cut in', () => {
  assert.equal(isBargeIn('подожди секунду', ''), true)
  assert.equal(isBargeIn('а теперь', 'покажи папку'), true)
})

test('one final word does not', () => {
  assert.equal(isBargeIn('ну', 'да так'), false)
})

test('a stop word cuts in at once, interim or final', () => {
  assert.equal(isBargeIn('', 'стоп'), true)
  assert.equal(isBargeIn('', 'хватит'), true)
  assert.equal(isBargeIn('стоп', ''), true)
  assert.equal(isBargeIn('', 'stop'), true)
})
