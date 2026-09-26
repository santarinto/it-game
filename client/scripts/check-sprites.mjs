// Контроль качества спрайтов (ITGAME-28, манифест ITGAME): падает сборку
// на «забытый чекерборд» и на рассинхрон манифеста с диском — PNG из
// арт-пайплайна обязан соответствовать своей записи в едином манифесте
// client/src/assets/sprites.json (единственный источник правды: те же
// поля читают BootScene и check-sprites, дублировать пороги негде).
//
// Декодирование — pngjs (Node, без браузера): раньше гонял Chromium
// через puppeteer-core, сборка больше не зависит от установленного
// браузера/CHROME_PATH.
//
// Проверки на ключ (см. docs/development.md → Assets):
//   • ключ ⇔ файл в обе стороны — лишний PNG без ключа и ключ без PNG
//     оба фейлят (404 на несуществующий ассет роняет smoke);
//   • aliases/fallback указывают на существующие ключи манифеста;
//   • hd32 ⊇ sweetie16 и ≤32 цветов;
//   • размер ровно size·frames × size (контракт ITGAME-12);
//   • все непрозрачные пиксели — из палитры ключа;
//   • прозрачных пикселей ≥5% (alpha<26) — иначе фон запечён;
//   • полупрозрачных пикселей нет (26<=alpha<255) — PNG либо совсем
//     прозрачный, либо совсем непрозрачный пиксель, полутонов не бывает;
//   • доля #f4f4f4 ≤ maxWhitePct (по умолчанию 40, ключ переопределяет);
//   • «шум»: 8-связные компоненты непрозрачных пикселей на каждый кадр;
//     спек — компонента площадью ≤ 4·(size/64)²; проваливаем, если
//     спеков больше maxSpecks ключа (по умолчанию 0);
//   • только предупреждение (не фейл): доля внутренних пикселей (все 8
//     соседей непрозрачны), ни один из соседей не совпадает по цвету, >10%.
//
// Запуск: node scripts/check-sprites.mjs (входит в npm run build).
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'

const CLIENT_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const SPRITES_DIR = join(CLIENT_DIR, 'public', 'assets', 'sprites')
const MANIFEST_PATH = join(CLIENT_DIR, 'src', 'assets', 'sprites.json')

const MIN_TRANSPARENT_PCT = 5
const DEFAULT_MAX_WHITE_PCT = 40
const DEFAULT_MAX_SPECKS = 0
const INTERIOR_SPECKLE_WARN_PCT = 10
const WHITE_HEX = 'f4f4f4'

if (!existsSync(MANIFEST_PATH)) {
  console.error(`CHECK-SPRITES FAIL: нет манифеста ${MANIFEST_PATH}`)
  process.exit(1)
}
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
const { palettes, sprites, aliases } = manifest
const spriteKeys = Object.keys(sprites)

if (!existsSync(SPRITES_DIR)) {
  console.error(`CHECK-SPRITES FAIL: нет каталога ${SPRITES_DIR}`)
  process.exit(1)
}
const files = readdirSync(SPRITES_DIR).filter((f) => f.endsWith('.png'))

const violations = []
const warnings = []
function fail(msg) {
  violations.push(msg)
  console.error(`FAIL ${msg}`)
}
function warn(msg) {
  warnings.push(msg)
  console.warn(`WARN ${msg}`)
}
function ok(msg) {
  console.log(`ok   ${msg}`)
}

// ── Манифест как таковой: палитры и ссылки aliases/fallback ────────────────
const sweetie16 = palettes?.sweetie16 ?? []
const hd32 = palettes?.hd32 ?? []
if (hd32.length > 32) {
  fail(`палитра hd32: ${hd32.length} цветов > 32`)
} else {
  ok(`палитра hd32: ${hd32.length} цветов (<=32)`)
}
const hd32Set = new Set(hd32)
const missingInHd32 = sweetie16.filter((c) => !hd32Set.has(c))
if (missingInHd32.length > 0) {
  fail(`палитра hd32 не включает sweetie16 целиком: не хватает ${missingInHd32.join(', ')}`)
} else {
  ok('палитра hd32 ⊇ sweetie16')
}

