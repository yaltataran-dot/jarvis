import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FRAME_SAMPLES, createDownsampler, createFramer, floatToPcm16 } from '../src/lib/pcm.ts'

test('float samples become 16-bit and are clipped, not wrapped', () => {
  const out = floatToPcm16(Float32Array.from([0, 1, -1, 0.5, -0.5, 2, -3]))
  assert.deepEqual([...out], [0, 32767, -32768, 16384, -16384, 32767, -32768])
})

test('48 kHz becomes 16 kHz: three inputs averaged into one', () => {
  const d = createDownsampler(48000)
  const out = d.push(Float32Array.from([0, 0.3, 0.6, 1, 1, 1]))
  assert.equal(out.length, 2)
  assert.ok(Math.abs(out[0] - 0.3) < 1e-6)
  assert.ok(Math.abs(out[1] - 1) < 1e-6)
})

test('blocks that do not divide evenly join without a seam or a lost sample', () => {
  const whole = createDownsampler(48000).push(Float32Array.from({ length: 3000 }, (_, i) => Math.sin(i / 7)))
  const d = createDownsampler(48000)
  const parts = [d.push(new Float32Array(1024).map((_, i) => Math.sin(i / 7))), d.push(new Float32Array(1024).map((_, i) => Math.sin((i + 1024) / 7))), d.push(new Float32Array(952).map((_, i) => Math.sin((i + 2048) / 7)))]
  const joined = parts.flatMap((p) => [...p])
  assert.equal(joined.length, whole.length)
  joined.forEach((v, i) => assert.ok(Math.abs(v - whole[i]) < 1e-6))
})

test('a fractional ratio (44.1 kHz) yields the right number of samples over a second', () => {
  const out = createDownsampler(44100).push(new Float32Array(44100))
  assert.ok(Math.abs(out.length - 16000) <= 1)
})

test('it never invents samples by going up', () => {
  assert.throws(() => createDownsampler(8000))
})

test('the framer hands back whole 100 ms frames and keeps the remainder', () => {
  const f = createFramer()
  assert.equal(FRAME_SAMPLES, 1600)
  assert.equal(f.push(new Int16Array(1000)).length, 0)
  const frames = f.push(new Int16Array(2300))
  assert.equal(frames.length, 2)
  assert.ok(frames.every((x) => x.length === FRAME_SAMPLES))
  assert.equal(f.pending(), 100)
})

test('the framer keeps the samples in order across pushes', () => {
  const f = createFramer(4)
  const frames = [...f.push(Int16Array.from([1, 2, 3])), ...f.push(Int16Array.from([4, 5, 6, 7, 8]))]
  assert.deepEqual(frames.map((x) => [...x]), [[1, 2, 3, 4], [5, 6, 7, 8]])
})
