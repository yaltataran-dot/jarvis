import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CLIENT_FILE, TOKEN_FILE, calendarAction, classify, createGoogleCalendar, eventIdFor } from '../bridge/googleCalendar.mjs'

const ACCESS = 'ya29.ACCESS-TOKEN-SECRET'
const REFRESH = '1//REFRESH-TOKEN-SECRET'

/**
 * A pretend Google: the token endpoint and the events of the primary calendar.
 * `fault` makes the next matching request fail the way the network or Google
 * can: a thrown timeout, a lost answer after the write landed, an HTTP error.
 */
function google({ events = [], tokenError = null, faults = [] } = {}) {
  const store = new Map(events.map((e) => [e.id, { status: 'confirmed', etag: '"1"', ...e }]))
  const log = []
  const requests = []
  let issued = 0
  const json = (status, body) => ({ ok: status < 400, status, json: async () => body })
  const fetch = async (url, init = {}) => {
    const u = new URL(url)
    const method = init.method ?? 'GET'
    requests.push({ method, path: u.pathname, auth: init.headers?.authorization, ifMatch: init.headers?.['if-match'], body: init.body })
    const fault = faults.find((f) => f.method === method && u.pathname.includes(f.path) && !f.used)
    if (fault) {
      fault.used = true
      if (fault.apply) fault.apply(store, init)
      if (fault.throw) {
        const err = new Error('timed out')
        err.name = fault.throw
        throw err
      }
      return json(fault.status, fault.body ?? {})
    }
    if (u.hostname === 'oauth2.googleapis.com') {
      if (tokenError) return json(400, { error: tokenError })
      issued++
      return json(200, { access_token: ACCESS, expires_in: 3600, scope: 'https://www.googleapis.com/auth/calendar.events' })
    }
    if (init.headers?.authorization !== `Bearer ${ACCESS}`) return json(401, {})
    const m = /\/calendars\/primary\/events(?:\/([^/?]+))?/.exec(u.pathname)
    const id = m?.[1] && decodeURIComponent(m[1])
    if (method === 'GET' && !id) {
      const items = [...store.values()]
      return json(200, { timeZone: 'Europe/Moscow', items })
    }
    if (method === 'GET') return store.has(id) ? json(200, store.get(id)) : json(404, {})
    if (method === 'POST') {
      const body = JSON.parse(init.body)
      if (store.has(body.id)) return json(409, { error: { errors: [{ reason: 'duplicate' }] } })
      const ev = { ...body, status: 'confirmed', etag: '"1"' }
      store.set(body.id, ev)
      return json(200, ev)
    }
    if (method === 'PATCH') {
      const ev = store.get(id)
      if (!ev) return json(404, {})
      if (ev.status === 'cancelled') return json(410, {})
      if (init.headers?.['if-match'] && init.headers['if-match'] !== ev.etag) return json(412, {})
      Object.assign(ev, JSON.parse(init.body), { etag: '"2"' })
      return json(200, ev)
    }
    if (method === 'DELETE') {
      const ev = store.get(id)
      if (!ev) return json(404, {})
      if (ev.status === 'cancelled') return json(410, {})
      ev.status = 'cancelled'
      return { ok: true, status: 204, json: async () => null }
    }
    return json(400, {})
  }
  const cal = (env = { JARVIS_CALENDAR_WRITES: '1' }) =>
    createGoogleCalendar({
      fetch,
      exists: (p) => p === CLIENT_FILE || p === TOKEN_FILE,
      read: (p) => (p === CLIENT_FILE ? JSON.stringify({ installed: { client_id: 'cid.apps.googleusercontent.com', client_secret: 'csecret' } }) : 'SEALED'),
      unprotect: async (s) => (s === 'SEALED' ? JSON.stringify({ refresh_token: REFRESH }) : ''),
      sleep: async () => {},
      env,
      log: (l) => log.push(l),
    })
  return { cal, store, log, requests, issued: () => issued }
}

const NEW = {
  opId: '0123456789abcdef0123',
  summary: 'Встреча',
  location: 'ресторан Батони',
  timeZone: 'Europe/Moscow',
  start: { dateTime: '2026-10-18T18:00:00' },
  end: { dateTime: '2026-10-18T19:00:00' },
}

