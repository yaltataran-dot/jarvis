import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { APP_EXE, CDP_PORT, createMediaWorker, createYandexMusic, matchPlaylists, musicAction, sourceName } from '../bridge/yandexMusic.mjs'
import { describeResult } from '../bridge/music.mjs'

const APP_ID = 'ru.yandex.desktop.music'
const BROWSER_ID = 'Yandex.Browser.ABC123'

/**
 * A pretend Yandex Music, and a pretend Windows.
 *
 * The app's page answers the module's CDP calls from a state object; its
 * buttons change that state (or, with `stuck`, do nothing). Windows' media
 * sessions are a second set of objects: the app's own (`appSession`) and other
 * players (`others`, a browser tab).
 */
function rig({
  installed = true,
  control = false,
  running = false,
  stuck = false,
  page = {},
  appSession = null,
  others = [],
  mediaError = null,
  search = null,
  playlists = null,
} = {}) {
  const st = { ready: true, playing: false, title: 'Группа крови', artist: 'КИНО', loaded: true, volume: 35, ...page }
  const calls = { spawn: [], media: [], clicks: [], typed: [], mouse: 0 }
  let clock = 0
  let open = control
  let tab = 0

  const startPlaying = (title, artist) => {
    if (stuck) return
    st.playing = true
    st.title = title
    st.artist = artist
    st.loaded = true
  }

  class FakeWS extends EventEmitter {
    constructor() {
      super()
      setImmediate(() => this.emit('open'))
    }
    send(raw) {
      const { id, method, params } = JSON.parse(raw)
      let value
      if (method === 'Input.insertText') calls.typed.push(params.text)
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') {
        calls.mouse++
        // A real click on whatever was aimed at.
        if (calls.aim === 'playlist') startPlaying(playlists.firstTrack ?? 'Мне похуй', 'DJ Bulava')
        if (calls.aim === 'search') startPlaying(search.found.title, search.found.artist)
        if (calls.aim === 'next' || calls.aim === 'play') calls.clicks.push(calls.aim)
        if (calls.aim === 'next' && !stuck) st.title = 'Звезда по имени Солнце'
        if (calls.aim === 'play' && !stuck) st.playing = !st.playing
      }
      if (method === 'Runtime.evaluate') {
        const e = params.expression
        if (e.includes('return state();')) value = { ...st }
        else if (e.includes('elementFromPoint')) {
          calls.aim = e.includes("const b = $('NEXT_TRACK_BUTTON')")
            ? 'next'
            : e.includes("const b = $('PREVIOUS_TRACK_BUTTON')")
              ? 'prev'
              : e.includes('const b = playButton()')
                ? 'play'
                : e.includes('data-jarvis-target')
                  ? 'search'
                  : 'playlist'
          value = { x: 10, y: 10 }
        } else if (e.includes("return !!$('PLAYLIST_EMPTY_BLOCK')")) {
          value = !!playlists?.empty
        } else if (e.includes("$('PLAYLIST_PAGE') && ")) {
          value = !!playlists?.empty
        } else if (e.includes('const KINDS')) {
          value = search?.found ? { found: search.found, playable: true } : { found: null }
        } else if (e.includes('.filter((p) => p.title && p.uuid)')) {
          value = tab === 0 ? playlists.own : playlists.theirs ?? []
        } else if (e.includes('tabs[1].click()')) {
          tab = 1
          value = !!playlists.theirs
        } else if (e.includes('[data-test-id="TAB"]')) {
          tab = 0
        } else if (e.includes('playlistUuid') && e.includes('return !!(')) {
          value = true
        } else if (e.includes('COLLECTION_PLAYLISTS_PAGE')) {
          value = !!playlists
        } else if (e.includes('virtuoso-scroller')) {
          value = false
        } else if (search && e.includes('i.focus()')) value = true
        else if (search && e.includes('return !!i && i.value ===')) value = !!search.already
        else if (search && e.includes('SEARCH_EMPTY_CONTAINER')) {
          value = { searched: true, fresh: !!search.fresh, empty: !!search.empty }
        } else if (e.includes('CHANGE_VOLUME_SLIDER') && e.includes('setter.call')) {
          const v = Number(/setter\.call\(el, String\(([\d.]+)\)\)/.exec(e)[1])
          if (!stuck) st.volume = Math.round(v * 100)
        }
      }
      setImmediate(() => this.emit('message', JSON.stringify({ id, result: { result: { value } } })))
    }
    close() {}
  }

  const sessionList = () => [
    ...(appSession ? [{ ...appSession, app: APP_ID, isApp: true }] : []),
    ...others.map((s) => ({ ...s, isApp: false })),
  ]

  const ym = createYandexMusic({
    platform: 'win32',
    exists: (p) => installed && p === APP_EXE,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
    },
    WebSocket: FakeWS,
    fetch: async (url) => {
      assert.ok(String(url).startsWith(`http://127.0.0.1:${CDP_PORT}/`), 'only the local port is ever asked')
      if (!open) throw new Error('ECONNREFUSED')
      return { ok: true, json: async () => [{ type: 'page', url: 'music-application://desktop/', webSocketDebuggerUrl: 'ws://x' }] }
    },
    spawn: (exe, args, opts) => {
      calls.spawn.push({ exe, args, opts })
      open = true
      // cmd's `start` returns at once, the app carrying on by itself.
      const child = new EventEmitter()
      setImmediate(() => child.emit('exit', 0))
      return child
    },
    isRunning: async () => running,
    // media.ps1: every session on status; an action on one session, confirmed or not.
    media: async (action, target = 'app') => {
      calls.media.push(target === 'app' ? action : `${action}:${target}`)
      if (mediaError) throw new Error(mediaError)
      if (action === 'kill') return { running: false }
      const sessions = sessionList()
      if (action === 'status') return { found: !!appSession, sessions, ...(appSession ?? {}) }
      const s = target === 'app' ? appSession : others.find((x) => x.app === target)
      if (!s) return { found: false, sessions }
      const before = { ...s }
      if (!s.stuck) {
        if (action === 'play') s.playing = true
        if (action === 'pause') s.playing = false
        if (action === 'next') s.title = 'Следующая'
      }
      const confirmed = action === 'play' ? s.playing : action === 'pause' ? !s.playing : s.title !== before.title
      return { found: true, sent: true, ...s, isApp: target === 'app', app: target === 'app' ? APP_ID : s.app, confirmed, before }
    },
  })
  return { ym, st, calls }
}

