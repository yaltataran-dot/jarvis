import { test } from 'node:test'
import assert from 'node:assert/strict'
import { asksToSee, NOT_ASKED_TO_SEE } from '../bridge/visual.mjs'
import { displayServer } from '../bridge/panels.mjs'

/**
 * The tools as the agent calls them, on a fake socket. `_registeredTools` is
 * the MCP SDK's own table of handlers — reached into here because the server
 * object offers no other way to call one without a transport.
 */
function rig(mayShow) {
  const blades = []
  const refused = []
  const server = displayServer(() => {}, (b) => blades.push(b), { mayShow, onRefused: (w) => refused.push(w) })
  const call = (name, args) => server.instance._registeredTools[name].handler(args, {})
  return { call, blades, refused }
}

const CARD = { title: 'ПОГОДА', html: '<div><span class="hud-metric">+9</span><span class="hud-unit">Москва</span></div>' }

test('a question asked to be answered is not a request to see anything', () => {
  for (const q of [
    'Глянь погоду в Москве.',
    'Какая погода завтра?',
    'А завтра там чё будет?',
    'Сколько стоит биткоин?',
    'Расскажи про VPS',
    'Найди, когда открывается музей',
    'Посмотри, что нового в новостях',
  ]) {
    assert.equal(asksToSee(q), false, q)
  }
})

test('asked to see it, by any of the usual words', () => {
  for (const q of [
    'Покажи погоду в Москве',
    'Покажи на экране погоду в Москве.',
    'Выведи это на экран',
    'Сделай таблицу тарифов',
    'Нарисуй график курса',
    'Отобрази список задач',
    'А можно наглядно?',
    'Show me the weather',
    'Put it on screen',
  ]) {
    assert.equal(asksToSee(q), true, q)
  }
})

test('unasked: display is refused, nothing reaches the screen, and the model is told not to retry', async () => {
  const r = rig(() => false)
  const res = await r.call('display', CARD)
  assert.equal(res.isError, true)
  assert.equal(res.content[0].text, NOT_ASKED_TO_SEE)
  assert.match(NOT_ASKED_TO_SEE, /Do not call display again/)
  assert.deepEqual(r.blades, [])
  assert.deepEqual(r.refused, ['display'])
})

test('unasked: a markup blade — the same panel by another door — is refused too', async () => {
  const r = rig(() => false)
  const res = await r.call('blade', { title: 'ПОГОДА', kind: 'markup', html: CARD.html })
  assert.equal(res.isError, true)
  assert.deepEqual(r.blades, [])
  assert.deepEqual(r.refused, ['blade:markup'])
})

test('unasked: a blade of its own kind — the camera, a picture they named — is not judged here', async () => {
  const r = rig(() => false)
  const res = await r.call('blade', { title: 'КАМЕРА', kind: 'camera' })
  assert.notEqual(res.isError, true)
  assert.equal(r.blades.length, 1)
  assert.deepEqual(r.refused, [])
})

test('asked to see: the panel goes up, once per call', async () => {
  const r = rig(() => true)
  const res = await r.call('display', CARD)
  assert.notEqual(res.isError, true)
  assert.equal(r.blades.length, 1)
  assert.equal(r.blades[0].kind, 'markup')
  assert.deepEqual(r.refused, [])
})

test('the verdict is read at the call, so it follows the turn in flight', async () => {
  let asked = false
  const r = rig(() => asked)
  await r.call('display', CARD)
  asked = true
  await r.call('display', CARD)
  asked = false
  await r.call('display', CARD)
  assert.equal(r.blades.length, 1)
  assert.deepEqual(r.refused, ['display', 'display'])
})

test('with no gate given, display behaves as before', async () => {
  const blades = []
  const server = displayServer(() => {}, (b) => blades.push(b))
  await server.instance._registeredTools.display.handler(CARD, {})
  assert.equal(blades.length, 1)
})
