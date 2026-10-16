import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFloor, StaleTurn, type FloorSpeaker, type Turn } from '../src/lib/floor.ts'

/**
 * The floor with everything around it faked: speakers that record what they
 * were given and play until the test says they have finished, and a brain
 * whose answers arrive when the test says so. `audible()` is what is coming
 * out of the speakers at that moment — the thing that must never be two.
 */
type Fake = FloorSpeaker & {
  label: string
  said: string[]
  /** Every push and say that reached it, played or not. */
  received: number
  cancelled: boolean
  finished: boolean
  finish: () => void
}

function rig(o: { brainStops?: boolean } = {}) {
  const made: Fake[] = []
  let maxAudible = 0
  const audible = () => made.filter((s) => s.said.length && !s.cancelled && !s.finished)
  const note = () => (maxAudible = Math.max(maxAudible, audible().length))

  const speaker = (label: string) => (): Fake => {
    let resolveEnd: (() => void) | null = null
    let ending = false
    const s: Fake = {
      label,
      said: [],
      received: 0,
      cancelled: false,
      finished: false,
      push: (d) => {
        s.received++
        if (!s.cancelled && !s.finished) s.said.push(d)
        note()
      },
      say: (t) => {
        s.received++
        if (!s.cancelled && !s.finished) s.said.push(t)
        note()
      },
      end: () =>
        new Promise<void>((r) => {
          ending = true
          if (s.cancelled || s.finished) return r()
          resolveEnd = r
        }),
      cancel: () => {
        s.cancelled = true
        resolveEnd?.()
      },
      level: () => 0,
      finish: () => {
        s.finished = true
        if (ending) resolveEnd?.()
      },
    }
    made.push(s)
    return s
  }

  // The brain: questions answered, failed or interrupted from the test.
  type Q = { prompt: string; answer: (text: string) => void; fail: (e: Error) => void; settled: boolean }
  const questions: Q[] = []
  let interrupts = 0
  const ask = (prompt: string) =>
    new Promise<{ text: string }>((resolve, reject) => {
      const q: Q = {
        prompt,
        settled: false,
        answer: (text) => {
          if (q.settled) return
          q.settled = true
          resolve({ text })
        },
        fail: (e) => {
          if (q.settled) return
          q.settled = true
          reject(e)
        },
      }
      questions.push(q)
    })
  const floor = createFloor<Fake>({
    interrupt: () => {
      interrupts++
      // As bridge.ts does: the question in flight settles at once, with
      // nothing. A brain that does not stop leaves it to answer late.
      if (o.brainStops !== false) for (const q of questions) q.answer('')
    },
  })

  /**
   * One turn as App.tsx runs it: begin, ask, speak the answer, wait for the
   * end, give the floor back — checking stale() after every await.
   */
  const respond = async (prompt: string, log: string[]) => {
    const t: Turn<Fake> = floor.begin('utterance')
    try {
      const { text } = await t.ask(() => ask(prompt))
      if (t.stale()) return log.push(`${prompt}:stale-after-ask`)
      const spk = t.speaker(speaker(prompt))
      spk.push(text)
      await spk.end()
      if (t.stale()) return log.push(`${prompt}:stale-after-speech`)
      t.release(spk)
      log.push(`${prompt}:done`)
    } catch (err) {
      if (t.stale()) return log.push(`${prompt}:stale-error`)
      log.push(`${prompt}:error:${(err as Error).message}`)
    }
  }

  return { floor, made, audible, maxAudible: () => maxAudible, questions, interrupts: () => interrupts, respond, speaker }
}

const tick = () => new Promise((r) => setImmediate(r))
const steps = (f: { events: () => Array<{ turn: number; step: string }> }) => f.events().map((e) => `${e.turn}:${e.step}`)

