import { calendarAction } from '../googleCalendar.mjs'

/**
 * POST /calendar — Google Calendar, for the page's calendar flow
 * (src/lib/calendarFlow.ts): status, list, and the writes it sends only after
 * a spoken yes. Always 200 with a result object; what happened is in its
 * `code`.
 *
 * Moved out of server.mjs unchanged. What may be written, and every check of
 * the command, is calendarAction's and the calendar's own (googleCalendar.mjs:
 * JARVIS_CALENDAR_WRITES, never JARVIS_ALLOW_WRITES); this only reads the body
 * and passes the result on. server.mjs still does everything that comes
 * before any route — the Host and Origin checks, OPTIONS, the CORS headers —
 * and hands this handler the `cors` headers it built.
 */

export const CALENDAR_PATH = '/calendar'

/** A command is a small JSON object; anything longer is refused. */
export const MAX_BODY = 8192

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ cors: Record<string, string>, cal: object }} d — `cal` from createGoogleCalendar
 */
export async function calendarRequest(req, res, { cors, cal }) {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > MAX_BODY) {
      req.destroy()
      res.writeHead(413, cors)
      return res.end('body too large')
    }
  }
  let cmd
  try {
    cmd = JSON.parse(body || '{}')
  } catch {
    res.writeHead(400, cors)
    return res.end('bad json')
  }
  const result = await calendarAction(cal, cmd)
  res.writeHead(200, { ...cors, 'content-type': 'application/json' })
  return res.end(JSON.stringify(result))
}