for (const [alias, target] of Object.entries(aliases ?? {})) {
  if (!spriteKeys.includes(target)) {
    fail(`aliases.${alias} → '${target}' — нет такого ключа в sprites`)
  }
}
for (const key of spriteKeys) {
  const fb = sprites[key].fallback
  if (fb && !spriteKeys.includes(fb)) {
    fail(`sprites.${key}.fallback → '${fb}' — нет такого ключа в sprites`)
  }
}

// ── Ключ ⇔ файл в обе стороны ───────────────────────────────────────────────
const fileSet = new Set(files.map((f) => f.replace(/\.png$/, '')))
const keySet = new Set(spriteKeys)
for (const key of spriteKeys) {
  if (!fileSet.has(key)) fail(`ключ манифеста '${key}' без файла ${key}.png`)
}
for (const name of fileSet) {
  if (!keySet.has(name)) fail(`файл ${name}.png без ключа в манифесте — 404 в игре уронит smoke`)
}

// ── Пер-файловые проверки ───────────────────────────────────────────────────
for (const key of spriteKeys) {
  const file = `${key}.png`
  if (!fileSet.has(key)) continue // уже отмечено выше — нет смысла дублировать
  const spec = sprites[key]
  const paletteName = spec.palette
  const palette = palettes?.[paletteName]
  if (!palette) {
    fail(`${file}: неизвестная палитра '${paletteName}'`)
    continue
  }
  const paletteSet = new Set(palette)
  const size = spec.size
  const frames = spec.frames ?? 1
  const expectW = size * frames
  const expectH = size

  let png
  try {
    png = PNG.sync.read(readFileSync(join(SPRITES_DIR, file)))
  } catch (e) {
    fail(`${file}: PNG не читается — ${e instanceof Error ? e.message : String(e)}`)
    continue
  }
  const { width: w, height: h, data } = png
  const problems = []
  if (w !== expectW || h !== expectH) {
    problems.push(`размер ${w}×${h}, контракт ${expectW}×${expectH} (size=${size}×frames=${frames})`)
  }

  const opaque = (x, y) => x >= 0 && y >= 0 && x < w && y < h && data[(y * w + x) * 4 + 3] >= 26
  const hexAt = (x, y) => {
    const i = (y * w + x) * 4
    return [data[i], data[i + 1], data[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('')
  }

  let transparent = 0
  let semi = 0
  let white = 0
  const offPalette = new Map()
  for (let i = 3; i < data.length; i += 4) {
    const a = data[i]
    if (a < 26) {
      transparent++
      continue
    }
    if (a < 255) semi++
    const idx = i - 3
    const hex = [data[idx], data[idx + 1], data[idx + 2]].map((v) => v.toString(16).padStart(2, '0')).join('')
    if (hex === WHITE_HEX) white++
    if (!paletteSet.has(hex)) offPalette.set(hex, (offPalette.get(hex) ?? 0) + 1)
  }
  const total = w * h
  const transparentPct = Math.round((transparent / total) * 1000) / 10
  const whitePct = Math.round((white / total) * 1000) / 10
  const maxWhitePct = spec.maxWhitePct ?? DEFAULT_MAX_WHITE_PCT

  if (transparentPct < MIN_TRANSPARENT_PCT) {
    problems.push(`прозрачных ${transparentPct}% < ${MIN_TRANSPARENT_PCT}% — фон запечён?`)
  }
  if (semi > 0) {
    problems.push(`полупрозрачных пикселей ${semi} (alpha 26..254) — сглаживание/полутон не по контракту`)
  }
  if (whitePct > maxWhitePct) {
    problems.push(`#${WHITE_HEX} занимает ${whitePct}% > ${maxWhitePct}% — чекерборд/белая заливка`)
  }
  if (offPalette.size > 0) {
    const top = [...offPalette.keys()].slice(0, 5)
    problems.push(`вне палитры ${paletteName}: ${top.join(' ')}${offPalette.size > 5 ? '…' : ''}`)
  }

  // «Шум» — только если размеры совпали с контрактом (иначе кадры считать не по чему).
  let noiseSummary = ''
  if (w === expectW && h === expectH) {
    const maxSpecks = spec.maxSpecks ?? DEFAULT_MAX_SPECKS
    let totalSpecks = 0
    let totalInterior = 0
    let totalSpeckled = 0
    const speckThreshold = 4 * (size / 64) ** 2
    for (let f = 0; f < frames; f++) {
      const fx0 = f * size
      const inFrame = (x, y) => x >= fx0 && x < fx0 + size && y >= 0 && y < size
      const frameOpaque = (x, y) => inFrame(x, y) && opaque(x, y)
      // 8-связные компоненты непрозрачных пикселей кадра.
      const seen = new Uint8Array(size * size)
      const idxOf = (x, y) => y * size + (x - fx0)
      for (let y = 0; y < size; y++) {
        for (let x = fx0; x < fx0 + size; x++) {
          if (!frameOpaque(x, y) || seen[idxOf(x, y)]) continue
          let n = 0
          const stack = [[x, y]]
          seen[idxOf(x, y)] = 1
          while (stack.length) {
            const [cx, cy] = stack.pop()
            n++
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                if (!dx && !dy) continue
                const nx = cx + dx
                const ny = cy + dy
                if (frameOpaque(nx, ny) && !seen[idxOf(nx, ny)]) {
                  seen[idxOf(nx, ny)] = 1
                  stack.push([nx, ny])
                }
              }
            }
          }
          if (n <= speckThreshold) totalSpecks++
        }
      }
      // Предупреждение: доля внутренних пикселей (все 8 соседей непрозрачны),
      // чей цвет не совпадает НИ С ОДНИМ из 8 соседей.
      for (let y = 0; y < size; y++) {
        for (let x = fx0; x < fx0 + size; x++) {
          if (!frameOpaque(x, y)) continue
          const neighbours = []
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (!dx && !dy) continue
              if (frameOpaque(x + dx, y + dy)) neighbours.push(hexAt(x + dx, y + dy))
            }
          }
          if (neighbours.length === 8) {
            totalInterior++
            if (!neighbours.includes(hexAt(x, y))) totalSpeckled++
          }
        }
      }
    }
    if (totalSpecks > maxSpecks) {
      problems.push(`шум: ${totalSpecks} спек(ов) площадью <=${speckThreshold}px > лимита ${maxSpecks}`)
    }
    const speckledPct = totalInterior > 0 ? Math.round((totalSpeckled / totalInterior) * 1000) / 10 : 0
    if (speckledPct > INTERIOR_SPECKLE_WARN_PCT) {
      warn(`${file}: ${speckledPct}% внутренних пикселей шумят цветом (>${INTERIOR_SPECKLE_WARN_PCT}%) — не фейл, но арт стоит перегенерировать`)
    }
    noiseSummary = `, шум ${totalSpecks}/${maxSpecks}`
  }

  if (problems.length > 0) {
    fail(`${file}: ${problems.join('; ')}`)
  } else {
    ok(`${file} (прозрачность ${transparentPct}%, #${WHITE_HEX} ${whitePct}%${noiseSummary})`)
  }
  if (spec.note) {
    console.log(`     ${file}: note — ${spec.note}`)
  }
}

console.log('')
if (violations.length > 0) {
  console.error(`CHECK-SPRITES FAIL — ${violations.length} наруш.(ий) контракта арт-пайплайна (манифест client/src/assets/sprites.json)`)
  process.exit(1)
}
console.log(
  `CHECK-SPRITES OK — ${spriteKeys.length} спрайтов в контракте манифеста` +
  (warnings.length > 0 ? ` (${warnings.length} предупреждение(й) — см. выше)` : ''),
)
