import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createSessionInput } from '../bridge/sessionInput.mjs'
import { createSocketState } from '../bridge/socketState.mjs'
import { effortFor } from '../bridge/effort.mjs'
import { formatAsides, withAside } from '../bridge/turnText.mjs'
import { asksToSee } from '../bridge/visual.mjs'

/**
 * What goes into one socket's session (bridge/sessionInput.mjs), moved out of
 * server.mjs unchanged, on a stand-in session and Chrome check. The same code
 * through the real connection handler: tests/sessionCore.test.mjs.
 */

const NOTE_RU = '\n\n(Служебно, не озвучивать: браузер пользователя сейчас недоступен — chrome_* не вызывай, для фактов используй WebSearch.)'
const NOTE_EN = "\n\n(System note, not to be spoken: the user's browser is unavailable right now — do not call chrome_*; use WebSearch for facts.)"

/** A socket's state with a stand-in session, and the input built on it; `log` records effort changes and frames in order. */
function rig({ routeEffort = true, lang = 'ru', chrome = async () => true, apply = async () => {} } = {}) {
  const s = createSocketState({ effort: 'medium', account: 'primary' })
  const log = []
  s.session = {
    applyFlagSettings: async (o) => {
      log.push(['apply', o.effortLevel])
      await apply(o)
    },
  }
  const userMessages = createSessionInput({
    s,
    sendTurn: (f) => log.push(['frame', f]),
    knowledge: { kb: null },
    lang,
    routeEffort,
    trace: false,
    chromeAvailable: chrome,
  })
  return { s, log, it: userMessages(s.chan) }
}

const user = (content) => ({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null })

test('a question goes in after its effort is set, with the effort frame just before it', async () => {
  const { s, log, it } = rig()
  const text = 'Сравни подробно три тарифа и объясни, какой выгоднее'
  const want = effortFor(text)
  assert.notEqual(want, 'medium', 'a question that changes the effort')
  s.chan.put({ text })
  assert.deepEqual((await it.next()).value, user(text))
  assert.deepEqual(log, [['apply', want], ['frame', { type: 'effort', level: want }]])
  assert.equal(s.sessionEffort, want)
})

test('the same effort is not set again; with routing off it is never set, and the frame says the session\'s', async () => {
  const same = rig()
  same.s.sessionEffort = effortFor('Привет')
  same.s.chan.put({ text: 'Привет' })
  await same.it.next()
  assert.deepEqual(same.log, [['frame', { type: 'effort', level: same.s.sessionEffort }]])

  const off = rig({ routeEffort: false })
  off.s.chan.put({ text: 'Сравни подробно три тарифа и объясни, какой выгоднее' })
  await off.it.next()
  assert.deepEqual(off.log, [['frame', { type: 'effort', level: 'medium' }]])
})

test('an effort the session refuses is not fatal: the question still goes in, on the effort it had', async () => {
  const { s, log, it } = rig({ apply: async () => { throw new Error('no') } })
  const text = 'Сравни подробно три тарифа и объясни, какой выгоднее'
  s.chan.put({ text })
  assert.deepEqual((await it.next()).value, user(text))
  assert.equal(s.sessionEffort, 'medium')
  assert.deepEqual(log.at(-1), ['frame', { type: 'effort', level: effortFor(text) }], 'the frame says how the question was sorted')
})

test('asides go in once: fresh ones with the question, the ones the session has had never again', async () => {
  const { s, it } = rig()
  const a = { id: 'a', said: 'Который час?', reply: 'Четыре двадцать.' }
  const b = { id: 'b', said: 'Какое число?', reply: 'Девятнадцатое.' }
  s.chan.put({ text: 'А погода?', asides: [a] })
  assert.deepEqual((await it.next()).value, user(withAside('А погода?', formatAsides([a], 'ru'))))
  s.chan.put({ text: 'А завтра?', asides: [a, b] })
  assert.deepEqual((await it.next()).value, user(withAside('А завтра?', formatAsides([b], 'ru'))))
  s.chan.put({ text: 'Спасибо', asides: [a, b] })
  assert.deepEqual((await it.next()).value, user('Спасибо'))
})

test('asides are recorded at the hand-over, not before', async () => {
  const { s, it } = rig({ chrome: () => new Promise(() => {}) })
  const a = { id: 'a', said: 's', reply: 'r' }
  s.chan.put({ text: 'Привет', asides: [a] })
  void it.next()
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(s.asideLedger.fresh([a]), [a], 'still fresh while the question waits')
})

test('a line for the model when Chrome is down or its check fails, in the bridge\'s language', async () => {
  for (const [chrome, lang, note] of [
    [async () => false, 'ru', NOTE_RU],
    [async () => { throw new Error('x') }, 'ru', NOTE_RU],
    [async () => false, 'en', NOTE_EN],
    [async () => true, 'en', ''],
  ]) {
    const { s, it } = rig({ chrome, lang })
    s.chan.put({ text: 'Найди новости' })
    assert.deepEqual((await it.next()).value, user('Найди новости' + note))
  }
})

test('the question sets whether it may show a panel, and the latency record gets the effort and the time sent', async () => {
  const { s, it } = rig({ routeEffort: false })
  s.lat = { effort: null, sent: 0 }
  const text = 'Покажи мне фото Эльбруса'
  s.chan.put({ text })
  await it.next()
  assert.equal(s.turnMayShow, asksToSee(text))
  assert.equal(s.lat.effort, 'medium')
  assert.ok(s.lat.sent > 0)
})

test('it ends with its inbox or its socket, and a waiting read ends on the close', async () => {
  const closedInbox = rig()
  closedInbox.s.chan.put({ text: 'Привет' })
  closedInbox.s.chan.close()
  assert.equal((await closedInbox.it.next()).done, true, 'a closed inbox hands nothing more')

  const closedSocket = rig()
  closedSocket.s.chan.put({ text: 'Привет' })
  closedSocket.s.closed = true
  assert.equal((await closedSocket.it.next()).done, true)

  const waiting = rig()
  const pending = waiting.it.next()
  waiting.s.chan.close()
  assert.equal((await pending).done, true)
  assert.deepEqual(waiting.log, [])
})

test('server.mjs builds it per connection with the bridge\'s values and opens each session on the socket\'s inbox', () => {
  const server = readFileSync(new URL('../bridge/server.mjs', import.meta.url), 'utf8').replace(/\r/g, '')
  assert.match(
    server,
    /const userMessages = createSessionInput\(\{\n {4}s,\n {4}sendTurn,\n {4}knowledge: KNOWLEDGE,\n {4}lang: LANG,\n {4}routeEffort: ROUTE_EFFORT,\n {4}trace: TRACE,\n {4}chromeAvailable,\n {2}\}\)/,
  )
  assert.equal(server.match(/createSessionInput\(/g)?.length, 1)
  assert.match(server, /prompt: userMessages\(s\.chan\),/)
  assert.ok(server.indexOf('const userMessages = createSessionInput(') < server.indexOf('} = createSessionLifecycle({'), 'made before the lifecycle that opens sessions on it')
  assert.doesNotMatch(server, /tuneFor|browserNote|async function\* userMessages/)
})
