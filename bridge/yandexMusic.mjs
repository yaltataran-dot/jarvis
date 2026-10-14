/**
 * Yandex Music, driven from the bridge.
 *
 * Two channels, both through things the user already has and is signed in to —
 * no unofficial API, no token, no password anywhere:
 *
 *   1. The desktop app's own interface. Yandex Music for Windows is an Electron
 *      app, and started with a local DevTools port it can be driven the way a
 *      person drives it: press the player's buttons, type into its search box,
 *      open the user's own collection, move the volume slider, read the track
 *      from the page's Media Session. The port is opened only by this module,
 *      only on 127.0.0.1, and only when it starts the app itself.
 *   2. Windows' own media sessions (media.ps1), the API behind the media keys.
 *      It sees every player on the machine — the app opened by hand, and Yandex
 *      Music in a browser tab — so it is how "what is playing" is answered when
 *      the app is not under control, and how play / pause / next / previous
 *      still work then. It runs as one long-lived PowerShell process: starting
 *      PowerShell and loading WinRT took two seconds a command.
 *
 * Every action reports what the player did, not what was asked of it: the
 * state is read back after the click, and a play that did not start comes back
 * as 'unconfirmed' rather than as success. "Nothing is playing" is said only
 * when a source that can see the player says so; when none can, the answer is
 * 'unknown'. Actions are queued one at a time — two clicks racing each other on
 * the same button would cancel out.
 *
 * Nothing here touches DRM, the stream, the account or a playlist's contents;
 * it presses the app's own buttons and reads its own screen.
 */

import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync as nodeExists } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const HERE = dirname(fileURLToPath(import.meta.url))

export const APP_EXE = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'YandexMusic', 'Яндекс Музыка.exe')
/** The local control port. A number, or the default — it ends up on a command line. */
export const CDP_PORT = (() => {
  const n = Number(process.env.JARVIS_YM_PORT ?? 9339)
  return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : 9339
})()

/** How long to wait for the player to show the change a button asked for. */
const CONFIRM_MS = 4000
/** How long a newly chosen track or playlist may take to start: it has to load. */
const START_MS = 8000
/** How long a freshly started app may take to put its player on screen. */
const LAUNCH_MS = 25_000
/** How long the app may take to open a page (search, collection). */
const PAGE_MS = 8000
/** How long, once the words are typed, search results may take to appear. */
const RESULTS_MS = 15_000
/** Ceiling for one whole action, whatever it is waiting on. */
const ACTION_MS = 45_000
/** One step of "louder" / "quieter", out of 1. */
export const VOLUME_STEP = 0.1

// ---------------------------------------------------------------------------
// In the page. Plain functions, sent as source; the app's own data-test-id
// markers are what they find things by, never generated class names.
// ---------------------------------------------------------------------------

const PAGE_HELPERS = `
  const $ = (id, root = document) => root.querySelector('[data-test-id="' + id + '"]');
  const transport = () => { const p = $('PREVIOUS_TRACK_BUTTON'); return p ? p.parentElement : null; };
  const playButton = () => { const t = transport(); return t ? [...t.querySelectorAll('button')].find((b) => b !== $('PREVIOUS_TRACK_BUTTON', t) && b !== $('NEXT_TRACK_BUTTON', t)) : null; };
  const state = () => {
    const ms = navigator.mediaSession;
    const md = ms && ms.metadata;
    const vol = $('CHANGE_VOLUME_SLIDER');
    const end = $('TIMECODE_TIME_END');
    const pb = playButton();
    // Playing, by either of the app's own signs: the Media Session it feeds
    // Windows, or its play button having turned into a pause button.
    const playing = (!!ms && ms.playbackState === 'playing') || (!!pb && pb.getAttribute('aria-label') === 'Пауза');
    return {
      ready: !!transport(),
      playing,
      title: (md && md.title) || null,
      artist: (md && md.artist) || null,
      // Something is in the player at all: a track length, or metadata.
      loaded: !!(md && md.title) || (!!end && /[1-9]/.test(end.innerText)),
      volume: vol ? Math.round(Number(vol.value) * 100) : null,
    };
  };
`