test('one question: one turn, one question to the brain, one answer spoken once', async () => {
  const r = rig()
  const log: string[] = []
  const done = r.respond('Какая погода?', log)
  await tick()
  assert.equal(r.floor.asking(), true)
  assert.equal(r.questions.length, 1)
  r.questions[0].answer('Солнечно.')
  await tick()
  assert.equal(r.audible().length, 1)
  r.made[0].finish()
  await done
  assert.deepEqual(log, ['Какая погода?:done'])
  assert.equal(r.questions.length, 1, 'asked once')
  assert.equal(r.made.length, 1, 'one speaker')
  assert.deepEqual(r.made[0].said, ['Солнечно.'], 'spoken once')
  assert.equal(r.floor.turn(), 1)
  assert.equal(r.floor.current(), null, 'the floor is free again')
  assert.equal(r.floor.asking(), false)
  assert.equal(r.floor.live(), 0)
  assert.equal(r.interrupts(), 0)
})

test('"стоп" while he speaks: the voice is cut at once and the rest of the answer never plays', async () => {
  const r = rig()
  const log: string[] = []
  const t = r.floor.begin('utterance')
  const spk = t.speaker(r.speaker('answer'))
  spk.push('Первое предложение.')
  assert.equal(r.audible().length, 1)
  // What App.onSpeechStart does on a barge-in.
  r.floor.supersede('barge-in')
  assert.equal(r.made[0].cancelled, true, 'cut in the same tick, not after the sentence')
  assert.equal(r.audible().length, 0)
  // The rest of the stream still arriving from the old turn has nowhere to go.
  spk.push('Хвост ответа.')
  t.speaker(r.speaker('late')).push('И ещё.')
  assert.deepEqual(r.made[0].said, ['Первое предложение.'])
  assert.equal(r.made.length, 1, 'no speaker made for a stopped turn')
  assert.equal(t.stale(), true)
  assert.equal(log.length, 0)
})

test('a new question while he speaks: the old voice stops before the new one starts', async () => {
  const r = rig()
  const log: string[] = []
  const a = r.respond('длинный', log)
  await tick()
  r.questions[0].answer('Очень длинный ответ.')
  await tick()
  assert.equal(r.audible().length, 1)
  const b = r.respond('новый', log)
  assert.equal(r.made[0].cancelled, true, 'the old answer was cut off by the new turn itself')
  await a
  r.questions[1].answer('Новый ответ.')
  await tick()
  assert.deepEqual(r.audible().map((s) => s.label), ['новый'])
  r.made[1].finish()
  await b
  assert.deepEqual(log, ['длинный:stale-after-speech', 'новый:done'])
  assert.equal(r.maxAudible(), 1, 'never two voices at once')
  assert.equal(r.floor.live(), 0)
})

test('two quick questions: the first is interrupted on the bridge, only the second is spoken', async () => {
  const r = rig()
  const log: string[] = []
  const a = r.respond('первый', log)
  await tick()
  const b = r.respond('второй', log)
  await tick()
  assert.equal(r.interrupts(), 1, 'the first question interrupted, once')
  await a
  r.questions[1].answer('Ответ на второй.')
  await tick()
  r.made[0].finish()
  await b
  assert.deepEqual(log, ['первый:stale-after-ask', 'второй:done'])
  assert.equal(r.made.length, 1, 'no speaker was ever made for the first')
  assert.deepEqual(r.made[0].said, ['Ответ на второй.'])
})

test('Escape while he waits for the answer: the bridge is interrupted, and the late answer says nothing', async () => {
  // A brain that does not stop when told: its answer still comes back.
  const r = rig({ brainStops: false })
  const log: string[] = []
  const a = r.respond('вопрос', log)
  await tick()
  assert.equal(r.floor.asking(), true)
  // What App.goDormant('escape') does.
  r.floor.supersede('escape')
  assert.equal(r.interrupts(), 1, 'interrupt sent to the bridge')
  assert.equal(r.floor.asking(), false)
  r.questions[0].answer('Поздний ответ.')
  await a
  assert.deepEqual(log, ['вопрос:stale-after-ask'])
  assert.equal(r.made.length, 0, 'nothing was spoken')
  assert.equal(r.floor.current(), null)
  // A second Escape has nothing left to interrupt.
  r.floor.supersede('escape')
  assert.equal(r.interrupts(), 1)
})

