/**
 * What «Юг-Трансфер» may do on this computer, and nothing else.
 *
 * Every action goes through here, and every action is one of a fixed list:
 * open an approved application, list a folder, find a file, read a text file,
 * run one of the project's own checks. There is no way to pass a command line,
 * an executable or a script — the model picks from enums and supplies paths,
 * and the paths are checked against the allowed folders before every use.
 *
 * Why this exists rather than the SDK's built-in Read, Glob, Grep and Bash:
 * those run from the home directory with no boundary at all — the SSH keys,
 * Claude's own credentials and every .env file on the machine were one Read
 * away. They are switched off in the default mode (server.mjs), and these
 * replace them with a surface small enough to reason about.
 *
 * Kept free of the SDK so the tests can drive it against a scratch folder;
 * pc.mjs wraps it as the MCP server the model sees.
 */

import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The project this bridge lives in — the one folder allowed by default. */
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const LIMITS = {
  /** Larger files are refused outright, not truncated. */
  readBytes: 256 * 1024,
  /** Characters of a file handed back in one read. */
  readChars: 12_000,
  /** Lines in one read; `from_line` pages through the rest. */
  readLines: 300,
  listEntries: 100,
  findResults: 40,
  findVisited: 20_000,
  findDepth: 10,
  findMs: 5_000,
  /** Characters of a check's output handed back. */
  checkChars: 4_000,
  /** The same application is not started twice inside this window. */
  reopenMs: 10_000,
}

// ---------------------------------------------------------------------------
// Secrets

/**
 * Names that are never listed, found or read. Deliberately broad: a file named
 * `tokens.css` is refused along with `.env`, and that is the right way round —
 * a refusal costs a sentence, a leak cannot be taken back.
 */
const SECRET_NAMES = [
  /^\.env(\..*)?$/i,
  /\.(pem|key|p12|pfx|crt|cer|der|jks|keystore|kdbx|ppk|asc|gpg|ovpn)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /secret|credential|password|passwd|token|api[-_]?key|private[-_]?key/i,
  /^\.(npmrc|pypirc|netrc|git-credentials|claude\.json|ssh|aws|gnupg|azure|kube|docker)$/i,
  // Git's own folder: remotes and config can carry tokens in their URLs.
  /^\.git$/i,
]

export const isSecretName = (name) => SECRET_NAMES.some((re) => re.test(name))

/** Folders a search never descends into: generated, vendored, or huge. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.vite', '.cache', '.next', '.turbo'])

/**
 * Key-shaped strings inside otherwise readable text. A README that quotes a
 * real key, or a test log that prints one, still never sends it on.
 */
