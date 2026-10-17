/**
 * What goes into a turn and what comes out of it as text.
 */

/**
 * The page's record of what it answered by itself (src/lib/aside.ts), as it
 * may reach the model: a short list of { id, said, reply }, or nothing. Every
 * field is checked and bounded rather than trusted — the page caps them far
 * below this already. An item without an id cannot be told from a repeat, so
 * it is dropped.
 */
export const ASIDE_ITEMS = 8
export const ASIDE_FIELD = 300

const field = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, ASIDE_FIELD) : '')

export function asidesFrom(raw) {
  if (!Array.isArray(raw)) return null
  const out = []
  for (const a of raw.slice(-ASIDE_ITEMS)) {
    const id = typeof a?.id === 'string' ? a.id.slice(0, 64) : ''
    const said = field(a?.said)
    const reply = field(a?.reply)
    if (id && said && reply) out.push({ id, said, reply })
  }
  return out.length ? out : null
}

/**
 * Which asides this session already has. One per connection — the socket is
 * the session. `delivered` is called as the question carrying them is handed to
 * the agent, so an exchange is in the session exactly once however many times
 * the page sends it: the page keeps them after a failed turn (it cannot tell a
 * turn that failed before the model from one that failed after), and this is
 * where a repeat is recognised. A new exchange has a new id and is never held
 * back, even when its words are the same as an earlier one's.
 */
export function createAsideLedger(limit = 200) {
  const seen = new Set()
  return {
    fresh: (items) => items.filter((a) => !seen.has(a.id)),
    delivered(items) {
      for (const a of items) seen.add(a.id)
      // Bounded: ids are only ever compared with the page's last few.
      while (seen.size > limit) seen.delete(seen.values().next().value)
    },
  }
}

/** The note as the model reads it — the same words as the page's own (aside.ts). */
export function formatAsides(items, lang = 'ru') {
  if (lang === 'ru') {
    return (
      '(Служебно, не озвучивать. Перед этим вопросом интерфейс сам, без тебя, ответил пользователю — это часть разговора:\n' +
      items.map((a) => `— Пользователь: «${a.said}». Ты: «${a.reply}».`).join('\n') +
      ')'
    )
  }
  return (
    '(System note, not to be spoken. Before this question the interface answered the user itself, without you — this is part of the conversation:\n' +
    items.map((a) => `— User: "${a.said}". You: "${a.reply}".`).join('\n') +
    ')'
  )
}

/** The user message: the note first, then the question. */
export function withAside(text, context) {
  return context ? `${context}\n\n${text}` : text
}

/**
 * A space after each text block of the answer.
 *
 * An answer that calls a tool comes as several text blocks — words, the tool,
 * more words — and the deltas of each were sent back to back. Measured on the
 * weather: "…без осадков.Теплее нормы…". The page's sentence splitter needs a
 * space after the full stop, so the last sentence before the tool was held
 * until the next block arrived, after the tool had run (2.5–3 s for a
 * `display`), and was then spoken glued to the next one.
 *
 * Fed each stream event; returns the delta to send when a text block that had
 * text in it closes, or null.
 */
export function createBlockJoin() {
  /** Index of the text block open now, and whether it carried any text. */
  let open = -1
  let wrote = false
  return (ev) => {
    if (ev?.type === 'content_block_start') {
      open = ev.content_block?.type === 'text' ? (ev.index ?? 0) : -1
      wrote = false
      return null
    }
    if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
      if ((ev.index ?? 0) === open) wrote = true
      return null
    }
    if (ev?.type === 'content_block_stop' && (ev.index ?? 0) === open) {
      const end = wrote ? ' ' : null
      open = -1
      wrote = false
      return end
    }
    return null
  }
}
