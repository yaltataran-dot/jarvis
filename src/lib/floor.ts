/**
 * The floor: who is speaking, and which turn is in flight.
 *
 * Every voice the page produces — an answer, a calendar read-back, a music
 * reply, "Да, сэр?", the start-up greeting, the V and T demos — is a speaker
 * from tts.ts, and every speaker plays on its own: its own queue, its own pump,
 * its own audio element. Nothing in tts.ts stops a second one from playing over
 * the first. That used to be the app's job, done by hand at each place a
 * speaker was made, and several places did not do it: a new turn replaced the
 * speaker ref without cancelling the speaker in it, so the old answer went on
 * playing under the new one. Two voices at once is the overlap itself; and
 * because the echo guard in tts.ts tracks one sentence at a time, the first
 * voice to finish a sentence cleared it while the other was still audible —
 * the microphone was open to his own voice, and he answered himself.
 *
 * So a speaker is only ever made through here, and making one cancels whatever
 * held the floor before. A turn is begun through here too, and beginning one
 * ends the turn in flight — its speaker cancelled, its question to the brain
 * interrupted — so a superseded turn has nothing left that can speak or act.
 * Its code may still be running, awaiting something; when it comes back, its
 * turn is stale and any speaker it asks for is a silent one.
 *
 * It also keeps the record: every turn, speaker, question and stand-down, with
 * the turn's number, on `window.__floor`. Two dialogues at once would show
 * there as two live speakers or two questions in flight — and they cannot both
 * be, by construction; `live()` says so.
 */

/** What the floor needs of a speaker — tts.ts's createSpeaker returns one. */
export type FloorSpeaker = {
  push: (delta: string) => void
  say: (text: string) => void
  end: () => Promise<void>
  cancel: () => void
  level: () => number
}

export type FloorEvent = {
  /** Milliseconds since the floor was made. */
  t: number
  step: string
  /** The turn current when it happened — the dialogue it belongs to. */
  turn: number
  info?: Record<string, string | number | boolean>
}

export type Turn<S extends FloorSpeaker> = {
  readonly id: number
  /** A newer turn, or a stand-down, has replaced this one. */
  stale: () => boolean
  /**
   * A speaker for this turn. Takes the floor from whoever had it. Once the turn
   * is stale it is a silent speaker: a late answer has nowhere to play.
   */
  speaker: (make: () => S, label?: string) => S
  /**
   * Ask the brain. While this runs the question is in flight, and the next
   * turn or stand-down interrupts it. A stale turn does not ask at all.
   */
  ask: <T>(run: () => Promise<T>) => Promise<T>
  /** A speaker of this turn has finished; see Floor.release. */
  release: (spk: S) => boolean
  /** The turn has run its course. Only recorded. */
  done: (how: string) => void
}

export type Floor<S extends FloorSpeaker> = {
  /** Start a turn, ending whatever turn is in flight. */
  begin: (source: string) => Turn<S>
  /** End the turn in flight without starting another: barge-in, Escape, idle. */
  supersede: (reason: string) => void
  /** Cut off whoever is speaking. The turn, and any question, carry on. */
  silence: (reason: string) => void
  /** A speaker outside any turn — a greeting, a demo. Takes the floor too. */
  claim: (make: () => S, label: string) => S
  /**
   * The speaker is done with: it leaves the floor if it still holds it. True
   * if it did — false if something else took the floor meanwhile. One that
   * has not finished playing is cut off: a speaker off the floor is one the
   * next turn would no longer cut, so it must not be left sounding.
   */
  release: (spk: S) => boolean
  /** Whoever holds the floor, or null. */
  current: () => S | null
  /** The newest turn's number. */
  turn: () => number
  /** A question to the brain is in flight. */
  asking: () => boolean
  /** Speakers made and not yet finished or cancelled. Never more than one. */
  live: () => number
  log: (step: string, info?: Record<string, string | number | boolean>) => void
  /** The last events — a window, not the whole session; see stats(). */
  events: () => FloorEvent[]
  /** Counts for the whole session, which the event window can roll past. */
  stats: () => FloorStats
}

export type FloorStats = {
  turns: number
  /** Turns ended by a newer turn or a stand-down before they finished. */
  superseded: number
  /** Questions to the brain interrupted. */
  interrupts: number
  speakers: number
  /** The most speakers ever live at once. Anything over 1 is an overlap. */
  maxLive: number
  overlaps: number
}

/** Thrown by Turn.ask for a turn that went stale before asking. */
export class StaleTurn extends Error {
  constructor() {
    super('stale turn')
  }
}

/** How many events the record keeps. */
const KEEP = 300

