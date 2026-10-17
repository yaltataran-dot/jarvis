import { test } from 'node:test'
import assert from 'node:assert/strict'
import { routePhrase } from '../src/lib/turnRoute.ts'
import { createCalendarFlow, type CalApi, type CalEvent } from '../src/lib/calendarFlow.ts'
import { parseCalendarCommand } from '../src/lib/calendarIntent.ts'
import { parseMusicCommand, type MusicIntent } from '../src/lib/musicIntent.ts'
import { createFloor, type FloorSpeaker } from '../src/lib/floor.ts'
import { localAnswer, localKind } from '../src/lib/localAnswer.ts'
import { createAsides, formatAsides, ASIDE_CHARS, ASIDE_MAX, ASIDE_TTL_MS } from '../src/lib/aside.ts'
import { takeSentences } from '../src/lib/sentences.ts'
// @ts-expect-error — a plain .mjs module of the bridge, no types
import { effortFor } from '../bridge/effort.mjs'
// @ts-expect-error — a plain .mjs module of the bridge, no types
import { createAsideLedger, formatAsides as bridgeFormat } from '../bridge/turnText.mjs'

/**
 * A conversation through App.respond as it now runs: the real routing, the real
 * calendar flow on a calendar in memory, the real music parser, the page's own
 * answers — and a model that records what it is asked and with which note of
 * what the page answered by itself (aside.ts). Nothing here reaches a real
 * calendar, player or model.
 */
const BATONI: CalEvent = {
  id: 'a1',
  etag: '"e1"',
  summary: 'Встреча',
  location: 'ресторан Батони',
  start: '2026-10-14T18:00:00+03:00',
  end: '2026-10-14T19:00:00+03:00',
}

/**
 * How a model turn fails: 'before' it reached the model (the usage limit, held
 * off at the bridge; a socket that would not open) or 'after' (the API failed
 * mid-answer — the session already has the question and its note).
 */
type Failure = 'before' | 'after' | null

function rig(o: { modelFails?: () => Failure; during?: () => void } = {}) {
  const writes: string[] = []
  const api: CalApi = {
    status: async () => ({ connected: true, writes: true, timeZone: 'Europe/Moscow' }),
    list: async () => ({ code: 'ok', events: [{ ...BATONI }] }),
    create: async (e) => {
      writes.push('create')
      return { code: 'ok', event: { id: `jarvis${e.opId}`, summary: e.summary, start: '', end: '' } }
    },
    update: async () => {
      writes.push('update')
      return { code: 'ok', event: { ...BATONI } }
    },
    remove: async () => {
      writes.push('remove')
      return { code: 'ok' }
    },
  }
  let n = 0
  const flow = createCalendarFlow({ api, now: () => new Date('2026-10-14T15:36:00+03:00'), opId: () => `op${++n}` })
  const floor = createFloor<FloorSpeaker>({ interrupt: () => {} })
  const asides = createAsides('ru')
  /** The bridge's side: which asides the session has had (server.mjs, userMessages). */
  const ledger = createAsideLedger()
  const asked: Array<{ said: string; context: string | null }> = []
  const replies: string[] = []
  const music: MusicIntent[] = []

  /** App.respond, from floor.begin to the model, in the same order. */
  const say = async (said: string) => {
    const t = floor.begin('utterance')
    const route = await routePhrase(said, {
      calendarWaiting: () => flow.waiting(),
      calendar: async (p) => {
        const r = await flow.handle(p)
        if (!r) return false
        replies.push(r.say)
        asides.add(p, r.say)
        if (r.readBack) flow.heard(r.readBack)
        return true
      },
      music: (p) => parseMusicCommand(p, { inMusic: true }),
      playMusic: async (c) => {
        music.push(c)
        asides.add(said, 'Включаю.')
      },
      stale: t.stale,
      local: (p) => localAnswer(p, { now: new Date(2026, 9, 14, 15, 36), voice: 'Руслан (Piper)', connected: true }),
      sayLocal: async (a) => {
        replies.push(a)
        asides.add(said, a)
      },
    })
    if (route === 'model') {
      // App.respond: what the page sends with the question.
      const sent = asides.pending()
      try {
        await t.ask(async () => {
          const failure = o.modelFails?.() ?? null
          if (failure === 'before') throw new Error('429, held at the bridge')
          // The bridge, at the hand-over: only what the session lacks.
          const fresh = ledger.fresh(sent)
          ledger.delivered(fresh)
          asked.push({ said, context: fresh.length ? bridgeFormat(fresh, 'ru') : null })
          o.during?.()
          if (failure === 'after') throw new Error('API failed mid-answer')
        })
        // App.respond: these went in with this question.
        asides.drop(sent.map((a) => a.id))
      } catch {
        // App.respond: a failed turn keeps them; the bridge drops any repeat.
      }
    }
    return route
  }
  const asks = () => floor.events().filter((e) => e.step === 'ask:start').length
  return { say, flow, writes, asked, replies, music, asks, asides }
}

