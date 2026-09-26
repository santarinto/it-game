#!/usr/bin/env node
// sprite-remap — постобработка спрайтов на pngjs, без ImageMagick
// (ITGAME-6/HD): заменяет scripts/sprites/remap.sh (`magick` недоступен
// в контейнере). Квантизует произвольный вход в палитру ключа манифеста
// и кладёт результат в холст size×size, затем прогоняет тот же контракт,
// что client/scripts/check-sprites.mjs (см. client/scripts/lib/sprite-check.mjs),
// и печатает краткий отчёт.
//
// Использование:
//   node client/scripts/sprite-remap.mjs <in.png> <out.png> --key <ключ> \
//     [--size N] [--palette sweetie16|hd32] [--alpha N=128] \
//     [--downscale-nearest] [--despeckle N=0] [--bottom-margin N=0] \
//     [--flip-x] [--place X,Y]
//
// Алгоритм (без ресемплинга/интерполяции — пиксель-арт терпит только
// точное приближение цвета и точное прореживание):
//   1. (опционально) --downscale-nearest: если вход РОВНО в k раз больше
//      size (квадрат, width%size===0), берём каждый k-й пиксель по обеим
//      осям — это не ресемплинг с интерполяцией, а точная инверсия
//      nearest-апскейла (единственный случай, где такое обращение точное).
//   2. Alpha-порог: alpha >= --alpha (default 128) → непрозрачный (alpha
//      принудительно 255), иначе полностью прозрачный (0,0,0,0). Никаких
//      полутонов — check-sprites запрещает alpha 26..254 как контракт.
//   3. Для каждого непрозрачного пикселя — ближайший цвет палитры ключа.
//      Метрика: redmean (низкобюджетная перцептивная метрика, см.
//      nearestPaletteColor ниже) — без дизеринга (пиксель-арт с фиксным
//      сетом цветов дизер только шумит).
//   4. --despeckle N: удаляет 8-связные компоненты непрозрачных пикселей
//      площадью ≤ N (до вычисления bbox — шум не должен раздувать рамку).
//   5. bbox непрозрачных пикселей. Если bbox шире/выше size — ошибка
//      (exit 1): ресемплинг не делаем, вход должен быть уже нужного
//      разрешения (см. --downscale-nearest выше).
//   5.5. --flip-x: зеркалит по горизонтали СОДЕРЖИМОЕ bbox (bbox-зависимо
//      — сам bbox не двигается и не меняет размер, зеркалится только то,
//      что внутри него). После alpha/квантизации/despeckle, до размещения
//      на холсте — зеркалим уже готовые пиксели, а не сырой вход.
//   6. Холст size×size: по умолчанию bbox кладём по центру по X и по низу
//      (минус --bottom-margin, default 0) по Y; с --place X,Y — вместо
//      этого левый-верхний угол bbox кладётся ровно в (X,Y) (используется
//      для ручной подгонки нескольких спрайтов в одну точку слота, см.
//      worker.png в scripts/sprites/build-hd.sh). Если со смещением bbox
//      не влезает в холст — ошибка (exit 1), без ресемплинга.
//   7. Отчёт: checkSpriteImage() из lib/sprite-check.mjs — тот же
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
    'Usage: node client/scripts/sprite-remap.mjs <in.png> <out.png> --key <ключ> ' +
      '[--size N] [--palette sweetie16|hd32] [--alpha N=128] [--downscale-nearest] ' +
      '[--despeckle N=0] [--bottom-margin N=0] [--flip-x] [--place X,Y]',
  )
  process.exit(1)
}

// ── Аргументы ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const positional = []
const opts = { alpha: 128, despeckle: 0, bottomMargin: 0, downscaleNearest: false, flipX: false, place: null }
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  switch (a) {
    case '--key':
      opts.key = argv[++i]
      break
    case '--size':
      opts.size = Number(argv[++i])
      break
    case '--palette':
      opts.palette = argv[++i]
      break
    case '--alpha':
      opts.alpha = Number(argv[++i])
      break
    case '--downscale-nearest':
      opts.downscaleNearest = true
      break
    case '--despeckle':
      opts.despeckle = Number(argv[++i])
      break
    case '--bottom-margin':
      opts.bottomMargin = Number(argv[++i])
      break
    case '--flip-x':
      opts.flipX = true
      break
    case '--place': {
      const raw = argv[++i] ?? ''
      const m = /^(-?\d+),(-?\d+)$/.exec(raw)
      if (!m) usageError(`--place ожидает "X,Y" целыми числами, получено '${raw}'`)
      opts.place = { x: Number(m[1]), y: Number(m[2]) }
      break
    }
    default:
      if (a.startsWith('--')) usageError(`неизвестный флаг ${a}`)
      positional.push(a)
  }
}
const [inPath, outPath] = positional
if (!inPath || !outPath) usageError('нужны позиционные <in.png> <out.png>')
if (!opts.key) usageError('нужен --key <ключ манифеста>')
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
if (!Number.isFinite(opts.alpha) || opts.alpha < 1 || opts.alpha > 255) {
  usageError(`некорректный --alpha: ${opts.alpha} (ожидается 1..255)`)
}

