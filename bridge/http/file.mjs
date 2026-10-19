import { readFile as fsReadFile, realpath as fsRealpath, stat as fsStat } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'

/**
 * GET /file?path=… — local image files for the page. Screenshots and generated
 * art land on disk as absolute paths, and a page served over http can't read
 * file:// — so the bridge, which can, hands them over.
 *
 * Moved out of server.mjs unchanged. What stays there and is passed in: the
 * image types, the size limit and the roots (FILE_ROOTS, realpath'd at boot),
 * as `withinRoots` built from them with `withinRootsOf` below — the
 * containment check itself, moved here verbatim so it can be tested.
 * server.mjs also does everything that comes before any route — the Host and
 * Origin checks, OPTIONS, the CORS headers — and hands this handler the
 * `cors` headers. `fs` defaults to the real functions; tests pass their own.
 */

export const FILE_PATH_PREFIX = '/file?'

/**
 * True when `real` sits inside one of the roots, after both are resolved.
 * @param {string[]} roots — already realpath'd
 */
export const withinRootsOf = (roots) => (real) =>
  roots.some((root) => {
    const rel = relative(root, real)
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  })

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{
 *   cors: Record<string, string>,
 *   imageTypes: Record<string, string>,
 *   maxBytes: number,
 *   withinRoots: (real: string) => boolean,
 *   fs?: { realpath: typeof fsRealpath, stat: typeof fsStat, readFile: typeof fsReadFile },
 * }} d
 */
export async function fileRequest(req, res, { cors, imageTypes, maxBytes, withinRoots, fs = { realpath: fsRealpath, stat: fsStat, readFile: fsReadFile } }) {
  const { realpath, stat, readFile } = fs
  const asked = new URL(req.url, 'http://x').searchParams.get('path') ?? ''
  // Resolve symlinks BEFORE judging anything. A name ending in .png can be a
  // link pointing at /etc/hosts, and checking the suffix the caller supplied
  // would wave that straight through — which is exactly how this endpoint
  // used to serve the contents of arbitrary system files.
  let real = null
  try {
    if (isAbsolute(asked)) real = await realpath(asked)
  } catch {
    real = null
  }
  const dot = real ? real.lastIndexOf('.') : -1
  const ext = dot === -1 ? '' : real.slice(dot).toLowerCase()
  // Images only, absolute paths only, and only under roots we expect things
  // to be written to. This endpoint exists to show pictures, not to be a
  // general file read for whatever the model — or another page — asks for.
  if (!real || !Object.hasOwn(imageTypes, ext) || !withinRoots(real)) {
    res.writeHead(400, cors)
    return res.end('images only')
  }
  try {
    const info = await stat(real)
    if (!info.isFile() || info.size > maxBytes) {
      res.writeHead(413, cors)
      return res.end('too large')
    }
    // Asynchronous because this process is also pumping the agent's token
    // stream; a synchronous read of a large screenshot stalls the voice.
    const body = await readFile(real)
    res.writeHead(200, {
      ...cors,
      'content-type': imageTypes[ext],
      'x-content-type-options': 'nosniff',
    })
    return res.end(body)
  } catch {
    res.writeHead(404, cors)
    return res.end('not found')
  }
}
