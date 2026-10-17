/**
 * Filling and keeping the knowledge base, by hand.
 *
 * This is the only way records enter it before JARVIS learns from
 * conversations, and it is built around one rule:
 *
 *   NOTHING BECOMES `verified` EXCEPT FROM AN INTERACTIVE TERMINAL.
 *
 * Every command that adds a verified record, vouches for one, edits one or
 * deletes one asks a person to type at a prompt. With no terminal attached —
 * a pipe, a script, a cron job, an assistant running commands on the user's
 * behalf — those commands refuse. So an answer Claude gave, or a file somebody
 * prepared, cannot be promoted by running a command: the promotion needs the
 * user, looking at the record, saying yes.
 *
 * What does work anywhere is reading (list, show, search, stats, export) and
 * `import`, which can only ever create UNVERIFIED candidates: whatever the file
 * says about itself ("verified", a provenance) is ignored. Candidates wait for
 * `review`, where the user confirms, corrects or discards them one by one.
 *
 * The logic takes its terminal as an argument so it can be tested without one.
 */
import { parseArgs } from 'node:util'
import { KINDS, KnowledgeError, LIMITS } from './knowledge.mjs'

/** Largest import: a file, and the records in it. */
export const IMPORT_MAX_BYTES = 1024 * 1024
export const IMPORT_MAX_ITEMS = 500

const NEEDS_PERSON = new Set(['add', 'edit', 'confirm', 'review', 'delete'])

const HELP = `База знаний JARVIS

Чтение (работает везде):
  list [--pending | --verified] [--kind K] [--limit N]   записи
  show <id>                                              одна запись целиком
  search <слова>                                         поиск
  stats                                                  сколько записей и какой достоверности
  export [файл.json]                                     выгрузка (без файла — в stdout)

Кандидаты (работает везде, записи всегда НЕподтверждённые):
  import <файл.json>                                     загрузить список [{question, answer, kind?, topic?}]

Подтверждённые знания (только в интерактивном терминале, вводит человек):
  add                                                    добавить своё знание
  review                                                 разобрать неподтверждённые: подтвердить / поправить / удалить
  confirm <id>      edit <id>      delete <id>

Подтверждённым становится только то, что вы сами сказали и подтвердили здесь.
Ответ Claude, импортированный файл или автоматически извлечённый факт — нет.
`

const NOT_A_PERSON =
  'Эта команда подтверждает или меняет знания, поэтому работает только в интерактивном терминале, где ответы вводит человек. ' +
  'Так подтверждённым не может стать ответ Claude или содержимое файла. Откройте терминал и выполните её сами: node scripts/kb.mjs <команда>'

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const mark = (r) => (r.verified ? '✓' : '?')

function describe(r) {
  const q = r.question ? `${clip(r.question, 60)} → ` : ''
  return `#${r.id} [${mark(r)}] ${r.kind.padEnd(10)} ${q}${clip(r.answer, 70)}`
}

function full(r) {
  return [
    `#${r.id}  ${r.verified ? 'ПОДТВЕРЖДЕНО' : 'не подтверждено'}  (${r.provenance}${r.source ? `, ${r.source}` : ''})`,
    `вид:      ${r.kind}${r.topic ? `   тема: ${r.topic}` : ''}${r.volatile ? '   изменчивое' : ''}`,
    r.question && `вопрос:   ${r.question}`,
    `ответ:    ${r.answer}`,
    `создано:  ${r.createdAt}   изменено: ${r.updatedAt}${r.confirmedAt ? `   подтверждено: ${r.confirmedAt}` : ''}`,
    r.expiresAt && `действует до: ${r.expiresAt}`,
    `использовано: ${r.hits}   статус: ${r.status}`,
  ]
    .filter(Boolean)
    .join('\n')
}

const yes = (a) => /^(?:y|yes|д|да)$/i.test(a.trim())

/**
 * @param {string[]} argv       arguments after the program name
 * @param {object} env
 * @param {object} env.kb       an open knowledge base
 * @param {{ tty: boolean, ask: (q: string) => Promise<string>, out: (s: string) => void, err: (s: string) => void, readFile: (path: string) => { size: number, text: string }, writeFile: (path: string, text: string) => void }} env.io
 * @returns {Promise<number>}  the exit code
 */