// ── Ближайший цвет палитры: redmean ─────────────────────────────────────
// Redmean (compuphase "Colour metric") — низкобюджетное перцептивное
// приближение: взвешивает R/G/B по среднему уровню красного, без полного
// перевода в linear-light/CIEDE2000. Для пиксель-арт палитры фиксного
// размера (16–32 цвета) даёт заметно более «человеческий» выбор, чем
// плоский евклид RGB (меньше промахов зелёный↔голубой на границах
// силуэта), а стоит почти как евклид — никакого gamma-decode на пиксель.
// Явно НЕ CIEDE2000/Lab: для замены готовых 14 спрайтов и HD-заготовок
// точность важнее компенсации отсутствия дизеринга, redmean достаточно.
const paletteRgb = palette.map((hex) => [
  parseInt(hex.slice(0, 2), 16),
  parseInt(hex.slice(2, 4), 16),
  parseInt(hex.slice(4, 6), 16),
])
function nearestPaletteColor(r, g, b) {
  let best = paletteRgb[0]
  let bestDist = Infinity
  for (const [pr, pg, pb] of paletteRgb) {
    const rmean = (r + pr) / 2
    const dr = r - pr
    const dg = g - pg
    const db = b - pb
    const dist = (2 + rmean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rmean) / 256) * db * db
    if (dist < bestDist) {
      bestDist = dist
      best = [pr, pg, pb]
    }
  }
  return best
}

// ── 1. Вход + опциональный точный nearest-downscale ─────────────────────
let src = PNG.sync.read(readFileSync(inPath))
if (opts.downscaleNearest) {
  if (src.width !== src.height) {
    usageError(`--downscale-nearest: вход не квадратный ${src.width}x${src.height}`)
  }
  if (src.width % size !== 0) {
    usageError(`--downscale-nearest: ширина входа ${src.width} не делится на size=${size} нацело`)
  }
  const k = src.width / size
  if (k > 1) {
    const ds = new PNG({ width: size, height: size })
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const si = (y * k * src.width + x * k) * 4
        const di = (y * size + x) * 4
        ds.data[di] = src.data[si]
        ds.data[di + 1] = src.data[si + 1]
        ds.data[di + 2] = src.data[si + 2]
        ds.data[di + 3] = src.data[si + 3]
      }
    }
    src = ds
  }
}

// ── 2+3. Alpha-порог + квантизация в палитру ────────────────────────────
const w = src.width
const h = src.height
const work = Buffer.alloc(w * h * 4)
for (let i = 0; i < w * h; i++) {
  const si = i * 4
  if (src.data[si + 3] >= opts.alpha) {
    const [nr, ng, nb] = nearestPaletteColor(src.data[si], src.data[si + 1], src.data[si + 2])
    work[si] = nr
    work[si + 1] = ng
    work[si + 2] = nb
    work[si + 3] = 255
  } else {
    work[si] = 0
    work[si + 1] = 0
    work[si + 2] = 0
    work[si + 3] = 0
  }
}

// ── 4. Despeckle ─────────────────────────────────────────────────────────
if (opts.despeckle > 0) {
  const seen = new Uint8Array(w * h)
  const opaque = (x, y) => x >= 0 && y >= 0 && x < w && y < h && work[(y * w + x) * 4 + 3] === 255
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x
      if (!opaque(x, y) || seen[idx]) continue
      const stack = [[x, y]]
      const pixels = [[x, y]]
      seen[idx] = 1
      while (stack.length) {
        const [cx, cy] = stack.pop()
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue
            const nx = cx + dx
            const ny = cy + dy
            const nidx = ny * w + nx
            if (opaque(nx, ny) && !seen[nidx]) {
              seen[nidx] = 1
              stack.push([nx, ny])
              pixels.push([nx, ny])
            }
          }
        }
      }
      if (pixels.length <= opts.despeckle) {
        for (const [px, py] of pixels) {
          const i = (py * w + px) * 4
          work[i] = 0
          work[i + 1] = 0
          work[i + 2] = 0
          work[i + 3] = 0
        }
      }
    }
  }
}

