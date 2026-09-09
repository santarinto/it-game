// Контроль качества спрайтов (ITGAME-28): падает сборку на «забытый
// чекерборд» — PNG из арт-пайплайна обязан быть 64×64, с прозрачным фоном
// и квантизированным в Sweetie-16 набором цветов (scripts/sprites/remap.sh).
//
// Инцидент: PixelLab мог привезти фон, запечённый шахматкой из превью —
// глазом на маленьком спрайте не видно, в игре «фон-тень» вокруг объекта.
// Пороги:
//   • размер ровно 64×64 (контракт ITGAME-12);
//   • прозрачных пикселей ≥ 5% (alpha < 26 из 255);
//   • #f4f4f4 ≤ 40% — белая заливка-чекерборд превышает, штрихи — нет;
//   • все непрозрачные цвета — из Sweetie-16 (remap.sh с -dither None).
//
// Запуск: node scripts/check-sprites.mjs (входит в npm run build).
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'assets', 'sprites')
const SIZE = 64
const MIN_TRANSPARENT_PCT = 5
const MAX_F4_PCT = 40
// Пер-файловые пороги: у кого белый — часть дизайна, а не запечённый фон.
// office_floor_tile: светлый пол, ~45% #f4f4f4 — сам предмет спрайта.
const F4_OVERRIDES = { 'office_floor_tile.png': 60 }
const SWEETIE16 = new Set([
  '1a1c2c', '333c57', '29366f', '5d275d', '257179', 'b13e53', 'ef7d57',
  '38b764', 'a7f070', 'ffcd75', '566c86', '3b5dc9', '41a6f6', '73eff7',
  '94b0c2', 'f4f4f4',
])

function chromePath() {
  const cands = [
    process.env.CHROME_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable',
  ].filter((p) => !!p)
  const found = cands.find((p) => existsSync(p))
  if (!found) {
    console.error('CHECK-SPRITES FAIL: chromium не найден — задайте CHROME_PATH')
    process.exit(1)
  }
  return found
}

if (!existsSync(DIR)) {
  console.error(`CHECK-SPRITES FAIL: нет каталога ${DIR}`)
  process.exit(1)
}
const files = readdirSync(DIR).filter((f) => f.endsWith('.png'))
if (files.length === 0) {
  console.error('CHECK-SPRITES FAIL: в каталоге спрайтов нет PNG')
  process.exit(1)
}

const browser = await puppeteer.launch({
  executablePath: chromePath(),
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const violations = []
try {
  const page = await browser.newPage()
  for (const file of files) {
    const b64 = readFileSync(join(DIR, file)).toString('base64')
    const r = await page.evaluate(
      async (b64, palette) => {
        const sweetie = new Set(palette)
        const img = new Image()
        img.src = 'data:image/png;base64,' + b64
        await img.decode()
        const { width: w, height: h } = img
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        ctx.drawImage(img, 0, 0)
        const data = ctx.getImageData(0, 0, w, h).data
        let transparent = 0
        let f4 = 0
        const off = new Map()
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 26) {
            transparent++
            continue
          }
          const hex = [data[i], data[i + 1], data[i + 2]]
            .map((v) => v.toString(16).padStart(2, '0'))
            .join('')
          if (hex === 'f4f4f4') f4++
          if (!sweetie.has(hex)) off.set(hex, (off.get(hex) ?? 0) + 1)
        }
        const total = w * h
        return {
          w,
          h,
          transparentPct: Math.round((transparent / total) * 1000) / 10,
          f4Pct: Math.round((f4 / total) * 1000) / 10,
          offPalette: [...off.keys()],
        }
      },
      b64,
      [...SWEETIE16],
    )
    const problems = []
    if (r.w !== SIZE || r.h !== SIZE) problems.push(`размер ${r.w}×${r.h}, контракт ${SIZE}×${SIZE}`)
    if (r.transparentPct < MIN_TRANSPARENT_PCT) {
      problems.push(`прозрачных ${r.transparentPct}% < ${MIN_TRANSPARENT_PCT}% — фон запечён?`)
    }
    const maxF4 = F4_OVERRIDES[file] ?? MAX_F4_PCT
    if (r.f4Pct > maxF4) {
      problems.push(`#f4f4f4 занимает ${r.f4Pct}% > ${maxF4}% — чекерборд/белая заливка`)
    }
    if (r.offPalette.length > 0) {
      problems.push(`вне Sweetie-16: ${r.offPalette.slice(0, 5).join(' ')}${r.offPalette.length > 5 ? '…' : ''}`)
    }
    if (problems.length > 0) {
      violations.push(`${file}: ${problems.join('; ')}`)
      console.error(`FAIL ${file}: ${problems.join('; ')}`)
    } else {
      console.log(`ok   ${file} (прозрачность ${r.transparentPct}%, f4 ${r.f4Pct}%)`)
    }
  }
} finally {
  await browser.close()
}

if (violations.length > 0) {
  console.error(`\nCHECK-SPRITES FAIL — ${violations.length} спрайт(ов) ломают контракт арт-пайплайна`)
  process.exit(1)
}
console.log(`CHECK-SPRITES OK — ${files.length} спрайтов в контракте (64×64, прозрачность, Sweetie-16)`)
