// itd.ask (ITGAME-152): чистая логика src/debug/askCore.ts — без Phaser и DOM, Node берёт .ts как есть.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  calcDockBoxStyle,
  calcDockWhere,
  checkAskItems,
  checkAskOptions,
  newAskRecord,
  parseAskRecord,
  serializeAskRecord,
} from '../../src/debug/askCore.ts'

test('checkAskItems: валидация пустого массива и превышения длины', () => {
  assert.equal(checkAskItems([])?.code, 'bad_args')
  assert.equal(checkAskItems(null)?.code, 'bad_args')
  assert.equal(checkAskItems('not an array')?.code, 'bad_args')
  const tooMany = Array.from({ length: 25 }, (_, i) => ({ n: i + 1, text: 'ok' }))
  assert.equal(checkAskItems(tooMany)?.code, 'bad_args')
})

test('checkAskItems: валидация полей n, text, kind, choices, target', () => {
  assert.equal(checkAskItems([{ n: 0, text: 'ok' }])?.code, 'bad_args')
  assert.equal(checkAskItems([{ n: 1, text: '' }])?.code, 'bad_args')
  assert.equal(checkAskItems([{ n: 1, text: '   ' }])?.code, 'bad_args')
  assert.equal(checkAskItems([{ n: 1, text: 'ok', kind: 'invalid' }])?.code, 'bad_args')
  assert.equal(checkAskItems([{ n: 1, text: 'ok', choices: [] }])?.code, 'bad_args')
  assert.equal(checkAskItems([{ n: 1, text: 'ok', target: '' }])?.code, 'bad_args')
  assert.equal(checkAskItems([{ n: 1, text: 'a' }, { n: 1, text: 'b' }])?.code, 'bad_args') // duplicate n

  // Валидный список
  const valid = [
    { n: 1, text: 'Виден ли шрифт?', kind: 'check' },
    { n: 2, text: 'Какое число на экране?', kind: 'value', choices: ['10', '20', '30'] },
    { n: 3, text: 'Нажми кнопку найма', target: 'btn.hire' },
  ]
  assert.equal(checkAskItems(valid), null)
})

test('checkAskOptions: валидация dock', () => {
  assert.equal(checkAskOptions(undefined), null)
  assert.equal(checkAskOptions(null), null)
  assert.equal(checkAskOptions({}), null)
  assert.equal(checkAskOptions({ dock: 'auto' }), null)
  assert.equal(checkAskOptions({ dock: 'bottom' }), null)
  assert.equal(checkAskOptions({ dock: 'right' }), null)
  assert.equal(checkAskOptions({ dock: 'overlay' }), null)
  assert.equal(checkAskOptions({ dock: 'center' })?.code, 'bad_args')
  assert.equal(checkAskOptions('string')?.code, 'bad_args')
})

test('calcDockWhere: правила размещения auto/bottom/right/overlay', () => {
  const canvasRect = { bottom: 700, right: 1200 }
  // freeBottom = 950 - 700 = 250 (>= 220) -> bottom
  assert.equal(calcDockWhere('auto', canvasRect, { iw: 1300, ih: 950 }), 'bottom')

  // freeBottom = 800 - 700 = 100 (< 220), freeRight = 1600 - 1200 = 400 (>= 320) -> right
  assert.equal(calcDockWhere('auto', canvasRect, { iw: 1600, ih: 800 }), 'right')

  // freeBottom = 100, freeRight = 100 -> overlay
  assert.equal(calcDockWhere('auto', canvasRect, { iw: 1300, ih: 800 }), 'overlay')

  // Явные режимы
  assert.equal(calcDockWhere('bottom', canvasRect, { iw: 1300, ih: 800 }), 'bottom')
  assert.equal(calcDockWhere('right', canvasRect, { iw: 1300, ih: 950 }), 'right')
  assert.equal(calcDockWhere('overlay', canvasRect, { iw: 1600, ih: 950 }), 'overlay')
})

test('newAskRecord, serializeAskRecord, parseAskRecord: круг без потерь', () => {
  const items = [
    { n: 1, text: 'Пункт 1', kind: 'check' },
    { n: 2, text: 'Пункт 2', kind: 'value', choices: ['да', 'нет'] },
  ]
  const rec = newAskRecord(items, 'auto', 'bottom')
  rec.answers[1] = { status: 'корректно', comment: 'все ок' }
  rec.collapsed = true

  const json = serializeAskRecord(rec)
  const parsed = parseAskRecord(json)
  assert.ok(parsed)
  assert.equal(parsed.where, 'bottom')
  assert.equal(parsed.dock, 'auto')
  assert.equal(parsed.collapsed, true)
  assert.equal(parsed.submitted, false)
  assert.deepEqual(parsed.answers[1], { status: 'корректно', comment: 'все ок' })
  assert.deepEqual(parsed.items.length, 2)

  // Мусор парсится безопасно в null
  assert.equal(parseAskRecord('invalid json'), null)
  assert.equal(parseAskRecord('123'), null)
  assert.equal(parseAskRecord(JSON.stringify({ items: [{ n: 0, text: '' }], answers: {} })), null)
  assert.equal(parseAskRecord(JSON.stringify({ items: [{ n: 1, text: 'ok' }], answers: 'not an object' })), null)
})

test('calcDockBoxStyle: стили для bottom, right, overlay и collapsed', () => {
  const canvas = { left: 50, top: 20, right: 1250, bottom: 720, width: 1200, height: 700 }
  const vp = { iw: 1400, ih: 1000 }

  const sBottom = calcDockBoxStyle('bottom', canvas, vp, false)
  assert.equal(sBottom.left, '50px')
  assert.equal(sBottom.top, '728px')
  assert.equal(sBottom.width, '1200px')
  assert.equal(sBottom.boxShadow, 'none')

  const sRight = calcDockBoxStyle('right', canvas, { iw: 1650, ih: 750 }, false)
  assert.equal(sRight.left, '1258px')
  assert.equal(sRight.top, '20px')
  assert.equal(sRight.boxShadow, 'none')

  const sOverlay = calcDockBoxStyle('overlay', canvas, { iw: 1300, ih: 750 }, false)
  assert.equal(sOverlay.boxShadow, '0 4px 16px rgba(0,0,0,0.5)')
  assert.equal(sOverlay.top, '48px') // Math.max(48, 20 + 8)

  const sCollapsed = calcDockBoxStyle('bottom', canvas, vp, true)
  assert.equal(sCollapsed.maxHeight, '48px')
})
