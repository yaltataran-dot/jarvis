/**
 * Google Calendar, from the bridge: the official Calendar API v3 over plain
 * HTTPS with OAuth 2.0 — no client library, nothing added to package.json.
 *
 * Access is the one scope the job needs, calendar.events: the user's events,
 * read and written. Not their mail, contacts, drive or calendar settings.
 *
 * Secrets, and where they are:
 *   - The OAuth client (the JSON downloaded from Google Cloud) is copied to
 *     %LOCALAPPDATA%\JARVIS\google-oauth-client.json by `npm run
 *     calendar:connect` — outside the project, so it cannot be committed.
 *   - The refresh token is stored next to it encrypted with Windows DPAPI
 *     (dpapi.ps1): only this Windows account on this machine can read it.
 *   - The access token lives in memory only, and is renewed from the refresh
 *     token when it expires.
 *   - None of them is ever logged; the log carries the operation, the outcome,
 *     the HTTP status and the time taken.
 *
 * Writes are double-gated. The bridge refuses them unless
 * JARVIS_CALENDAR_WRITES=1 is set — the general JARVIS_ALLOW_WRITES does not
 * count — and the page sends one only after the spoken command for that very
 * operation ("записывай", "переноси", "меняй", "удаляй") to that very draft
 * (src/lib/calendarFlow.ts). A confirmation never stands in for the setting.
 *
 * No duplicates: every create carries an event id derived from the page's
 * operation id. Sending the same create twice — a retry after a lost answer,
 * a second "да" — gets 409 from Google instead of a second event, and the
 * event that is already there is returned. A write whose answer never came is
 * looked up by that id before anything is said; if it still cannot be
 * established, the answer is 'unknown', never success.
 *
 * Changes are made with the version they were read at (If-Match on the
 * etag): an event edited in the meantime is reported as a conflict, not
 * overwritten.
 */

import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync as nodeExists, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

export const CONFIG_DIR = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'JARVIS')
export const CLIENT_FILE = join(CONFIG_DIR, 'google-oauth-client.json')
export const TOKEN_FILE = join(CONFIG_DIR, 'google-calendar-token.dat')
export const SCOPE = 'https://www.googleapis.com/auth/calendar.events'
export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const API = 'https://www.googleapis.com/calendar/v3/calendars/primary'

/** One request may take this long before it is given up as a timeout. */
const REQUEST_MS = 10_000

/**
 * The event id for an operation. Google allows a-v and 0-9 (base32hex);
 * "jarvis" and lower-case hex are both inside that.
 */
export function eventIdFor(opId) {
  if (!/^[0-9a-f]{8,64}$/.test(String(opId))) throw new Error('bad operation id')
  return `jarvis${opId}`
}

/** The parts of an API event the page uses. */
function slim(e) {
  return {
    id: e.id,
    etag: e.etag,
    summary: e.summary ?? '',
    ...(e.location ? { location: e.location } : {}),
    start: e.start?.dateTime ?? e.start?.date ?? '',
    end: e.end?.dateTime ?? e.end?.date ?? '',
  }
}

/** An HTTP answer from Google, as one of the codes the page knows. */
export function classify(status, body) {
  const reason = body?.error?.errors?.[0]?.reason ?? body?.error?.status ?? ''
  if (status === 401) return 'auth'
  if (status === 403) {
    if (/rateLimit|quota|userRateLimit/i.test(reason)) return 'rate'
    return 'forbidden'
  }
  if (status === 404) return 'not-found'
  if (status === 409) return 'duplicate'
  if (status === 410) return 'gone'
  if (status === 412) return 'conflict'
  if (status === 429) return 'rate'
  if (status >= 500) return 'server'
  return 'failed'
}

class CalError extends Error {
  constructor(code, detail) {
    super(detail || code)
    this.code = code
  }
}

/** A thrown fetch, as a code: a timeout and a dead network are different answers. */
const networkCode = (err) => (err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'network')