const FOLLOW_UPS = [
  'А какой лучше для моего проекта?',
  'А почему?',
  'Объясни проще.',
  'Сделай короче.',
  'А теперь сравни.',
  'Сколько это стоит?',
  'Давай второй вариант.',
  'Нет, я другое имел в виду.',
  'Вернись к предыдущей теме.',
  'Напомни, что мы решили.',
  'А завтра там чё будет?',
  'Верни предыдущий вариант.',
]

test('1, 2, 3, 4. an ordinary question and every follow-up, clarification and correction go to the model, once each, in order', async () => {
  const r = rig()
  assert.equal(await r.say('Расскажи про VPS'), 'model')
  for (const said of FOLLOW_UPS) assert.equal(await r.say(said), 'model', said)
  assert.deepEqual(
    r.asked.map((a) => a.said),
    ['Расскажи про VPS', ...FOLLOW_UPS],
  )
  assert.equal(r.asks(), FOLLOW_UPS.length + 1, 'one model ask per phrase')
  assert.deepEqual(r.writes, [], 'nothing written')
  assert.deepEqual(r.music, [], 'nothing played')
  assert.deepEqual(r.replies, [], 'nothing answered by the page in its place')
})

test('4. "напомни, что мы решили" is a question about the conversation, not a calendar reminder', () => {
  const c = { now: { date: { y: 2026, m: 10, d: 16 }, h: 12, min: 0 }, today: { y: 2026, m: 10, d: 16 } } as const
  for (const said of [
    'Напомни, что мы решили.',
    'Напомни, о чём мы говорили',
    'Напомни мне, как его зовут',
    'Напомни, пожалуйста, что я просил',
    'Напомни, сколько это стоило',
  ]) {
    assert.equal(parseCalendarCommand(said, c as never), null, said)
  }
  // A reminder with a time stays one — it is still read back for a yes.
  for (const said of ['Напомни мне завтра позвонить маме', 'Напомни завтра в 10, что нужно купить хлеб', 'Напомни купить хлеб']) {
    assert.equal(parseCalendarCommand(said, c as never)?.action, 'create', said)
  }
})

test('9, 14. colloquial questions about the time and date are answered by the page, with no model', async () => {
  const r = rig()
  for (const said of [
    'Сколько время?',
    'Слушай, который час?',
    'А который час?',
    'Ну а сколько сейчас времени',
    'Который час сейчас',
    'Время сколько?',
    'Джарвис, а сколько время?',
    'Скажи-ка, который час',
    'Сколько на часах?',
  ]) {
    assert.equal(localKind(said), 'time', said)
    assert.equal(await r.say(said), 'local', said)
  }
  for (const said of ['Сегодня какое число?', 'Эм, какое сегодня число', 'Ну и какой сегодня день недели']) {
    assert.equal(localKind(said), 'date', said)
  }
  assert.equal(r.asks(), 0, 'no model ask')
  assert.ok(r.replies.every((a) => a === 'Пятнадцать тридцать шесть.'))
})