// ── 5. bbox ──────────────────────────────────────────────────────────────
let minX = w
let minY = h
let maxX = -1
let maxY = -1
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    if (work[(y * w + x) * 4 + 3] === 255) {
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
}
if (maxX < 0) {
  usageError('после alpha-порога/despeckle не осталось ни одного непрозрачного пикселя')
}
const bboxW = maxX - minX + 1
const bboxH = maxY - minY + 1
if (bboxW > size || bboxH > size) {
  console.error(
    `error: bbox непрозрачных пикселей ${bboxW}x${bboxH} больше холста ${size}x${size} — ` +
      `ресемплинг не делается (см. --downscale-nearest для точного целого делителя)`,
  )
  process.exit(1)
}

// ── 5.5. --flip-x: зеркалим содержимое bbox по горизонтали (bbox не двигается) ──
if (opts.flipX) {
  const flipped = Buffer.from(work)
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const srcX = minX + maxX - x
      const si = (y * w + srcX) * 4
      const di = (y * w + x) * 4
      flipped[di] = work[si]
      flipped[di + 1] = work[si + 1]
      flipped[di + 2] = work[si + 2]
      flipped[di + 3] = work[si + 3]
    }
  }
  flipped.copy(work)
}

// ── 6. Холст size×size: по центру X, по низу Y (минус bottomMargin), либо ─
//      с --place X,Y — левый-верхний угол bbox ровно в (X,Y) ───────────────
if (opts.bottomMargin < 0 || opts.bottomMargin > size) {
  usageError(`некорректный --bottom-margin: ${opts.bottomMargin}`)
}
let destX0
let destY0
if (opts.place) {
  destX0 = opts.place.x
  destY0 = opts.place.y
  if (destX0 < 0 || destY0 < 0 || destX0 + bboxW > size || destY0 + bboxH > size) {
    console.error(
      `error: --place ${destX0},${destY0} — bbox ${bboxW}x${bboxH} не влезает в холст ${size}x${size} ` +
        `(нужно 0<=X, 0<=Y, X+${bboxW}<=${size}, Y+${bboxH}<=${size})`,
    )
    process.exit(1)
  }
} else {
  destX0 = Math.floor((size - bboxW) / 2)
  destY0 = size - opts.bottomMargin - bboxH
  if (destY0 < 0) {
    usageError(`--bottom-margin=${opts.bottomMargin} не оставляет места для bbox высотой ${bboxH} в холсте ${size}`)
  }
}
const canvas = new PNG({ width: size, height: size }) // Buffer.alloc — уже прозрачно (нули)
for (let y = 0; y < bboxH; y++) {
  for (let x = 0; x < bboxW; x++) {
    const si = ((minY + y) * w + (minX + x)) * 4
    const di = ((destY0 + y) * size + (destX0 + x)) * 4
    canvas.data[di] = work[si]
    canvas.data[di + 1] = work[si + 1]
    canvas.data[di + 2] = work[si + 2]
    canvas.data[di + 3] = work[si + 3]
  }
}

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, PNG.sync.write(canvas))

// ── 7. Отчёт: тот же контракт, что check-sprites.mjs ────────────────────
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
  `  ${size}x${size}, палитра ${paletteName}, alpha>=${opts.alpha}` +
    (opts.downscaleNearest ? `, downscale-nearest` : '') +
    (opts.despeckle > 0 ? `, despeckle<=${opts.despeckle}` : '') +
    (opts.flipX ? `, flip-x` : ''),
)
console.log(
  `  bbox исходника: ${bboxW}x${bboxH} → холст со смещением (${destX0}, ${destY0})` +
    (opts.place ? ` (--place)` : ''),
)
console.log(`  цветов использовано: ${usedColors.size}, прозрачность: ${stats.transparentPct}%, #${WHITE_HEX}: ${stats.whitePct}%${stats.noiseSummary}`)
for (const wmsg of warnings) console.warn(`  WARN ${wmsg}`)

if (problems.length > 0) {
  console.error(`  CHECK FAIL: ${problems.join('; ')}`)
  process.exit(1)
}
console.log('  CHECK OK')
