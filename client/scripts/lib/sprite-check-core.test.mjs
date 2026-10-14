import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { checkSpriteImage } from './sprite-check-core.mjs'

const PALETTE = ['1a1c2c', 'b13e53', 'f4f4f4']

// 8×8: рамка 6×6 цвета hex по центру, остальное прозрачно
function png(hex, { size = 8, alpha = 255 } = {}) {
  const data = new Uint8Array(size * size * 4)
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16))
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      data.set([r, g, b, alpha], (y * size + x) * 4)
    }
  }
  return { width: size, height: size, data }
}

test('чистый спрайт — без нарушений', () => {
  const r = checkSpriteImage(png('b13e53'), { size: 8 }, PALETTE, 'test')
  assert.deepEqual(r.problems, [])
  assert.equal(r.stats.transparentPct, 43.8)
})

test('цвет вне палитры назван в problems', () => {
  const r = checkSpriteImage(png('ff00ff'), { size: 8 }, PALETTE, 'test')
  assert.equal(r.problems.length, 1)
  assert.match(r.problems[0], /вне палитры test: ff00ff/)
})

test('полупрозрачные пиксели — нарушение', () => {
  const r = checkSpriteImage(png('b13e53', { alpha: 128 }), { size: 8 }, PALETTE)
  assert.ok(r.problems.some((p) => p.startsWith('полупрозрачных пикселей 36')))
})

test('чужой размер — нарушение, шум не считается', () => {
  const r = checkSpriteImage(png('b13e53', { size: 4 }), { size: 8 }, PALETTE)
  assert.ok(r.problems.some((p) => p.startsWith('размер 4×4, контракт 8×8')))
  assert.equal(r.stats.noiseSummary, '')
})

test('модуль не тянет node:* — годится для сборки клиента', () => {
  const src = readFileSync(new URL('./sprite-check-core.mjs', import.meta.url), 'utf8')
  assert.equal(/from 'node:/.test(src), false)
})
