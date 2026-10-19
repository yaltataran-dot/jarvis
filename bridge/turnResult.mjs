import { describeFailure, isAuthFailure, isRateLimit, rateLimitReset, turnFailed } from './failures.mjs'

/**
 * The usage limit, once it is known to be reached.
 *
 * Measured: with the session limit hit, every question still went to the
 * model and came back as a 429 a second later — each one another request
 * against a limit already spent. So when a turn fails with the limit, the
 * model is left alone until the time Claude Code gave for it to lift (or a
 * minute, when it gave none), and questions in the meantime are answered at
 * once with the same plain sentence. Everything that needs no model — the
 * page's own answers, music, the calendar — goes on working. The first
 * question after the time passes goes to the model as normal. Bridge-wide,
 * because the limit belongs to the account, not to one page.
 *
 * Held per login (accounts.mjs): with backups in JARVIS_CLAUDE_BACKUP_DIR (one
 * directory, or several on the path delimiter — settings.mjs), a limited login
 * hands new sessions to the next one free until its time passes, and the model
 * is held off only while every one is.
 */
export const LIMIT_PAUSE_FALLBACK_MS = 60_000
/** Never trust a parsed time to hold the model off for longer than this. */
export const LIMIT_PAUSE_MAX_MS = 6 * 60 * 60_000
/** A login that refused itself, or whose session would not start, is left alone this long. */
export const ACCOUNT_DOWN_MS = 15 * 60_000

/**
 * What a turn's `result` message means, as the outcome turns.mjs takes, with
 * the log line for it and the login held off when the result says so. Moved
 * out of server.mjs unchanged; built once for the bridge (its logins, its
 * language, its failure sentences and how it words a question no login takes),
 * and called by the session stream with what it knows of the turn.
 *
 * @param {{
 *   accounts: ReturnType<typeof import('./accounts.mjs').createAccounts>,
 *   lang: string,
 *   failures: Record<string, string>,
 *   noLogin: (clock: string | null, blocked: object | null) => object,
 * }} o
 */
export function createTurnOutcome({ accounts, lang, failures, noLogin }) {
  /**
   * A result is not automatically a success. The error subtypes
   * carry no `result` field at all, so reporting them as 'done' with
   * empty text is indistinguishable from a turn that simply had
   * nothing to say — the HUD stops spinning and JARVIS stands there
   * silent. Say what happened instead.
   *
   * Nor is subtype 'success' always one: an API error that ends the
   * turn — 403 when the VPN drops, a DNS failure — arrives as
   * 'success' with is_error set and the error as the result text,
   * never streamed. Passed on as 'done' it was an answer nobody heard.
   * See failures.mjs.
   *
   * The frame is handed to turns.mjs rather than sent: it decides
   * whether the page still wants it, and whether the limit's frame
   * becomes a question for the fallback instead.
   *
   * The page stopped this turn — barge-in, "стоп", a newer question.
   * Such a turn ends as error_during_execution, which is the
   * expected shape of a stop and not a fault; logged as a failure
   * it buried the real ones.
   *
   * @param {any} msg  The SDK's result message.
   * @param {{ apiError: string | null, interrupted: boolean, account: string, seconds: () => string, tools: string[] }} turn
   */
  return function turnOutcome(msg, { apiError, interrupted, account, seconds, tools }) {
    let outcome
    if (!turnFailed(msg, apiError)) {
      console.log(
        `[jarvis] turn ok in ${seconds()} s` +
          (tools.length ? ` · tools: ${tools.join(', ')}` : ''),
      )
      outcome = {
        kind: 'ok',
        frame: { type: 'done', text: msg.result ?? '', costUsd: msg.total_cost_usd ?? null },
      }
    } else if (interrupted && msg.subtype === 'error_during_execution' && !apiError) {
      console.log(
        `[jarvis] turn interrupted after ${seconds()} s` +
          (tools.length ? ` · tools: ${tools.join(', ')}` : ''),
      )
      outcome = {
        kind: 'failed',
        frame: { type: 'error', message: failures[msg.subtype] ?? failures.default },
      }
    } else if (isRateLimit(msg, apiError)) {
      // The limit: hold this login off until it lifts — see accounts.
      const reset = rateLimitReset(msg)
      const now = Date.now()
      const until = reset ? Math.min(reset.until, now + LIMIT_PAUSE_MAX_MS) : now + LIMIT_PAUSE_FALLBACK_MS
      accounts.hold(account, until, reset?.clock ?? null, 'rate')
      console.error(
        `[jarvis] turn failed after ${seconds()} s: usage limit (429)` +
          (accounts.switchable() ? ` · login ${account}` : '') +
          ` · model paused until ${new Date(until).toLocaleTimeString()}`,
      )
      // Every login held off: the user waits for the soonest of them, not this one.
      const blocked = accounts.blocked()
      const clock = blocked ? blocked.clock : (reset?.clock ?? null)
      outcome = {
        kind: 'rate',
        frame: noLogin(clock, blocked),
      }
    } else {
      const described = describeFailure(msg, apiError, lang)
      console.error(
        `[jarvis] turn failed after ${seconds()} s: ${msg.subtype}` +
          ` · is_error=${msg.is_error === true}` +
          ` · api_status=${msg.api_error_status ?? 'none'}` +
          ` · api_error=${apiError ?? 'none'}` +
          (tools.length ? ` · tools: ${tools.join(', ')}` : '') +
          (msg.result ? ` · result: ${String(msg.result).slice(0, 300)}` : ''),
        msg.errors ?? '',
      )
      // A login that refused itself: with another to go to, set it
      // aside, so the next turn opens there instead of failing again.
      if (accounts.switchable() && isAuthFailure(msg, apiError)) {
        accounts.hold(account, Date.now() + ACCOUNT_DOWN_MS, null, 'down')
        console.warn(`[jarvis] login ${account} refused — set aside for ${ACCOUNT_DOWN_MS / 60_000} min`)
      }
      // The specific cause when one is known; otherwise the subtype's
      // own sentence, as before.
      const generic = describeFailure({ subtype: 'unknown' }, null, lang)
      outcome = {
        kind: 'failed',
        frame: {
          type: 'error',
          // A known cause outside JARVIS — the network, the VPN, the
          // service — rather than a fault of his own.
          ...(described !== generic ? { kind: 'service' } : {}),
          message:
            described !== generic
              ? described
              : (failures[msg.subtype] ?? failures.default),
        },
      }
    }
    return outcome
  }
}