// -- what is playing -----------------------------------------------------------

test('1. app not running, no other player: not-running', async () => {
  const { ym } = rig()
  assert.equal((await ym.now()).code, 'not-running')
})

test('2. app under control, nothing loaded: nothing-playing (the page can see the player)', async () => {
  const { ym } = rig({ control: true, page: { title: null, artist: null, loaded: false } })
  assert.equal((await ym.now()).code, 'nothing-playing')
})

test('3. app under control, playing: the track', async () => {
  const { ym } = rig({ control: true, page: { playing: true } })
  const r = await ym.now()
  assert.equal(r.code, 'ok')
  assert.equal(r.playing, true)
  assert.equal(r.title, 'Группа крови')
})

test('4. paused on a track: ok, not playing — not "nothing"', async () => {
  const { ym } = rig({ control: true, page: { playing: false } })
  const r = await ym.now()
  assert.equal(r.code, 'ok')
  assert.equal(r.playing, false)
  assert.equal(r.title, 'Группа крови')
})

test('5. app opened by hand, no media session: idle — open, nothing started in it', async () => {
  const { ym } = rig({ running: true })
  assert.equal((await ym.now()).code, 'idle')
})

test('6. a session that is playing without metadata is still playing', async () => {
  const { ym } = rig({ running: true, appSession: { playing: true, title: null, artist: null } })
  const r = await ym.now()
  assert.equal(r.code, 'ok')
  assert.equal(r.playing, true)
  assert.equal(r.title, null)
})

test('6b. the page playing without a title borrows it from Windows', async () => {
  const { ym } = rig({ control: true, page: { playing: true, title: null, artist: null }, appSession: { playing: true, title: 'Мне похуй', artist: 'DJ Bulava' } })
  const r = await ym.now()
  assert.equal(r.code, 'ok')
  assert.equal(r.playing, true)
  assert.equal(r.title, 'Мне похуй')
})

test('6c. Yandex Music in a browser tab, app closed: reported, and named as the browser', async () => {
  const tab = { app: BROWSER_ID, playing: true, title: 'Мне похуй', artist: 'DJ Bulava' }
  const { ym, calls } = rig({ others: [tab] })
  const r = await ym.now()
  assert.equal(r.code, 'ok')
  assert.equal(r.playing, true)
  assert.equal(r.source, 'Яндекс Браузер')
  // And "пауза" pauses that tab rather than starting the app.
  const p = await ym.pause()
  assert.equal(p.code, 'ok')
  assert.equal(p.playing, false)
  assert.ok(calls.media.includes(`pause:${BROWSER_ID}`))
  assert.equal(calls.spawn.length, 0)
})

