import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
// @ts-expect-error — a plain .mjs module of the bridge, without type declarations
import { displayServer } from '../bridge/panels.mjs'

/**
 * The panel and blade contract (shared/ui.ts) against what the bridge really
 * builds. The allowed fields and values are read from the contract file
 * itself, so this test cannot drift from it: a field the bridge sends that the
 * page does not know, or a value outside the union, fails here.
 */

function shape(name: string): Map<string, { optional: boolean; values: string[] | null }> {
  const src = readFileSync(new URL('../shared/ui.ts', import.meta.url), 'utf8').replace(/\r/g, '')
  const body = new RegExp(`export type ${name} = \\{\\n([\\s\\S]*?)\\n\\}`).exec(src)
  assert.ok(body, `${name} is declared in shared/ui.ts`)
  const fields = new Map<string, { optional: boolean; values: string[] | null }>()
  for (const line of body[1].split('\n')) {
    const m = /^\s+([a-zA-Z]+)(\?)?: (.+)$/.exec(line)
    if (!m) continue
    const literals = [...m[3].matchAll(/'([^']+)'/g)].map((x) => x[1])
    fields.set(m[1], { optional: Boolean(m[2]), values: literals.length ? literals : null })
  }
  return fields
}

function conforms(name: string, value: Record<string, unknown>) {
  const fields = shape(name)
  for (const [k, v] of Object.entries(value)) {
    const f = fields.get(k)
    assert.ok(f, `${name}.${k} is in the contract`)
    if (f.values && v !== undefined) assert.ok(f.values.includes(String(v)), `${name}.${k} = ${String(v)} is one of ${f.values.join('|')}`)
  }
  for (const [k, f] of fields) if (!f.optional) assert.ok(value[k] !== undefined, `${name}.${k} is present`)
}

function rig() {
  const blades: Record<string, unknown>[] = []
  const server = displayServer(() => {}, (b: Record<string, unknown>) => blades.push(b), { mayShow: () => true })
  const call = (tool: string, args: Record<string, unknown>) => server.instance._registeredTools[tool].handler(args, {})
  return { call, blades }
}

test('the contract declares both shapes, with the fields the page reads', () => {
  const panel = shape('Panel'), blade = shape('Blade')
  for (const k of ['id', 'title', 'html', 'anim', 'slot', 'accent', 'hold']) assert.ok(panel.has(k), `Panel.${k}`)
  for (const k of ['id', 'title', 'kind', 'size', 'hold', 'url', 'images', 'html', 'mode']) assert.ok(blade.has(k), `Blade.${k}`)
})

test('every blade the bridge builds conforms to the contract: display cards and each kind of blade', async () => {
  const r = rig()
  await r.call('display', { title: 'ПОГОДА', html: '<div>+9</div>' })
  await r.call('display', { title: 'ТАБЛИЦА', html: '<table><tr><td>Тариф</td><td>900</td></tr></table>', slot: 'wide', hold: 'sticky' })
  await r.call('blade', { title: 'Статья', kind: 'article', url: 'https://example.com/a' })
  await r.call('blade', { title: 'Фото', kind: 'image', url: 'https://example.com/i.png', size: 'full' })
  await r.call('blade', { title: 'Галерея', kind: 'gallery', images: ['https://example.com/1.png', 'https://example.com/2.png'] })
  await r.call('blade', { title: 'Схема', kind: 'markup', html: '<svg></svg>' })
  assert.ok(r.blades.length >= 6, `the bridge built ${r.blades.length} blades`)
  for (const b of r.blades) conforms('Blade', b)
})

test('wiring: the transport and the store take the shapes from the contract; the store re-exports them', () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')
  assert.match(read('../src/lib/bridge.ts'), /import type \{ Blade, Panel \} from '\.\.\/\.\.\/shared\/ui'/)
  assert.match(read('../src/lib/brain.ts'), /import type \{ Blade, Panel \} from '\.\.\/\.\.\/shared\/ui'/)
  const store = read('../src/store.ts')
  assert.match(store, /import type \{ Blade, Panel \} from '\.\.\/shared\/ui'/)
  assert.match(store, /export type \{ Blade, Panel \}/)
  assert.doesNotMatch(store, /export type (Panel|Blade) = \{/, 'declared once, in the contract')
})