export function createFloor<S extends FloorSpeaker>(deps: {
  /** Interrupt the question in flight — brain.ts's interrupt(). */
  interrupt: () => void
  /** Where each event also goes — bridge.ts's trace(), off unless VITE_TRACE=1. */
  trace?: (step: string, info: Record<string, string | number | boolean>) => void
  now?: () => number
  /** A speaker that says nothing, for stale turns. */
  silent?: () => S
}): Floor<S> {
  const now = deps.now ?? (() => Date.now())
  const born = now()
  const record: FloorEvent[] = []

  let seq = 0
  let cur: S | null = null
  let curLabel = ''
  /** The turn whose question is in flight, or 0. */
  let askingTurn = 0
  let speakerSeq = 0
  const liveSpeakers = new Map<number, string>()
  /** How to cut off each floor speaker that has not finished yet. */
  const unfinished = new WeakMap<object, () => void>()
  const stats: FloorStats = { turns: 0, superseded: 0, interrupts: 0, speakers: 0, maxLive: 0, overlaps: 0 }

  const log = (step: string, info: Record<string, string | number | boolean> = {}) => {
    record.push({ t: now() - born, step, turn: seq, ...(Object.keys(info).length ? { info } : {}) })
    if (record.length > KEEP) record.splice(0, record.length - KEEP)
    deps.trace?.(`floor:${step}`, { turn: seq, ...info })
  }

  const silentSpeaker = (): S =>
    deps.silent?.() ??
    ({ push: () => {}, say: () => {}, end: async () => {}, cancel: () => {}, level: () => 0 } as unknown as S)

  const silence = (reason: string) => {
    const s = cur
    if (!s) return
    cur = null
    log('speak:cut', { who: curLabel, reason })
    s.cancel()
  }

  const interruptAsk = (reason: string) => {
    if (!askingTurn) return
    const of = askingTurn
    askingTurn = 0
    stats.interrupts++
    log('ask:interrupt', { of, reason })
    deps.interrupt()
  }

  const claim = (make: () => S, label: string): S => {
    silence(`floor taken by ${label}`)
    const raw = make()
    const id = ++speakerSeq
    liveSpeakers.set(id, label)
    stats.speakers++
    stats.maxLive = Math.max(stats.maxLive, liveSpeakers.size)
    // Every speaker before this one was cut above, or has finished, or was
    // cut on release — so a second live one is a speaker that escaped all
    // three. Say so loudly rather than let it pass.
    if (liveSpeakers.size > 1) {
      stats.overlaps++
      log('overlap', { speakers: [...liveSpeakers.values()].join(',') })
    }
    log('speak:start', { who: label, speaker: id })
    let over = false
    const finished = (how: string) => {
      if (over) return
      over = true
      liveSpeakers.delete(id)
      log('speak:end', { who: label, speaker: id, how })
    }
    /**
     * Words for a speaker that has been cut or has finished: the tail of a
     * cancelled answer still streaming in. They go nowhere — tts.ts drops
     * them — and are recorded once per speaker, not once per word.
     */
    let lateTold = false
    const late = () => {
      if (!over) return false
      if (!lateTold) {
        lateTold = true
        log('speak:late', { who: label, speaker: id })
      }
      return true
    }
    const wrapped = {
      push: (delta: string) => {
        if (!late()) raw.push(delta)
      },
      say: (text: string) => {
        if (!late()) raw.say(text)
      },
      end: async () => {
        await raw.end()
        finished('ended')
      },
      cancel: () => {
        raw.cancel()
        finished('cancelled')
      },
      level: () => raw.level(),
    } as unknown as S
    unfinished.set(wrapped, () => {
      if (over) return
      raw.cancel()
      finished('released')
    })
    cur = wrapped
    curLabel = label
    return wrapped
  }

  const release = (spk: S): boolean => {
    unfinished.get(spk)?.()
    if (cur !== spk) return false
    cur = null
    return true
  }

  const turnOf = (id: number): Turn<S> => {
    const stale = () => id !== seq
    return {
      id,
      stale,
      speaker: (make, label = 'answer') => {
        if (stale()) {
          log('speak:refused', { of: id, who: label })
          return silentSpeaker()
        }
        return claim(make, `turn${id}:${label}`)
      },
      ask: async (run) => {
        if (stale()) {
          log('ask:refused', { of: id })
          throw new StaleTurn()
        }
        askingTurn = id
        log('ask:start', { of: id })
        try {
          const r = await run()
          log('ask:end', { of: id, stale: stale() })
          return r
        } catch (err) {
          log('ask:failed', { of: id, stale: stale() })
          throw err
        } finally {
          if (askingTurn === id) askingTurn = 0
        }
      },
      release,
      done: (how) => log('turn:done', { of: id, how, stale: stale() }),
    }
  }

  const floor: Floor<S> = {
    begin: (source) => {
      const next = seq + 1
      silence(`turn ${next} begins`)
      interruptAsk(`turn ${next} begins`)
      seq = next
      stats.turns++
      log('turn:begin', { source })
      return turnOf(seq)
    },
    supersede: (reason) => {
      silence(reason)
      interruptAsk(reason)
      seq++
      stats.superseded++
      log('turn:superseded', { reason })
    },
    silence,
    claim,
    release,
    current: () => cur,
    turn: () => seq,
    asking: () => askingTurn !== 0,
    live: () => liveSpeakers.size,
    log,
    events: () => record.slice(),
    stats: () => ({ ...stats }),
  }
  return floor
}
