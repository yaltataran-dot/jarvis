/**
 * One question on the floor at a time, and every frame tagged with the
 * question that produced it.
 *
 * The agent session's stream carries no notion of a turn: a delta is just a
 * delta, so the only way to say which question it belongs to is to never let
 * two questions be in the session at once. A question is handed over only when
 * the one before it has reported its `result` — the SDK emits exactly one per
 * turn — and until then every frame belongs to the turn on the floor.
 *
 * This replaces a queue that waited for that result with a 30 s cap and then
 * handed the next question over anyway. Past the cap the old turn was still in
 * the session, so its tail went out tagged with the new question's id and the
 * page took it for the new answer. Now the cap restarts the session instead
 * (primary.restart), and the stuck turn's frames die with the old stream.
 *
 * What stops a turn, and what it does:
 *   - "стоп" or a barge-in (interrupt): the turn on the floor is stopped and
 *     whatever was waiting behind it is dropped; nothing more of it is sent.
 *   - a newer question (ask): the older one is stopped the same way, and the
 *     newer one takes the floor once it has finished.
 *
 * The usage limit, when a fallback channel is configured (fallback.mjs): the
 * same question goes to the fallback, in the same turn, only once the primary
 * has finished — never both at once — and only if the primary had neither
 * called a tool nor said a word. A turn that called tools is not tried again
 * anywhere, since some of it may already have happened; the fallback itself
 * has no tools at all.
 *
 * The usage limit, when there are other Claude logins (accounts.mjs): before
 * that, the same question goes to a new session on another login — on the same
 * terms, only if the turn had neither called a tool nor said a word. At most
 * `maxSwitches` times per turn (one per other login), and never to a login the
 * turn has already been on, so limited logins cannot pass a question back and
 * forth. Which login a turn starts on is settled before it is handed over,
 * never in the middle of one.
 *
 * Kept free of imports so the tests can drive it with fakes.
 */

/**
 * @param {object} o
 * @param {{
 *   hand(turn): void,
 *   interrupt(): unknown,
 *   restart(): void,
 *   pausedFrame(): object | null,
 *   atBoundary?(): void,
 *   account?(): string,
 *   switchAccount?(tried: string[]): string | boolean,
 * }} o.primary  The agent session. `pausedFrame` is the limit's error frame
 *   while the model is held off (every login limited, in server.mjs),
 *   otherwise null. `atBoundary`, between turns, moves the session to the
 *   login a new turn should run on; `account` names the login it is on.
 *   `switchAccount`, after a limit, moves it to another login that is free
 *   and not among `tried`, and says which (or just whether it did).
 * @param {null | {
 *   ready(): { ok: boolean, kind?: string },
 *   answer(a: { item, history, signal: AbortSignal, onText(d: string): void }): Promise<{ text: string, costUsd?: number }>,
 * }} [o.fallback]
 * @param {(frame: object) => void} o.send
 * @param {{ fallbackDown(kind: string): string, limitMidTurn(): string }} o.say
 * @param {(event: string, turn?: object, detail?: string) => void} [o.log]
 * @param {number} [o.waitCapMs]  How long a stopped turn may take to finish.
 * @param {number} [o.maxSwitches]  How many other logins one question may be asked on.
 */