const SECRET_VALUES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-ant-[\w-]{10,}/g,
  /\bsk-[A-Za-z0-9]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[\w-]{10,}/g,
  /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g,
]
const SECRET_ASSIGNMENT =
  /((?:password|passwd|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|auth)[\w-]*["']?\s*[:=]\s*)(["']?)[^\s"',;]{4,}\2/gi

export function redact(text) {
  let out = String(text)
  for (const re of SECRET_VALUES) out = out.replace(re, '[скрыто]')
  return out.replace(SECRET_ASSIGNMENT, '$1$2[скрыто]$2')
}

// ---------------------------------------------------------------------------
// Paths

export class Refusal extends Error {}

const inside = (root, p) => {
  const rel = relative(root, p)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Turn what the model asked for into a path that is certainly inside an
 * allowed folder, or refuse. Relative paths are taken from the first root.
 * `..` is refused as written, not merely resolved away; symbolic links and
 * junctions are followed and the real target checked again, so a link inside
 * the project that points at the home directory leads nowhere.
 */
export function resolveSafe(input, roots) {
  const raw = String(input ?? '').trim() || '.'
  if (raw.length > 400 || raw.includes('\0')) throw new Refusal('Недопустимый путь.')
  // UNC shares, device paths, and "C:file" (relative to a drive's cwd).
  if (/^[\\/]{2}/.test(raw) || /^[a-z]:(?![\\/])/i.test(raw)) throw new Refusal('Такие пути не поддерживаются.')
  if (raw.split(/[\\/]+/).includes('..')) throw new Refusal('Переход в родительскую папку через «..» запрещён.')

  const candidate = isAbsolute(raw) ? resolve(raw) : resolve(roots[0], raw)
  const root = roots.find((r) => inside(r, candidate))
  if (!root) throw new Refusal('Этот путь вне разрешённых папок.')

  const guard = (r, p) => {
    for (const part of relative(r, p).split(sep)) {
      if (part && isSecretName(part)) throw new Refusal('Это закрытый файл: ключи, пароли и токены не читаются.')
    }
  }
  guard(root, candidate)

  let real = candidate
  let realRoot = root
  if (existsSync(candidate)) {
    real = realpathSync.native(candidate)
    realRoot = roots.find((r) => inside(r, real))
    if (!realRoot) throw new Refusal('Ссылка ведёт за пределы разрешённых папок.')
    // And the name it really has: a link called notes.txt onto .env is .env.
    guard(realRoot, real)
  }
  return { abs: real, root: realRoot, rel: relative(realRoot, real) || '.' }
}

/** The display form of a path: relative to its root, forward slashes. */
const show = (root, p) => (relative(root, p) || '.').split(sep).join('/')

// ---------------------------------------------------------------------------
// Applications

/**
 * The applications that may be opened, each with a fixed executable and fixed
 * arguments. The model names one by key; nothing it says reaches a command line.
 */
const SYSTEM_ROOT = process.env.SystemRoot || 'C:\\Windows'
export const APPS = {
  notepad: { label: 'Блокнот', exe: join(SYSTEM_ROOT, 'System32', 'notepad.exe'), args: [] },
  calculator: { label: 'Калькулятор', exe: join(SYSTEM_ROOT, 'System32', 'calc.exe'), args: [] },
  explorer: { label: 'Проводник с папкой проекта', exe: join(SYSTEM_ROOT, 'explorer.exe'), args: [PROJECT_ROOT] },
}

// ---------------------------------------------------------------------------
// Checks

/**
 * The project's own checks, run with the Node that runs the bridge and fixed
 * arguments — no shell, no npm, nothing taken from package.json at run time,
 * so editing a script there cannot change what this executes. None of them
 * writes to the project: tests and lint only read, and the type check is
 * noEmit (it keeps an incremental cache under node_modules/.tmp).
 */
export const CHECKS = {
  tests: {
    label: 'тесты',
    args: ['--import', 'tsx', '--test', 'tests/*.test.*'],
    timeoutMs: 180_000,
  },
  lint: {
    label: 'линтер',
    args: ['node_modules/oxlint/bin/oxlint'],
    timeoutMs: 60_000,
  },
  typecheck: {
    label: 'проверка типов',
    args: ['node_modules/typescript/bin/tsc', '-b'],
    timeoutMs: 120_000,
  },
}

const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;?]*[A-Za-z]', 'g')

/** The figures worth saying out loud, pulled from a check's output. */
export function summariseCheck(check, code, output) {
  const n = (re) => Number(re.exec(output)?.[1] ?? NaN)
  if (check === 'tests') {
    const pass = n(/^ℹ pass (\d+)/m)
    const fail = n(/^ℹ fail (\d+)/m)
    if (Number.isFinite(pass)) return `тестов пройдено: ${pass}, не пройдено: ${Number.isFinite(fail) ? fail : 0}`
  }
  if (check === 'lint') {
    // With a terminal oxlint ends on "Found N warnings and M errors"; piped,
    // as here, it prints only one line per finding.
    const w = n(/Found (\d+) warnings?/i)
    const e = n(/and (\d+) errors?/i)
    if (Number.isFinite(w)) return `предупреждений: ${w}, ошибок: ${Number.isFinite(e) ? e : 0}`
    const count = (kind) => (output.match(new RegExp(`:\\d+:\\d+: ${kind} `, 'g')) ?? []).length
    return `предупреждений: ${count('warning')}, ошибок: ${count('error')}`
  }
  if (check === 'typecheck') {
    const errors = (output.match(/error TS\d+/g) ?? []).length
    return errors ? `ошибок типов: ${errors}` : code === 0 ? 'ошибок типов нет' : ''
  }
  return ''
}

// ---------------------------------------------------------------------------

/**
 * @param {object} [o]
 * @param {string[]} [o.roots]   allowed folders; the first is the default
 * @param {Function} [o.spawn]   child_process.spawn, replaceable in tests
 * @param {string} [o.platform]
 * @param {() => number} [o.now]
 * @param {(line: string) => void} [o.log]
 */
export function createComputer(o = {}) {
  const roots = (o.roots ?? [PROJECT_ROOT]).map((r) => {
    const abs = resolve(r)
    return existsSync(abs) ? realpathSync.native(abs) : abs
  })
  const spawn = o.spawn ?? nodeSpawn
  const platform = o.platform ?? process.platform
  const now = o.now ?? Date.now
  const log = o.log ?? (() => {})
  const lastOpened = new Map()
  const running = new Map()

  /** Every operation, timed and logged by name and path only — never content. */
  const logged = (op, detail, fn) => async (...args) => {
    const t0 = now()
    try {
      const out = await fn(...args)
      log(`[jarvis] pc ${op} ${detail(...args)} -> ok ${now() - t0} ms`)
      return out
    } catch (err) {
      log(`[jarvis] pc ${op} ${detail(...args)} -> ${err instanceof Refusal ? 'refused' : 'failed'}: ${err.message}`)
      throw err
    }
  }

  const openApp = logged('open_app', (app) => String(app), async (app) => {
    const a = APPS[app]
    if (!a) throw new Refusal(`Такого приложения нет в разрешённом списке. Можно: ${Object.values(APPS).map((x) => x.label).join(', ')}.`)
    if (platform !== 'win32') throw new Refusal('Открывать приложения можно только в Windows.')
    // The same request twice in a row — an echo, a repeated phrase — opens
    // one window, not two.
    const last = lastOpened.get(app) ?? -Infinity
    if (now() - last < LIMITS.reopenMs) return { app, label: a.label, already: true }
    if (!existsSync(a.exe)) throw new Error(`${a.label} не найден на этом компьютере.`)
    await new Promise((res, rej) => {
      const child = spawn(a.exe, a.args, { detached: true, stdio: 'ignore', windowsHide: false, shell: false })
      child.once('error', rej)
      child.once('spawn', res)
      child.unref?.()
    })
    lastOpened.set(app, now())
    return { app, label: a.label, already: false }
  })

  const listDir = logged('list_dir', (p) => String(p ?? '.'), async (path = '.', limit = LIMITS.listEntries) => {
    const { abs, root } = resolveSafe(path, roots)
    if (!(await stat(abs)).isDirectory()) throw new Refusal('Это файл, а не папка.')
    const all = await readdir(abs, { withFileTypes: true })
    let hidden = 0
    const entries = []
    for (const d of all) {
      if (isSecretName(d.name)) {
        hidden++
        continue
      }
      entries.push({
        name: d.name,
        type: d.isSymbolicLink() ? 'link' : d.isDirectory() ? 'dir' : 'file',
      })
    }
    entries.sort((a, b) => (a.type === 'dir') === (b.type === 'dir') ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1)
    const cap = Math.max(1, Math.min(Number(limit) || LIMITS.listEntries, 200))
    return { path: show(root, abs), entries: entries.slice(0, cap), total: entries.length, hidden }
  })

  const findFiles = logged('find_files', (q, p) => `${q} in ${p ?? '.'}`, async (query, path = '.') => {
    const q = String(query ?? '').trim()
    if (!q || q.length > 100 || /[\\/]/.test(q)) throw new Refusal('Нужно имя файла или его часть, без пути.')
    const { abs, root } = resolveSafe(path, roots)
    // `*` and `?` as wildcards; otherwise a case-insensitive substring.
    const re = /[*?]/.test(q)
      ? new RegExp('^' + q.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')
      : null
    const match = (name) => (re ? re.test(name) : name.toLowerCase().includes(q.toLowerCase()))

    const found = []
    let visited = 0
    let cut = false
    const deadline = now() + LIMITS.findMs
    const queue = [[abs, 0]]
    while (queue.length) {
      const [dir, depth] = queue.shift()
      let items
      try {
        items = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const d of items) {
        if (++visited > LIMITS.findVisited || now() > deadline) {
          cut = true
          break
        }
        if (isSecretName(d.name)) continue
        const full = join(dir, d.name)
        if (match(d.name)) found.push({ path: show(root, full), type: d.isDirectory() ? 'dir' : 'file' })
        // Links are never followed — that is how a search leaves the folder.
        if (d.isDirectory() && !d.isSymbolicLink() && !SKIP_DIRS.has(d.name) && depth < LIMITS.findDepth) {
          queue.push([full, depth + 1])
        }
        if (found.length >= LIMITS.findResults) {
          cut = true
          break
        }
      }
      if (cut) break
    }
    return { query: q, in: show(root, abs), results: found, truncated: cut }
  })

  const readFile = logged('read_file', (p) => String(p), async (path, fromLine = 1) => {
    const { abs, root } = resolveSafe(path, roots)
    // abs is already the real path, so this is the target, not a link.
    const st = await stat(abs)
    if (st.isDirectory()) throw new Refusal('Это папка, а не файл.')
    if (st.size > LIMITS.readBytes) throw new Refusal(`Файл слишком большой для чтения: ${Math.round(st.size / 1024)} КБ, предел ${LIMITS.readBytes / 1024} КБ.`)
    const fh = await open(abs, 'r')
    let buf
    try {
      buf = await fh.readFile()
    } finally {
      await fh.close()
    }
    if (buf.subarray(0, 8192).includes(0)) throw new Refusal('Это не текстовый файл.')
    const lines = buf.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/)
    const start = Math.max(1, Math.floor(Number(fromLine) || 1))
    let text = lines.slice(start - 1, start - 1 + LIMITS.readLines).join('\n')
    let truncated = start - 1 + LIMITS.readLines < lines.length
    if (text.length > LIMITS.readChars) {
      text = text.slice(0, LIMITS.readChars)
      truncated = true
    }
    return { path: show(root, abs), totalLines: lines.length, fromLine: start, truncated, text: redact(text) }
  })

  const runCheck = logged('run_check', (c) => String(c), async (check, signal) => {
    const c = CHECKS[check]
    if (!c) throw new Refusal(`Такой проверки нет. Можно: ${Object.keys(CHECKS).join(', ')}.`)
    // Asked again while it runs — a repeated phrase, an echo — the second ask
    // waits for the first rather than starting another.
    if (running.has(check)) return { ...(await running.get(check)), joined: true }
    const job = new Promise((res) => {
      const t0 = now()
      let out = ''
      const child = spawn(process.execPath, c.args, {
        cwd: PROJECT_ROOT,
        shell: false,
        windowsHide: true,
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      })
      const take = (b) => {
        if (out.length < 200_000) out += b.toString()
      }
      child.stdout?.on('data', take)
      child.stderr?.on('data', take)
      let why = ''
      const kill = (reason) => {
        if (why) return
        why = reason
        // The whole tree: node --test runs each file in its own process.
        if (platform === 'win32' && child.pid) {
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, shell: false })
        } else child.kill('SIGKILL')
      }
      const timer = setTimeout(() => kill('timeout'), c.timeoutMs)
      const onAbort = () => kill('cancelled')
      signal?.addEventListener?.('abort', onAbort, { once: true })
      const done = (code) => {
        clearTimeout(timer)
        signal?.removeEventListener?.('abort', onAbort)
        const clean = redact(out.replace(ANSI, ''))
        res({
          check,
          label: c.label,
          exitCode: code,
          ok: code === 0 && !why,
          stopped: why || null,
          seconds: Math.round((now() - t0) / 100) / 10,
          summary: summariseCheck(check, code, clean),
          tail: clean.trim().split(/\r?\n/).slice(-40).join('\n').slice(-LIMITS.checkChars),
        })
      }
      child.once('error', (err) => {
        out += `\n${err.message}`
        done(-1)
      })
      child.once('close', (code) => done(code ?? -1))
    })
    running.set(check, job)
    try {
      return await job
    } finally {
      running.delete(check)
    }
  })

  return { roots, openApp, listDir, findFiles, readFile, runCheck }
}
