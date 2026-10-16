import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bridgeEnvFor } from '../scripts/bridgeEnv.mjs'

test('--calendar-writes opens the calendar to the bridge, and nothing else', () => {
  assert.deepEqual(bridgeEnvFor(['node', 'scripts/start.mjs', '--calendar-writes'], {}), { JARVIS_CALENDAR_WRITES: '1' })
})

test('--writes does not open the calendar', () => {
  const env = bridgeEnvFor(['node', 'scripts/start.mjs', '--writes'], {})
  assert.deepEqual(env, { JARVIS_ALLOW_WRITES: '1' })
  assert.equal(env.JARVIS_CALENDAR_WRITES, undefined)
})

test('no switch, no writes of either kind', () => {
  assert.deepEqual(bridgeEnvFor(['node', 'scripts/start.mjs'], {}), {})
})

test('the switches are separate and can be given together', () => {
  assert.deepEqual(bridgeEnvFor(['node', 'scripts/start.mjs', '--writes', '--calendar-writes'], {}), {
    JARVIS_ALLOW_WRITES: '1',
    JARVIS_CALENDAR_WRITES: '1',
  })
})

test('the face port is still passed on', () => {
  assert.deepEqual(bridgeEnvFor(['node', 'scripts/start.mjs'], { PORT: '5180' }), {
    JARVIS_ALLOWED_ORIGINS: 'http://localhost:5180,http://127.0.0.1:5180',
  })
})