export function createTurns({
  primary,
  fallback = null,
  send,
  say,
  log = () => {},
  waitCapMs = 30_000,
  maxSwitches = 1,
  historyMax = 6,
  timers = globalThis,
}) {
  /** The turn on the floor. */
  let current = null
  /** The one question waiting for the floor; a newer one replaces it. */
  let waiting = null
  /** Recent exchanges, for the fallback, which has no session of its own. */
  const history = []
  let closed = false

  const tag = (turn, frame) => send({ ...frame, ask: turn.id })

  function finish(turn, answer) {
    if (current !== turn) return
    timers.clearTimeout(turn.watchdog)
    turn.watchdog = 0
    current = null
    if (typeof answer === 'string' && answer.trim()) {
      history.push({ q: turn.item.text, a: answer.trim() })
      if (history.length > historyMax) history.shift()
    }
    pump()
  }

  function pump() {
    if (closed || current || !waiting) return
    const next = waiting
    waiting = null
    start(next)
  }

  function start({ id, item }) {
    const turn = {
      id,
      item,
      phase: 'primary',
      interrupted: false,
      reinterrupted: false,
      acted: false,
      spoke: false,
      switches: 0,
      /** The logins this question has been asked on, by label, when they are known. */
      tried: [],
      abort: null,
      watchdog: 0,
    }
    current = turn
    // Between turns: the login this one should run on.
    primary.atBoundary?.()
    const on = primary.account?.()
    if (on) turn.tried.push(on)
    // The limit is known to be reached: no request against it.
    const paused = primary.pausedFrame()
    if (paused) {
      if (fallback) return void runFallback(turn, paused)
      tag(turn, paused)
      return finish(turn)
    }
    primary.hand(turn)
  }

  const interruptPrimary = () => {
    void Promise.resolve()
      .then(() => primary.interrupt())
      .catch(() => {})
  }

  /**
   * A stopped turn has this long to report its end. A primary turn that does
   * not is stuck in the session, and the session is replaced; a fallback that
   * ignores its abort signal is simply let go.
   */
  function armWatchdog(turn) {
    if (turn.watchdog) return
    turn.watchdog = timers.setTimeout(() => {
      turn.watchdog = 0
      if (current !== turn) return
      log('stuck', turn)
      if (turn.phase === 'primary') primary.restart()
      finish(turn)
    }, waitCapMs)
  }

  function stop(turn) {
    if (turn.interrupted) return
    turn.interrupted = true
    if (turn.phase === 'fallback') turn.abort?.abort()
    else interruptPrimary()
    armWatchdog(turn)
  }

  async function runFallback(turn, limitFrame) {
    turn.phase = 'fallback'
    // Set before anything is awaited, so a "стоп" in the switch-over lands.
    const abort = new AbortController()
    turn.abort = abort
    if (turn.interrupted) return finish(turn)
    const ready = fallback.ready()
    if (!ready.ok) {
      log('fallback-skipped', turn, ready.kind)
      tag(turn, ready.kind === 'config' ? limitFrame : { ...limitFrame, message: say.fallbackDown(ready.kind) })
      return finish(turn)
    }
    log('fallback', turn)
    try {
      const res = await fallback.answer({
        item: turn.item,
        history: history.slice(),
        signal: abort.signal,
        onText: (delta) => {
          if (current === turn && !turn.interrupted && delta) tag(turn, { type: 'text', delta })
        },
      })
      if (current !== turn || turn.interrupted) return finish(turn)
      tag(turn, { type: 'done', text: res.text, costUsd: res.costUsd ?? null, provider: 'fallback' })
      finish(turn, res.text)
    } catch (err) {
      const kind = turn.interrupted || abort.signal.aborted ? 'cancelled' : (err?.kind ?? 'service')
      log('fallback-failed', turn, kind)
      if (kind !== 'cancelled' && current === turn) {
        // Still the limit's frame — the page says the limit aloud — with the
        // reason the fallback could not take it on the screen.
        tag(turn, { ...limitFrame, message: say.fallbackDown(kind) })
      }
      finish(turn)
    }
  }

  return {
    /** A question from the page. `item` is whatever primary.hand needs. */
    ask(id, item) {
      if (closed) return
      if (waiting) log('superseded', waiting)
      waiting = { id, item }
      // The page listens only for its newest question.
      if (current) stop(current)
      pump()
    },

    /** "Стоп", a barge-in, or the page's own turn limit. */
    interrupt() {
      if (waiting) {
        log('superseded', waiting)
        waiting = null
      }
      if (current) stop(current)
    },

    /**
     * A frame from the primary session for the turn on the floor. Dropped when
     * there is no such turn or it has been stopped: the page has stopped
     * listening, and an untagged frame would be read by whichever turn is next.
     */
    frame(f) {
      const turn = current
      if (!turn || turn.phase !== 'primary' || turn.interrupted) return false
      if (f.type === 'text' && typeof f.delta === 'string' && f.delta.trim()) turn.spoke = true
      tag(turn, f)
      return true
    },

    /**
     * Any stream event from the primary. A turn stopped while the session was
     * still starting up is running only now, so the interrupt is sent again —
     * the first one did not land.
     */
    streaming() {
      const turn = current
      if (turn?.phase === 'primary' && turn.interrupted && !turn.reinterrupted) {
        turn.reinterrupted = true
        interruptPrimary()
      }
    },

    /** The primary turn called a tool, which may have changed something. */
    acted() {
      if (current?.phase === 'primary') current.acted = true
    },

    /** A primary turn is on the floor and still wanted — for panels and the like. */
    live() {
      return Boolean(current && current.phase === 'primary' && !current.interrupted)
    },

    /** The turn on the floor was stopped by the page. */
    interrupted() {
      return Boolean(current?.interrupted)
    },

    /**
     * The primary reported its `result`.
     * @param {{ kind: 'ok' | 'failed' | 'rate', frame: object }} outcome
     */
    primaryEnded(outcome) {
      const turn = current
      if (!turn || turn.phase !== 'primary') {
        log('stale-result')
        return
      }
      // Stopped: the page is not listening, and says nothing about it.
      if (turn.interrupted) return finish(turn)
      if (outcome.kind === 'rate' && turn.acted) {
        tag(turn, { ...outcome.frame, message: say.limitMidTurn() })
        return finish(turn)
      }
      // Another login, one not yet tried: nothing of this turn happened, so it can be asked again.
      if (outcome.kind === 'rate' && !turn.spoke && turn.switches < maxSwitches) {
        const to = primary.switchAccount?.(turn.tried)
        if (to) {
          turn.switches++
          if (typeof to === 'string') turn.tried.push(to)
          log('account-switch', turn)
          return void primary.hand(turn)
        }
      }
      if (outcome.kind === 'rate' && fallback && !turn.spoke) return void runFallback(turn, outcome.frame)
      tag(turn, outcome.frame)
      finish(turn, outcome.kind === 'ok' ? outcome.frame.text : null)
    },

    /** The socket is gone. */
    close() {
      closed = true
      waiting = null
      const turn = current
      if (!turn) return
      current = null
      timers.clearTimeout(turn.watchdog)
      turn.interrupted = true
      turn.abort?.abort()
    },
  }
}
