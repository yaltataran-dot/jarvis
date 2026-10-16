import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ENERGY,
  EXIT,
  GREET_SCREEN_MS,
  HANDOVER_MS,
  HUD_IN,
  SPLASH_AFTER_START_MS,
  smooth,
} from '../src/lib/bootTimeline.ts'

test('the way out never shows two logos: the start-up one settles first', () => {
  // The layer and the working screen's instruments (with the core's own logo)
  // only begin to cross once the start-up logo is where the core's will be.
  assert.ok(EXIT.DELAY_MS >= EXIT.LOGO_MS, 'the layer waits for the logo')
  assert.ok(HUD_IN.DELAY_MS >= EXIT.LOGO_MS, 'the instruments wait for the logo')
  // And the instruments are fully up only after the layer has gone.
  assert.ok(HUD_IN.DELAY_MS + HUD_IN.FADE_MS >= EXIT.DELAY_MS + EXIT.FADE_MS)
})

test('the greeting comes after the handover, inside the greeting screen', () => {
  assert.ok(SPLASH_AFTER_START_MS > 0, 'the answer to the click is seen first')
  assert.ok(HANDOVER_MS < GREET_SCREEN_MS)
  assert.ok(HANDOVER_MS >= 800 && HANDOVER_MS <= 1500, 'a handover of 0.8–1.5 s')
})

test('the streams never leave the screen, and nothing flares', () => {
  // A pull of 1 would draw the streams all the way into the ring.
  assert.ok(ENERGY.engagePull > 0 && ENERGY.engagePull < 1)
  assert.ok(ENERGY.greetPull > 0 && ENERGY.greetPull < 1)
  assert.ok(ENERGY.calmStreams > 0.3, 'the greeting screen keeps them visible')
  // The click brightens a little, the greeting screen softens a little.
  assert.ok(ENERGY.engageBrightness > 1 && ENERGY.engageBrightness <= 1.2)
  assert.ok(ENERGY.greetBrightness < 1 && ENERGY.greetBrightness >= 0.8)
})

test('smooth eases between its ends and stays inside them', () => {
  assert.equal(smooth(0, 100, -5), 0)
  assert.equal(smooth(0, 100, 0), 0)
  assert.equal(smooth(0, 100, 50), 0.5)
  assert.equal(smooth(0, 100, 100), 1)
  assert.equal(smooth(0, 100, 500), 1)
})