/**
 * @param {object} [o]
 * @param {typeof fetch} [o.fetch]
 * @param {(p: string) => boolean} [o.exists]
 * @param {(p: string) => string} [o.read]
 * @param {(p: string, s: string) => void} [o.write]
 * @param {(s: string) => Promise<string>} [o.unprotect]
 * @param {() => number} [o.now]
 * @param {(ms: number) => Promise<void>} [o.sleep]
 * @param {Record<string, string|undefined>} [o.env]
 * @param {(line: string) => void} [o.log]
 */
export function createGoogleCalendar(o = {}) {
  const fetchFn = o.fetch ?? fetch
  const exists = o.exists ?? nodeExists
  const read = o.read ?? ((p) => readFileSync(p, 'utf8'))
  const unprotect = o.unprotect ?? ((s) => dpapi('unprotect', s))
  const now = o.now ?? Date.now
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const env = o.env ?? process.env
  const log = o.log ?? (() => {})

  // Only the calendar's own switch. JARVIS_ALLOW_WRITES opens the shell to the
  // model, and the shell can reach /calendar without any spoken confirmation,
  // so it must never be what turns calendar writes on.
  const writesAllowed = () => env.JARVIS_CALENDAR_WRITES === '1'

  let client = null
  let refreshToken = null
  let access = null // { token, until }
  let revoked = false
  let zone = env.JARVIS_TIMEZONE || null

  const connected = () => !revoked && exists(CLIENT_FILE) && exists(TOKEN_FILE)

  const loadClient = () => {
    if (client) return client
    const raw = JSON.parse(read(CLIENT_FILE))
    const c = raw.installed ?? raw.web ?? raw
    if (!c.client_id) throw new CalError('not-connected', 'OAuth client file has no client_id')
    client = { id: c.client_id, secret: c.client_secret ?? '' }
    return client
  }

  const loadRefresh = async () => {
    if (refreshToken) return refreshToken
    if (!exists(TOKEN_FILE)) throw new CalError('not-connected')
    const saved = JSON.parse(await unprotect(read(TOKEN_FILE).trim()))
    if (!saved.refresh_token) throw new CalError('not-connected')
    refreshToken = saved.refresh_token
    return refreshToken
  }

  /** A valid access token, renewed from the refresh token when it runs out. */
  const accessToken = async (force = false) => {
    if (!force && access && now() < access.until) return access.token
    if (!connected()) throw new CalError('not-connected')
    const c = loadClient()
    const rt = await loadRefresh()
    let res
    try {
      res = await fetchFn(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt, client_id: c.id, client_secret: c.secret }).toString(),
        signal: AbortSignal.timeout(REQUEST_MS),
      })
    } catch (err) {
      throw new CalError(networkCode(err), 'token refresh did not complete')
    }
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      // invalid_grant: the user revoked access, or the token aged out. Only a
      // new connect brings it back; say so rather than retrying for ever.
      if (body.error === 'invalid_grant' || res.status === 400 || res.status === 401) {
        revoked = true
        access = null
        throw new CalError('auth', `token refresh refused (${body.error ?? res.status})`)
      }
      throw new CalError(classify(res.status, body), `token refresh failed (${res.status})`)
    }
    if (typeof body.scope === 'string' && !body.scope.split(' ').includes(SCOPE)) {
      throw new CalError('forbidden', 'the granted access does not include calendar events')
    }
    access = { token: body.access_token, until: now() + Math.max(60, (body.expires_in ?? 3600) - 60) * 1000 }
    return access.token
  }

  /** One API call. A 401 renews the token once and tries again. */
  const call = async (method, path, { query, body, etag } = {}) => {
    const url = `${API}${path}${query ? `?${new URLSearchParams(query)}` : ''}`
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await accessToken(attempt > 0)
      let res
      try {
        res = await fetchFn(url, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(body ? { 'content-type': 'application/json' } : {}),
            ...(etag ? { 'if-match': etag } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(REQUEST_MS),
        })
      } catch (err) {
        throw new CalError(networkCode(err))
      }
      if (res.status === 401 && attempt === 0) continue
      const json = res.status === 204 ? null : await res.json().catch(() => null)
      if (!res.ok) throw new CalError(classify(res.status, json), `HTTP ${res.status}`)
      return json
    }
    throw new CalError('auth')
  }

  /** Reads are safe to repeat: one more try on a passing fault. */
  const readCall = async (...args) => {
    try {
      return await call(...args)
    } catch (err) {
      if (!['network', 'timeout', 'server'].includes(err.code)) throw err
      await sleep(500)
      return call(...args)
    }
  }

  const getEvent = async (id) => {
    try {
      return await readCall('GET', `/events/${encodeURIComponent(id)}`)
    } catch (err) {
      if (err.code === 'not-found' || err.code === 'gone') return null
      throw err
    }
  }

  // -- operations ----------------------------------------------------------------

  const status = async () => {
    const ok = connected()
    // The calendar's own zone, learnt from any list (the events resource
    // carries it): the user's zone, not the server's.
    if (ok && !zone) {
      try {
        const r = await readCall('GET', '/events', { query: { maxResults: '1' } })
        if (r?.timeZone) zone = r.timeZone
      } catch {
        /* the status is still worth answering */
      }
    }
    return {
      code: 'ok',
      connected: ok,
      writes: writesAllowed(),
      timeZone: zone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    }
  }

  const list = async ({ timeMin, timeMax }) => {
    const out = []
    let pageToken
    for (let page = 0; page < 5; page++) {
      const r = await readCall('GET', '/events', {
        query: {
          timeMin,
          timeMax,
          singleEvents: 'true',
          orderBy: 'startTime',
          maxResults: '100',
          ...(zone ? { timeZone: zone } : {}),
          ...(pageToken ? { pageToken } : {}),
        },
      })
      if (r?.timeZone && !env.JARVIS_TIMEZONE) zone = r.timeZone
      for (const e of r?.items ?? []) if (e.status !== 'cancelled') out.push(slim(e))
      pageToken = r?.nextPageToken
      if (!pageToken) break
    }
    return { code: 'ok', events: out }
  }

  const create = async (e) => {
    if (!writesAllowed()) return { code: 'writes-disabled' }
    const id = eventIdFor(e.opId)
    const withZone = (t) => (t.dateTime ? { dateTime: t.dateTime, timeZone: e.timeZone } : { date: t.date })
    const body = {
      id,
      summary: e.summary,
      ...(e.location ? { location: e.location } : {}),
      start: withZone(e.start),
      end: withZone(e.end),
      ...(typeof e.reminderMin === 'number'
        ? { reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: e.reminderMin }] } }
        : {}),
    }
    /** Already there, under this operation's id? */
    const found = async () => {
      const ev = await getEvent(id)
      if (!ev) return null
      if (ev.status === 'cancelled') return { code: 'failed', message: 'встреча с этим номером уже была удалена' }
      return { code: 'ok', event: slim(ev), already: true }
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const ev = await call('POST', '/events', { body })
        return { code: 'ok', event: slim(ev) }
      } catch (err) {
        if (err.code === 'duplicate') return (await found()) ?? { code: 'failed', message: 'Google сообщил о дубле, но встречи не видно' }
        if (!['network', 'timeout', 'server'].includes(err.code)) return { code: err.code, message: err.message }
        // The answer was lost — the event may or may not exist. Look before
        // trying again; the retry carries the same id, so it cannot duplicate.
        const there = await found().catch(() => undefined)
        if (there) return there
        if (there === undefined) return { code: 'unknown' }
        await sleep(700)
      }
    }
    return { code: 'unknown' }
  }

  const update = async (e) => {
    if (!writesAllowed()) return { code: 'writes-disabled' }
    const withZone = (t) => (t.dateTime ? { dateTime: t.dateTime, timeZone: e.timeZone } : { date: t.date })
    const body = {
      ...(e.start ? { start: withZone(e.start) } : {}),
      ...(e.end ? { end: withZone(e.end) } : {}),
      ...(e.location !== undefined ? { location: e.location } : {}),
    }
    const applied = (ev) =>
      (!e.location || ev.location === e.location) &&
      (!e.start?.dateTime || String(ev.start?.dateTime ?? '').startsWith(e.start.dateTime.slice(0, 16))) &&
      (!e.start?.date || ev.start?.date === e.start.date)
    try {
      const ev = await call('PATCH', `/events/${encodeURIComponent(e.id)}`, { body, etag: e.etag })
      return { code: 'ok', event: slim(ev) }
    } catch (err) {
      if (err.code === 'gone') return { code: 'not-found' }
      if (!['network', 'timeout', 'server'].includes(err.code)) return { code: err.code, message: err.message }
      // Lost answer: did the change land?
      const ev = await getEvent(e.id).catch(() => undefined)
      if (ev === undefined) return { code: 'unknown' }
      if (!ev || ev.status === 'cancelled') return { code: 'not-found' }
      return applied(ev) ? { code: 'ok', event: slim(ev) } : { code: 'unknown' }
    }
  }

  const remove = async (e) => {
    if (!writesAllowed()) return { code: 'writes-disabled' }
    try {
      await call('DELETE', `/events/${encodeURIComponent(e.id)}`, { etag: e.etag })
      return { code: 'ok' }
    } catch (err) {
      // 410: deleted already — a second delete of the same event, which is
      // what the user wanted either way.
      if (err.code === 'gone') return { code: 'ok', already: true }
      if (!['network', 'timeout', 'server'].includes(err.code)) return { code: err.code, message: err.message }
      const ev = await getEvent(e.id).catch(() => undefined)
      if (ev === undefined) return { code: 'unknown' }
      if (!ev || ev.status === 'cancelled') return { code: 'ok' }
      return { code: 'unknown' }
    }
  }

  /** Every operation: a result object, never a throw; logged without secrets or content. */
  const run = (name, fn) => async (arg) => {
    const t0 = now()
    let r
    try {
      r = await fn(arg)
    } catch (err) {
      r = { code: err instanceof CalError ? err.code : 'failed', message: err instanceof CalError ? undefined : String(err?.message ?? err) }
      if (r.code === 'duplicate' || r.code === 'gone') r.code = 'failed'
      if (r.code === 'timeout' || r.code === 'server') r.code = 'network'
    }
    if (r.code === 'timeout' || r.code === 'server') r.code = name === 'list' ? 'network' : 'unknown'
    log(`[jarvis] calendar ${name} -> ${r.code}${r.already ? ' (already)' : ''} ${now() - t0} ms${r.code !== 'ok' && r.message ? ` (${r.message})` : ''}`)
    return r
  }

  return {
    status: run('status', status),
    list: run('list', list),
    create: run('create', create),
    update: run('update', update),
    remove: run('remove', remove),
    /** For the connect script: the client config as Google issued it. */
    loadClient,
  }
}

