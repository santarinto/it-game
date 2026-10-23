// Строки «Админы» отчёта дня (ITGAME-159), множественное «мест» (seatsLabel), строки денег
// экрана банкротства (bankruptLines, ITGAME-176) и единый формат денег fmtMoney (ITGAME-231).
// src/format.ts без импортов — Node берёт его как есть (как eventlog.ts в daylog.test.mjs).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { adminsReportLines, bankruptLines, fmtMoney, seatsLabel, virusReportLines } from '../../src/format.ts'

test('fmtMoney: положительное $X, ноль $0, отрицательное −$X со знаком «−» (U+2212, ITGAME-231)', () => {
  assert.equal(fmtMoney(1234), '$1,234')
  assert.equal(fmtMoney(0), '$0')
  assert.equal(fmtMoney(-1234), '−$1,234')
  assert.equal(fmtMoney(-1234).charCodeAt(0), 0x2212)
})

// Колонка значений отчёта: «Доход:     $X» — значение с 12-го знака.
const COL = 'Доход:     '.length

test('adminsReportLines: обе части — две строки, вторая под колонкой значений; склеенные — фраза целиком', () => {
  const lines = adminsReportLines(1, 2)
  assert.deepEqual(lines, ['Админы:    починили 1 ПК,', '           вычистили 2 места'])
  assert.equal(lines[0].indexOf('починили'), COL)
  assert.equal(lines[1].indexOf('вычистили'), COL)
  assert.equal(`${lines[0]} ${lines[1].trimStart()}`, 'Админы:    починили 1 ПК, вычистили 2 места')
})

test('adminsReportLines: одна часть при нуле другой — одна строка без запятой', () => {
  assert.deepEqual(adminsReportLines(1, 0), ['Админы:    починили 1 ПК'])
  assert.deepEqual(adminsReportLines(7, 0), ['Админы:    починили 7 ПК'])
  assert.deepEqual(adminsReportLines(0, 1), ['Админы:    вычистили 1 место'])
  assert.deepEqual(adminsReportLines(0, 5), ['Админы:    вычистили 5 мест'])
})

test('adminsReportLines: обе нулевые — строк нет', () => {
  assert.deepEqual(adminsReportLines(0, 0), [])
})

test('adminsReportLines: каждая строка ≤ 38 знаков — панель 440 минус поля 2×24 при 10,18 px на знак, и при трёхзначных числах', () => {
  for (const [r, c] of [[999, 999], [999, 0], [0, 999], [12, 22]]) {
    for (const l of adminsReportLines(r, c)) assert.ok(l.length <= 38, `${l.length}: «${l}»`)
  }
})

test('seatsLabel: 1 место, 2–4 места, 5–20 мест, 21 место, 111 мест', () => {
  assert.deepEqual([1, 2, 4, 5, 11, 12, 14, 20, 21, 22, 25, 111, 112].map(seatsLabel),
    ['1 место', '2 места', '4 места', '5 мест', '11 мест', '12 мест', '14 мест', '20 мест', '21 место', '22 места', '25 мест', '111 мест', '112 мест'])
})

// Экран банкротства (ITGAME-176, вариант В владельца): долг и нехватка последнего вечера.
test('bankruptLines: долг и нехватка сверх порога — две строки; нехватки нет или она равна долгу — одна', () => {
  // Норма, овердрафт: ФОТ вечера $500, долг $850 — не хватило $350.
  assert.deepEqual(bankruptLines(-850, 350), ['Долг на момент банкротства: $850', 'На зарплаты не хватило: $350'])
  // Хардкор, кредит $10,000 с процентом: долг $11,499 — сверх лимита $1,499.
  assert.deepEqual(bankruptLines(-11499, 1499), ['Долг на момент банкротства: $11,499', 'На зарплаты не хватило: $1,499'])
  assert.deepEqual(bankruptLines(-614, 614), ['Долг на момент банкротства: $614'])
  assert.deepEqual(bankruptLines(-614, 0), ['Долг на момент банкротства: $614'])
})

test('virusReportLines: новые заражения — «+k ПК за день (−$X)»; без новых, но с убытком — «новых нет (−$X)», не «+0»', () => {
  assert.deepEqual(virusReportLines(3, 120), ['Вирус:     +3 ПК за день (−$120)'])
  assert.deepEqual(virusReportLines(2, 0), ['Вирус:     +2 ПК за день (−$0)'])
  assert.deepEqual(virusReportLines(0, 10), ['Вирус:     новых нет (−$10)'])
  assert.deepEqual(virusReportLines(0, 12345), ['Вирус:     новых нет (−$12,345)'])
  assert.equal(virusReportLines(0, 10)[0].indexOf('новых'), COL)
})

test('virusReportLines: ни заражений, ни убытка — строки нет; каждая строка ≤ 38 знаков', () => {
  assert.deepEqual(virusReportLines(0, 0), [])
  for (const [k, x] of [[99, 99999], [0, 9999999], [12, 123456]]) {
    for (const l of virusReportLines(k, x)) assert.ok(l.length <= 38, `${l.length}: «${l}»`)
  }
})