/** Mark the play button of the first search result of the wanted kind; describe the card. */
const PICK_RESULT = (kind) => `(() => {
  ${PAGE_HELPERS}
  const KINDS = {
    track: ['SEARCH_TRACK_CARD'],
    album: ['HORIZONTAL_ALBUM_CARD', 'ALBUM_CARD'],
    artist: ['HORIZONTAL_ARTIST_CARD', 'ARTIST_CARD'],
    playlist: ['HORIZONTAL_PLAYLIST_CARD', 'PLAYLIST_CARD'],
  };
  // Only cards from this search — see the mark set before typing.
  const fresh = (id, root = document) => root.querySelector('[data-test-id="' + id + '"]:not([data-jarvis-seen])');
  const top = $('SEARCH_PAGE_RESULTS_TOP');
  const ids = KINDS[${JSON.stringify(kind)}];
  let card = null;
  if (ids) for (const id of ids) { card = fresh(id); if (card) break; }
  // "any": the best match the app itself puts first.
  if (!card && top) card = [...top.querySelectorAll('[data-test-id$="CARD"]:not([data-jarvis-seen])')].find((e) => $('PLAY_BUTTON', e)) || null;
  if (!card) card = fresh('SEARCH_TRACK_CARD');
  if (!card) return { found: null };
  const text = (id) => { const e = $(id, card); return e ? e.innerText.trim() : null; };
  const title = text('TRACK_TITLE') || text('ENTITY_CARD_ENTITY_META_TITLE') || text('SEARCH_ARTIST_CARD_TITLE_LINK') || text('ALBUM_TITLE') || text('ARTIST_TITLE') || text('PLAYLIST_TITLE') || card.innerText.split('\\n')[0];
  const artist = text('SEPARATED_ARTIST_TITLE') || text('ENTITY_CARD_ENTITY_META_SUBTITLE');
  const b = $('PLAY_BUTTON', card);
  document.querySelectorAll('[data-jarvis-target]').forEach((e) => e.removeAttribute('data-jarvis-target'));
  if (b) b.setAttribute('data-jarvis-target', '1');
  return { found: { title, artist, kind: card.getAttribute('data-test-id') }, playable: !!b };
})()`

/** The user's playlists on the page now: title, uuid, and whether its play button is there. */
const READ_PLAYLISTS = `(() => {
  ${PAGE_HELPERS}
  return [...document.querySelectorAll('[data-test-id="PLAYLIST_ITEM"]')].map((it) => {
    const a = it.querySelector('a[href*="playlistUuid="]');
    const uuid = a ? new URL(a.href).searchParams.get('playlistUuid') : null;
    const t = $('PLAYLIST_TITLE', it);
    return { title: t ? t.innerText.trim() : null, uuid, playable: !!$('PLAY_BUTTON', it) };
  }).filter((p) => p.title && p.uuid);
})()`

// ---------------------------------------------------------------------------
// Matching a spoken playlist name against the user's own
// ---------------------------------------------------------------------------

const fold = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

/**
 * The playlists that answer to `name`, best first, as many as tie for best.
 * Exact name, then name starting with it, then containing it, then sharing all
 * its words in any order. Nothing weaker counts: a playlist the user did not
 * mean is worse than a question.
 */
export function matchPlaylists(list, name) {
  const want = fold(name)
  if (!want) return []
  const words = want.split(' ')
  const score = (p) => {
    const t = fold(p.title)
    if (t === want) return 4
    if (t.startsWith(want)) return 3
    if (t.includes(want)) return 2
    const tw = new Set(t.split(' '))
    if (words.every((w) => tw.has(w) || [...tw].some((x) => x.startsWith(w) && w.length >= 4))) return 1
    return 0
  }
  const scored = list.map((p) => [score(p), p]).filter(([s]) => s > 0)
  const best = Math.max(0, ...scored.map(([s]) => s))
  return scored.filter(([s]) => s === best).map(([, p]) => p)
}

/** A readable name for whatever else Windows says is playing. */
export function sourceName(appId) {
  const id = String(appId ?? '')
  if (/yandex.*music|music.*yandex|YandexMusic/i.test(id)) return 'Яндекс Музыка'
  if (/yandex/i.test(id)) return 'Яндекс Браузер'
  if (/chrome/i.test(id)) return 'Google Chrome'
  if (/edge/i.test(id)) return 'Microsoft Edge'
  if (/firefox/i.test(id)) return 'Firefox'
  if (/opera/i.test(id)) return 'Opera'
  return 'другое приложение'
}

// ---------------------------------------------------------------------------

/**
 * @param {object} [o]
 * @param {typeof fetch} [o.fetch]
 * @param {typeof WebSocket} [o.WebSocket]
 * @param {Function} [o.spawn]
 * @param {(p: string) => boolean} [o.exists]
 * @param {(ms: number) => Promise<void>} [o.sleep]
 * @param {() => number} [o.now]
 * @param {(action: string, target?: string) => Promise<any>} [o.media]   media.ps1
 * @param {() => Promise<boolean>} [o.isRunning]          is the app's process up?
 * @param {string} [o.platform]
 * @param {(line: string) => void} [o.log]
 */
