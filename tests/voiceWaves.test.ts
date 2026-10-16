import { test } from 'node:test'
import assert from 'node:assert/strict'
import { follow, waveTarget, type WaveDrive } from '../src/lib/voiceWaves.ts'

/** Run the shown drive for `ms` at 60 frames a second. */
const run = (from: WaveDrive, phase: string, level: number, ms: number) => {
  let d = from
  for (let t = 0; t < ms; t += 1000 / 60) d = follow(d, waveTarget(phase, level), 1 / 60)
  return d
}

test('speaking: his real loudness, across the whole width', () => {
  assert.deepEqual(waveTarget('speaking', 0.6), { amp: 0.6, reach: 1 })
  assert.equal(waveTarget('speaking', 0).amp, 0, 'a pause between sentences is a flat line')
  assert.equal(waveTarget('speaking', 3).amp, 1)
  assert.equal(waveTarget('speaking', Number.NaN).amp, 0)
})

test('listening: the microphone, shorter waves; thinking: a shimmer; at rest: nothing', () => {
  const l = waveTarget('listening', 0.5)
  assert.ok(l.amp > 0 && l.amp < 0.5 && l.reach < 0.5)
  const th = waveTarget('thinking', 0.9)
  assert.ok(th.amp > 0 && th.amp < 0.2, 'thinking does not follow the room noise')
  for (const p of ['dormant', 'offline', 'boot']) assert.deepEqual(waveTarget(p, 0.8), { amp: 0, reach: 0 }, p)
})

test('«Стоп»: the long waves are gone within a few tenths of a second', () => {
  const speaking = run({ amp: 0, reach: 0 }, 'speaking', 0.8, 1000)
  assert.ok(speaking.reach > 0.99 && speaking.amp > 0.79)
  // The stop cuts his voice: the phase is listening, the room is quiet.
  const after = run(speaking, 'listening', 0.02, 300)
  assert.ok(after.reach < 0.5, `still reaching ${after.reach.toFixed(2)} of the width`)
  assert.ok(after.amp < 0.1, `still ${after.amp.toFixed(2)} high`)
})

test('the waves follow the voice up quickly and never overshoot', () => {
  let d: WaveDrive = { amp: 0, reach: 0 }
  for (let i = 0; i < 120; i++) {
    d = follow(d, waveTarget('speaking', 0.5), 1 / 60)
    assert.ok(d.amp <= 0.5 + 1e-9 && d.reach <= 1 + 1e-9)
  }
  assert.ok(run({ amp: 0, reach: 0 }, 'speaking', 0.5, 200).amp > 0.4, 'within 0.2 s')
})