test('13. Windows media API failing: unknown, never "nothing is playing"', async () => {
  const { ym } = rig({ running: true, mediaError: 'Windows media API timed out' })
  const r = await ym.now()
  assert.equal(r.code, 'unknown')
  const p = await ym.pause()
  assert.equal(p.code, 'failed')
})

// -- playing things --------------------------------------------------------------

test('7. a song from search: found, played with a real click, confirmed by the player', async () => {
  const found = { title: 'Группа крови', artist: 'КИНО', kind: 'SEARCH_TRACK_CARD' }
  const { ym, calls } = rig({ control: true, page: { title: null, artist: null, loaded: false }, search: { fresh: true, found } })
  const look = await ym.search({ query: 'кино группа крови', kind: 'track', play: false })
  assert.equal(look.code, 'ok')
  assert.deepEqual(look.found, found)
  assert.equal(calls.mouse, 0, 'looking does not play')
  const r = await ym.search({ query: 'кино группа крови', kind: 'track', play: true })
  assert.equal(r.code, 'ok')
  assert.equal(r.title, 'Группа крови')
  assert.equal(calls.mouse, 1)
})

test('search: the same words again use the results on screen', async () => {
  const found = { title: 'Звезда по имени Солнце', artist: 'КИНО', kind: 'SEARCH_TRACK_CARD' }
  const { ym, calls } = rig({ control: true, page: { title: null, loaded: false }, search: { already: true, fresh: true, found } })
  assert.equal((await ym.search({ query: 'Звезда по имени Солнце', kind: 'track' })).code, 'ok')
  assert.deepEqual(calls.typed, [], 'nothing typed')
})

test('search: "nothing found" only when the app says so; a slow page is a failure, not "nothing"', async () => {
  assert.equal((await rig({ control: true, search: { empty: true } }).ym.search({ query: 'фываолдж' })).code, 'not-found')
  const r = await rig({ control: true, search: { fresh: false, empty: false } }).ym.search({ query: 'земфира' })
  assert.equal(r.code, 'failed')
  assert.match(r.message, /не загрузились/)
})

const OWN = [
  { title: 'Понравилось на Кинопоиске', uuid: '7a52-kino', playable: true },
  { title: 'Дорога', uuid: 'aaaa-road', playable: true },
  { title: 'Для работы', uuid: 'bbbb-work', playable: true },
  { title: 'Мне нравится', uuid: 'lk.1d9f-liked', playable: true },
]

test('8. one of the user\'s own playlists, by name', async () => {
  const { ym, calls } = rig({ control: true, page: { playing: false, title: null, loaded: false }, playlists: { own: OWN, firstTrack: 'Трек дороги' } })
  const r = await ym.playlist({ name: 'дорога' })
  assert.equal(r.code, 'ok')
  assert.equal(r.playlist, 'Дорога')
  assert.equal(r.playing, true)
  assert.equal(calls.mouse, 1, 'a real click, not a scripted one')
  assert.deepEqual(calls.typed, [], 'never the public search')
})

test('9. «Мне нравится» is found by what it is (lk. id), not by a search', async () => {
  const { ym } = rig({ control: true, page: { playing: false, title: null, loaded: false }, playlists: { own: OWN } })
  const r = await ym.playlist({ liked: true })
  assert.equal(r.code, 'ok')
  assert.equal(r.playlist, 'Мне нравится')
  assert.equal(r.title, 'Мне похуй')
})

test('10. several playlists answer to the name: ambiguous, nothing played', async () => {
  const own = [
    { title: 'Для работы', uuid: '1', playable: true },
    { title: 'Для работы 2', uuid: '2', playable: true },
  ]
  const { ym, calls } = rig({ control: true, playlists: { own } })
  const r = await ym.playlist({ name: 'для' })
  assert.equal(r.code, 'ambiguous')
  assert.deepEqual(r.options, ['Для работы', 'Для работы 2'])
  assert.equal(calls.mouse, 0)
})

