import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { systemPromptFor } from '../bridge/prompt.mjs'

/**
 * The system prompt (bridge/prompt.mjs), moved out of server.mjs unchanged.
 *
 * The digests were taken from SYSTEM_PROMPT as server.mjs built it before the
 * move (091a8ad), for each language. Any edit to the prompt — a word, a space,
 * a line break — changes them; when that edit is meant, the new digests go
 * here in the same change, so it is never silent.
 */
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

const RU = { sha256: 'c59ea452a2cc46177b89d991eb6c62349f709f036fc7c1faaf21e08644b24a0f', length: 18620 }
const EN = { sha256: '26175c387a694db8b5258a99c502f817599260822c291a70da5a8010dbca55b0', length: 15040 }

test('the Russian prompt is byte for byte the one server.mjs had', () => {
  const p = systemPromptFor('ru')
  assert.equal(p.length, RU.length)
  assert.equal(sha256(p), RU.sha256)
})

test('the English prompt is byte for byte the one server.mjs had', () => {
  const p = systemPromptFor('en')
  assert.equal(p.length, EN.length)
  assert.equal(sha256(p), EN.sha256)
})

test('language: Russian only for "ru"; anything else is the English prompt, as before', () => {
  assert.equal(sha256(systemPromptFor('ru')), RU.sha256)
  for (const lang of ['en', 'RU', 'de', '', undefined]) assert.equal(sha256(systemPromptFor(lang)), EN.sha256, String(lang))
  // The Russian one is the English one with a head and a tail around it.
  const ru = systemPromptFor('ru')
  const en = systemPromptFor('en')
  assert.ok(ru.includes(en))
  assert.ok(ru.indexOf(en) > 0 && ru.indexOf(en) + en.length < ru.length)
})

test('server.mjs builds SYSTEM_PROMPT from LANG once, and uses it where it did', () => {
  const server = readFileSync(new URL('../bridge/server.mjs', import.meta.url), 'utf8').replace(/\r/g, '')
  assert.match(server, /^import \{ systemPromptFor \} from '\.\/prompt\.mjs'$/m)
  assert.match(server, /^const SYSTEM_PROMPT = systemPromptFor\(LANG\)$/m)
  assert.equal(server.match(/\bSYSTEM_PROMPT\b/g)?.length, 3, 'defined once, used twice')
  assert.match(server, /system: SYSTEM_PROMPT \+ note,/, 'the fallback model gets it, with its note')
  assert.match(server, /systemPrompt: SYSTEM_PROMPT,/, 'the agent session gets it')
  assert.doesNotMatch(server, /\b(BASE_PROMPT|RUSSIAN_HEAD|RUSSIAN)\b/, 'no second copy left behind')
})