export function createYandexMusic(o = {}) {
  const fetchFn = o.fetch ?? fetch
  const WS = o.WebSocket ?? WebSocket
  const spawn = o.spawn ?? nodeSpawn
  const exists = o.exists ?? nodeExists
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const now = o.now ?? Date.now
  const platform = o.platform ?? process.platform
  const log = o.log ?? (() => {})
  const worker = o.media ? null : createMediaWorker({ log })
  const media = o.media ?? ((action, target) => worker.request(action, target))
  const isRunning =
    o.isRunning ??
    (async () => {
      const r = await media('running').catch(() => null)
      return typeof r?.running === 'boolean' ? r.running : appRunning()
    })

  // -- the app's page over CDP ----------------------------------------------

  /** The app's page target, or null if the port is not open. */
  const pageTarget = async () => {
    try {
      const res = await fetchFn(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(1500) })
      if (!res.ok) return null
      const list = await res.json()
      return list.find((t) => t.type === 'page' && String(t.url).startsWith('music-application://')) ?? null
    } catch {
      return null
    }
  }

  /** One short CDP session: run the calls, close. Nothing is held open between actions. */
  const withPage = async (fn) => {
    const target = await pageTarget()
    if (!target) return null
    const ws = new WS(target.webSocketDebuggerUrl)
    await new Promise((res, rej) => {
      ws.once('open', res)
      ws.once('error', rej)
    })
    let id = 0
    const pending = new Map()
    ws.on('message', (m) => {
      const d = JSON.parse(String(m))
      const p = pending.get(d.id)
      if (!p) return
      pending.delete(d.id)
      if (d.error) p.rej(new Error(d.error.message))
      else p.res(d.result)
    })
    const send = (method, params = {}) =>
      new Promise((res, rej) => {
        const i = ++id
        pending.set(i, { res, rej })
        ws.send(JSON.stringify({ id: i, method, params }))
        setTimeout(() => pending.has(i) && (pending.delete(i), rej(new Error('Яндекс Музыка не ответила'))), 8000)
      })
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'ошибка на странице')
      return r.result?.value
    }
    try {
      return await fn({ send, evaluate })
    } finally {
      ws.close()
    }
  }

  const readState = (page) => page.evaluate(`(() => { ${PAGE_HELPERS} return state(); })()`)

  /** Poll until `ok(state)` or the time runs out; the last state either way. */
  const until = async (page, ok, ms = CONFIRM_MS) => {
    const end = now() + ms
    let s = await readState(page)
    while (!ok(s) && now() < end) {
      await sleep(200)
      s = await readState(page)
    }
    return s
  }

  /** Wait for a condition evaluated in the page. */
  const waitFor = async (page, expr, ms = PAGE_MS) => {
    const end = now() + ms
    while (now() < end) {
      if (await page.evaluate(`(() => { ${PAGE_HELPERS} return !!(${expr}); })()`)) return true
      await sleep(200)
    }
    return false
  }

  /**
   * Press an element the way a mouse does. Some of the app's buttons — a
   * playlist card's play button among them — ignore a scripted click() and
   * answer only to real pointer events. The point is checked first: if
   * something else sits on top of the element there, it is clicked from script
   * instead of clicking whatever covers it.
   */
  const press = async (page, finder) => {
    const box = await page.evaluate(`(() => { ${PAGE_HELPERS}
      const el = (${finder})();
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (!r.width || !r.height || !hit || !(hit === el || el.contains(hit))) { el.click(); return { scripted: true }; }
      return { x, y };
    })()`)
    if (!box) return false
    if (box.scripted) return true
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await page.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
    }
    return true
  }

  // -- the app's process -----------------------------------------------------

  /** 'control' (port open), 'running' (no port), 'closed' or 'missing'. */
  const appStatus = async () => {
    if (await pageTarget()) return 'control'
    if (!exists(APP_EXE)) return 'missing'
    return (await isRunning().catch(() => false)) ? 'running' : 'closed'
  }

  /**
   * Start the app with the control port and wait for its player.
   *
   * Through cmd's `start`, not as the bridge's own child: the launcher stops
   * JARVIS with `taskkill /T`, which takes the whole process tree with it, and
   * the user's music stopped every time JARVIS did. The command line is fixed —
   * the install path and a validated port number, nothing anyone said.
   */
  const launch = async () => {
    if (platform !== 'win32') throw new Error('Яндекс Музыкой можно управлять только в Windows')
    await new Promise((res, rej) => {
      const child = spawn(
        process.env.ComSpec || 'cmd.exe',
        ['/d', '/s', '/c', `start "" "${APP_EXE}" --remote-debugging-port=${CDP_PORT}`],
        { windowsVerbatimArguments: true, windowsHide: true, stdio: 'ignore', shell: false },
      )
      child.once('error', rej)
      child.once('exit', (code) => (code === 0 ? res() : rej(new Error(`Яндекс Музыка не запустилась (код ${code})`))))
    })
    const end = now() + LAUNCH_MS
    while (now() < end) {
      const s = await withPage(readState).catch(() => null)
      if (s?.ready) return true
      await sleep(300)
    }
    return false
  }

  /** The app under control, starting it if it is closed. A result object if that cannot be done. */
  const ensureControl = async ({ start }) => {
    const st = await appStatus()
    if (st === 'control') return null
    if (st === 'missing') return { code: 'not-installed' }
    if (st === 'running') return { code: 'no-control' }
    if (!start) return { code: 'not-running' }
    if (!(await launch())) return { code: 'failed', message: 'Яндекс Музыка не открылась' }
    return null
  }

  // -- Windows media sessions -------------------------------------------------

  /**
   * Another player Windows can see — Yandex Music in a browser tab, say — when
   * the app has none. The one playing, else the first paused one; null if there
   * is none.
   */
  const otherSession = (status) => {
    const others = (status?.sessions ?? []).filter((s) => !s.isApp)
    return others.find((s) => s.playing) ?? others[0] ?? null
  }

  /** A state reported by Windows, labelled with where it came from. */
  const fromSession = (s, channel) => ({
    code: 'ok',
    channel,
    ...pickState(s),
    ...(s.isApp ? {} : { source: sourceName(s.app) }),
  })

  /**
   * Drive one session through media.ps1, which sends the action and waits for
   * the player to confirm it in the same process.
   */
  const viaSession = async (action, target, channel) => {
    const r = await media(action, target)
    if (r?.error) return { code: 'failed', channel, message: `Windows: ${r.error}` }
    if (!r?.found) return null
    if (!r.sent) return { code: 'failed', channel, message: 'Windows не передала команду проигрывателю' }
    return {
      ...fromSession(r, channel),
      code: r.confirmed ? 'ok' : 'unconfirmed',
      diag: { before: describe(r.before), after: describe(r) },
    }
  }

  // -- actions ----------------------------------------------------------------

  /** Did the player change the way `action` asked? */
  const confirmed = (action, before, s) => {
    if (action === 'play') return s.playing
    if (action === 'pause') return !s.playing
    if (action === 'next' || action === 'prev') return !!s.title && (s.title !== before.title || s.artist !== before.artist)
    return true
  }

  /**
   * What is playing, from the best source that can see it.
   *
   *   app under control  -> its own page (and Windows for a title the page lacks)
   *   app opened by hand -> its Windows session
   *   no app             -> any other player Windows sees, named as such
   *
   * "Nothing" only from a source that can see the player; otherwise 'unknown'.
   */
  const nowPlaying = async () => {
    const st = await appStatus()
    if (st === 'control') {
      const s = await withPage(readState)
      if (!s) return { code: 'unknown', channel: 'cdp', message: 'приложение не ответило' }
      if (!s.title) {
        // The page has no title for it; Windows may.
        const w = await media('status').catch(() => null)
        if (w?.found && w.title) return { ...fromSession(w, 'cdp+smtc'), playing: s.playing || w.playing, volume: s.volume }
      }
      if (s.playing || s.title) return { code: 'ok', channel: 'cdp', ...pickState(s) }
      if (!s.loaded) return { code: 'nothing-playing', channel: 'cdp', ...pickState(s) }
      return { code: 'ok', channel: 'cdp', ...pickState(s) }
    }
    const w = await media('status').catch((err) => ({ error: String(err?.message ?? err) }))
    if (w?.error) {
      return st === 'running' || st === 'closed'
        ? { code: 'unknown', channel: 'smtc', message: w.error }
        : { code: 'not-installed' }
    }
    if (w.found) return fromSession(w, 'smtc')
    const other = otherSession(w)
    if (other) return fromSession(other, 'smtc-other')
    if (st === 'running') return { code: 'idle', channel: 'smtc' }
    if (st === 'missing') return { code: 'not-installed' }
    return { code: 'not-running', channel: 'smtc' }
  }

  const transport = async (action) => {
    const st = await appStatus()
    if (st !== 'control') {
      // The app's own Windows session, else another player (a browser tab
      // playing Yandex Music), else — for play only — start the app.
      const status = await media('status').catch((err) => ({ error: String(err?.message ?? err) }))
      if (status?.error && st !== 'closed') return { code: 'failed', channel: 'smtc', message: `Windows: ${status.error}` }
      if (status?.found) return (await viaSession(action, 'app', 'smtc')) ?? { code: 'no-control', channel: 'smtc' }
      const other = otherSession(status)
      if (other) return (await viaSession(action, other.app, 'smtc-other')) ?? { code: 'failed', channel: 'smtc-other' }
      if (st === 'missing') return { code: 'not-installed' }
      if (st === 'running') return { code: 'no-control', channel: 'smtc' }
      if (action !== 'play') return { code: 'not-running' }
      const fail = await ensureControl({ start: true })
      if (fail) return fail
    }
    return withPage(async (page) => {
      const before = await until(page, (s) => s.ready)
      if (!before.ready) return { code: 'failed', channel: 'cdp', message: 'плеер не загрузился' }
      const diag = { before: describe(before) }
      if (action === 'pause' && !before.playing) return { code: 'ok', channel: 'cdp', ...pickState(before), diag }
      if (action === 'play' && before.playing) return { code: 'ok', channel: 'cdp', ...pickState(before), diag }
      if ((action === 'next' || action === 'prev') && !before.loaded) return { code: 'nothing-playing', channel: 'cdp', diag }
      const button = action === 'next' ? "$('NEXT_TRACK_BUTTON')" : action === 'prev' ? "$('PREVIOUS_TRACK_BUTTON')" : 'playButton()'
      // A real press: the player bar shown for a playlist ignores a scripted
      // click() on its play/pause button, though the "Моя волна" bar did not.
      const finder = `() => { const b = ${button}; return b && !b.disabled ? b : null; }`
      // A track that has only just been switched to ignores pause until it is
      // actually sounding; wait for its clock to start (briefly) first.
      if (action === 'pause') await waitFor(page, `(() => { const t = $('TIMECODE_TIME_START'); return !t || t.innerText !== '00:00'; })()`, 1500)
      if (!(await press(page, finder))) return { code: 'failed', channel: 'cdp', message: 'кнопка плеера недоступна', diag }
      // Next/previous without a title to compare: wait for any change at all.
      const done = (x) => (before.title ? confirmed(action, before, x) : action === 'pause' ? !x.playing : x.playing)
      let s = await until(page, done, action === 'pause' || action === 'play' ? 1500 : CONFIRM_MS)
      // Play and pause: one more press if the first was swallowed — but only
      // while the player is still exactly as it was, so a late first press is
      // never undone by the second.
      if ((action === 'pause' || action === 'play') && !done(s) && s.playing === before.playing) {
        await press(page, finder)
        s = await until(page, done)
      }
      // "Previous" a few seconds into a track restarts it rather than going back;
      // a second press goes back. That is the app's rule, followed here.
      if (action === 'prev' && !done(s)) {
        await press(page, finder)
        s = await until(page, done)
      }
      return { code: done(s) ? 'ok' : 'unconfirmed', channel: 'cdp', ...pickState(s), diag: { ...diag, after: describe(s) } }
    }).then((r) => r ?? { code: 'no-control' })
  }

  const volume = async ({ delta, set }) => {
    const fail = await ensureControl({ start: false })
    if (fail) return fail
    return withPage(async (page) => {
      const before = await readState(page)
      if (before.volume === null) return { code: 'failed', channel: 'cdp', message: 'регулятор громкости не найден' }
      const target = typeof set === 'number' ? set / 100 : before.volume / 100 + delta * VOLUME_STEP
      const v = Math.min(1, Math.max(0, Math.round(target * 100) / 100))
      // A range input owned by React: set through the native setter so React
      // sees a change, then fire the events it listens for.
      await page.evaluate(`(() => { ${PAGE_HELPERS}
        const el = $('CHANGE_VOLUME_SLIDER');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(el, String(${v}));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      })()`)
      const want = Math.round(v * 100)
      const s = await until(page, (x) => x.volume === want, 1500)
      return {
        code: s.volume === want ? 'ok' : 'unconfirmed',
        channel: 'cdp',
        ...pickState(s),
        diag: { before: `volume ${before.volume}`, after: `volume ${s.volume}` },
      }
    }).then((r) => r ?? { code: 'no-control' })
  }

  /** Start what `press` points at, and confirm it from the player. */
  const startAndConfirm = async (page, before, finder) => {
    if (!(await press(page, finder))) return { ok: false, s: before }
    const started = (x) => x.playing && (x.title !== before.title || !before.playing)
    const s = await until(page, started, START_MS)
    return { ok: started(s), s }
  }

  const search = async ({ query, kind = 'any', play = true }) => {
    const q = String(query ?? '').trim().slice(0, 200)
    if (!q) return { code: 'not-found' }
    const fail = await ensureControl({ start: true })
    if (fail) return fail
    return withPage(async (page) => {
      const before = await until(page, (s) => s.ready)
      // The app's own search: open it, put the words in the box the way typing
      // would, wait for the results for these words.
      await page.evaluate(`(() => { ${PAGE_HELPERS} const n = $('NAVBAR_NAVIGATION_ITEM_SEARCH'); if (n) n.click(); })()`)
      const focusBy = now() + PAGE_MS
      let focused = false
      while (!focused && now() < focusBy) {
        focused = await page.evaluate(`(() => { ${PAGE_HELPERS} const i = $('SEARCH_PAGE_SEARCH_INPUT'); if (!i) return false; i.focus(); i.select(); return document.activeElement === i; })()`)
        if (!focused) await sleep(200)
      }
      if (!focused) return { code: 'failed', channel: 'cdp', message: 'поиск в приложении не открылся' }
      const wanted = JSON.stringify(q)
      // The same words already searched: typing them again changes nothing, so
      // no new results would ever arrive. The ones on screen are the answer.
      const already = await page.evaluate(`(() => { ${PAGE_HELPERS}
        const i = $('SEARCH_PAGE_SEARCH_INPUT');
        return !!i && i.value === ${wanted} && new URLSearchParams(location.search).get('text') === ${wanted};
      })()`)
      if (already) {
        await page.evaluate(`document.querySelectorAll('[data-jarvis-seen]').forEach((e) => e.removeAttribute('data-jarvis-seen'))`)
      } else {
        // The previous search's cards stay on screen while the new ones load, so
        // they are marked first: only a card without the mark answers this query.
        await page.evaluate(`document.querySelectorAll('[data-test-id$="CARD"]').forEach((e) => e.setAttribute('data-jarvis-seen', '1'))`)
        await page.send('Input.insertText', { text: q })
      }
      const resultsBy = now() + RESULTS_MS
      let r = { searched: false, fresh: false, empty: false }
      while (!(r.searched && (r.fresh || r.empty)) && now() < resultsBy) {
        await sleep(300)
        r = await page.evaluate(`(() => { ${PAGE_HELPERS}
          const i = $('SEARCH_PAGE_SEARCH_INPUT');
          const shown = new URLSearchParams(location.search).get('text');
          const searched = !!i && i.value === ${wanted} && shown === ${wanted};
          const fresh = [...document.querySelectorAll('[data-test-id$="CARD"]:not([data-jarvis-seen])')].some((c) => $('PLAY_BUTTON', c));
          return { searched, fresh, empty: !!$('SEARCH_EMPTY_CONTAINER') };
        })()`)
      }
      // "Nothing found" only when the app itself says so; running out of time
      // is a different answer and is reported as one.
      if (r.searched && r.empty && !r.fresh) return { code: 'not-found', channel: 'cdp' }
      if (!r.fresh) return { code: 'failed', channel: 'cdp', message: 'результаты поиска не загрузились вовремя' }
      // A moment for the cards to settle after the first ones paint.
      await sleep(400)
      const picked = await page.evaluate(PICK_RESULT(kind))
      if (!picked?.found) return { code: 'not-found', channel: 'cdp' }
      if (!play) return { code: 'ok', channel: 'cdp', found: picked.found, ...pickState(before) }
      if (!picked.playable) return { code: 'unconfirmed', channel: 'cdp', found: picked.found, ...pickState(before) }
      const { ok, s } = await startAndConfirm(page, before, `() => document.querySelector('[data-jarvis-target]')`)
      return {
        code: ok ? 'ok' : 'unconfirmed',
        channel: 'cdp',
        found: picked.found,
        ...pickState(s),
        diag: { before: describe(before), after: describe(s) },
      }
    }).then((r) => r ?? { code: 'no-control' })
  }

  /**
   * The user's own playlists, from the app's collection page — the list the
   * account itself shows, so no id is guessed or hard-coded. The page is
   * virtualised: it is scrolled through to see them all. "Вам понравилось"
   * (other people's playlists the user liked) is read only if the user's own
   * do not answer.
   */
  const playlist = async ({ name, liked = false, play = true }) => {
    const fail = await ensureControl({ start: true })
    if (fail) return fail
    return withPage(async (page) => {
      const before = await until(page, (s) => s.ready)
      const onList = `$('COLLECTION_PLAYLISTS_PAGE') && ($('PLAYLIST_ITEM') || $('CREATE_PLAYLIST_CARD'))`
      if (!(await page.evaluate(`(() => { ${PAGE_HELPERS} return !!(${onList}); })()`))) {
        await page.evaluate(`(() => { ${PAGE_HELPERS} const n = $('NAVBAR_NAVIGATION_ITEM_COLLECTION'); if (n) n.click(); })()`)
        const link = `[...document.querySelectorAll('a')].find((a) => /\\/collection\\/playlists$/.test(a.href))`
        if (!(await waitFor(page, link))) return { code: 'failed', channel: 'cdp', message: 'коллекция не открылась' }
        await page.evaluate(`(() => { const a = ${link}; if (a) a.click(); })()`)
        if (!(await waitFor(page, onList))) return { code: 'failed', channel: 'cdp', message: 'список плейлистов не открылся' }
      }

      const collect = async () => {
        const seen = new Map()
        await page.evaluate(`(() => { const s = document.querySelector('[data-test-id="virtuoso-scroller"]'); if (s) s.scrollTop = 0; })()`)
        for (let i = 0; i < 40; i++) {
          await sleep(250)
          for (const p of (await page.evaluate(READ_PLAYLISTS)) ?? []) if (!seen.has(p.uuid)) seen.set(p.uuid, p)
          const moved = await page.evaluate(`(() => {
            const s = document.querySelector('[data-test-id="virtuoso-scroller"]');
            if (!s || s.scrollTop + s.clientHeight >= s.scrollHeight - 2) return false;
            s.scrollTop += s.clientHeight * 0.8; return true;
          })()`)
          if (!moved) break
        }
        return [...seen.values()]
      }
      const pick = (list) => (liked ? list.filter((p) => p.uuid.startsWith('lk.')) : matchPlaylists(list, name))

      const own = await collect()
      let matches = pick(own)
      let all = own
      if (!matches.length && !liked) {
        // The second tab: playlists of other people the user has liked.
        const switched = await page.evaluate(`(() => { ${PAGE_HELPERS} const tabs = [...document.querySelectorAll('[data-test-id="TAB"]')]; if (tabs.length < 2) return false; tabs[1].click(); return true; })()`)
        if (switched) {
          await sleep(700)
          const theirs = await collect()
          all = own.concat(theirs)
          matches = pick(theirs)
          await page.evaluate(`(() => { ${PAGE_HELPERS} const t = document.querySelector('[data-test-id="TAB"]'); if (t) t.click(); })()`)
        }
      }
      const names = all.map((p) => p.title)
      if (!matches.length) return { code: 'not-found', channel: 'cdp', playlists: names.slice(0, 8) }
      if (matches.length > 1) return { code: 'ambiguous', channel: 'cdp', options: matches.map((p) => p.title).slice(0, 5) }
      const target = matches[0]
      const found = { title: target.title, kind: 'playlist' }
      if (!play) return { code: 'ok', channel: 'cdp', found, playlist: target.title, ...pickState(before) }
      const finder = `() => { const it = [...document.querySelectorAll('[data-test-id="PLAYLIST_ITEM"]')].find((i) => { const a = i.querySelector('a[href*="playlistUuid="]'); return a && new URL(a.href).searchParams.get('playlistUuid') === ${JSON.stringify(target.uuid)}; }); return it ? $('PLAY_BUTTON', it) : null; }`
      // Back to it in the list: the scroll may have carried it out of the window.
      await page.evaluate(`(() => { const s = document.querySelector('[data-test-id="virtuoso-scroller"]'); if (s) s.scrollTop = 0; })()`)
      let present = false
      for (let i = 0; i < 40 && !present; i++) {
        await sleep(200)
        present = await page.evaluate(`(() => { ${PAGE_HELPERS} return !!(${finder})(); })()`)
        if (!present) {
          const moved = await page.evaluate(`(() => { const s = document.querySelector('[data-test-id="virtuoso-scroller"]'); if (!s || s.scrollTop + s.clientHeight >= s.scrollHeight - 2) return false; s.scrollTop += s.clientHeight * 0.8; return true; })()`)
          if (!moved) break
        }
      }
      if (!present) return { code: 'failed', channel: 'cdp', found, message: 'кнопка плейлиста не нашлась на странице' }
      const { ok, s } = await startAndConfirm(page, before, finder)
      if (!ok) {
        // Nothing started: an empty playlist is the usual reason, and the
        // app says so on the playlist's own page. Look, so the answer can.
        await page.evaluate(`(() => { const a = [...document.querySelectorAll('a[href*="playlistUuid="]')].find((x) => new URL(x.href).searchParams.get('playlistUuid') === ${JSON.stringify(target.uuid)}); if (a) a.click(); })()`)
        if (await waitFor(page, `$('PLAYLIST_PAGE') && ($('PLAYLIST_EMPTY_BLOCK') || $('TRACK_TITLE', $('PLAYLIST_PAGE')))`, 4000)) {
          if (await page.evaluate(`(() => { ${PAGE_HELPERS} return !!$('PLAYLIST_EMPTY_BLOCK'); })()`)) {
            return { code: 'empty', channel: 'cdp', found, playlist: target.title, ...pickState(s) }
          }
        }
      }
      return {
        code: ok ? 'ok' : 'unconfirmed',
        channel: 'cdp',
        found,
        playlist: target.title,
        ...pickState(s),
        diag: { before: describe(before), after: describe(s) },
      }
    }).then((r) => r ?? { code: 'no-control' })
  }

  const open = async () => {
    const st = await appStatus()
    if (st === 'missing') return { code: 'not-installed' }
    if (st !== 'closed') return { code: 'ok', channel: st === 'control' ? 'cdp' : 'process' }
    return (await ensureControl({ start: true })) ?? { code: 'ok', channel: 'cdp' }
  }

  /** Close the app and start it again with the control port — on request only. */
  const restart = async () => {
    if (!exists(APP_EXE)) return { code: 'not-installed' }
    const t0 = now()
    await media('kill').catch(() => null)
    // Until the old instance has gone, a new one only hands over to it and exits.
    const end = now() + 8000
    while (now() < end && (await isRunning().catch(() => false))) await sleep(200)
    const t1 = now()
    const r = (await ensureControl({ start: true })) ?? { code: 'ok', channel: 'cdp' }
    return { ...r, diag: { before: `closed in ${t1 - t0} ms`, after: `started in ${now() - t1} ms` } }
  }

  // -- the queue ---------------------------------------------------------------

  let queue = Promise.resolve()
  /**
   * One action at a time, every outcome a result — never a throw, never a wait
   * without end. Logged with the channel used, the state before and after, the
   * time taken and why it failed; never anything from the account.
   */
  const run = (name, fn) => {
    const t0 = now()
    const timed = () => {
      let timer
      const limit = new Promise((res) => {
        timer = setTimeout(() => res({ code: 'failed', message: 'Яндекс Музыка не ответила вовремя' }), ACTION_MS)
        timer.unref?.()
      })
      return Promise.race([fn(), limit]).finally(() => clearTimeout(timer))
    }
    const out = queue.then(timed).catch((err) => ({ code: 'failed', message: String(err?.message ?? err) }))
    queue = out.then(() => {})
    return out.then((r) => {
      const { diag, ...result } = r
      const change = diag ? ` ${diag.before ?? '?'} -> ${diag.after ?? '?'}` : ''
      log(
        `[jarvis] music ${name}${result.channel ? ` via ${result.channel}` : ''}:${change} -> ${result.code}` +
          ` ${now() - t0} ms${result.message ? ` (${result.message})` : ''}`,
      )
      return result
    })
  }

  return {
    open: () => run('open', open),
    restart: () => run('restart', restart),
    play: () => run('play', () => transport('play')),
    pause: () => run('pause', () => transport('pause')),
    next: () => run('next', () => transport('next')),
    prev: () => run('prev', () => transport('prev')),
    now: () => run('now', nowPlaying),
    volume: (v) => run('volume', () => volume(v)),
    search: (q) => run('search', () => search(q)),
    playlist: (p) => run('playlist', () => playlist(p)),
    /** Start the Windows media helper ahead of the first command. */
    warm: () => worker?.warm(),
  }
}

