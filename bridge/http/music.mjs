import { musicAction } from '../yandexMusic.mjs'

/**
 * POST /music — Yandex Music, for the commands the page recognises itself
 * ("пауза", "следующий трек"), with no model turn. Answers 200 with a result
 * object; what happened is in its `code` (see yandexMusic.mjs).
 *
 * Moved out of server.mjs unchanged. Which actions exist, how a command is
 * checked and every call to the player — with its own time limits — are
 * musicAction's and yandexMusic.mjs's; this only reads the body and passes the
 * result on. A player call that throws is not caught here: it reaches the
 * bridge's request handler, which answers 500 (server.mjs). server.mjs also
 * does everything that comes before any route — the Host and Origin checks,
 * OPTIONS, the CORS headers — and hands this handler the `cors` headers.
 */

export const MUSIC_PATH = '/music'

/** A command is a small JSON object; anything longer is refused. */
export const MAX_BODY = 4096

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ cors: Record<string, string>, ym: object }} d — `ym` from createYandexMusic
 */
export async function musicRequest(req, res, { cors, ym }) {
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
  const result = await musicAction(ym, cmd)
  res.writeHead(200, { ...cors, 'content-type': 'application/json' })
  return res.end(JSON.stringify(result))
}