test('create: the event, with its zone and our id, confirmed from Google\'s answer', async () => {
  const g = google()
  const r = await g.cal().create(NEW)
  assert.equal(r.code, 'ok')
  assert.equal(r.event.id, eventIdFor(NEW.opId))
  const sent = JSON.parse(g.requests.find((q) => q.method === 'POST' && q.path.includes('/events')).body)
  assert.deepEqual(sent.start, { dateTime: '2026-10-18T18:00:00', timeZone: 'Europe/Moscow' })
  assert.equal(sent.location, 'ресторан Батони')
})

test('a 15-minute event goes to Google exactly as read back: wall-clock start and end with the calendar\'s zone, nothing converted', async () => {
  const g = google()
  const r = await calendarAction(g.cal(), {
    op: 'create',
    opId: 'abcdef0123456789',
    summary: 'Проверка календаря',
    timeZone: 'Europe/Kiev',
    start: { dateTime: '2026-10-15T16:00:00' },
    end: { dateTime: '2026-10-15T16:15:00' },
  })
  assert.equal(r.code, 'ok')
  const body = JSON.parse(g.requests.find((q) => q.method === 'POST' && q.path.includes('/events')).body)
  assert.deepEqual(body.start, { dateTime: '2026-10-15T16:00:00', timeZone: 'Europe/Kiev' })
  assert.deepEqual(body.end, { dateTime: '2026-10-15T16:15:00', timeZone: 'Europe/Kiev' })
  // What Google answered is what the page is given to say.
  assert.equal(r.event.start, body.start.dateTime)
  assert.equal(r.event.end, body.end.dateTime)
  // A start or end the route cannot read is refused, never sent.
  const bad = google()
  for (const end of [{ dateTime: '16:15' }, { dateTime: '2026-10-15T16:15:00+03:00' }, {}]) {
    assert.equal((await calendarAction(bad.cal(), { op: 'create', opId: 'abcdef0123456789', summary: 'x', timeZone: 'Europe/Kiev', start: { dateTime: '2026-10-15T16:00:00' }, end })).code, 'failed')
  }
  assert.equal(bad.requests.length, 0)
})

test('the same create twice: Google refuses the twin, the first is returned — one event', async () => {
  const g = google()
  const c = g.cal()
  await c.create(NEW)
  const again = await c.create(NEW)
  assert.equal(again.code, 'ok')
  assert.equal(again.already, true)
  assert.equal(g.store.size, 1)
})

test('the answer to a create lost after it landed: found by its id, not created again', async () => {
  const g = google({
    faults: [{ method: 'POST', path: '/events', throw: 'TimeoutError', apply: (store, init) => { const b = JSON.parse(init.body); store.set(b.id, { ...b, status: 'confirmed', etag: '"1"' }) } }],
  })
  const r = await g.cal().create(NEW)
  assert.equal(r.code, 'ok')
  assert.equal(r.already, true)
  assert.equal(g.store.size, 1)
})

test('a create that timed out before landing is tried once more, with the same id', async () => {
  const g = google({ faults: [{ method: 'POST', path: '/events', throw: 'TimeoutError' }] })
  const r = await g.cal().create(NEW)
  assert.equal(r.code, 'ok')
  const posts = g.requests.filter((q) => q.method === 'POST' && q.path.includes('/events')).map((q) => JSON.parse(q.body).id)
  assert.deepEqual(posts, [eventIdFor(NEW.opId), eventIdFor(NEW.opId)])
})

test('a create whose outcome cannot be checked is unknown — never success, never a blind repeat', async () => {
  const g = google({
    faults: [
      { method: 'POST', path: '/events', throw: 'TimeoutError' },
      { method: 'GET', path: '/events/', throw: 'TypeError' },
      { method: 'GET', path: '/events/', throw: 'TypeError' },
    ],
  })
  const r = await g.cal().create(NEW)
  assert.equal(r.code, 'unknown')
  assert.equal(g.requests.filter((q) => q.method === 'POST' && q.path.includes('/events')).length, 1)
})

test('list: the period\'s events in the calendar\'s zone, cancelled ones left out', async () => {
  const g = google({
    events: [
      { id: 'a1', summary: 'Встреча', start: { dateTime: '2026-10-18T18:00:00+03:00' }, end: { dateTime: '2026-10-18T19:00:00+03:00' } },
      { id: 'a2', summary: 'Отменённая', status: 'cancelled', start: { dateTime: '2026-10-18T20:00:00+03:00' }, end: { dateTime: '2026-10-18T21:00:00+03:00' } },
      { id: 'a3', summary: 'День рождения', start: { date: '2026-10-19' }, end: { date: '2026-10-20' } },
    ],
  })
  const c = g.cal()
  const r = await c.list({ timeMin: '2026-10-18T00:00:00+03:00', timeMax: '2026-10-20T00:00:00+03:00' })
  assert.equal(r.code, 'ok')
  assert.deepEqual(r.events.map((e) => [e.id, e.start]), [['a1', '2026-10-18T18:00:00+03:00'], ['a3', '2026-10-19']])
  assert.equal((await c.status()).timeZone, 'Europe/Moscow')
})

