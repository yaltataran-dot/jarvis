/**
 * The knowledge base: what JARVIS has been told, kept on this machine.
 *
 * One SQLite file (node:sqlite, built into Node >= 22.5 — no native module to
 * build or install) with a full-text index. No vectors: the questions are short
 * and phrased by the same person, and an exact or keyword match that can be
 * explained beats a nearest-neighbour guess that cannot.
 *
 * This file stores and finds. It does NOT decide what may be answered
 * aloud — that is a separate, stricter question for the router (stage B).
 *
 * TRUST IS DERIVED, NEVER PASSED IN.
 * Callers say where a record came from (`provenance`); the store works out how
 * far it can be trusted. Only the user's own words — said with the intent to
 * save, or confirmed afterwards — make a record `verified`. Whatever Claude said
 * and whatever was lifted out of a conversation is `unverified` until the user
 * confirms it. There is no argument that sets `confidence` directly, so no
 * caller can promote a record by mistake.
 *
 * STORED TEXT IS DATA. It is never executed, never interpreted as a command and
 * never changes a setting. Text that looks like a credential is refused.
 */
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { redact } from './computer.mjs'

export const KINDS = ['fact', 'preference', 'qa', 'self', 'note']

/**
 * Where a record came from. Everything but the first two is unverified.
 *   user-explicit   the user said it, meaning it to be remembered
 *   user-confirmed  something unverified that the user then confirmed
 *   model           Claude's answer
 *   extracted       lifted out of a conversation automatically
 *   web             read from a page or a search
 *   seed            shipped with JARVIS (what he can do, who he is)
 */
export const PROVENANCE = ['user-explicit', 'user-confirmed', 'model', 'extracted', 'web', 'seed']
const USER_PROVENANCE = new Set(['user-explicit', 'user-confirmed'])

export const LIMITS = { question: 500, answer: 4000, topic: 120, list: 200 }

export class KnowledgeError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'KnowledgeError'
    this.code = code
  }
}

/** The folder the database lives in: JARVIS_KB_DIR, else <project>/data. */
export function knowledgeDir(env = process.env) {
  const set = env.JARVIS_KB_DIR?.trim()
  if (set) return resolve(set)
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'data')
}

/**
 * Lower case, ё as е, no punctuation, single spaces. Two phrasings that differ
 * only in these are the same question. Deliberately nothing cleverer: anything
 * that changes the words changes the key.
 */
