import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { FILE_PATH_PREFIX, fileRequest, withinRootsOf } from '../bridge/http/file.mjs'

/**
 * GET /file (bridge/http/file.mjs) over real HTTP, against throwaway
 * directories only: an allowed root, a directory outside every root, and a
 * sibling whose name merely starts like the root's. The image types are read
 * from server.mjs, so this tests the bridge's own list. Mostly the refusals:
 * relative paths, `..`, outside roots, symlinks out of the root or onto a
 * non-image, other types, directories, size, read errors. Symlink cases need
 * a platform that lets this user make links; where it cannot, they are
 * skipped and say so (Windows without Developer Mode: EPERM; they were run
 * on Linux). Written against the route while it was still in server.mjs
 * (the last test checked the copy matched; it now checks the wiring).
 */

const CORS = { 'access-control-allow-origin': 'https://page.example', vary: 'origin' }
const serverSrc = readFileSync(new URL('../bridge/server.mjs', import.meta.url), 'utf8').replace(/\r/g, '')
/** The bridge's IMAGE_TYPES, as written in server.mjs. */
const IMAGE_TYPES = Object.fromEntries(
  [...serverSrc.slice(serverSrc.indexOf('const IMAGE_TYPES = {'), serverSrc.indexOf('}', serverSrc.indexOf('const IMAGE_TYPES = {'))).matchAll(/'(\.[a-z]+)': '([a-z/]+)'/g)].map((m) => [m[1], m[2]]),
)
const MAX = 64 * 1024

let base, root, outside, sibling, server, port
let canLink = true
let linkSkip = ''
let fsOverride = null
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 255, 0])

before(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'jarvis-file-test-')))
  root = join(base, 'root')
  outside = join(base, 'outside')
  sibling = join(base, 'root-sibling')
  for (const d of [root, outside, sibling, join(root, 'sub'), join(root, 'dir.png')]) mkdirSync(d, { recursive: true })
  writeFileSync(join(root, 'shot.png'), PNG)
  writeFileSync(join(root, 'photo.JPEG'), PNG)
  writeFileSync(join(root, 'notes.txt'), 'secret notes')
  writeFileSync(join(root, 'drawing.svg'), '<svg onload="alert(1)"/>')
  writeFileSync(join(root, 'noext'), PNG)
  writeFileSync(join(root, 'shot.png.txt'), 'x')
  writeFileSync(join(root, '..weird.png'), PNG)
  writeFileSync(join(root, 'big.png'), Buffer.alloc(MAX + 1, 1))
  writeFileSync(join(outside, 'private.png'), PNG)
  writeFileSync(join(sibling, 'other.png'), PNG)
  try {
    symlinkSync(join(outside, 'private.png'), join(root, 'escape.png'))
    symlinkSync(join(root, 'notes.txt'), join(root, 'disguised.png'))
    symlinkSync(join(root, 'shot.png'), join(root, 'alias.png'))
  } catch (err) {
    canLink = false
    linkSkip = `this user cannot create symbolic links here (${err.code})`
  }
  const withinRoots = withinRootsOf([root])
  server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url?.startsWith(FILE_PATH_PREFIX)) {
      return void fileRequest(req, res, { cors: CORS, imageTypes: IMAGE_TYPES, maxBytes: MAX, withinRoots, ...(fsOverride ? { fs: fsOverride } : {}) })
    }
    res.writeHead(404).end()
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  port = server.address().port
})
after(async () => {
  await new Promise((r) => server.close(r))
  rmSync(base, { recursive: true, force: true })
})

const get = (path) =>
  new Promise((ok, no) => {
    const q = path === undefined ? '/file?' : `/file?path=${encodeURIComponent(path)}`
    http.get({ host: '127.0.0.1', port, path: q }, (res) => {
      const parts = []
      res.on('data', (d) => parts.push(d)).on('end', () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }))
    }).on('error', no)
  })

const refused = async (path, why) => {
  const r = await get(path)
  assert.equal(r.status, 400, `${why}: ${path}`)
  assert.equal(r.body.toString(), 'images only', why)
  assert.equal(r.headers['access-control-allow-origin'], 'https://page.example')
}

