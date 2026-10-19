/**
 * The questions for one agent session, and the resolver of the one its input
 * generator is waiting on. One per session: a session stuck on a stopped turn
 * is replaced (turns.mjs), and the old generator has to end with it rather
 * than take the next question.
 *
 * Moved out of server.mjs unchanged — it was an object literal there, read and
 * written in place — so the same few steps are named once:
 *
 *   put    a question handed over: to the generator waiting, or queued
 *   next   the next queued question, at once, or undefined
 *   wait   a promise of the next one handed over; a close settles it with null
 *   close  the session is over: no more questions, a waiting generator woken
 *
 * `next() ?? await wait()` is the generator's read, so a queued question goes
 * in without an extra turn of the event loop, as before.
 */
export function createInbox() {
  const ch = { inbox: [], deliver: null, closed: false }
  return {
    /** Closed: the session it fed is over. */
    get closed() {
      return ch.closed
    },
    put(item) {
      if (ch.deliver) {
        const resolve = ch.deliver
        ch.deliver = null
        resolve(item)
      } else {
        ch.inbox.push(item)
      }
    },
    next: () => ch.inbox.shift(),
    wait: () =>
      new Promise((resolve) => {
        ch.deliver = resolve
      }),
    close() {
      ch.closed = true
      ch.deliver?.(null)
    },
  }
}