test('stop mid-answer while the answer is still streaming: the queue goes, the stream goes nowhere, recorded once', async () => {
  const r = rig()
  const log: string[] = []
  const p = r.respond('длинный', log)
  await tick()
  r.questions[0].answer('Первое предложение.')
  await tick()
  const spk = r.made[0]
  const answer = r.floor.current()!
  r.floor.supersede('barge-in')
  assert.equal(spk.cancelled, true, 'the sound itself stopped')
  // The model keeps streaming the old answer for a moment.
  for (const w of ['Второе', ' предложение.', ' Третье.']) answer.push(w)
  answer.say('Минуту, сэр.')
  await p
  assert.deepEqual(spk.said, ['Первое предложение.'], 'nothing more was played')
  assert.equal(spk.received, 1, 'nor even handed to the speaker')
  const steps = r.floor.events().map((e) => e.step)
  assert.equal(steps.filter((s) => s === 'speak:late').length, 1, 'the late stream recorded once, not per word')
  assert.deepEqual(
    steps.filter((s) => ['speak:cut', 'turn:superseded', 'speak:late'].includes(s)),
    ['speak:cut', 'turn:superseded', 'speak:late'],
  )
  assert.equal(r.floor.current(), null)
  assert.equal(r.floor.asking(), false)
  assert.deepEqual(log, ['длинный:stale-after-speech'])
})

test('a stale turn never reaches the brain, and its speaker is a silent one', async () => {
  const r = rig()
  const t = r.floor.begin('utterance')
  r.floor.supersede('escape')
  let ran = false
  await assert.rejects(
    t.ask(async () => {
      ran = true
      return 1
    }),
    StaleTurn,
  )
  assert.equal(ran, false)
  t.speaker(r.speaker('forgetful')).push('Это не должно прозвучать.')
  assert.equal(r.made.length, 0)
})

test('a greeting is cut off by the turn that follows it', async () => {
  const r = rig()
  const greeting = r.floor.claim(r.speaker('attention'), 'attention')
  greeting.say('Да, сэр?')
  const t = r.floor.begin('utterance')
  t.speaker(r.speaker('answer')).push('Слушаю.')
  assert.equal(r.made[0].cancelled, true)
  assert.equal(r.maxAudible(), 1)
  assert.equal(r.floor.release(greeting), false, 'the greeting no longer holds the floor')
})

test('two voices outside any turn — "Да, сэр?" then the V demo — never play together', async () => {
  const r = rig()
  r.floor.claim(r.speaker('attention'), 'attention').say('Да, сэр?')
  r.floor.claim(r.speaker('voice-demo'), 'voice-demo').say('Голос: Руслан.')
  assert.equal(r.made[0].cancelled, true)
  assert.deepEqual(r.audible().map((s) => s.label), ['voice-demo'])
  assert.equal(r.maxAudible(), 1)
  assert.equal(r.floor.live(), 1)
  assert.equal(r.floor.events().some((e) => e.step === 'overlap'), false)
})

test('a turn that fails after its filler started: the filler is cut when the turn gives up the floor', async () => {
  const r = rig()
  const t = r.floor.begin('utterance')
  const spk = t.speaker(r.speaker('answer'))
  spk.say('Минуту, сэр.') // the tool filler, still playing
  // The question fails; App's finally gives the floor back without end().
  assert.equal(t.release(spk), true)
  assert.equal(r.made[0].cancelled, true, 'not left sounding off the floor')
  assert.equal(r.floor.live(), 0)
  // So the next voice is the only one.
  r.floor.begin('utterance').speaker(r.speaker('next')).push('Следующий ответ.')
  assert.equal(r.maxAudible(), 1)
  assert.equal(r.floor.stats().overlaps, 0)
  assert.equal(r.floor.stats().maxLive, 1)
})

