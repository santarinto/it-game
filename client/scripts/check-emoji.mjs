#!/usr/bin/env node
// check-emoji (ITGAME-83): в client/src нет эмодзи — ни в строках, ни в комментариях, ни в
// манифесте; иконки — спрайты (ui/iconText.ts). Что считается эмодзи — scripts/lib/emoji-check.mjs.
// contract.gen.ts проверяется вместе со всеми: он собран из JSDoc того же src.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findEmoji } from './lib/emoji-check.mjs'

const CLIENT_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const SRC = join(CLIENT_DIR, 'src')

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|json|css|html)$/.test(name) ? [p] : []
  })
}

let total = 0
for (const file of walk(SRC)) {
  for (const f of findEmoji(readFileSync(file, 'utf8'))) {
    console.log(`${relative(CLIENT_DIR, file)}:${f.line}:${f.col}  ${f.char}  ${f.code}`)
    total++
  }
}
if (total) {
  console.log(`CHECK-EMOJI FAIL — ${total} эмодзи в client/src: иконка — спрайт через attachIcon, текстовый символ — глиф наших шрифтов`)
  process.exit(1)
}
console.log('CHECK-EMOJI OK — в client/src эмодзи нет')
