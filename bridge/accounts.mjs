/**
 * Which Claude login the agent session runs on: `primary`, the one Claude Code
 * uses by default, and optionally `backup`, a second login kept in its own
 * config directory (JARVIS_CLAUDE_BACKUP_DIR, read by Claude Code as
 * CLAUDE_CONFIG_DIR). Each has its own credentials and its own transcripts, so
 * the two never share a token, and a session on one cannot resume the other's.
 *
 * The state is per account and bridge-wide, because a usage limit belongs to
 * the account rather than to one page: when one is limited until a time, no
 * session anywhere is opened on it before then. The choice is always the first
 * account not held off, so the primary is taken back as soon as its time has
 * passed. Whether it really has lifted is only known from the next request;
 * if it has not, that request's 429 holds it off again.
 *
 * Labels only, here and in every log line: never an email or a path.
 *
 * Kept free of imports so the tests can drive it with plain numbers.
 */

/**
 * @param {object} [o]
 * @param {string | null} [o.backupDir]  The backup login's config directory, or none.
 */
export function createAccounts({ backupDir = null } = {}) {
  const list = [{ label: 'primary', dir: null }]
  if (backupDir) list.push({ label: 'backup', dir: backupDir })
  /** label -> { until, clock, reason } while held off. */
  const held = new Map()

  const heldAt = (label, now) => {
    const h = held.get(label)
    return h && now < h.until ? h : null
  }

  return {
    /** Every account, in the order they are preferred. */
    labels: () => list.map((a) => a.label),

    /** More than one login to choose from. */
    switchable: () => list.length > 1,

    /**
     * The agent's environment for `label`: the primary's as it is, the
     * backup's with its own config directory.
     */
    env(label, base) {
      const a = list.find((x) => x.label === label)
      return a?.dir ? { ...base, CLAUDE_CONFIG_DIR: a.dir } : base
    },

    /**
     * Hold `label` off until `until`. `clock` is the time to tell the user,
     * when the limit gave one; `reason` is for the log ('rate' or 'down').
     * A later time never shortens an earlier one still running.
     */
    hold(label, until, clock = null, reason = 'rate') {
      if ((held.get(label)?.until ?? 0) >= until) return
      held.set(label, { until, clock, reason })
    },

    /** Is `label` held off at `now`? */
    held: (label, now = Date.now()) => Boolean(heldAt(label, now)),

    /** The account a new session should open on: the first not held off, else null. */
    pick(now = Date.now()) {
      return list.find((a) => !heldAt(a.label, now))?.label ?? null
    },

    /**
     * When every account is held off: when the soonest one is back, and its
     * clock. Null clock when that one gave none — a later account's time would
     * tell the user to wait longer than they must. Null while any is free.
     */
    blocked(now = Date.now()) {
      const hs = list.map((a) => heldAt(a.label, now))
      if (hs.some((h) => !h)) return null
      const soonest = hs.reduce((a, b) => (b.until < a.until ? b : a))
      return { until: soonest.until, clock: soonest.clock }
    },
  }
}
