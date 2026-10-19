import { answerRequest } from '../knowledgeRoute.mjs'

/**
 * POST /knowledge/answer — a question the page asks before it asks Claude: is
 * it one the user has already told JARVIS the answer to? Read-only; a miss is
 * a normal 200 with hit:false, and a bridge without a database simply always
 * misses.
 *
 * Moved out of server.mjs unchanged. server.mjs still does everything that
 * comes before any route — the Host and Origin checks, OPTIONS, the CORS
 * headers — and hands this handler the `cors` headers it built.
 */

export const KNOWLEDGE_ANSWER_PATH = '/knowledge/answer'

/** The request body is a short JSON object; anything longer is refused. */
export const MAX_BODY = 4096

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ cors: Record<string, string>, kb: object | null, log: (line: string) => void, defer: (fn: () => void) => void }} d
 */
export async function knowledgeAnswer(req, res, { cors, kb, log, defer }) {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > MAX_BODY) {
      req.destroy()
      res.writeHead(413, cors)
      return res.end('body too large')
    }
  }
  let ask
  try {
    ask = JSON.parse(body || '{}')
  } catch {
    res.writeHead(400, cors)
    return res.end('bad json')
  }
  const result = answerRequest(kb, ask, { log, defer })
  res.writeHead(200, { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' })
  return res.end(JSON.stringify(result))
}
