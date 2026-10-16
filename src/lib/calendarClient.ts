import { BRIDGE_HTTP_URL } from '../config'
import type { CalApi, CalResult, CalStatus } from './calendarFlow'

/**
 * The calendar flow's api, backed by the bridge's /calendar route
 * (bridge/googleCalendar.mjs). Never throws: a bridge that is down or slow
 * comes back as code 'bridge', which the flow says out loud. A write that
 * timed out here may still have reached Google, so it comes back as
 * 'unknown' — never as a failure that would invite a blind retry.
 */
async function post(body: Record<string, unknown>, writing: boolean): Promise<CalResult> {
  try {
    const res = await fetch(`${BRIDGE_HTTP_URL}/calendar`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      // The bridge itself gives up on Google within about 25 s (a lost write
      // is looked up before it answers); this only catches a bridge that hangs.
      signal: AbortSignal.timeout(40_000),
    })
    if (!res.ok) return { code: 'bridge' }
    const r = (await res.json()) as CalResult
    return r && typeof r.code === 'string' ? r : { code: writing ? 'unknown' : 'bridge' }
  } catch (err) {
    // A bridge that refused the connection never sent anything on; one that
    // timed out may have — for a write, that is an unknown, not a failure.
    const timedOut = err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')
    return { code: writing && timedOut ? 'unknown' : 'bridge' }
  }
}

export const bridgeCalendar: CalApi = {
  async status() {
    const r = (await post({ op: 'status' }, false)) as CalResult & Partial<CalStatus>
    if (r.code !== 'ok') return null
    return { connected: !!r.connected, writes: !!r.writes, timeZone: String(r.timeZone ?? '') }
  },
  list: (timeMin, timeMax) => post({ op: 'list', timeMin, timeMax }, false),
  create: (e) => post({ op: 'create', ...e }, true),
  update: (e) => post({ op: 'update', ...e }, true),
  remove: (e) => post({ op: 'remove', ...e }, true),
}