test('update: sent with the version read; a change made meanwhile is a conflict, not overwritten', async () => {
  const g = google({ events: [{ id: 'a1', summary: 'Встреча', start: { dateTime: '2026-10-18T18:00:00+03:00' }, end: { dateTime: '2026-10-18T19:00:00+03:00' } }] })
  const c = g.cal()
  const ok = await c.update({ id: 'a1', etag: '"1"', timeZone: 'Europe/Moscow', start: { dateTime: '2026-10-18T19:00:00' }, end: { dateTime: '2026-10-18T20:00:00' } })
  assert.equal(ok.code, 'ok')
  assert.equal(g.requests.find((q) => q.method === 'PATCH').ifMatch, '"1"')
  const stale = await c.update({ id: 'a1', etag: '"1"', timeZone: 'Europe/Moscow', location: 'кафе' })
  assert.equal(stale.code, 'conflict')
  assert.equal(g.store.get('a1').location, undefined)
})

test('update whose answer was lost: checked against the event', async () => {
  const g = google({
    events: [{ id: 'a1', summary: 'Встреча', start: { dateTime: '2026-10-18T18:00:00+03:00' }, end: { dateTime: '2026-10-18T19:00:00+03:00' } }],
    faults: [{ method: 'PATCH', path: '/events/a1', throw: 'TimeoutError', apply: (store) => Object.assign(store.get('a1'), { location: 'кафе Пушкин' }) }],
  })
  assert.equal((await g.cal().update({ id: 'a1', timeZone: 'Europe/Moscow', location: 'кафе Пушкин' })).code, 'ok')
  const h = google({
    events: [{ id: 'a1', summary: 'Встреча', start: { dateTime: '2026-10-18T18:00:00+03:00' }, end: { dateTime: '2026-10-18T19:00:00+03:00' } }],
    faults: [{ method: 'PATCH', path: '/events/a1', throw: 'TimeoutError' }],
  })
  assert.equal((await h.cal().update({ id: 'a1', timeZone: 'Europe/Moscow', location: 'кафе Пушкин' })).code, 'unknown')
})

test('delete: removed; deleted twice is still done; never existed is not found', async () => {
  const g = google({ events: [{ id: 'a1', summary: 'Встреча', start: { dateTime: '2026-10-18T18:00:00+03:00' }, end: { dateTime: '2026-10-18T19:00:00+03:00' } }] })
  const c = g.cal()
  assert.equal((await c.remove({ id: 'a1' })).code, 'ok')
  const twice = await c.remove({ id: 'a1' })
  assert.equal(twice.code, 'ok')
  assert.equal(twice.already, true)
  assert.equal((await c.remove({ id: 'zz999' })).code, 'not-found')
})

test('writes are refused without JARVIS_CALENDAR_WRITES; reading is not', async () => {
  const g = google()
  const off = g.cal({})
  assert.equal((await off.create(NEW)).code, 'writes-disabled')
  assert.equal((await off.update({ id: 'a1', timeZone: 'Europe/Moscow', location: 'x' })).code, 'writes-disabled')
  assert.equal((await off.remove({ id: 'a1' })).code, 'writes-disabled')
  assert.equal(g.requests.filter((q) => q.method !== 'GET' && !q.path.includes('token')).length, 0)
  assert.equal((await off.list({ timeMin: '2026-10-18T00:00:00+03:00', timeMax: '2026-10-19T00:00:00+03:00' })).code, 'ok')
  assert.equal((await off.status()).writes, false)
  assert.equal((await g.cal({ JARVIS_CALENDAR_WRITES: '1' }).create(NEW)).code, 'ok')
})