test('14. a filler in front does not widen what the page answers: anything more still goes to the model', () => {
  for (const said of [
    'Слушай, который час в Токио?',
    'А сколько времени ехать до Краснодара?',
    'Ну а что у меня сегодня?',
    'А завтра там чё будет?',
    'Эм, а сколько это стоит?',
  ]) {
    assert.equal(localKind(said), null, said)
  }
})

test('2. what the page answered by itself reaches the next model turn, once', async () => {
  const r = rig()
  assert.equal(await r.say('Который час?'), 'local')
  assert.equal(await r.say('Что у меня сегодня?'), 'calendar')
  assert.equal(await r.say('А это надолго?'), 'model')
  const note = r.asked[0].context!
  assert.match(note, /^\(Служебно, не озвучивать\./)
  assert.match(note, /«Который час\?»\. Ты: «Пятнадцать тридцать шесть\.»/)
  assert.match(note, /«Что у меня сегодня\?»/)
  // Oldest first, as it was said.
  assert.ok(note.indexOf('Который час') < note.indexOf('Что у меня сегодня'))
  // Handed over once: the next question carries nothing.
  assert.equal(await r.say('А почему?'), 'model')
  assert.equal(r.asked[1].context, null)
})

test('5. two questions in a row: the second carries no note the first already took', async () => {
  const r = rig()
  await r.say('Сколько время?')
  await r.say('Расскажи про VPS')
  await r.say('А какой лучше?')
  assert.ok(r.asked[0].context)
  assert.equal(r.asked[1].context, null)
})

test('7. a turn that fails before the model (the usage limit) keeps the note for the next one', async () => {
  let fail: Failure = 'before'
  const r = rig({ modelFails: () => fail })
  await r.say('Который час?')
  await r.say('А сколько осталось до вечера?')
  assert.equal(r.asked.length, 0, 'the model was never reached')
  fail = null
  await r.say('А сколько осталось до вечера?')
  assert.match(r.asked[0].context ?? '', /Который час/, 'not lost')
  await r.say('Понятно, а почему?')
  assert.equal(r.asked[1].context, null, 'and then not again')
})

test('7. a turn that fails after the model had it: the page sends the note again, the session gets it once', async () => {
  let fail: Failure = 'after'
  const r = rig({ modelFails: () => fail })
  await r.say('Который час?')
  await r.say('А сколько осталось до вечера?')
  assert.match(r.asked[0].context ?? '', /Который час/)
  assert.equal(r.asides.size(), 1, 'the page could not know, so it kept it')
  fail = null
  await r.say('А сколько осталось до вечера?')
  assert.equal(r.asked[1].context, null, 'already in the session: not said twice')
  assert.equal(r.asides.size(), 0)
})

test('7. after such a failure a new exchange still goes in — and the same words asked again on purpose are new', async () => {
  let fail: Failure = 'after'
  const r = rig({ modelFails: () => fail })
  await r.say('Который час?')
  await r.say('Расскажи про VPS')
  fail = null
  await r.say('Который час?')
  await r.say('А что ещё?')
  const note = r.asked[1].context ?? ''
  assert.equal(note.match(/Который час/g)?.length, 1, 'the new exchange, once — the old one is not repeated')
})

test('5, 8. a page answer given while a model turn ran is not lost when that turn comes back', async () => {
  const r = rig({ during: () => r.asides.add('Сколько время?', 'Пятнадцать тридцать шесть.') })
  await r.say('Расскажи про VPS')
  assert.equal(r.asides.size(), 1, 'the one added meanwhile is still to go')
})

test('6. the note is bounded: the last few exchanges, each cut short, none from an earlier conversation', () => {
  let now = 0
  const a = createAsides('ru', () => now)
  for (let k = 0; k < ASIDE_MAX + 3; k++) a.add(`вопрос ${k}`, `ответ ${k}`)
  assert.equal(a.size(), ASIDE_MAX)
  assert.doesNotMatch(a.note()!, /вопрос 0/)
  assert.equal(new Set(a.pending().map((x) => x.id)).size, ASIDE_MAX, 'every exchange its own id')
  assert.match(a.note()!, new RegExp(`вопрос ${ASIDE_MAX + 2}`))

  a.drop(a.pending().map((x) => x.id))
  a.add('x'.repeat(5000), 'y'.repeat(5000))
  const note = a.note()!
  assert.ok(note.length < 2 * ASIDE_CHARS + 200, `note is ${note.length} chars`)

  a.drop(a.pending().map((x) => x.id))
  a.add('Который час?', 'Пятнадцать ноль-ноль.')
  now += ASIDE_TTL_MS
  assert.equal(a.note(), null, 'ten minutes on, it is another conversation')

  // Nothing said, nothing kept.
  a.add('', 'ответ')
  a.add('вопрос', '  ')
  assert.equal(a.size(), 0)
})

test('the note in English, for the English persona', () => {
  assert.match(formatAsides([{ said: 'What time is it?', reply: 'Four twenty.' }], 'en'), /^\(System note, not to be spoken\./)
})

test('8. a stop ends the turn; the next question still reaches the model, with the page-answered context intact', async () => {
  const r = rig()
  await r.say('Который час?')
  assert.equal(await r.say('Стоп, отмена.'), 'stop')
  assert.equal(r.asks(), 0)
  assert.equal(await r.say('А что у нас по погоде?'), 'model')
  assert.ok(r.asked[0].context, 'a stop is not a model turn and does not consume the note')
})

test('11. no conversational phrase writes to the calendar or starts a read-back', async () => {
  const r = rig()
  for (const said of [
    'Напомни, что мы решили.',
    'Нет, я другое имел в виду.',
    'Верни предыдущий вариант.',
    'Давай второй вариант.',
    'Вернись к предыдущей теме.',
    'Сделай короче.',
    'Удали это',
    'Отмени всё',
  ]) {
    await r.say(said)
    assert.equal(r.flow.waiting(), false, `${said}: no question waiting for a yes`)
  }
  assert.deepEqual(r.writes, [])
})

test('11. a read-back answered with a correction is refused, never written', async () => {
  const r = rig()
  assert.equal(await r.say('Запиши встречу завтра в 15:00'), 'calendar')
  assert.equal(r.flow.waiting(), true)
  await r.say('Нет, я другое имел в виду.')
  assert.deepEqual(r.writes, [])
  assert.equal(await r.say('Да'), 'model', 'a yes after the refusal confirms nothing')
  assert.deepEqual(r.writes, [])
})

test('14. a reworded answer is not thought through again; a new question behind a filler still is', () => {
  for (const q of ['Объясни проще.', 'Сделай короче.', 'А можно чуть попроще?', 'Объясни простыми словами.', 'Скажи другими словами']) {
    assert.equal(effortFor(q), 'low', q)
  }
  assert.equal(effortFor('Короче, сравни три тарифа'), 'high')
  assert.equal(effortFor('Объясни простыми словами, что такое квантовая запутанность'), 'high')
  assert.equal(effortFor('Скажи короче, какая погода сегодня'), 'medium')
  assert.equal(effortFor('А почему?'), 'high')
})

test('12. an answer split around a tool is spoken as separate sentences, the first before the tool runs', () => {
  // What the bridge now sends: the first block, the space it closes with, then
  // (after the tool) the second block.
  const first = takeSentences('Плюс девять, пасмурно. Днём до пятнадцати, без осадков.' + ' ')
  assert.deepEqual(first.sentences, ['Плюс девять, пасмурно. ', 'Днём до пятнадцати, без осадков. '])
  assert.equal(first.rest, '')
  // Without the space the last sentence waited for the next block.
  assert.equal(takeSentences('Плюс девять, пасмурно. Днём до пятнадцати, без осадков.').rest, 'Днём до пятнадцати, без осадков.')
})