/** Run dpapi.ps1 with the text on stdin; its output. */
export function dpapi(mode, text, { spawn = nodeSpawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, 'dpapi.ps1'), '-Mode', mode],
      { windowsHide: true, shell: false },
    )
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    const timer = setTimeout(() => child.kill(), 20_000)
    child.once('error', (e) => (clearTimeout(timer), reject(e)))
    child.once('close', (code) => {
      clearTimeout(timer)
      // stderr may carry the reason, never the secret: the text went in on stdin.
      if (code !== 0) return reject(new Error(`DPAPI ${mode} failed${err ? `: ${err.trim().split('\n')[0].slice(0, 120)}` : ''}`))
      resolve(out)
    })
    child.stdin.end(text)
  })
}

/** Save the refresh token, encrypted, where the bridge will look for it. */
export async function saveToken(refreshToken, { protect = (s) => dpapi('protect', s), write = writeFileSync } = {}) {
  mkdirSync(CONFIG_DIR, { recursive: true })
  const sealed = await protect(JSON.stringify({ refresh_token: refreshToken, scope: SCOPE, saved: new Date().toISOString() }))
  write(TOKEN_FILE, sealed)
}

// ---------------------------------------------------------------------------
// The /calendar route
// ---------------------------------------------------------------------------

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/
const LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const ZONE = /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/
/**
 * An event id as Google issues it: base32hex. One occurrence of a recurring
 * event — what a list with singleEvents gives — is the series' id, "_", and
 * the occurrence's original start: "…_20261015T090000Z" (UTC), or
 * "…_20261015" for an all-day one. Nothing else is let through.
 */