export async function runKb(argv, { kb, io }) {
  const [cmd, ...rest] = argv
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    io.out(HELP)
    return cmd ? 0 : 1
  }
  if (NEEDS_PERSON.has(cmd) && !io.tty) {
    io.err(NOT_A_PERSON)
    return 3
  }

  let args
  try {
    args = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        pending: { type: 'boolean' },
        verified: { type: 'boolean' },
        kind: { type: 'string' },
        limit: { type: 'string' },
      },
    })
  } catch (err) {
    io.err(`Не понял аргументы: ${err.message}`)
    return 2
  }
  const { values, positionals } = args
  const idArg = () => {
    const n = Number(positionals[0])
    return Number.isInteger(n) && n > 0 ? n : null
  }
  const needId = () => {
    const id = idArg()
    if (id === null) io.err(`Нужен номер записи: node scripts/kb.mjs ${cmd} <id>`)
    return id
  }
  const fetch = (id) => {
    const r = kb.get(id)
    if (!r) io.err(`Записи ${id} нет.`)
    return r
  }
  const ask = async (q, fallback = '') => {
    const a = (await io.ask(q)).trim()
    return a || fallback
  }

  try {
    switch (cmd) {
      case 'list': {
        if (values.kind && !KINDS.includes(values.kind)) {
          io.err(`Вид должен быть один из: ${KINDS.join(', ')}`)
          return 2
        }
        const confidence = values.pending ? 'unverified' : values.verified ? 'verified' : null
        const rows = kb.list({ confidence, kind: values.kind ?? null, limit: Number(values.limit) || 50 })
        if (!rows.length) io.out('Записей нет.')
        for (const r of rows) io.out(describe(r))
        return 0
      }
      case 'show': {
        const id = needId()
        if (id === null) return 2
        const r = fetch(id)
        if (!r) return 1
        io.out(full(r))
        return 0
      }
      case 'search': {
        if (!positionals.length) {
          io.err('Что искать? node scripts/kb.mjs search <слова>')
          return 2
        }
        const rows = kb.search(positionals.join(' '), { limit: Number(values.limit) || 10 })
        if (!rows.length) io.out('Ничего не найдено.')
        for (const r of rows) io.out(describe(r))
        return 0
      }
      case 'stats': {
        const s = kb.stats()
        io.out(`всего ${s.total} · подтверждённых ${s.verified} · ждут подтверждения ${s.unverified} · заменённых ${s.superseded}`)
        return 0
      }
      case 'export': {
        const rows = kb.list({ limit: LIMITS.list }).map(({ kind, topic, question, answer, volatile, expiresAt, confidence, provenance, source }) => ({
          kind, topic, question, answer, volatile, expiresAt, confidence, provenance, source,
        }))
        const text = `${JSON.stringify(rows, null, 2)}\n`
        if (positionals[0]) {
          io.writeFile(positionals[0], text)
          io.out(`Выгружено ${rows.length} записей в ${positionals[0]}. Файл содержит личные данные — не отправляйте его и не добавляйте в Git.`)
        } else io.out(text)
        return 0
      }
      case 'import': {
        if (!positionals[0]) {
          io.err('Какой файл? node scripts/kb.mjs import <файл.json>')
          return 2
        }
        const file = io.readFile(positionals[0])
        if (file.size > IMPORT_MAX_BYTES) {
          io.err(`Файл больше ${IMPORT_MAX_BYTES} байт — не загружаю.`)
          return 2
        }
        let items
        try {
          items = JSON.parse(file.text)
        } catch {
          io.err('Файл не разобрать как JSON.')
          return 2
        }
        if (!Array.isArray(items) || items.length > IMPORT_MAX_ITEMS) {
          io.err(`Нужен список не длиннее ${IMPORT_MAX_ITEMS} записей.`)
          return 2
        }
        let added = 0
        const failed = []
        items.forEach((it, i) => {
          try {
            // Only the content is taken. `confidence`, `provenance`, `source`, `status` in the file are ignored:
            // a file cannot say it is trustworthy.
            kb.add({
              kind: KINDS.includes(it?.kind) ? it.kind : 'fact',
              topic: it?.topic,
              question: it?.question,
              answer: it?.answer,
              volatile: it?.volatile === true,
              expiresAt: typeof it?.expiresAt === 'string' ? it.expiresAt : null,
              provenance: 'extracted',
              source: `import:${String(positionals[0]).split(/[\\/]/).pop()}`,
            })
            added++
          } catch (err) {
            failed.push(`#${i + 1}: ${err instanceof KnowledgeError ? err.message : 'не удалось сохранить'}`)
          }
        })
        io.out(`Загружено кандидатов: ${added}. Все НЕподтверждены. Разберите их: node scripts/kb.mjs review`)
        for (const f of failed.slice(0, 20)) io.err(`  пропущено ${f}`)
        if (failed.length > 20) io.err(`  …и ещё ${failed.length - 20}`)
        return failed.length ? 1 : 0
      }
      case 'add': {
        io.out('Новое подтверждённое знание. Пустой ответ на вопрос «ответ» — отмена.')
        const kind = await ask(`вид (${KINDS.join('/')}) [fact]: `, 'fact')
        const question = await ask('вопрос (как вы его зададите вслух; можно пусто для заметки): ')
        const answer = await ask('ответ: ')
        if (!answer) {
          io.out('Отменено.')
          return 1
        }
        const topic = await ask('тема (необязательно): ')
        const volatile = yes(await ask('меняется со временем (погода, цены)? [н/Д]: ', 'n'))
        io.out(`\nСохранить как ПОДТВЕРЖДЁННОЕ?\n  вид: ${kind}\n  вопрос: ${question || '—'}\n  ответ: ${answer}${volatile ? '\n  изменчивое: да' : ''}`)
        if (!yes(await ask('да/нет: '))) {
          io.out('Не сохранено.')
          return 1
        }
        const r = kb.add({ kind, topic, question, answer, volatile, provenance: 'user-explicit', source: 'cli' })
        io.out(`Сохранено: #${r.id}`)
        return 0
      }
      case 'confirm': {
        const id = needId()
        if (id === null) return 2
        const r = fetch(id)
        if (!r) return 1
        io.out(full(r))
        if (!yes(await ask('\nВы подтверждаете, что это верно? да/нет: '))) {
          io.out('Не подтверждено.')
          return 1
        }
        kb.confirm(id)
        io.out(`Подтверждено: #${id}`)
        return 0
      }
      case 'edit': {
        const id = needId()
        if (id === null) return 2
        const r = fetch(id)
        if (!r) return 1
        io.out(full(r))
        const question = await ask(`\nвопрос [${r.question}]: `, r.question)
        const answer = await ask(`ответ [${r.answer}]: `, r.answer)
        if (!yes(await ask('Сохранить как ПОДТВЕРЖДЁННОЕ? да/нет: '))) {
          io.out('Не сохранено.')
          return 1
        }
        kb.update(id, { question, answer, provenance: 'user-explicit' })
        io.out(`Сохранено: #${id}`)
        return 0
      }
      case 'delete': {
        const id = needId()
        if (id === null) return 2
        const r = fetch(id)
        if (!r) return 1
        io.out(full(r))
        if (!yes(await ask('\nУдалить насовсем? да/нет: '))) {
          io.out('Не удалено.')
          return 1
        }
        kb.remove(id)
        io.out(`Удалено: #${id}`)
        return 0
      }
      case 'review': {
        // In the order they arrived, so a long queue is worked through from the top.
        const pending = kb.list({ confidence: 'unverified', limit: LIMITS.list }).sort((x, y) => x.id - y.id)
        if (!pending.length) {
          io.out('Нечего разбирать: неподтверждённых записей нет.')
          return 0
        }
        io.out(`Неподтверждённых: ${pending.length}. Для каждой: д — верно, п — поправить, у — удалить, с — пропустить, в — выйти.`)
        const done = { confirmed: 0, edited: 0, deleted: 0, skipped: 0 }
        for (const r of pending) {
          io.out(`\n${full(r)}`)
          const a = (await ask('[д/п/у/с/в]: ', 'с')).toLowerCase()
          if (a === 'в' || a === 'q') break
          if (a === 'д' || a === 'y') {
            kb.confirm(r.id)
            done.confirmed++
          } else if (a === 'п' || a === 'e') {
            const question = await ask(`вопрос [${r.question}]: `, r.question)
            const answer = await ask(`ответ [${r.answer}]: `, r.answer)
            kb.update(r.id, { question, answer, provenance: 'user-explicit' })
            done.edited++
          } else if (a === 'у' || a === 'd') {
            kb.remove(r.id)
            done.deleted++
          } else done.skipped++
        }
        io.out(`\nПодтверждено ${done.confirmed}, поправлено ${done.edited}, удалено ${done.deleted}, пропущено ${done.skipped}.`)
        return 0
      }
      default:
        io.err(`Неизвестная команда «${cmd}».\n`)
        io.out(HELP)
        return 2
    }
  } catch (err) {
    // The base refuses credentials, empty or oversized text; say why and stop, never half-save.
    io.err(err instanceof KnowledgeError ? `Не сохранено: ${err.message}` : `Ошибка: ${err.message}`)
    return 1
  }
}
