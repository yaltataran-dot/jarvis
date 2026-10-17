import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { openKnowledge } from '../bridge/knowledge.mjs'
import { IMPORT_MAX_ITEMS, runKb } from '../bridge/knowledgeAdmin.mjs'
import { decide } from '../bridge/knowledgeRoute.mjs'

let kb
beforeEach(() => {
  kb = openKnowledge({ dir: ':memory:' })
})
afterEach(() => kb.close())

/** A terminal that is, or is not, a person; answers are typed from a script. */
function term({ tty = true, answers = [], files = {} } = {}) {
  const out = []
  const err = []
  const asked = []
  const written = {}
  const queue = [...answers]
  const io = {
    tty,
    ask: async (q) => {
      asked.push(q)
      return queue.length ? queue.shift() : ''
    },
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    readFile: (path) => {
      if (!(path in files)) throw new Error(`no such file ${path}`)
      const text = typeof files[path] === 'string' ? files[path] : JSON.stringify(files[path])
      return { size: Buffer.byteLength(text), text }
    },
    writeFile: (path, text) => void (written[path] = text),
  }
  return { io, out, err, asked, written, left: () => queue.length }
}
const run = (argv, t) => runKb(argv, { kb, io: t.io })
const unverified = (q, a, provenance = 'model') => kb.add({ question: q, answer: a, provenance })

test('without a person at a terminal, nothing that confirms, edits or deletes will run', async () => {
  const model = unverified('Столица Австралии', 'Сидней')
  for (const argv of [['add'], ['confirm', String(model.id)], ['edit', String(model.id)], ['delete', String(model.id)], ['review']]) {
    const t = term({ tty: false, answers: ['да', 'да', 'да', 'да', 'да'] })
    assert.equal(await run(argv, t), 3, argv.join(' '))
    assert.match(t.err.join('\n'), /только в интерактивном терминале/)
    assert.deepEqual(t.asked, [], 'it did not even ask')
  }
  assert.equal(kb.get(model.id).verified, false, 'still unverified')
  assert.equal(kb.stats().total, 1)
})

test('reading works anywhere: list, show, search, stats, export', async () => {
  const v = kb.add({ question: 'Мой кофе', answer: 'Капучино', provenance: 'user-explicit' })
  unverified('Столица Австралии', 'Сидней')
  const t = term({ tty: false })
  assert.equal(await run(['stats'], t), 0)
  assert.match(t.out.at(-1), /всего 2 · подтверждённых 1 · ждут подтверждения 1/)
  assert.equal(await run(['list', '--pending'], t), 0)
  assert.match(t.out.at(-1), /\[\?\].*Сидней/)
  assert.equal(await run(['list', '--verified'], t), 0)
  assert.match(t.out.at(-1), /\[✓\].*Капучино/)
  assert.equal(await run(['show', String(v.id)], t), 0)
  assert.match(t.out.at(-1), /ПОДТВЕРЖДЕНО/)
  assert.equal(await run(['search', 'капучино'], t), 0)
  assert.match(t.out.at(-1), /Капучино/)
  assert.equal(await run(['export', 'out.json'], t), 0)
  assert.equal(JSON.parse(t.written['out.json']).length, 2)
  assert.equal(await run(['show', '999'], t), 1)
})

test('an import can only create candidates: a file cannot say it is verified', async () => {
  const t = term({
    tty: false,
    files: {
      'f.json': [
        { kind: 'fact', question: 'Столица Франции', answer: 'Париж', confidence: 'verified', provenance: 'user-explicit', source: 'me', status: 'active' },
        { question: 'Мой город', answer: 'Казань', confidence: 'verified' },
      ],
    },
  })
  assert.equal(await run(['import', 'f.json'], t), 0)
  const rows = kb.list()
  assert.equal(rows.length, 2)
  for (const r of rows) {
    assert.equal(r.verified, false)
    assert.equal(r.provenance, 'extracted')
    assert.equal(r.source, 'import:f.json')
    assert.equal(r.confirmedAt, null)
  }
  assert.match(t.out.join('\n'), /Все НЕподтверждены/)
})

test('an imported candidate is not an answer; after the person confirms it, it is', async () => {
  await run(['import', 'f.json'], term({ tty: false, files: { 'f.json': [{ question: 'Мой город', answer: 'Казань' }] } }))
  assert.equal(decide(kb, 'Мой город').reason, 'unverified')
  const t = term({ answers: ['д'] })
  assert.equal(await run(['review'], t), 0)
  assert.equal(decide(kb, 'Мой город').route, 'hit')
  assert.equal(kb.findExact('Мой город')[0].provenance, 'user-confirmed')
})

test('a bad import file changes nothing: not JSON, not a list, too long, too big', async () => {
  const cases = {
    'bad.json': '{not json',
    'obj.json': { question: 'q', answer: 'a' },
    'long.json': Array.from({ length: IMPORT_MAX_ITEMS + 1 }, (_, i) => ({ question: `q${i}`, answer: 'a' })),
    'big.json': JSON.stringify([{ question: 'q', answer: 'x'.repeat(1024 * 1024) }]),
  }
  for (const name of Object.keys(cases)) {
    const t = term({ tty: false, files: { [name]: cases[name] } })
    assert.equal(await run(['import', name], t), 2, name)
  }
  const missing = term({ tty: false })
  assert.equal(await run(['import', 'missing.json'], missing), 1, 'a missing file is an error, not a silent success')
  assert.match(missing.err.join('\n'), /no such file/)
  assert.equal(kb.stats().total, 0)
})

