import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAccess } from '../bridge/access.mjs'

/**
 * The Origin and Host checks (bridge/access.mjs) on their own, for each
 * environment setting. The running bridge is checked against the same rules in
 * tests/bridgeBind.test.mjs, which was written while they were in server.mjs.
 */

test('no environment: local dev origins only, no Origin refused, loopback hosts only', () => {
  const a = createAccess({})
  for (const o of ['http://localhost:5173', 'http://localhost:5199', 'http://localhost:4173', 'http://localhost:4199', 'http://127.0.0.1:5180', 'http://[::1]:5173']) {
    assert.equal(a.originAllowed(o), true, o)
  }
  for (const o of ['http://localhost:5172', 'http://localhost:5200', 'http://localhost:4172', 'http://localhost:4200', 'http://localhost', 'https://localhost:5173', 'http://evil.example:5173', 'null', 'not a url']) {
    assert.equal(a.originAllowed(o), false, o)
  }
  assert.equal(a.originAllowed(undefined), false)
  assert.equal(a.originAllowed(''), false)
  for (const h of ['localhost', 'localhost:8787', '127.0.0.1:1', '[::1]:8787', 'LOCALHOST']) assert.equal(a.hostAllowed(h), true, h)
  for (const h of ['evil.example', 'localhost.evil.example', '10.0.0.5', 'a b', '', undefined]) assert.equal(a.hostAllowed(h), false, String(h))
  assert.equal(a.extraOrigins.size, 0)
  assert.equal(a.allowNoOrigin, false)
})

test('JARVIS_ALLOW_NO_ORIGIN: only the exact value 1 lets a client without an Origin in', () => {
  assert.equal(createAccess({ JARVIS_ALLOW_NO_ORIGIN: '1' }).originAllowed(undefined), true)
  assert.equal(createAccess({ JARVIS_ALLOW_NO_ORIGIN: '1' }).allowNoOrigin, true)
  for (const v of ['0', 'true', 'yes', ' 1', '']) assert.equal(createAccess({ JARVIS_ALLOW_NO_ORIGIN: v }).originAllowed(undefined), false, JSON.stringify(v))
})

test('JARVIS_ALLOWED_ORIGINS: trimmed, trailing slashes dropped, empties skipped; their hosts are served', () => {
  const a = createAccess({ JARVIS_ALLOWED_ORIGINS: ' http://a.example:9000/ ,, http://b.example// , not a url ' })
  assert.deepEqual([...a.extraOrigins], ['http://a.example:9000', 'http://b.example', 'not a url'])
  for (const o of ['http://a.example:9000', 'http://a.example:9000/', 'http://b.example', 'not a url']) assert.equal(a.originAllowed(o), true, o)
  for (const o of ['http://a.example:9001', 'https://a.example:9000', 'http://c.example']) assert.equal(a.originAllowed(o), false, o)
  for (const h of ['a.example', 'A.Example:9000', 'b.example', 'localhost']) assert.equal(a.hostAllowed(h), true, h)
  for (const h of ['c.example', 'a.example.evil.example']) assert.equal(a.hostAllowed(h), false, h)
})

test('JARVIS_ALLOWED_HOSTS: names served as Host, lower-cased, but never an Origin', () => {
  const a = createAccess({ JARVIS_ALLOWED_HOSTS: 'Jarvis.Example, ,box.example ' })
  for (const h of ['jarvis.example', 'JARVIS.EXAMPLE:443', 'box.example']) assert.equal(a.hostAllowed(h), true, h)
  assert.equal(a.hostAllowed('other.example'), false)
  assert.equal(a.originAllowed('http://jarvis.example'), false, 'a host is not an origin')
})

test('read once: changing the environment afterwards changes nothing', () => {
  const env = { JARVIS_ALLOWED_HOSTS: 'one.example' }
  const a = createAccess(env)
  env.JARVIS_ALLOWED_HOSTS = 'two.example'
  env.JARVIS_ALLOW_NO_ORIGIN = '1'
  assert.equal(a.hostAllowed('one.example'), true)
  assert.equal(a.hostAllowed('two.example'), false)
  assert.equal(a.originAllowed(undefined), false)
})