export function questionKey(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

function clean(value, max, field, { required = false } = {}) {
  const text = String(value ?? '').replace(CONTROL, '').replace(/\s+/g, ' ').trim()
  if (!text) {
    if (required) throw new KnowledgeError('empty', `${field} is empty`)
    return ''
  }
  if (text.length > max) throw new KnowledgeError('too-long', `${field} is longer than ${max} characters`)
  if (redact(text) !== text) throw new KnowledgeError('secret', `${field} looks like a credential and was not stored`)
  return text
}

const SCHEMA_VERSION = 1

const SCHEMA = `
CREATE TABLE knowledge (
  id           INTEGER PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('fact','preference','qa','self','note')),
  topic        TEXT NOT NULL DEFAULT '',
  question     TEXT NOT NULL DEFAULT '',
  qkey         TEXT NOT NULL DEFAULT '',
  answer       TEXT NOT NULL,
  provenance   TEXT NOT NULL,
  confidence   TEXT NOT NULL CHECK (confidence IN ('verified','unverified')),
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded')),
  volatile     INTEGER NOT NULL DEFAULT 0,
  source       TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  confirmed_at TEXT,
  expires_at   TEXT,
  hits         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX knowledge_qkey ON knowledge (qkey) WHERE qkey <> '';

CREATE VIRTUAL TABLE knowledge_fts USING fts5(
  question, answer, topic,
  content='knowledge', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER knowledge_ai AFTER INSERT ON knowledge BEGIN
  INSERT INTO knowledge_fts (rowid, question, answer, topic) VALUES (new.id, new.question, new.answer, new.topic);
END;
CREATE TRIGGER knowledge_ad AFTER DELETE ON knowledge BEGIN
  INSERT INTO knowledge_fts (knowledge_fts, rowid, question, answer, topic) VALUES ('delete', old.id, old.question, old.answer, old.topic);
END;
-- Only when the indexed words change: a use-count or a confirmation must not re-index the text.
CREATE TRIGGER knowledge_au AFTER UPDATE OF question, answer, topic ON knowledge BEGIN
  INSERT INTO knowledge_fts (knowledge_fts, rowid, question, answer, topic) VALUES ('delete', old.id, old.question, old.answer, old.topic);
  INSERT INTO knowledge_fts (rowid, question, answer, topic) VALUES (new.id, new.question, new.answer, new.topic);
END;
`

const toEntry = (row) =>
  row ? {
    id: row.id,
    kind: row.kind,
    topic: row.topic,
    question: row.question,
    answer: row.answer,
    provenance: row.provenance,
    confidence: row.confidence,
    verified: row.confidence === 'verified',
    status: row.status,
    volatile: Boolean(row.volatile),
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    confirmedAt: row.confirmed_at,
    expiresAt: row.expires_at,
    hits: row.hits,
  } : null

/**
 * Words to a safe FTS5 query: every token quoted (so operators typed or spoken
 * are just words), tokens of three or more letters matched as prefixes — there
 * is no stemmer, and "кофе" should find "кофейный". Returns null when nothing
 * searchable is left.
 */
export function ftsQuery(text, mode = 'all') {
  const tokens = questionKey(text).split(' ').filter(Boolean).slice(0, 12)
  if (!tokens.length) return null
  const terms = tokens.map((t) => `"${t.replace(/"/g, '')}"${t.length >= 3 ? '*' : ''}`)
  return terms.join(mode === 'any' ? ' OR ' : ' AND ')
}

const POSIX = process.platform !== 'win32'
const PRIVATE_FILE = 0o600
const PRIVATE_DIR = 0o700
const SIDE_FILES = ['', '-wal', '-shm']

/**
 * Make the database and its two companions readable by this user alone.
 *
 * SQLite gives `-wal` and `-shm` the mode the main file has WHEN IT CREATES
 * them, so a main file made with the default 0644 hands out two 0644 files,
 * and a chmod afterwards fixes only the one it names. The main file is
 * therefore created private before SQLite first opens it (see openKnowledge),
 * which makes every later WAL and SHM — including those recreated after a
 * restart — private from birth. This pass covers files left loose by an
 * earlier version. Changing a file's mode does not disturb connections that
 * already have it open.
 *
 * Returns the paths it could not restrict; it reports them and carries on — a
 * knowledge base that opens with a loose file is better than none, and the
 * folder's own 0700 still stands in front of it.
 */
export function restrictFiles(file) {
  const failed = []
  if (!POSIX) return failed
  for (const suffix of SIDE_FILES) {
    const path = file + suffix
    if (!existsSync(path)) continue
    try {
      if (statSync(path).mode & 0o077) chmodSync(path, PRIVATE_FILE)
    } catch (err) {
      failed.push(path)
      console.warn(`[knowledge] could not restrict ${path}: ${err.message}`)
    }
  }
  return failed
}

/**
 * Open (creating if needed) the database in `dir`.
 * @param {object} [o]
 * @param {string} [o.dir]   folder for knowledge.db; ':memory:' keeps it in RAM
 * @param {() => Date} [o.now]
 */
export function openKnowledge({ dir = knowledgeDir(), now = () => new Date() } = {}) {
  const inMemory = dir === ':memory:'
  let file = ':memory:'
  if (!inMemory) {
    // Returns the first folder it had to create, or undefined if it was already there.
    const made = mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR })
    if (POSIX) {
      if (made !== undefined) chmodSync(dir, PRIVATE_DIR)
      else if (statSync(dir).mode & 0o077) {
        // Not ours to change — it may be a folder the user chose and shares. The files inside are private regardless.
        console.warn(`[knowledge] ${dir} is open to other users; the database files inside are private, but consider chmod 700`)
      }
    }
    file = join(dir, 'knowledge.db')
    // Private from the first byte, whatever the umask: the -wal and -shm inherit this.
    if (POSIX) closeSync(openSync(file, 'a', PRIVATE_FILE))
  }
  const db = new DatabaseSync(file)
  db.exec('PRAGMA busy_timeout = 3000')
  // A deleted record is overwritten with zeros, not just unlinked: "forget this" must mean it.
  db.exec('PRAGMA secure_delete = ON')
  // WAL with NORMAL syncing is SQLite's recommended pairing: a crash can lose the last
  // moments of writes, never corrupt the file — and it spares every write a full fsync.
  if (!inMemory) db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL')

  const version = db.prepare('PRAGMA user_version').get().user_version
  if (version === 0) {
    db.exec(SCHEMA)
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  } else if (version > SCHEMA_VERSION) {
    db.close()
    throw new KnowledgeError('newer-schema', `knowledge.db is schema ${version}; this JARVIS knows ${SCHEMA_VERSION}`)
  }
  if (!inMemory) restrictFiles(file)

  const stamp = () => now().toISOString()
  const q = {
    byId: db.prepare('SELECT * FROM knowledge WHERE id = ?'),
    byKey: db.prepare("SELECT * FROM knowledge WHERE qkey = ? AND qkey <> '' AND status = 'active' ORDER BY id"),
  }

  const need = (id) => {
    const row = q.byId.get(id)
    if (!row) throw new KnowledgeError('not-found', `no knowledge record ${id}`)
    return row
  }

  const confidenceFor = (provenance) => (USER_PROVENANCE.has(provenance) ? 'verified' : 'unverified')

  const tx = (fn) => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const out = fn()
      db.exec('COMMIT')
      return out
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  return {
    /**
     * Save a record. The same question with the same answer is not stored
     * twice: the existing record is refreshed, and upgraded if the new
     * provenance is the user's. A user's own different answer to a question
     * already answered supersedes the old ones (they stay out of search).
     */
    add({ kind = 'fact', topic = '', question = '', answer, provenance, source = '', volatile = false, expiresAt = null }) {
      if (!KINDS.includes(kind)) throw new KnowledgeError('bad-kind', `unknown kind "${kind}"`)
      if (!PROVENANCE.includes(provenance)) throw new KnowledgeError('bad-provenance', `unknown provenance "${provenance}"`)
      const a = clean(answer, LIMITS.answer, 'answer', { required: true })
      const qs = clean(question, LIMITS.question, 'question')
      const tp = clean(topic, LIMITS.topic, 'topic')
      const src = clean(source, LIMITS.topic, 'source')
      const key = questionKey(qs)
      const at = stamp()
      const confidence = confidenceFor(provenance)

      return tx(() => {
        if (key) {
          const same = q.byKey.all(key).find((r) => r.answer === a)
          if (same) {
            const upgrade = confidence === 'verified' && same.confidence !== 'verified'
            db.prepare(
              `UPDATE knowledge SET updated_at = ?, provenance = CASE WHEN ? THEN ? ELSE provenance END,
                 confidence = CASE WHEN ? THEN 'verified' ELSE confidence END,
                 confirmed_at = CASE WHEN ? THEN ? ELSE confirmed_at END WHERE id = ?`,
            ).run(at, upgrade ? 1 : 0, provenance, upgrade ? 1 : 0, upgrade ? 1 : 0, at, same.id)
            return toEntry(q.byId.get(same.id))
          }
          if (confidence === 'verified') {
            db.prepare("UPDATE knowledge SET status = 'superseded', updated_at = ? WHERE qkey = ? AND status = 'active'").run(at, key)
          }
        }
        const info = db
          .prepare(
            `INSERT INTO knowledge (kind, topic, question, qkey, answer, provenance, confidence, volatile, source, created_at, updated_at, confirmed_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(kind, tp, qs, key, a, provenance, confidence, volatile ? 1 : 0, src, at, at, confidence === 'verified' ? at : null, expiresAt)
        return toEntry(q.byId.get(Number(info.lastInsertRowid)))
      })
    },

    get(id) {
      return toEntry(q.byId.get(id))
    },

    /**
     * Edit a record. `provenance` says who is editing. When the user edits, the
     * record stays (or becomes) verified. When anyone else changes the words of
     * a verified record, it drops to unverified: the user vouched for the old
     * words, not these.
     */
    update(id, { question, answer, topic, kind, volatile, expiresAt, provenance = 'user-explicit' }) {
      if (!PROVENANCE.includes(provenance)) throw new KnowledgeError('bad-provenance', `unknown provenance "${provenance}"`)
      return tx(() => {
        const row = need(id)
        const next = {
          question: question === undefined ? row.question : clean(question, LIMITS.question, 'question'),
          answer: answer === undefined ? row.answer : clean(answer, LIMITS.answer, 'answer', { required: true }),
          topic: topic === undefined ? row.topic : clean(topic, LIMITS.topic, 'topic'),
          kind: kind === undefined ? row.kind : kind,
        }
        if (!KINDS.includes(next.kind)) throw new KnowledgeError('bad-kind', `unknown kind "${next.kind}"`)
        const changed = next.question !== row.question || next.answer !== row.answer
        const byUser = USER_PROVENANCE.has(provenance)
        let confidence = row.confidence
        let confirmedAt = row.confirmed_at
        if (byUser) {
          confidence = 'verified'
          confirmedAt = stamp()
        } else if (changed) {
          confidence = 'unverified'
          confirmedAt = null
        }
        db.prepare(
          `UPDATE knowledge SET question = ?, qkey = ?, answer = ?, topic = ?, kind = ?, provenance = ?, confidence = ?,
             confirmed_at = ?, volatile = ?, expires_at = ?, updated_at = ? WHERE id = ?`,
        ).run(
          next.question,
          questionKey(next.question),
          next.answer,
          next.topic,
          next.kind,
          changed || byUser ? provenance : row.provenance,
          confidence,
          confirmedAt,
          volatile === undefined ? row.volatile : volatile ? 1 : 0,
          expiresAt === undefined ? row.expires_at : expiresAt,
          stamp(),
          id,
        )
        return toEntry(q.byId.get(id))
      })
    },

    /** The user vouches for a record as it stands. The only way up for an unverified one. */
    confirm(id) {
      return tx(() => {
        need(id)
        const at = stamp()
        db.prepare(
          "UPDATE knowledge SET confidence = 'verified', provenance = 'user-confirmed', confirmed_at = ?, updated_at = ? WHERE id = ?",
        ).run(at, at, id)
        return toEntry(q.byId.get(id))
      })
    },

    /** Delete for good — the record and its index entries. Returns whether anything was there. */
    remove(id) {
      const info = db.prepare('DELETE FROM knowledge WHERE id = ?').run(id)
      return info.changes > 0
    },

    /** Active records whose question reads the same once normalised. More than one distinct answer is a conflict. */
    findExact(question) {
      const key = questionKey(question)
      return key ? q.byKey.all(key).map(toEntry) : []
    },

    /**
     * Keyword search over question, answer and topic, best match first. Finds;
     * does not judge. `verified` is on every result for the caller to use.
     */
    search(text, { limit = 10, kind = null, verifiedOnly = false, mode = 'all' } = {}) {
      const match = ftsQuery(text, mode)
      if (!match) return []
      const rows = db
        .prepare(
          `SELECT k.*, bm25(knowledge_fts) AS rank FROM knowledge_fts
             JOIN knowledge k ON k.id = knowledge_fts.rowid
            WHERE knowledge_fts MATCH ? AND k.status = 'active'
              AND (? IS NULL OR k.kind = ?) AND (? = 0 OR k.confidence = 'verified')
            ORDER BY rank LIMIT ?`,
        )
        .all(match, kind, kind, verifiedOnly ? 1 : 0, Math.min(Math.max(1, limit), LIMITS.list))
      return rows.map((r) => ({ ...toEntry(r), rank: r.rank }))
    },

    list({ confidence = null, kind = null, status = 'active', limit = 50 } = {}) {
      return db
        .prepare(
          `SELECT * FROM knowledge WHERE status = ? AND (? IS NULL OR confidence = ?) AND (? IS NULL OR kind = ?)
           ORDER BY updated_at DESC, id DESC LIMIT ?`,
        )
        .all(status, confidence, confidence, kind, kind, Math.min(Math.max(1, limit), LIMITS.list))
        .map(toEntry)
    },

    /** Count a use. Kept apart from reads so a search alone never changes anything. */
    touch(id) {
      db.prepare('UPDATE knowledge SET hits = hits + 1 WHERE id = ?').run(id)
    },

    stats() {
      const rows = db.prepare('SELECT confidence, status, COUNT(*) AS n FROM knowledge GROUP BY confidence, status').all()
      const out = { total: 0, verified: 0, unverified: 0, superseded: 0 }
      for (const r of rows) {
        out.total += r.n
        if (r.status === 'superseded') out.superseded += r.n
        else out[r.confidence] += r.n
      }
      return out
    },

    close() {
      db.close()
    },
  }
}