test('an import keeps the good items and reports the ones it refused, credentials included', async () => {
  const t = term({
    tty: false,
    files: { 'f.json': [{ question: 'Ключ', answer: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' }, { question: 'Нормально', answer: 'да' }, { answer: '' }] },
  })
  assert.equal(await run(['import', 'f.json'], t), 1)
  assert.equal(kb.stats().total, 1)
  assert.equal(kb.list()[0].answer, 'да')
  assert.match(t.err.join('\n'), /#1.*credential/)
  assert.match(t.err.join('\n'), /#3/)
  assert.ok(!JSON.stringify(kb.list()).includes('sk-ant'))
})

test('add: after the person says yes, the record is verified, and says where it came from', async () => {
  const t = term({ answers: ['preference', 'Какой кофе я люблю', 'Капучино без сахара', '', 'n', 'да'] })
  assert.equal(await run(['add'], t), 0)
  const r = kb.list()[0]
  assert.deepEqual([r.verified, r.provenance, r.source, r.kind], [true, 'user-explicit', 'cli', 'preference'])
  assert.equal(decide(kb, 'какой кофе я люблю').answer, 'Капучино без сахара')
})

test('add: "no" at the final question, or an empty answer, saves nothing', async () => {
  assert.equal(await run(['add'], term({ answers: ['fact', 'q', 'a', '', 'n', 'нет'] })), 1)
  assert.equal(await run(['add'], term({ answers: ['fact', 'q', '', ]})), 1)
  assert.equal(kb.stats().total, 0)
})

test('add refuses a credential and says why, saving nothing', async () => {
  const t = term({ answers: ['fact', 'ключ', 'password: hunter2hunter2', '', 'n', 'да'] })
  assert.equal(await run(['add'], t), 1)
  assert.match(t.err.join('\n'), /Не сохранено: answer looks like a credential/)
  assert.equal(kb.stats().total, 0)
})

test('a changeable fact can be marked, and then it is never answered directly', async () => {
  await run(['add'], term({ answers: ['fact', 'Какая погода', 'Солнечно', '', 'д', 'да'] }))
  assert.equal(kb.list()[0].volatile, true)
  assert.equal(decide(kb, 'Какая погода').reason, 'volatile')
})

test('confirm: only on an explicit yes, after the record is shown', async () => {
  const r = unverified('Столица Австралии', 'Канберра')
  const no = term({ answers: ['нет'] })
  assert.equal(await run(['confirm', String(r.id)], no), 1)
  assert.equal(kb.get(r.id).verified, false)
  assert.match(no.out.join('\n'), /Канберра/, 'what is being vouched for was shown')
  const yes = term({ answers: ['да'] })
  assert.equal(await run(['confirm', String(r.id)], yes), 0)
  assert.equal(kb.get(r.id).verified, true)
  assert.equal(await run(['confirm', 'abc'], term()), 2)
  assert.equal(await run(['confirm', '999'], term()), 1)
})

test('edit and delete need a yes; an edit by the person is verified', async () => {
  const r = unverified('Мой рост', '180')
  assert.equal(await run(['edit', String(r.id)], term({ answers: ['', '181', 'нет'] })), 1)
  assert.equal(kb.get(r.id).answer, '180', 'declined: unchanged')
  assert.equal(await run(['edit', String(r.id)], term({ answers: ['', '181', 'да'] })), 0)
  assert.deepEqual([kb.get(r.id).answer, kb.get(r.id).verified], ['181', true])
  assert.equal(await run(['delete', String(r.id)], term({ answers: ['нет'] })), 1)
  assert.ok(kb.get(r.id))
  assert.equal(await run(['delete', String(r.id)], term({ answers: ['да'] })), 0)
  assert.equal(kb.get(r.id), null)
})

test('review walks the unverified ones: confirm, correct, delete, skip, quit', async () => {
  const a = unverified('Вопрос А', 'ответ А')
  const b = unverified('Вопрос Б', 'ошибочный ответ')
  const c = unverified('Вопрос В', 'ответ В')
  const d = unverified('Вопрос Г', 'ответ Г')
  const e = unverified('Вопрос Д', 'ответ Д')
  const t = term({ answers: ['д', 'п', '', 'верный ответ', 'у', 'с', 'в'] })
  assert.equal(await run(['review'], t), 0)
  assert.equal(kb.get(a.id).verified, true)
  assert.deepEqual([kb.get(b.id).answer, kb.get(b.id).verified], ['верный ответ', true])
  assert.equal(kb.get(c.id), null)
  assert.equal(kb.get(d.id).verified, false, 'skipped')
  assert.equal(kb.get(e.id).verified, false, 'quit before it')
  assert.match(t.out.at(-1), /Подтверждено 1, поправлено 1, удалено 1, пропущено 1/)
})

test('review with a bare Enter or an unknown key changes nothing', async () => {
  const a = unverified('Вопрос', 'ответ')
  await run(['review'], term({ answers: [''] }))
  await run(['review'], term({ answers: ['??'] }))
  assert.equal(kb.get(a.id).verified, false)
  assert.equal(await run(['review'], term()), 0)
})

test('help, no command, an unknown command and bad arguments', async () => {
  const t = term({ tty: false })
  assert.equal(await run(['help'], t), 0)
  assert.equal(await run([], t), 1)
  assert.equal(await run(['frobnicate'], t), 2)
  assert.equal(await run(['list', '--nope'], t), 2)
  assert.equal(await run(['list', '--kind', 'command'], t), 2)
  assert.match(t.out.join('\n'), /Подтверждённым становится только то, что вы сами сказали/)
})
