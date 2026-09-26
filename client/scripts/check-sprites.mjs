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
import { checkSpriteImage, WHITE_HEX } from './lib/sprite-check.mjs'

const CLIENT_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const SPRITES_DIR = join(CLIENT_DIR, 'public', 'assets', 'sprites')
const MANIFEST_PATH = join(CLIENT_DIR, 'src', 'assets', 'sprites.json')

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

  let png
  try {
    png = PNG.sync.read(readFileSync(join(SPRITES_DIR, file)))
  } catch (e) {
    fail(`${file}: PNG не читается — ${e instanceof Error ? e.message : String(e)}`)
    continue
  }

  const { problems, warnings: imgWarnings, stats } = checkSpriteImage(png, spec, palette, paletteName)
  for (const w2 of imgWarnings) warn(`${file}: ${w2}`)

  if (problems.length > 0) {
    fail(`${file}: ${problems.join('; ')}`)
  } else {
    ok(`${file} (прозрачность ${stats.transparentPct}%, #${WHITE_HEX} ${stats.whitePct}%${stats.noiseSummary})`)
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
