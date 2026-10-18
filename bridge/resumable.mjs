/**
 * Agent sessions a page may pick up again after its socket drops.
 *
 * The conversation lives in the agent session, and the session was tied to the
 * socket: a phone whose screen went off (the page frozen, the socket gone
 * without a goodbye) came back to a new session that remembered nothing. Claude
 * Code keeps the transcript, so a session can be resumed by its id — but only
 * one this bridge handed out, to the same login, recently. An id the page
 * makes up, one from before a restart, one over thirty minutes old or one from
 * the other login is refused, and the page starts a new conversation as
 * before.
 *
 * Held in memory only. Kept free of imports so the tests can run it.
 */

export const RESUME_TTL_MS = 30 * 60 * 1000
export const RESUME_MAX = 100

/**
 * Where Claude Code keeps a session's transcript: under the login's config
 * directory, in a folder named after the working directory with everything but
 * letters and digits turned into '-' ("/root" -> "-root"). A session whose
 * transcript is not there cannot be resumed, so it is not offered as resumed.
 */
export function transcriptPath(configDir, cwd, id) {
  return `${configDir.replace(/[\\/]+$/, '')}/projects/${String(cwd).replace(/[^A-Za-z0-9]/g, '-')}/${id}.jsonl`
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function createResumable({ ttlMs = RESUME_TTL_MS, max = RESUME_MAX, now = () => Date.now() } = {}) {
  /** id -> { account, expires, owner } — owner is the live connection using it, or null. */
  const issued = new Map()

  const sweep = () => {
    const t = now()
    for (const [id, e] of issued) if (e.expires <= t) issued.delete(id)
    // Oldest first: a Map iterates in insertion order, and issue() re-inserts.
    while (issued.size > max) issued.delete(issued.keys().next().value)
  }

  return {
    /** The session `id` now belongs to this connection (`owner`), on `account`. Refreshes its clock. */
    issue(id, account, owner) {
      if (typeof id !== 'string' || !ID.test(id)) return
      issued.delete(id)
      issued.set(id, { account, expires: now() + ttlMs, owner })
      sweep()
    },

    /** The connection went away; the session stays resumable for the rest of its time. */
    release(id, owner) {
      const e = issued.get(id)
      if (!e || e.owner !== owner) return
      e.owner = null
      e.expires = now() + ttlMs
    },

    /**
     * May `id` be resumed on `account`? Returns the reason it may not, or the
     * live connection still holding it (a socket the server has not yet noticed
     * is dead), which the caller ends before resuming.
     */
    check(id, account) {
      sweep()
      if (typeof id !== 'string' || !ID.test(id)) return { ok: false, reason: 'malformed' }
      const e = issued.get(id)
      if (!e) return { ok: false, reason: 'unknown' }
      if (e.account !== account) return { ok: false, reason: 'other-login' }
      return { ok: true, holder: e.owner }
    },

    size: () => (sweep(), issued.size),
  }
}