/** A state in a few words, for the log. */
function describe(s) {
  if (!s) return '?'
  const what = s.title ? `«${s.title}»` : s.loaded === false ? 'nothing loaded' : 'no title'
  return `${s.playing ? 'playing' : 'paused'} ${what}`
}

/** Only the fields the page needs; nothing from the page is passed through raw. */
function pickState(s) {
  return {
    playing: !!s.playing,
    title: typeof s.title === 'string' && s.title ? s.title : null,
    artist: typeof s.artist === 'string' && s.artist ? s.artist : null,
    ...(typeof s.volume === 'number' ? { volume: s.volume } : {}),
  }
}

/**
 * Is the app's process running? tasklist, for when the media helper cannot
 * answer. Its output is in the console code page, so the name is not read
 * back — a CSV row at all means a match; no match prints one unquoted line.
 */
function appRunning() {
  if (process.platform !== 'win32') return Promise.resolve(false)
  return new Promise((resolve) => {
    const child = nodeSpawn('tasklist', ['/FI', `IMAGENAME eq ${basename(APP_EXE)}`, '/FO', 'CSV', '/NH'], {
      windowsHide: true,
      shell: false,
    })
    let out = ''
    child.stdout.on('data', (d) => (out += d.toString('latin1')))
    child.once('error', () => resolve(false))
    child.once('close', () => resolve(/^"/m.test(out)))
  })
}

/**
 * media.ps1 -Serve, kept running: one PowerShell for the life of the bridge,
 * started on first use (or by warm()) and again if it dies. Each request has a
 * time limit; a helper that misses it is killed so the next request starts a
 * fresh one rather than queueing behind a hung one.
 */
export function createMediaWorker({ log = () => {}, spawn = nodeSpawn, timeoutMs = 10_000 } = {}) {
  let child = null
  let buf = ''
  let nextId = 0
  const pending = new Map()

  const fail = (err) => {
    for (const p of pending.values()) p.reject(err)
    pending.clear()
  }

  const start = () => {
    if (child) return child
    if (process.platform !== 'win32') throw new Error('только в Windows')
    const c = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, 'media.ps1'), '-Serve'],
      { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    child = c
    buf = ''
    c.stdout.setEncoding('utf8')
    c.stdout.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        const p = pending.get(msg.id)
        if (p) {
          pending.delete(msg.id)
          p.resolve(msg)
        }
      }
    })
    c.stderr.on('data', (d) => log(`[jarvis] music: media helper: ${String(d).trim().slice(0, 200)}`))
    c.once('exit', () => {
      if (child === c) child = null
      fail(new Error('помощник Windows завершился'))
    })
    c.once('error', (err) => {
      if (child === c) child = null
      fail(err)
    })
    return c
  }

  const request = (action, target = 'app') =>
    new Promise((resolve, reject) => {
      let c
      try {
        c = start()
      } catch (err) {
        return reject(err)
      }
      const id = ++nextId
      const timer = setTimeout(() => {
        if (!pending.has(id)) return
        pending.delete(id)
        reject(new Error('Windows не ответила вовремя'))
        // A hung helper would hold every request after it; start over.
        c.kill()
      }, timeoutMs)
      pending.set(id, {
        resolve: (m) => (clearTimeout(timer), resolve(m)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      })
      c.stdin.write(JSON.stringify({ id, action, target }) + '\n')
    })

  return {
    request,
    warm: () => request('status').catch(() => null),
    stop: () => child?.kill(),
  }
}

