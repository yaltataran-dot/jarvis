import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * The dialogue window's frame, read from the stylesheet. The layout itself was
 * checked in a browser at 320–430 px; this keeps the rules that make it hold.
 */
const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8').replace(/\r/g, '')

/** The declarations of the first rule for `selector` inside `scope` (the whole sheet by default). */
function rule(selector: string, scope = css): string {
  const at = scope.indexOf(`${selector} {`)
  assert.notEqual(at, -1, `${selector} not found`)
  return scope.slice(at, scope.indexOf('}', at))
}

/** The body of `@media (max-width: 900px) { … }` that holds the narrow-screen dialogue rules. */
function narrowBlock(): string {
  const start = css.indexOf('@media (max-width: 900px) {\n  .rail {')
  assert.notEqual(start, -1, 'narrow-screen block not found')
  return css.slice(start, css.indexOf('\n}\n', start))
}

test('on a phone the dialogue frame has a fixed, compact height, not just a ceiling', () => {
  const panel = rule('.dialog-panel', narrowBlock())
  assert.match(panel, /height: clamp\(110px, 21vh, 200px\);/)
  assert.match(panel, /height: clamp\(110px, 21svh, 200px\);/, 'stable as the address bar slides')
  assert.match(panel, /max-height: none;/)
})

test('on a phone the frame is tighter inside; the desktop spacing is left alone', () => {
  const narrow = narrowBlock()
  assert.match(rule('.dialog-body', narrow), /padding: 8px 10px; gap: 6px;/)
  assert.match(rule('.log-line', narrow), /font-size: 13px; line-height: 1.35;/)
  const desktop = rule('.dialog-body')
  assert.match(desktop, /padding: 12px 14px;/)
  assert.match(desktop, /gap: 11px;/)
})

test('the history scrolls inside the frame and nothing reaches past it', () => {
  const panel = rule('.dialog-panel')
  assert.match(panel, /display: flex;/)
  assert.match(panel, /flex-direction: column;/)
  assert.match(panel, /overflow: hidden;/)
  const body = rule('.dialog-body')
  assert.match(body, /flex: 1 1 auto;/)
  assert.match(body, /min-height: 0;/, 'without it a flex child grows with its content')
  assert.match(body, /overflow-y: auto;/)
  assert.match(body, /overflow-x: hidden;/)
})

test('long words and URLs wrap instead of widening the window', () => {
  const line = rule('.log-line')
  assert.match(line, /overflow-wrap: anywhere;/)
  assert.match(line, /min-width: 0;/)
  assert.match(line, /max-width: 100%;/)
})
