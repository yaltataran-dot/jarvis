import { renderPage } from '../page.mjs'

/*
 * GET /page?url=…&mode=… — moved out of server.mjs unchanged.
 * What each mode does to the markup, the fetch, its limits and the SSRF gate
 * (through net.mjs) all stay in page.mjs; this is only the route around it.
 * server.mjs does everything that comes before any route — the Host and
 * Origin checks, OPTIONS, the CORS headers — and hands this handler the
 * `cors` headers and `bridgeOrigin`, the origin the reader mode points its
 * images and its CSP at: `http://localhost:${PORT}`, built there as before.
 * `render` defaults to the real renderPage; only tests pass their own.
 */

export const PAGE_PATH_PREFIX = '/page?'

/**
 * A whole web page, fetched here and served from this origin so it can be
 * framed. The publisher's X-Frame-Options and CORS rules are enforced against
 * the browser, and from the browser's point of view this document is ours —
 * so an article that refuses to be embedded anywhere still opens on the
 * display. See page.mjs for what each mode does to the markup.
 *
 * No Origin header arrives on an iframe navigation, so this rides the same
 * path as an <img> load through the checks at the top of server.mjs's handler.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ cors: Record<string, string>, bridgeOrigin: string, render?: typeof renderPage }} d
 */
export async function pageRequest(req, res, { cors, bridgeOrigin, render = renderPage }) {
  const asked = new URL(req.url, 'http://x')
  const target = asked.searchParams.get('url') ?? ''
  const mode = asked.searchParams.get('mode') === 'live' ? 'live' : 'reader'
  try {
    const page = await render(target, mode, bridgeOrigin)
    res.writeHead(200, { ...cors, ...page.headers })
    return res.end(page.body)
  } catch (err) {
    // Rendered as a page rather than returned as a status, because this lands
    // inside an iframe: a bare 502 body is a blank rectangle on the display,
    // which reads as the interface being broken rather than as the article
    // being unavailable.
    res.writeHead(err.status ?? 502, {
      ...cors,
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
    })
    return res.end(
      `<!doctype html><meta charset="utf-8"><style>
           body{margin:0;padding:26px;background:transparent;color:#7fb6bf;
                font:400 13px/1.6 ui-monospace,monospace}
           b{color:#cfe9ee;font-weight:500;display:block;margin-bottom:6px}
         </style><b>This page could not be opened.</b>${
         String(err?.message ?? 'unknown error').replace(/[<&]/g, '')
       }`,
    )
  }
}
