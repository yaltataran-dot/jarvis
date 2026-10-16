import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeLedger, type Result } from '../src/lib/ledger.ts'

/** One recogniser event, the way Chrome numbers it: results from `from` on. */
const event = (from: number, ...rs: [string, boolean][]): Result[] => {
  const list: Result[] = []
  rs.forEach(([transcript, isFinal], k) => (list[from + k] = { transcript, isFinal }))
  return list
}

test('the final of a phrase already sent as interim adds nothing', () => {
  const l = makeLedger()
  assert.deepEqual(l.read(event(0, ['открой блокнот', false]), 0), { fresh: '', interim: 'открой блокнот' })
  l.commit() // sent 900 ms later, still interim
  // Chrome finalises it, capitalised and punctuated, under the same index.
  assert.deepEqual(l.read(event(0, ['Открой блокнот.', true]), 0), { fresh: '', interim: '' })
})

test('a final that rewrites the words it was sent as is still the same phrase', () => {
  const l = makeLedger()
  l.read(event(0, ['открой блок нот', false]), 0)
  l.commit()
  assert.deepEqual(l.read(event(0, ['открой блокнот', true]), 0), { fresh: '', interim: '' })
})

test('words added to a sent result come through, and only those', () => {
  const l = makeLedger()
  l.read(event(0, ['покажи папку', false]), 0)
  l.commit()
  assert.deepEqual(l.read(event(0, ['покажи папку проекта', true]), 0), { fresh: ' проекта', interim: '' })
})

test('saying the same thing again is a new result, and it is heard', () => {
  const l = makeLedger()
  l.read(event(0, ['открой блокнот', true]), 0)
  l.commit()
  assert.deepEqual(l.read(event(1, ['открой блокнот', true]), 1), { fresh: 'открой блокнот', interim: '' })
})

test('a final delivered twice counts once', () => {
  const l = makeLedger()
  assert.equal(l.read(event(0, ['найди файл', true]), 0).fresh, 'найди файл')
  assert.equal(l.read(event(0, ['найди файл', true]), 0).fresh, '')
})

test('interim and final are kept apart, and nothing is spent until committed', () => {
  const l = makeLedger()
  assert.deepEqual(l.read(event(0, ['найди', true], [' файл effort', false]), 0), {
    fresh: 'найди',
    interim: ' файл effort',
  })
  // Not sent yet: its final is still news.
  assert.deepEqual(l.read(event(1, [' файл effort', true]), 1), { fresh: ' файл effort', interim: '' })
})

test('extended: words finishing a result already dealt with, not a result of their own', () => {
  const l = makeLedger()
  l.read(event(0, ['какая погода', false]), 0)
  assert.equal(l.extended(), false)
  l.commit()
  l.read(event(0, ['какая погода в москве', true]), 0)
  assert.equal(l.extended(), true, 'the same result, finished')
  l.commit()
  l.read(event(1, ['а в питере', true]), 1)
  assert.equal(l.extended(), false, 'a new result')
  l.read(event(0, ['какая погода в москве', true]), 0)
  assert.equal(l.extended(), false, 'a repeat adds nothing')
})

test('a new session starts its indices again', () => {
  const l = makeLedger()
  l.read(event(0, ['стоп', true]), 0)
  l.commit()
  l.clear()
  assert.deepEqual(l.read(event(0, ['что нового', false]), 0), { fresh: '', interim: 'что нового' })
})
