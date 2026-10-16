#!/usr/bin/env node
/**
 * Connect JARVIS to Google Calendar, once.
 *
 *   npm run calendar:connect -- "C:\path\to\client_secret_….json"
 *
 * The JSON is the OAuth client of type "Desktop app" downloaded from Google
 * Cloud (see the README section or the bridge's log for the steps). It is
 * copied to %LOCALAPPDATA%\JARVIS, outside the project. Then Google's own
 * sign-in page opens in the browser; the user signs in and allows access to
 * calendar events — nothing else is asked for. Google sends the answer back
 * to a one-off page on 127.0.0.1, the refresh token is saved encrypted with
 * Windows DPAPI, and a first read of the calendar proves it works.
 *
 * Run it again to reconnect after access was revoked. No token is printed.
 */

import { createHash, randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { AUTH_URL, CLIENT_FILE, CONFIG_DIR, SCOPE, TOKEN_FILE, TOKEN_URL, createGoogleCalendar, saveToken } from '../bridge/googleCalendar.mjs'

const say = (s) => console.log(s)
const fail = (s) => {
  console.error(`\n✗ ${s}\n`)
  process.exit(1)
}

// -- the client --------------------------------------------------------------

const given = process.argv[2]
mkdirSync(CONFIG_DIR, { recursive: true })
if (given) {
  if (!existsSync(given)) fail(`Файл не найден: ${given}`)
  let parsed
  try {
    parsed = JSON.parse(readFileSync(given, 'utf8'))
  } catch {
    fail('Это не JSON-файл OAuth-клиента Google.')
  }
  if (!parsed.installed?.client_id) {
    fail(parsed.web ? 'Это клиент типа «Web application». Нужен тип «Desktop app» — создайте его заново.' : 'В файле нет installed.client_id — нужен OAuth-клиент типа «Desktop app».')
  }
  copyFileSync(given, CLIENT_FILE)
  say(`Клиент OAuth сохранён в ${CLIENT_FILE}`)
} else if (!existsSync(CLIENT_FILE)) {
  fail('Укажите путь к скачанному JSON-файлу OAuth-клиента:\n  npm run calendar:connect -- "C:\\Users\\…\\Downloads\\client_secret_….json"')
}
const { installed } = JSON.parse(readFileSync(CLIENT_FILE, 'utf8'))
const clientId = installed.client_id
const clientSecret = installed.client_secret ?? ''

// -- the sign-in -------------------------------------------------------------

const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const verifier = b64url(randomBytes(48))
const challenge = b64url(createHash('sha256').update(verifier).digest())
const state = b64url(randomBytes(16))

const server = createServer()
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const redirect = `http://127.0.0.1:${server.address().port}/`

const url = `${AUTH_URL}?${new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirect,
  response_type: 'code',
  scope: SCOPE,
  access_type: 'offline',
  prompt: 'consent',
  code_challenge: challenge,
  code_challenge_method: 'S256',
  state,
})}`

say('\nОткрываю страницу входа Google в браузере.')
say('Войдите в свой аккаунт и разрешите доступ к событиям календаря.')
say(`Если браузер не открылся, откройте эту ссылку вручную:\n${url}\n`)
// rundll32 opens the URL in the default browser without a shell parsing its "&"s.
spawn('rundll32', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' }).unref()

const code = await new Promise((resolve) => {
  const timer = setTimeout(() => {
    server.close()
    fail('Ответа от Google не было 5 минут. Запустите команду ещё раз.')
  }, 5 * 60_000)
  server.on('request', (req, res) => {
    const q = new URL(req.url, redirect).searchParams
    if (!q.has('code') && !q.has('error')) {
      res.writeHead(404).end()
      return
    }
    const page = (title, text) =>
      `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;padding:40px;background:#111;color:#eee"><h2>${title}</h2><p>${text}</p></body>`
    if (q.get('state') !== state) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(page('Ошибка', 'Ответ не от этого запроса. Запустите подключение заново.'))
      return
    }
    if (q.get('error')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page('Доступ не выдан', 'Можно закрыть вкладку.'))
      clearTimeout(timer)
      server.close()
      fail(`Google не выдал доступ: ${q.get('error')}`)
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page('Готово', 'JARVIS подключён к Google Календарю. Вкладку можно закрыть.'))
    clearTimeout(timer)
    server.close()
    resolve(q.get('code'))
  })
})

// -- the token -----------------------------------------------------------------

const res = await fetch(TOKEN_URL, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirect,
    code_verifier: verifier,
  }).toString(),
}).catch((err) => fail(`Не удалось связаться с Google: ${err.message}`))
const tok = await res.json().catch(() => ({}))
if (!res.ok) fail(`Google отклонил обмен кода (${tok.error ?? res.status}).`)
if (!tok.refresh_token) fail('Google не выдал долговременный токен. Удалите доступ JARVIS в https://myaccount.google.com/permissions и повторите.')
if (typeof tok.scope === 'string' && !tok.scope.split(' ').includes(SCOPE)) {
  fail('Доступ к событиям календаря не был выдан. Повторите и отметьте разрешение на календарь.')
}
await saveToken(tok.refresh_token)
say(`Токен сохранён в зашифрованном виде: ${TOKEN_FILE}`)

// -- proof -------------------------------------------------------------------------

const cal = createGoogleCalendar({ env: { ...process.env, JARVIS_TIMEZONE: '' } })
const st = await cal.status()
const now = new Date()
const week = new Date(now.getTime() + 7 * 86_400_000)
const list = await cal.list({ timeMin: now.toISOString(), timeMax: week.toISOString() })
if (list.code !== 'ok') fail(`Подключение сохранено, но чтение календаря не удалось (${list.code}).`)
say(`\n✓ Google Календарь подключён. Часовой пояс календаря: ${st.timeZone}. Встреч на ближайшую неделю: ${list.events.length}.`)
say(st.writes ? 'Запись в календарь разрешена (JARVIS_CALENDAR_WRITES=1).' : 'Запись в календарь пока выключена. Чтобы разрешить: setx JARVIS_CALENDAR_WRITES 1 — и перезапустите JARVIS.')
say('Перезапустите JARVIS, чтобы мост подхватил подключение.\n')
process.exit(0)
