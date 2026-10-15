import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findEmoji } from './emoji-check.mjs'

test('эмодзи в строке найдено с позицией и кодом', () => {
  assert.deepEqual(findEmoji("a\nconst t = '🔒 Заблокировано'"), [{ line: 2, col: 12, char: '🔒', code: 'U+1F512' }])
})

test('текстовый символ из BMP с эмодзи-представлением (⚠, ⭐) и селектор FE0F — эмодзи', () => {
  assert.deepEqual(findEmoji('⚠️ ⭐').map((f) => f.code), ['U+26A0', 'U+FE0F', 'U+2B50'])
})

test('глифы наших шрифтов (⏸ ▶ ☣ ✖ из ITD Symbols, ★ ✓ ✕ ✗ ⌂ и масти из Departure Mono) — не эмодзи', () => {
  assert.deepEqual(findEmoji('⏸ ▶ ☣ ✖ ★ ✓ ✕ ✗ ⌂ ♥ © → «» —'), [])
})
