#!/usr/bin/env node
// sprite-recolor — точечная перекраска уже готового HD-спрайта на pngjs,
// тем же стилем, что sprite-remap.mjs (ITGAME-6/HD). Не квантизует и не
// ресемплит — только точная замена набора исходных hex-цветов на другие
// hex-цвета ТОЙ ЖЕ палитры ключа, детерминированно, без ИИ. Нужен для
// «состояний» одного и того же силуэта: экран монитора вкл/выключен/сбой,
// уровни цвета рубашки сотрудника — там, где смена состояния это просто
// перекраска готовых пикселей, а не новая генерация.
//
// Использование:
//   node client/scripts/sprite-recolor.mjs <in.png> <out.png> --key <ключ> \
//     --map aabbcc=ddeeff[,aabbcc=ddeeff…] [--region x0,y0,x1,y1] \
//     [--size N --palette sweetie16|hd32]
//
// Алгоритм:
//   1. --map разбирается в пары исходный_hex=целевой_hex (без '#', регистр
//      неважен, нормализуются в нижний). Каждый целевой_hex ОБЯЗАН быть в
//      палитре ключа (--size/--palette перекрывают запись манифеста, как
//      в sprite-remap.mjs) — иначе ошибка (exit 1) ДО чтения входа: замена
//      на цвет вне палитры сразу нарушит контракт check-sprites.
//   2. Вход читается как есть (никакого alpha-порога/квантизации/ресемпла
//      — предполагается, что <in.png> уже прошёл remap и валиден).
//   3. (опционально) --region x0,y0,x1,y1 — прямоугольник холста
//      ВКЛЮЧИТЕЛЬНО с обеих сторон; замена происходит только внутри него
//      (например, экран монитора отдельно от кресла/клавиатуры, которые
//      тоже тёмные и иначе попали бы под замену).
//   4. Для каждого пикселя: если alpha < 26 (прозрачный) — пропускаем;
//      иначе, если его hex есть в --map (и пиксель внутри --region, если
//      задан) — RGB заменяется на целевой, alpha не трогаем.
//   5. Отчёт в стиле sprite-remap.mjs: сколько пикселей заменено на
//      каждую пару (WARN, если 0 — вероятно неверно угадан исходный
//      цвет), затем checkSpriteImage() из lib/sprite-check.mjs — тот же
//      контракт, что build. Нарушения печатаются, exit 1.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import { checkSpriteImage, WHITE_HEX } from './lib/sprite-check.mjs'

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))
const CLIENT_DIR = dirname(SCRIPTS_DIR)
const MANIFEST_PATH = join(CLIENT_DIR, 'src', 'assets', 'sprites.json')

function usageError(msg) {
  console.error(`error: ${msg}`)
  console.error(
    'Usage: node client/scripts/sprite-recolor.mjs <in.png> <out.png> --key <ключ> ' +
      '--map aabbcc=ddeeff[,aabbcc=ddeeff…] [--region x0,y0,x1,y1] ' +
      '[--size N --palette sweetie16|hd32]',
  )
  process.exit(1)
}

const HEX_RE = /^[0-9a-f]{6}$/

// ── Аргументы ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const positional = []
const opts = { region: null }
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  switch (a) {
    case '--key':
      opts.key = argv[++i]
      break
    case '--map':
      opts.mapRaw = argv[++i]
      break
    case '--region': {
      const raw = argv[++i] ?? ''
      const m = /^(-?\d+),(-?\d+),(-?\d+),(-?\d+)$/.exec(raw)
      if (!m) usageError(`--region ожидает "x0,y0,x1,y1" целыми числами, получено '${raw}'`)
      opts.region = { x0: Number(m[1]), y0: Number(m[2]), x1: Number(m[3]), y1: Number(m[4]) }
      break
    }
    case '--size':
      opts.size = Number(argv[++i])
      break
    case '--palette':
      opts.palette = argv[++i]
      break
    default:
      if (a.startsWith('--')) usageError(`неизвестный флаг ${a}`)
      positional.push(a)
  }
}
const [inPath, outPath] = positional
if (!inPath || !outPath) usageError('нужны позиционные <in.png> <out.png>')
if (!opts.key) usageError('нужен --key <ключ манифеста>')
if (!opts.mapRaw) usageError('нужен --map aabbcc=ddeeff[,…]')
if (!existsSync(inPath)) usageError(`нет входного файла ${inPath}`)
if (!existsSync(MANIFEST_PATH)) usageError(`нет манифеста ${MANIFEST_PATH}`)

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
const spriteSpec = manifest.sprites?.[opts.key]
if (!spriteSpec && (!opts.size || !opts.palette)) {
  usageError(
    `ключ '${opts.key}' не найден в sprites.json — для нового ключа укажите --size и --palette явно`,
  )
}
const size = opts.size ?? spriteSpec.size
const paletteName = opts.palette ?? spriteSpec.palette
const palette = manifest.palettes?.[paletteName]
if (!Number.isInteger(size) || size <= 0) usageError(`некорректный size: ${size}`)
if (!palette) usageError(`неизвестная палитра '${paletteName}' (нет в manifest.palettes)`)
const paletteSet = new Set(palette)