test('JARVIS_ALLOW_WRITES does not open the calendar: nothing is sent, and status says writes are off', async () => {
  const g = google({ events: [{ id: 'a1', summary: 'Встреча', start: { dateTime: '2026-10-18T18:00:00+03:00' }, end: { dateTime: '2026-10-18T19:00:00+03:00' } }] })
  for (const env of [{ JARVIS_ALLOW_WRITES: '1' }, { JARVIS_ALLOW_WRITES: '1', JARVIS_CALENDAR_WRITES: '0' }, { JARVIS_CALENDAR_WRITES: 'true' }]) {
    const c = g.cal(env)
    assert.equal((await c.create(NEW)).code, 'writes-disabled', JSON.stringify(env))
    assert.equal((await c.update({ id: 'a1', timeZone: 'Europe/Moscow', location: 'x' })).code, 'writes-disabled')
    assert.equal((await c.remove({ id: 'a1' })).code, 'writes-disabled')
    assert.equal((await c.status()).writes, false)
  }
  assert.equal(g.requests.filter((q) => q.method !== 'GET' && !q.path.includes('token')).length, 0, 'no write reached Google')
  assert.equal(g.store.get('a1').status, 'confirmed')
  // Through the /calendar route as well (its ids are at least five characters).
  assert.equal((await calendarAction(g.cal({ JARVIS_ALLOW_WRITES: '1' }), { op: 'remove', id: 'abc12' })).code, 'writes-disabled')
  assert.equal((await calendarAction(g.cal({ JARVIS_ALLOW_WRITES: '1' }), { ...NEW, op: 'create' })).code, 'writes-disabled')
})

test('an expired access token is renewed; a revoked one asks for a reconnect', async () => {
  const g = google({ faults: [{ method: 'GET', path: '/events', status: 401 }] })
  const r = await g.cal().list({ timeMin: '2026-10-18T00:00:00+03:00', timeMax: '2026-10-19T00:00:00+03:00' })
  assert.equal(r.code, 'ok')
  assert.equal(g.issued(), 2, 'renewed once after the 401')
  const revoked = google({ tokenError: 'invalid_grant' })
  const c = revoked.cal()
  assert.equal((await c.list({ timeMin: '2026-10-18T00:00:00+03:00', timeMax: '2026-10-19T00:00:00+03:00' })).code, 'auth')
  assert.equal((await c.status()).connected, false, 'and stays disconnected until connected again')
})

test('Google\'s refusals, each as what it means', async () => {
  assert.equal(classify(403, { error: { errors: [{ reason: 'rateLimitExceeded' }] } }), 'rate')
  assert.equal(classify(403, { error: { errors: [{ reason: 'insufficientPermissions' }] } }), 'forbidden')
  assert.equal(classify(429, {}), 'rate')
  assert.equal(classify(503, {}), 'server')
  const g = google({ faults: [{ method: 'GET', path: '/events', status: 403, body: { error: { errors: [{ reason: 'insufficientPermissions' }] } } }] })
  assert.equal((await g.cal().list({ timeMin: '2026-10-18T00:00:00+03:00', timeMax: '2026-10-19T00:00:00+03:00' })).code, 'forbidden')
  const net = google({ faults: [{ method: 'GET', path: '/events', throw: 'TypeError' }, { method: 'GET', path: '/events', throw: 'TypeError' }] })
  assert.equal((await net.cal().list({ timeMin: '2026-10-18T00:00:00+03:00', timeMax: '2026-10-19T00:00:00+03:00' })).code, 'network')
})

test('the log carries no token, no client secret and no event content', async () => {
  const g = google()
  const c = g.cal()
  await c.create(NEW)
  await c.list({ timeMin: '2026-10-18T00:00:00+03:00', timeMax: '2026-10-19T00:00:00+03:00' })
  const all = g.log.join('\n')
  for (const secret of [ACCESS, REFRESH, 'csecret', 'Батони', 'Встреча']) assert.ok(!all.includes(secret), secret)
  assert.match(all, /calendar create -> ok/)
})

test('not connected: said, nothing sent', async () => {
  const c = createGoogleCalendar({ exists: () => false, fetch: async () => assert.fail('nothing should be sent'), env: {} })
  assert.equal((await c.list({ timeMin: '2026-10-18T00:00:00+03:00', timeMax: '2026-10-19T00:00:00+03:00' })).code, 'not-connected')
  assert.equal((await c.status()).connected, false)
})