test('16. playlist not among theirs: not-found, with their playlists listed; one that will not start: unconfirmed', async () => {
  const none = await rig({ control: true, playlists: { own: OWN, theirs: [] } }).ym.playlist({ name: 'Спорт' })
  assert.equal(none.code, 'not-found')
  assert.deepEqual(none.playlists, OWN.map((p) => p.title))
  const stuck = await rig({ control: true, stuck: true, page: { playing: false }, playlists: { own: OWN } }).ym.playlist({ liked: true })
  assert.equal(stuck.code, 'unconfirmed')
})

test('an empty playlist: said so, rather than "it did not start"', async () => {
  const { ym } = rig({ control: true, stuck: true, page: { playing: false }, playlists: { own: OWN, empty: true } })
  const r = await ym.playlist({ name: 'Дорога' })
  assert.equal(r.code, 'empty')
  assert.equal(r.playlist, 'Дорога')
})

test('a playlist liked from someone else is found on the second tab', async () => {
  const { ym } = rig({ control: true, page: { playing: false, title: null }, playlists: { own: OWN, theirs: [{ title: 'Русский рок', uuid: 'cccc', playable: true }] } })
  const r = await ym.playlist({ name: 'русский рок' })
  assert.equal(r.code, 'ok')
  assert.equal(r.playlist, 'Русский рок')
})

test('playlists need the app under control; opened by hand they say why not', async () => {
  const { ym, calls } = rig({ running: true })
  assert.equal((await ym.playlist({ liked: true })).code, 'no-control')
  assert.equal(calls.spawn.length, 0, 'never restarted behind their back')
})

test('matching names: exact beats contains, words in any order, nothing weak', () => {
  assert.deepEqual(matchPlaylists(OWN, 'для работы').map((p) => p.title), ['Для работы'])
  assert.deepEqual(matchPlaylists(OWN, 'кинопоиске понравилось').map((p) => p.title), ['Понравилось на Кинопоиске'])
  assert.deepEqual(matchPlaylists(OWN, 'спорт'), [])
})

// -- controlling playback -------------------------------------------------------

test('14. not installed: said so, nothing started', async () => {
  const { ym, calls } = rig({ installed: false })
  assert.equal((await ym.play()).code, 'not-installed')
  assert.equal((await ym.search({ query: 'кино' })).code, 'not-installed')
  assert.equal(calls.spawn.length, 0)
})

test('closed app: play starts it — outside JARVIS\'s process tree, fixed command line — then plays', async () => {
  const { ym, st, calls } = rig()
  const r = await ym.play()
  assert.equal(calls.spawn.length, 1)
  const { exe, args, opts } = calls.spawn[0]
  assert.match(exe, /cmd\.exe$/i)
  assert.deepEqual(args, ['/d', '/s', '/c', `start "" "${APP_EXE}" --remote-debugging-port=${CDP_PORT}`])
  assert.equal(opts.shell, false)
  assert.equal(r.code, 'ok')
  assert.equal(st.playing, true)
})

test('closed app: pause, next and volume do not start it', async () => {
  const { ym, calls } = rig()
  for (const r of [await ym.pause(), await ym.next(), await ym.volume({ delta: 1 })]) assert.equal(r.code, 'not-running')
  assert.equal(calls.spawn.length, 0)
})

test('11. pause and resume, each confirmed; nothing pressed when already so', async () => {
  const { ym, calls } = rig({ control: true, page: { playing: true } })
  assert.equal((await ym.pause()).playing, false)
  assert.equal((await ym.play()).playing, true)
  assert.equal((await ym.play()).code, 'ok')
  assert.deepEqual(calls.clicks, ['play', 'play'])
})

test('12. next track confirmed by the title changing; a click the player ignores is unconfirmed', async () => {
  const r = await rig({ control: true, page: { playing: true } }).ym.next()
  assert.equal(r.code, 'ok')
  assert.equal(r.title, 'Звезда по имени Солнце')
  assert.equal((await rig({ control: true, stuck: true }).ym.next()).code, 'unconfirmed')
  assert.equal((await rig({ control: true, stuck: true }).ym.play()).code, 'unconfirmed')
})

test('nothing loaded: next says so', async () => {
  const { ym } = rig({ control: true, page: { title: null, artist: null, loaded: false } })
  assert.equal((await ym.next()).code, 'nothing-playing')
})

test('volume moves in 10% steps, clamped, and is read back', async () => {
  const { ym } = rig({ control: true, page: { volume: 95 } })
  assert.equal((await ym.volume({ delta: 1 })).volume, 100)
  assert.equal((await ym.volume({ set: 20 })).volume, 20)
  assert.equal((await ym.volume({ delta: -1 })).volume, 10)
})

