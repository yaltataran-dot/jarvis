import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ErrorBoundary, RecoveryScreen, SceneFallback } from '../src/ui/ErrorBoundary.tsx'
import { firstFault, recordFault, resetFaults, formatFault, toFault } from '../src/lib/faultLog.ts'
import { watchContext, type Timers } from '../src/scene/contextWatch.ts'

beforeEach(() => resetFaults())

/** Drive the class the way React does, without a DOM. */
function boundary(scope: 'ui' | 'scene') {
  const b = new ErrorBoundary({ scope, children: null })
  b.setState = ((u: unknown) => {
    const next = typeof u === 'function' ? (u as (s: typeof b.state) => object)(b.state) : u
    b.state = { ...b.state, ...(next as object) }
  }) as typeof b.setState
  return b
}

test('a render error becomes a fault screen state, not an empty tree', () => {
  const b = boundary('ui')
  b.state = { ...b.state, ...ErrorBoundary.getDerivedStateFromError() }
  assert.ok(b.state.fault, 'fallback state is set immediately')
  const html = renderToStaticMarkup(b.render() as never)
  assert.match(html, /data-fault="ui"/)
  assert.match(html, /Повторить/)
})

test('the original error and stack trace are kept, with the component stack', () => {
  const b = boundary('ui')
  const err = new Error('The node to be removed is not a child of this node.')
  b.componentDidCatch(err, { componentStack: '\n    at Text\n    at Hud' })
  const f = firstFault()!
  assert.equal(f.message, err.message)
  assert.equal(f.stack, err.stack)
  assert.match(f.componentStack, /at Text/)
  assert.equal(b.state.fault, f)
  assert.match(renderToStaticMarkup(b.render() as never), /not a child of this node/)
})

test('the FIRST fault is the one reported; later consequences do not replace it', () => {
  recordFault('window', new Error('first'))
  const b = boundary('ui')
  b.componentDidCatch(new Error('consequence'), { componentStack: '' })
  assert.equal(firstFault()!.message, 'first')
  const html = renderToStaticMarkup(createElement(RecoveryScreen, { fault: toFault('ui', new Error('consequence')), onRetry() {} }))
  assert.match(html, /first/)
  assert.match(formatFault(firstFault()!), /Error: first/)
})

test('non-Error throws are recorded rather than lost', () => {
  assert.equal(recordFault('ui', 'just a string').message, 'just a string')
})

test('an error inside the Canvas is contained: scene fallback, HUD untouched', () => {
  const b = boundary('scene')
  b.componentDidCatch(new Error('shader failed'), { componentStack: '\n    at Core' })
  const html = renderToStaticMarkup(b.render() as never)
  assert.match(html, /data-fault="scene"/)
  assert.doesNotMatch(html, /data-fault="ui"/)
  assert.match(html, /<button/, 'the user can restart the scene')
  assert.match(renderToStaticMarkup(createElement(SceneFallback, { fault: firstFault()!, onRetry() {} })), /shader failed/)
})

test('after a failure the interface stays usable: retry remounts the children', () => {
  const b = boundary('ui')
  b.componentDidCatch(new Error('boom'), { componentStack: '' })
  assert.ok(b.state.fault)
  const before = b.state.attempt
  b.retry()
  assert.equal(b.state.fault, null)
  assert.equal(b.state.attempt, before + 1)
  const out = b.render() as { key: unknown }
  assert.equal(String(out.key), String(before + 1), 'new key forces a fresh mount')
})

test('without a failure the children render untouched', () => {
  const b = new ErrorBoundary({ scope: 'ui', children: createElement('main', null, 'jarvis') })
  assert.equal(renderToStaticMarkup(b.render() as never), '<main>jarvis</main>')
})

function fakeTimers() {
  const pending = new Map<number, () => void>()
  let n = 0
  const timers: Timers = {
    set: (fn) => (pending.set(++n, fn), n),
    clear: (id) => void pending.delete(id as number),
  }
  return { timers, pending, fire: () => [...pending.values()].forEach((f) => f()) }
}

test('webgl: loss is preventDefault-ed so the browser may restore it', () => {
  const c = new EventTarget()
  const t = fakeTimers()
  const calls: string[] = []
  watchContext(c, { onLost: () => calls.push('lost'), onRestored: () => calls.push('restored'), onGiveUp: () => calls.push('giveup') }, 4000, t.timers)
  const ev = new Event('webglcontextlost', { cancelable: true })
  c.dispatchEvent(ev)
  assert.equal(ev.defaultPrevented, true)
  c.dispatchEvent(new Event('webglcontextrestored'))
  t.fire()
  assert.deepEqual(calls, ['lost', 'restored'], 'restore cancels the give-up timer')
})

test('webgl: no restore within the grace period escalates exactly once', () => {
  const c = new EventTarget()
  const t = fakeTimers()
  const calls: string[] = []
  const stop = watchContext(c, { onLost: () => calls.push('lost'), onRestored: () => calls.push('restored'), onGiveUp: () => calls.push('giveup') }, 4000, t.timers)
  c.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
  t.fire()
  assert.deepEqual(calls, ['lost', 'giveup'])
  stop()
  c.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
  assert.equal(calls.length, 2, 'listeners are removed on unmount')
})