test('the /calendar route checks what it is given', async () => {
  const seen = []
  const fake = new Proxy({}, { get: (_, k) => (arg) => (seen.push([k, arg]), Promise.resolve({ code: 'ok' })) })
  assert.equal((await calendarAction(fake, { op: 'drop-all' })).code, 'failed')
  assert.equal((await calendarAction(fake, { op: 'list', timeMin: 'yesterday', timeMax: 'x' })).code, 'failed')
  assert.equal((await calendarAction(fake, { ...NEW, op: 'create', opId: '../../x' })).code, 'failed')
  assert.equal((await calendarAction(fake, { ...NEW, op: 'create', timeZone: 'Europe/Moscow; rm' })).code, 'failed')
  assert.equal((await calendarAction(fake, { op: 'remove', id: 'ABC/../x' })).code, 'failed')
  await calendarAction(fake, { ...NEW, op: 'create', summary: 'Встреча\u0000\nс Иваном', reminderMin: 30 })
  assert.equal(seen[0][1].summary, 'Встреча с Иваном')
  assert.equal(seen[0][1].reminderMin, 30)
  assert.throws(() => eventIdFor('../x'))
})

test('event ids: plain events and occurrences of recurring ones are let through; nothing else is', async () => {
  const seen = []
  const fake = new Proxy({}, { get: (_, k) => (arg) => (seen.push([k, arg.id]), Promise.resolve({ code: 'ok' })) })
  const ok = [
    'abc12', // the shortest Google allows
    '7p3kq9v0a1b2c3d4e5f6g7h8i9', // as Google makes them
    eventIdFor('0123456789abcdef0123'), // as JARVIS makes them
    '7p3kq9v0a1b2c3d4e5f6g7h8i9_20261015T090000Z', // one occurrence of a timed series
    '7p3kq9v0a1b2c3d4e5f6g7h8i9_20261015', // one occurrence of an all-day series
    'v'.repeat(1024),
  ]
  for (const id of ok) {
    assert.equal((await calendarAction(fake, { op: 'remove', id })).code, 'ok', id)
    assert.equal((await calendarAction(fake, { op: 'update', id, timeZone: 'Europe/Moscow', location: 'кафе' })).code, 'ok', id)
  }
  assert.deepEqual(seen.map(([, id]) => id), ok.flatMap((id) => [id, id]), 'each reached the calendar exactly as given')

  seen.length = 0
  const bad = [
    '', 'abcd', // too short
    'v'.repeat(1025), // too long
    'ABC12', 'abcw1', 'abc-12', 'abc 12', 'abc.12', // outside base32hex
    '_20261015T090000Z', // an occurrence of nothing
    'abc12_', 'abc12__20261015', 'abc12_2026101', 'abc12_202610151', // a broken occurrence date
    'abc12_20261015T0900Z', 'abc12_20261015T090000', 'abc12_20261015t090000z', // a broken occurrence time
    'abc12_20261015T090000Z_20261016', // two occurrences
    'abc12_20261015/../x', 'abc12_20261015?x=1', 'abc12_20261015%2F', 'abc12_20261015\n', // path and query tricks
    'abc12_R20261015T090000', // a split series: its form is not confirmed, so not let through
    12345, null, { id: 'abc12' }, ['abc12'],
  ]
  for (const id of bad) {
    assert.equal((await calendarAction(fake, { op: 'remove', id })).code, 'failed', JSON.stringify(id))
    assert.equal((await calendarAction(fake, { op: 'update', id, timeZone: 'Europe/Moscow', location: 'кафе' })).code, 'failed', JSON.stringify(id))
  }
  assert.equal(seen.length, 0, 'no bad id reached the calendar')
})

test('one occurrence of a recurring event is moved and deleted by its own id', async () => {
  const id = '7p3kq9v0a1b2c3d4e5f6g7h8i9_20261015T090000Z'
  const g = google({ events: [{ id, recurringEventId: '7p3kq9v0a1b2c3d4e5f6g7h8i9', summary: 'Планёрка', start: { dateTime: '2026-10-15T12:00:00+03:00' }, end: { dateTime: '2026-10-15T12:30:00+03:00' } }] })
  const moved = await calendarAction(g.cal(), { op: 'update', id, etag: '"1"', timeZone: 'Europe/Moscow', start: { dateTime: '2026-10-15T13:00:00' }, end: { dateTime: '2026-10-15T13:30:00' } })
  assert.equal(moved.code, 'ok')
  assert.equal(moved.event.id, id)
  assert.equal(g.store.get(id).start.dateTime, '2026-10-15T13:00:00')
  assert.equal((await calendarAction(g.cal(), { op: 'remove', id, etag: '"2"' })).code, 'ok')
  assert.equal(g.store.get(id).status, 'cancelled')
  // The id goes into the path escaped, and only this occurrence's path.
  assert.ok(g.requests.filter((q) => q.method !== 'GET' && !q.path.includes('token')).every((q) => q.path.endsWith(`/events/${id}`)))
})
