// Гейт мобильного захода (ITGAME-161): <script id="mobile-gate"> из index.html гоняется
// как есть, в vm с подставными location, screen, matchMedia и sessionStorage — копии логики нет.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
const gate = read('../../index.html').match(/<script id="mobile-gate">([\s\S]*?)<\/script>/)?.[1]

function run({ search = '', coarse = true, screen = [390, 844], storage = {}, storageThrows = false } = {}) {
  const store = new Map(Object.entries(storage))
  const guard = () => { if (storageThrows) throw new Error('SecurityError') }
  const replaced = []
  const dataset = {}
  vm.runInNewContext(gate, {
    URLSearchParams,
    location: { search, replace: (url) => replaced.push(url) },
    sessionStorage: {
      getItem: (k) => { guard(); return store.has(k) ? store.get(k) : null },
      setItem: (k, v) => { guard(); store.set(k, String(v)) },
    },
    matchMedia: (q) => ({ matches: q === '(pointer: coarse)' && coarse }),
    screen: { width: screen[0], height: screen[1] },
    document: { documentElement: { dataset } },
  })
  return { replaced, dataset, store }
}

test('гейт найден в index.html', () => {
  assert.ok(gate, '<script id="mobile-gate"> нет в client/index.html')
})

test('телефон в портрете и в ландшафте уходит на /mobile.html с меткой для main.ts', () => {
  for (const screen of [[390, 844], [844, 390], [767, 1024]]) {
    const r = run({ screen })
    assert.deepEqual(r.replaced, ['/mobile.html'], String(screen))
    assert.equal(r.dataset.mobileGate, 'redirect', String(screen))
  }
})

test('десктоп, мышь на маленьком экране и планшет остаются на игре', () => {
  for (const env of [
    { coarse: false, screen: [1920, 1080] },
    { coarse: false, screen: [390, 844] },
    { coarse: true, screen: [768, 1024] },
    { coarse: true, screen: [820, 1180] },
  ]) {
    const r = run(env)
    assert.deepEqual(r.replaced, [], JSON.stringify(env))
    assert.equal(r.dataset.mobileGate, undefined, JSON.stringify(env))
  }
})

test('?debug=1 и агентская вкладка (запись itd.claim) не уводятся', () => {
  assert.deepEqual(run({ search: '?debug=1' }).replaced, [])
  assert.deepEqual(run({ search: '?debug=1&sandbox=acc' }).replaced, [])
  assert.deepEqual(run({ storage: { 'itd.claim': '{"label":"acc161"}' } }).replaced, [])
})

test('?desktop=1 запоминается во вкладке: следующий заход без параметра тоже на игре', () => {
  const first = run({ search: '?desktop=1' })
  assert.deepEqual(first.replaced, [])
  assert.equal(first.store.get('itd.desktop'), '1')
  assert.deepEqual(run({ storage: Object.fromEntries(first.store) }).replaced, [])
})

test('закрытый sessionStorage — без ухода и без исключения', () => {
  assert.deepEqual(run({ storageThrows: true }).replaced, [])
  assert.deepEqual(run({ search: '?desktop=1', storageThrows: true }).replaced, [])
})

test('мобильная страница ведёт на ?desktop=1, main.ts ждёт ту же метку', () => {
  assert.match(read('../../mobile.html'), /href="\/\?desktop=1"/)
  assert.match(read('../../src/main.ts'), /dataset\.mobileGate === 'redirect'/)
})