test('opened by hand: transport goes through the app\'s Windows session, confirmed', async () => {
  const { ym, calls } = rig({ running: true, appSession: { playing: true, title: 'Хочешь?', artist: 'Земфира' } })
  const r = await ym.pause()
  assert.equal(r.code, 'ok')
  assert.equal(r.playing, false)
  assert.ok(calls.media.includes('pause'))
  assert.equal((await ym.next()).title, 'Следующая')
  assert.equal((await ym.volume({ delta: 1 })).code, 'no-control')
  const stuck = rig({ running: true, appSession: { playing: true, title: 'x', stuck: true } })
  assert.equal((await stuck.ym.pause()).code, 'unconfirmed')
})

test('opened by hand, no session at all: no-control, not a false success', async () => {
  assert.equal((await rig({ running: true }).ym.play()).code, 'no-control')
})

// -- the Windows helper itself --------------------------------------------------

test('15. a Windows helper that does not answer in time: rejected, killed, and the next request starts a new one', async () => {
  const spawned = []
  const spawn = () => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stdout.setEncoding = () => {}
    child.stderr = new EventEmitter()
    child.stdin = { write: () => {} }
    child.kill = () => {
      child.killed = true
      setImmediate(() => child.emit('exit'))
    }
    spawned.push(child)
    return child
  }
  if (process.platform !== 'win32') return
  const w = createMediaWorker({ spawn, timeoutMs: 20 })
  await assert.rejects(w.request('status'), /не ответила вовремя/)
  assert.equal(spawned[0].killed, true)
  await new Promise((r) => setImmediate(r))
  await assert.rejects(w.request('status'), /не ответила вовремя/)
  assert.equal(spawned.length, 2)
})

test('a Windows helper that cannot run at all: a failure result, never a throw', async () => {
  const ym = createYandexMusic({
    platform: 'win32',
    exists: () => true,
    fetch: async () => {
      throw new Error('boom')
    },
    isRunning: async () => true,
    media: async () => {
      throw new Error('powershell missing')
    },
    sleep: async () => {},
  })
  const r = await ym.pause()
  assert.equal(r.code, 'failed')
})

// -- the route and the model ----------------------------------------------------

test('the /music dispatcher checks what it is given', async () => {
  const seen = []
  const fake = new Proxy({}, { get: (_, k) => (arg) => (seen.push([k, arg]), Promise.resolve({ code: 'ok' })) })
  assert.equal((await musicAction(fake, { action: 'rm -rf' })).code, 'failed')
  assert.equal((await musicAction(fake, { action: 'volume' })).code, 'failed')
  assert.equal((await musicAction(fake, { action: 'playlist' })).code, 'failed')
  await musicAction(fake, { action: 'volume', delta: 7 })
  await musicAction(fake, { action: 'volume', set: 250 })
  await musicAction(fake, { action: 'search', query: 'кино', kind: '<script>', play: false })
  await musicAction(fake, { action: 'playlist', liked: true })
  await musicAction(fake, { action: 'playlist', name: 'Дорога', play: false })
  assert.deepEqual(seen, [
    ['volume', { delta: 1 }],
    ['volume', { set: 100 }],
    ['search', { query: 'кино', kind: 'any', play: false }],
    ['playlist', { name: '', liked: true, play: true }],
    ['playlist', { name: 'Дорога', liked: false, play: false }],
  ])
})

test('the model is told plainly what happened', () => {
  assert.match(describeResult({ code: 'unconfirmed', playing: false }), /do NOT say it worked/)
  assert.match(describeResult({ code: 'ok', playing: true, title: 'Хочешь?', artist: 'Земфира' }), /Now playing «Хочешь\?» — Земфира/)
  assert.match(describeResult({ code: 'ok', playing: true, title: null }), /gives no title/)
  assert.match(describeResult({ code: 'unknown' }), /do not guess/)
  assert.match(describeResult({ code: 'ambiguous', options: ['А', 'Б'] }), /Ask which/)
})

test('source names', () => {
  assert.equal(sourceName(APP_ID), 'Яндекс Музыка')
  assert.equal(sourceName(BROWSER_ID), 'Яндекс Браузер')
  assert.equal(sourceName('Chrome'), 'Google Chrome')
})