const ID = /^[a-v0-9]{5,1024}(?:_\d{8}(?:T\d{6}Z)?)?$/
/** A string, so 12345 or ['abc12'] is not read as one. */
const isEventId = (v) => typeof v === 'string' && ID.test(v)

const text = (v, max) => (typeof v === 'string' ? v.replace(/\p{Cc}+/gu, ' ').trim().slice(0, max) : '')
const time = (t) => {
  if (!t || typeof t !== 'object') return null
  if (typeof t.dateTime === 'string' && LOCAL.test(t.dateTime)) return { dateTime: t.dateTime }
  if (typeof t.date === 'string' && DATE.test(t.date)) return { date: t.date }
  return null
}

/** The /calendar route's dispatcher: an operation and its arguments, checked. */
export function calendarAction(cal, body) {
  const op = String(body?.op ?? '')
  const bad = (message) => Promise.resolve({ code: 'failed', message })
  switch (op) {
    case 'status':
      return cal.status()
    case 'list':
      if (!RFC3339.test(body.timeMin ?? '') || !RFC3339.test(body.timeMax ?? '')) return bad('неверный период')
      return cal.list({ timeMin: body.timeMin, timeMax: body.timeMax })
    case 'create': {
      const start = time(body.start)
      const end = time(body.end)
      if (!/^[0-9a-f]{8,64}$/.test(String(body.opId ?? ''))) return bad('неверный номер операции')
      if (!start || !end || !ZONE.test(String(body.timeZone ?? ''))) return bad('неверное время')
      const summary = text(body.summary, 300)
      if (!summary) return bad('нет названия')
      const reminder = Number(body.reminderMin)
      return cal.create({
        opId: body.opId,
        summary,
        ...(text(body.location, 300) ? { location: text(body.location, 300) } : {}),
        timeZone: body.timeZone,
        start,
        end,
        ...(Number.isInteger(reminder) && reminder >= 0 && reminder <= 40320 ? { reminderMin: reminder } : {}),
      })
    }
    case 'update': {
      if (!isEventId(body.id)) return bad('неверный номер встречи')
      const start = body.start ? time(body.start) : undefined
      const end = body.end ? time(body.end) : undefined
      if (start === null || end === null || !ZONE.test(String(body.timeZone ?? ''))) return bad('неверное время')
      const location = body.location !== undefined ? text(body.location, 300) : undefined
      return cal.update({
        id: body.id,
        ...(typeof body.etag === 'string' ? { etag: body.etag.slice(0, 200) } : {}),
        timeZone: body.timeZone,
        ...(start ? { start } : {}),
        ...(end ? { end } : {}),
        ...(location !== undefined ? { location } : {}),
      })
    }
    case 'remove':
      if (!isEventId(body.id)) return bad('неверный номер встречи')
      return cal.remove({ id: body.id, ...(typeof body.etag === 'string' ? { etag: body.etag.slice(0, 200) } : {}) })
    default:
      return bad('неизвестная операция')
  }
}