test('the image types are the bridge\'s own: png, jpg, jpeg, webp, gif — and no svg', () => {
  assert.deepEqual(IMAGE_TYPES, { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' })
})

test('an image inside a root: 200, its bytes untouched, its type, nosniff and the CORS headers', async () => {
  const r = await get(join(root, 'shot.png'))
  assert.equal(r.status, 200)
  assert.equal(r.headers['content-type'], 'image/png')
  assert.equal(r.headers['x-content-type-options'], 'nosniff')
  assert.equal(r.headers['access-control-allow-origin'], 'https://page.example')
  assert.ok(r.body.equals(PNG))
  const upper = await get(join(root, 'photo.JPEG'))
  assert.equal(upper.status, 200, 'the extension is matched without regard to case')
  assert.equal(upper.headers['content-type'], 'image/jpeg')
})

test('a missing file, even inside a root, is refused as "images only" (it cannot be resolved), not 404', async () => {
  await refused(join(root, 'nothing-here.png'), 'missing')
})

test('no path, a relative path, or the root itself: refused', async () => {
  await refused(undefined, 'no path')
  await refused('', 'empty')
  await refused('shot.png', 'relative')
  await refused(`.${sep}shot.png`, 'relative')
  await refused(root, 'the root itself')
})

test('".." out of the root, an absolute path outside every root, and a sibling that only shares the root\'s prefix: refused', async () => {
  await refused(join(root, 'sub', '..', '..', 'outside', 'private.png'), 'dot-dot out')
  await refused(`${root}${sep}sub${sep}..${sep}..${sep}outside${sep}private.png`, 'dot-dot, unjoined')
  await refused(join(outside, 'private.png'), 'outside')
  await refused(join(sibling, 'other.png'), 'prefix sibling')
})

test('".." that stays inside the root still resolves and is served', async () => {
  const r = await get(join(root, 'sub', '..', 'shot.png'))
  assert.equal(r.status, 200)
})

test('other types are refused: svg, text, no extension, a .png that is really .txt', async () => {
  await refused(join(root, 'drawing.svg'), 'svg')
  await refused(join(root, 'notes.txt'), 'txt')
  await refused(join(root, 'noext'), 'no extension')
  await refused(join(root, 'shot.png.txt'), 'double extension')
})

test('a name that begins with ".." inside the root is refused too (the check is conservative)', async () => {
  await refused(join(root, '..weird.png'), 'leading dots')
})

test('symlinks are judged by where they lead: out of the root refused, onto a non-image refused, onto an image in the root served', async (t) => {
  if (!canLink) return t.skip(linkSkip)
  await refused(join(root, 'escape.png'), 'link out of the root')
  await refused(join(root, 'disguised.png'), 'link onto a text file')
  const r = await get(join(root, 'alias.png'))
  assert.equal(r.status, 200)
  assert.ok(r.body.equals(PNG))
})

test('a directory with an image name, or a file over the limit: 413 "too large"', async () => {
  for (const p of [join(root, 'dir.png'), join(root, 'big.png')]) {
    const r = await get(p)
    assert.equal(r.status, 413, p)
    assert.equal(r.body.toString(), 'too large')
  }
})

test('a file that cannot be read once resolved (permissions, gone meanwhile): 404 "not found"', async () => {
  const eacces = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
  for (const fsx of [
    { realpath: async (p) => p, stat: async () => ({ isFile: () => true, size: 10 }), readFile: async () => { throw eacces } },
    { realpath: async (p) => p, stat: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }, readFile: async () => PNG },
  ]) {
    fsOverride = fsx
    try {
      const r = await get(join(root, 'shot.png'))
      assert.equal(r.status, 404)
      assert.equal(r.body.toString(), 'not found')
    } finally {
      fsOverride = null
    }
  }
})

test('the containment check itself: inside only, never the root, never by prefix, never through ..', () => {
  const within = withinRootsOf([root, outside])
  assert.equal(within(join(root, 'a.png')), true)
  assert.equal(within(join(root, 'sub', 'a.png')), true)
  assert.equal(within(join(outside, 'a.png')), true, 'any of the roots')
  assert.equal(within(root), false)
  assert.equal(within(join(sibling, 'a.png')), false)
  assert.equal(within(join(base, 'a.png')), false)
  assert.equal(withinRootsOf([])(join(root, 'a.png')), false, 'no roots: nothing')
})

test('wiring: /file reaches this handler with the bridge\'s types, limit and roots, after the Host and Origin checks', () => {
  const srv = serverSrc
  assert.equal(FILE_PATH_PREFIX, '/file?')
  assert.match(srv, /import \{ FILE_PATH_PREFIX, fileRequest, withinRootsOf \} from '\.\/http\/file\.mjs'/)
  const route = "if (req.method === 'GET' && req.url?.startsWith(FILE_PATH_PREFIX)) {\n    return fileRequest(req, res, { cors, imageTypes: IMAGE_TYPES, maxBytes: MAX_FILE_BYTES, withinRoots })"
  assert.ok(srv.includes(route), 'no fs passed: the real one, as before')
  assert.ok(srv.includes('const withinRoots = withinRootsOf(FILE_ROOTS)\n'), 'the roots are the bridge\'s FILE_ROOTS')
  assert.ok(srv.includes('const MAX_FILE_BYTES = 25 * 1024 * 1024\n'))
  const at = srv.indexOf(route)
  const handler = srv.indexOf('const handleRequest = async (req, res) => {')
  for (const guard of ['if (!hostAllowed(req.headers.host)) {', 'if (origin && !originAllowed(origin)) {', 'const cors = corsFor(req)']) {
    const g = srv.indexOf(guard, handler)
    assert.ok(g > handler && g < at, `${guard} still runs before the route`)
  }
  assert.ok(srv.indexOf('res.writeHead(404, cors)', at) > at, 'the 404 for anything else still follows')
  assert.ok(!srv.includes("startsWith('/file?')"), 'the old inline route is gone')
  assert.ok(!srv.includes('realpath(asked)'), 'the file reading lives in the route module only')
})