/** The /music route's dispatcher: an action name and its arguments, checked. */
export function musicAction(ym, body) {
  const a = String(body?.action ?? '')
  switch (a) {
    case 'open':
    case 'restart':
    case 'play':
    case 'pause':
    case 'next':
    case 'prev':
    case 'now':
      return ym[a]()
    case 'volume': {
      const set = Number(body.set)
      const delta = Number(body.delta)
      if (Number.isFinite(set)) return ym.volume({ set: Math.min(100, Math.max(0, set)) })
      if (Number.isFinite(delta)) return ym.volume({ delta: Math.sign(delta) })
      return Promise.resolve({ code: 'failed', message: 'не указано, как менять громкость' })
    }
    case 'search': {
      const kind = ['track', 'album', 'artist', 'playlist', 'any'].includes(body.kind) ? body.kind : 'any'
      return ym.search({ query: String(body.query ?? ''), kind, play: body.play !== false })
    }
    case 'playlist': {
      const liked = body.liked === true
      const name = String(body.name ?? '').slice(0, 100)
      if (!liked && !name.trim()) return Promise.resolve({ code: 'failed', message: 'не указано, какой плейлист' })
      return ym.playlist({ name, liked, play: body.play !== false })
    }
    default:
      return Promise.resolve({ code: 'failed', message: 'неизвестная команда' })
  }
}