test('the session counts do not roll off with the event window', async () => {
  const r = rig()
  const log: string[] = []
  for (let i = 0; i < 120; i++) {
    const p = r.respond(`вопрос ${i}`, log)
    await tick()
    r.questions[i].answer(`Ответ ${i}.`)
    await tick()
    if (i % 2) {
      r.made.at(-1)!.finish() // heard to the end
    } else {
      r.floor.supersede('barge-in') // cut off
    }
    await p
  }
  assert.ok(r.floor.events().length <= 300, 'the window is bounded')
  assert.equal(r.floor.events()[0].turn > 1, true, 'and has rolled past the first turns')
  const s = r.floor.stats()
  assert.equal(s.turns, 120)
  assert.equal(s.superseded, 60)
  assert.equal(s.speakers, 120)
  assert.equal(s.maxLive, 1, 'never two at once, over the whole session')
  assert.equal(s.overlaps, 0)
  assert.equal(r.maxAudible(), 1)
})

test('a repeated end, or a cancel after the end, records one end and starts nothing', async () => {
  const r = rig()
  const t = r.floor.begin('utterance')
  const spk = t.speaker(r.speaker('once'))
  spk.push('Готово.')
  r.made[0].finish()
  await spk.end()
  await spk.end()
  spk.cancel()
  assert.equal(r.floor.live(), 0)
  assert.equal(t.release(spk), true)
  assert.equal(t.release(spk), false)
  assert.equal(r.floor.events().filter((e) => e.step === 'speak:end').length, 1)
  assert.equal(r.floor.turn(), 1)
})

test('the bridge drops mid-question: the turn fails once, nothing is retried, the next turn starts clean', async () => {
  const r = rig()
  const log: string[] = []
  const a = r.respond('до обрыва', log)
  await tick()
  r.questions[0].fail(new Error('Связь с мостом прервалась посреди ответа.'))
  await a
  assert.deepEqual(log, ['до обрыва:error:Связь с мостом прервалась посреди ответа.'])
  assert.equal(r.floor.asking(), false)
  assert.equal(r.questions.length, 1, 'not asked again')
  const b = r.respond('после', log)
  await tick()
  assert.equal(r.interrupts(), 0, 'nothing left in flight to interrupt')
  r.questions[1].answer('Снова на связи.')
  await tick()
  r.made[0].finish()
  await b
  assert.equal(log.at(-1), 'после:done')
  assert.equal(r.made.length, 1)
})

test('every event carries the turn it belongs to, and there is never an overlap', async () => {
  const r = rig()
  const log: string[] = []
  const a = r.respond('один', log)
  await tick()
  const b = r.respond('два', log)
  await tick()
  await a
  r.questions[1].answer('Два.')
  await tick()
  r.made[0].finish()
  await b
  const c = r.respond('три', log)
  await tick()
  r.questions[2].answer('Три.')
  await tick()
  const d = r.respond('четыре', log) // over the answer to "три"
  await c
  r.questions[3].answer('Четыре.')
  await tick()
  r.made[2].finish()
  await d
  assert.deepEqual(steps(r.floor), [
    '1:turn:begin',
    '1:ask:start',
    '1:ask:interrupt',
    '2:turn:begin',
    '2:ask:start',
    '2:ask:end',
    '2:ask:end',
    '2:speak:start',
    '2:speak:end',
    '3:turn:begin',
    '3:ask:start',
    '3:ask:end',
    '3:speak:start',
    '3:speak:cut',
    '3:speak:end',
    '4:turn:begin',
    '4:ask:start',
    '4:ask:end',
    '4:speak:start',
    '4:speak:end',
  ])
  const askEnds = r.floor.events().filter((e) => e.step === 'ask:end').map((e) => [e.info?.of, e.info?.stale])
  assert.deepEqual(askEnds, [[1, true], [2, false], [3, false], [4, false]], 'each answer is filed under its own question')
  const starts = r.floor.events().filter((e) => e.step === 'speak:start').map((e) => [e.turn, e.info?.who])
  assert.deepEqual(starts, [[2, 'turn2:answer'], [3, 'turn3:answer'], [4, 'turn4:answer']])
  assert.equal(r.floor.events().some((e) => e.step === 'overlap'), false)
  assert.equal(r.maxAudible(), 1, 'never two answers playing')
  assert.deepEqual(log, ['один:stale-after-ask', 'два:done', 'три:stale-after-speech', 'четыре:done'])
})
