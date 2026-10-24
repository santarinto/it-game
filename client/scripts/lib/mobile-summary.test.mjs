// Что мобильный каркас (ITGAME-227) показывает из снапшота: деньги, день и время, открытые офисы,
// фаза. src/mobile/summary.ts импортирует только типы — Node берёт его как есть, как src/format.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mobileSummary } from '../../src/mobile/summary.ts'
import { fmtMoney } from '../../src/format.ts'

const emp = (pcBroken = false) => ({ name: 'x', pcBroken })
const office = (unlocked, employees = [], pcs = employees.length) => ({ unlocked, pcs, employees, workplaces: [] })
const state = (over = {}) => ({
  money: 1250, day: 3, clock: '14:20', isLunch: false, phase: 'running', speed: 1,
  offices: [office(true, [emp(), emp(true)], 3), office(false), office(true, [])],
  ...over,
})

test('деньги через fmtMoney, день и время, обед — припиской', () => {
  const v = mobileSummary(state(), fmtMoney)
  assert.equal(v.money, '$1,250')
  assert.equal(v.day, 'День 3 · 14:20')
  assert.equal(mobileSummary(state({ isLunch: true, money: -40 }), fmtMoney).day, 'День 3 · 14:20 · обед')
  assert.equal(mobileSummary(state({ money: -40 }), fmtMoney).money, '−$40')
})

test('только открытые офисы, номер — место в списке; сломанные ПК — если есть', () => {
  assert.deepEqual(mobileSummary(state(), fmtMoney).offices, [
    'Офис 1: людей 2, ПК 3, сломано 1',
    'Офис 3: людей 0, ПК 0',
  ])
})

test('фаза: пауза, ход со скоростью, закрытый день, финалы', () => {
  const p = (over) => mobileSummary(state(over), fmtMoney).phase
  assert.equal(p({ speed: 0 }), 'пауза')
  assert.equal(p({ speed: 2 }), 'идёт, скорость ×2')
  assert.equal(p({ phase: 'day_report' }), 'день закрыт')
  assert.equal(p({ phase: 'game_over' }), 'банкротство')
  assert.equal(p({ phase: 'won' }), 'победа')
})