// ── Разбор --map: source(hex, нормализован) → target(hex) ───────────────
const colorMap = new Map()
for (const pair of opts.mapRaw.split(',')) {
  const eq = pair.indexOf('=')
  if (eq < 0) usageError(`--map: пара '${pair}' не в формате aabbcc=ddeeff`)
  const from = pair.slice(0, eq).trim().toLowerCase().replace(/^#/, '')
  const to = pair.slice(eq + 1).trim().toLowerCase().replace(/^#/, '')
  if (!HEX_RE.test(from)) usageError(`--map: исходный цвет '${from}' не 6-значный hex`)
  if (!HEX_RE.test(to)) usageError(`--map: целевой цвет '${to}' не 6-значный hex`)
  if (!paletteSet.has(to)) {
    usageError(`--map: целевой цвет '${to}' отсутствует в палитре ${paletteName}`)
  }
  colorMap.set(from, to)
}

// ── Вход: как есть, без alpha-порога/квантизации/ресемпла ────────────────
const src = PNG.sync.read(readFileSync(inPath))
const w = src.width
const h = src.height

let region = opts.region
if (region) {
  const { x0, y0, x1, y1 } = region
  if (x0 < 0 || y0 < 0 || x1 >= w || y1 >= h || x0 > x1 || y0 > y1) {
    usageError(
      `--region ${x0},${y0},${x1},${y1} вне холста ${w}x${h} или некорректен (ожидается 0<=x0<=x1<${w}, 0<=y0<=y1<${h})`,
    )
  }
}
const inRegion = (x, y) => !region || (x >= region.x0 && x <= region.x1 && y >= region.y0 && y <= region.y1)

// ── Замена: только непрозрачные пиксели, только внутри --region ─────────
const canvas = new PNG({ width: w, height: h })
src.data.copy(canvas.data)
const replaced = new Map([...colorMap.keys()].map((k) => [k, 0]))
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4
    if (canvas.data[i + 3] < 26) continue // прозрачный — не трогаем
    if (!inRegion(x, y)) continue
    const hex = [canvas.data[i], canvas.data[i + 1], canvas.data[i + 2]]
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('')
    const to = colorMap.get(hex)
    if (!to) continue
    canvas.data[i] = parseInt(to.slice(0, 2), 16)
    canvas.data[i + 1] = parseInt(to.slice(2, 4), 16)
    canvas.data[i + 2] = parseInt(to.slice(4, 6), 16)
    replaced.set(hex, replaced.get(hex) + 1)
  }
}

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, PNG.sync.write(canvas))

// ── Отчёт: замены + тот же контракт, что check-sprites.mjs ──────────────
const reportSpec = {
  size,
  frames: 1,
  maxWhitePct: spriteSpec?.maxWhitePct,
  maxSpecks: spriteSpec?.maxSpecks,
}
const { problems, warnings, stats } = checkSpriteImage(canvas, reportSpec, palette, paletteName)

const usedColors = new Set()
for (let i = 0; i < canvas.data.length; i += 4) {
  if (canvas.data[i + 3] === 255) {
    usedColors.add(
      [canvas.data[i], canvas.data[i + 1], canvas.data[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join(''),
    )
  }
}

console.log(`${outPath}`)
console.log(
  `  ${size}x${size}, палитра ${paletteName}` + (region ? `, region (${region.x0},${region.y0})-(${region.x1},${region.y1})` : ''),
)
for (const [from, to] of colorMap) {
  const n = replaced.get(from)
  console.log(`  ${from} → ${to}: ${n} px${n === 0 ? ' (WARN: не встретился)' : ''}`)
}
console.log(`  цветов использовано: ${usedColors.size}, прозрачность: ${stats.transparentPct}%, #${WHITE_HEX}: ${stats.whitePct}%${stats.noiseSummary}`)
for (const wmsg of warnings) console.warn(`  WARN ${wmsg}`)

if (problems.length > 0) {
  console.error(`  CHECK FAIL: ${problems.join('; ')}`)
  process.exit(1)
}
console.log('  CHECK OK')
