import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ASIDE_FIELD, ASIDE_ITEMS, asidesFrom, createAsideLedger, createBlockJoin, formatAsides, withAside } from '../bridge/turnText.mjs'
import { formatAsides as pageFormat } from '../src/lib/aside.ts'

const start = (index, type) => ({ type: 'content_block_start', index, content_block: { type } })
const delta = (index, text) => ({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } })
const stop = (index) => ({ type: 'content_block_stop', index })

/** The text the page receives for a stream of events. */
function spoken(events) {
  const join = createBlockJoin()
  let out = ''
  for (const ev of events) {
    if (ev.type === 'content_block_delta' && ev.delta.text) out += ev.delta.text
    const gap = join(ev)
    if (gap) out += gap
  }
  return out
}

test('12. text blocks either side of a tool are not glued together', () => {
  const out = spoken([
    start(0, 'text'), delta(0, 'Плюс девять, пасмурно. '), delta(0, 'Без осадков.'), stop(0),
    start(1, 'tool_use'), stop(1),
    start(0, 'text'), delta(0, 'Теплее нормы.'), stop(0),
  ])
  assert.equal(out, 'Плюс девять, пасмурно. Без осадков. Теплее нормы. ')
  assert.doesNotMatch(out, /\.\S/)
})

test('12. one space per block that had words — none for a tool, an empty block, or a thinking block', () => {
  assert.equal(spoken([start(0, 'thinking'), stop(0), start(1, 'tool_use'), stop(1)]), '')
  assert.equal(spoken([start(0, 'text'), stop(0)]), '')
  assert.equal(spoken([start(0, 'text'), delta(0, 'Готово.'), stop(0)]), 'Готово. ')
  // A stop for some other block does not close the text block.
  assert.equal(spoken([start(0, 'text'), delta(0, 'Раз'), stop(3), delta(0, ' два.'), stop(0)]), 'Раз два. ')
})

test('anything not a stream event is ignored', () => {
  const join = createBlockJoin()
  for (const ev of [null, undefined, {}, { type: 'message_stop' }]) assert.equal(join(ev), null)
})

test('the asides from the page: checked, bounded, and only with an id', () => {
  for (const raw of [undefined, 42, 'текст', {}, [], [{ said: 'а', reply: 'б' }], [{ id: 'x', said: '  ', reply: 'б' }], [{ id: 5, said: 'а', reply: 'б' }]]) {
    assert.equal(asidesFrom(raw), null, JSON.stringify(raw))
  }
  assert.deepEqual(asidesFrom([{ id: 'k1', said: ' Который  час? ', reply: 'Девять.', extra: 'x' }]), [{ id: 'k1', said: 'Который час?', reply: 'Девять.' }])
  const many = asidesFrom(Array.from({ length: ASIDE_ITEMS + 5 }, (_, k) => ({ id: `k${k}`, said: 'x'.repeat(5000), reply: 'y' })))
  assert.equal(many.length, ASIDE_ITEMS)
  assert.equal(many[0].id, 'k5', 'the newest are kept')
  assert.equal(many[0].said.length, ASIDE_FIELD)
})

test('the ledger: an aside is handed to the session once, however often the page sends it', () => {
  const ledger = createAsideLedger()
  const a = { id: 'p-1', said: 'Который час?', reply: 'Девять.' }
  const b = { id: 'p-2', said: 'Что у меня сегодня?', reply: 'Две встречи.' }
  assert.deepEqual(ledger.fresh([a]), [a])
  ledger.delivered([a])
  // The turn failed after the model had it; the page sends it again with b.
  assert.deepEqual(ledger.fresh([a, b]), [b])
  ledger.delivered([b])
  assert.deepEqual(ledger.fresh([a, b]), [])
  // The same words again, asked again on purpose: a new id, so it goes in.
  const again = { ...a, id: 'p-3' }
  assert.deepEqual(ledger.fresh([again]), [again])
})

test('the ledger: not delivered is not recorded — a question superseded in the queue leaves its asides fresh', () => {
  const ledger = createAsideLedger()
  const a = { id: 'p-1', said: 'Который час?', reply: 'Девять.' }
  ledger.fresh([a])
  assert.deepEqual(ledger.fresh([a]), [a])
})

test('the ledger: a new connection is a new session, which has heard none of them', () => {
  const a = { id: 'p-1', said: 'Который час?', reply: 'Девять.' }
  const first = createAsideLedger()
  first.delivered([a])
  assert.deepEqual(createAsideLedger().fresh([a]), [a])
})

test('the ledger stays bounded', () => {
  const ledger = createAsideLedger(3)
  ledger.delivered([1, 2, 3, 4, 5].map((k) => ({ id: `p-${k}`, said: 's', reply: 'r' })))
  assert.equal(ledger.fresh([{ id: 'p-1', said: 's', reply: 'r' }]).length, 1, 'the oldest was forgotten')
  assert.equal(ledger.fresh([{ id: 'p-5', said: 's', reply: 'r' }]).length, 0)
})

test('the bridge words the note exactly as the page does', () => {
  const items = [{ id: 'p-1', said: 'Включи Queen', reply: 'Включаю Queen.' }]
  for (const lang of ['ru', 'en']) assert.equal(formatAsides(items, lang), pageFormat(items, lang))
})

test('the note goes before the question, and nothing is added without one', () => {
  assert.equal(withAside('А это что?', null), 'А это что?')
  assert.equal(withAside('А это что?', '(Служебно)'), '(Служебно)\n\nА это что?')
})
