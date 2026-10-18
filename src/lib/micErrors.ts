/**
 * What went wrong with the microphone, said so the user can act on it.
 *
 * Every getUserMedia failure used to be "denied" or "no microphone", and every
 * refusal from the browser's own SpeechRecognition was "Microphone access was
 * refused". On Android that last one appeared with the permission granted: the
 * built-in recogniser cannot open a microphone the page already holds, and says
 * `not-allowed`. Telling someone who has allowed the microphone that they have
 * not sends them to the wrong setting. So the cause is named, and the reason
 * code goes to the trace — never audio, never anything the user said.
 */

import type { MicPermission } from './lifecycle'

export type MicFailure = 'denied' | 'missing' | 'busy' | 'blocked' | 'unknown'

/** A getUserMedia rejection's name, as a cause. Older browsers used the names in the second column. */
export function classifyMicError(name: string | undefined): MicFailure {
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'denied'
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'missing'
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'busy'
    case 'SecurityError':
      return 'blocked'
    default:
      return 'unknown'
  }
}

const RU: Record<MicFailure, string> = {
  denied:
    'Доступ к микрофону запрещён для этого сайта. Разрешите его: значок замка у адреса → «Разрешения» → «Микрофон» → «Разрешить», затем коснитесь экрана.',
  missing: 'Микрофон не найден. Проверьте, что он подключён и не отключён в системе, затем коснитесь экрана.',
  busy: 'Микрофон занят другим приложением (звонок, диктофон, другая вкладка). Закройте его и коснитесь экрана.',
  blocked: 'Браузер не даёт этой странице доступ к микрофону (политика безопасности). Откройте сайт по https://ai-ug.ru напрямую.',
  unknown: 'Микрофон не запустился. Коснитесь экрана, чтобы попробовать снова.',
}
const EN: Record<MicFailure, string> = {
  denied: 'Microphone access is blocked for this site. Allow it in the site settings (the lock by the address), then tap the screen.',
  missing: 'No microphone was found. Check it is connected and enabled, then tap the screen.',
  busy: 'The microphone is in use by another app (a call, a recorder, another tab). Close it and tap the screen.',
  blocked: 'The browser does not let this page use the microphone (security policy). Open the site directly over https.',
  unknown: 'The microphone did not start. Tap the screen to try again.',
}

export function micFailureMessage(kind: MicFailure, lang: 'ru' | 'en' = 'ru'): string {
  return (lang === 'en' ? EN : RU)[kind]
}

/**
 * The recogniser's server could not be reached again after its session dropped
 * (the network, the bridge), and there is no fallback that works here.
 */
export function sttUnavailableMessage(lang: 'ru' | 'en' = 'ru'): string {
  return lang === 'en'
    ? 'Speech recognition has stopped: its server could not be reached. Check the connection and tap the screen to start it again.'
    : 'Распознавание речи остановилось: нет связи с сервером распознавания. Проверьте интернет и коснитесь экрана, чтобы запустить его снова.'
}

/**
 * The microphone is open and allowed, but the browser would not start the
 * audio that carries it to the recogniser (audioStart.ts) — on a phone, until
 * the page is touched. Not the permission, so the permission is not blamed.
 */
export function audioBlockedMessage(lang: 'ru' | 'en' = 'ru'): string {
  return lang === 'en'
    ? 'The browser did not start the audio from the microphone. Tap the screen once and he will listen.'
    : 'Браузер не запустил звук с микрофона. Коснитесь экрана один раз — после касания JARVIS начнёт слушать.'
}

/**
 * The browser's SpeechRecognition said `not-allowed` or `service-not-allowed`.
 * Which it means depends on what the browser says about the microphone: with
 * the permission granted it is the recogniser, not the user, that cannot have
 * the microphone.
 */
export function speechRefusalMessage(code: string, permission: MicPermission, lang: 'ru' | 'en' = 'ru'): string {
  const ru = lang !== 'en'
  if (code === 'service-not-allowed') {
    return ru
      ? 'Встроенное распознавание речи браузера отключено или недоступно. Основное распознавание вернётся автоматически; если сообщение не исчезает — коснитесь экрана.'
      : "The browser's own speech recognition is switched off or unavailable. The main recogniser will come back on its own; if this stays, tap the screen."
  }
  if (permission === 'granted') {
    return ru
      ? 'Микрофон разрешён, но встроенное распознавание браузера не смогло его получить. Основное распознавание вернётся автоматически; если сообщение не исчезает — коснитесь экрана.'
      : "The microphone is allowed, but the browser's own recogniser could not get it. The main recogniser will come back on its own; if this stays, tap the screen."
  }
  return micFailureMessage('denied', ru ? 'ru' : 'en')
}
