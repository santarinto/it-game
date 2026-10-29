#!/usr/bin/env node
// sprite-stub.mjs — генерация заглушек спрайтов по ролям сотрудников (ITGAME-243).
// Создаёт 2D-спрайты сотрудников (worker_<role>.png), столов (desk_pc_<role>.png)
// и изометрических рабочих мест (iso_desk_<role>.png), регистрирует их в sprites.json
// и проверяет каждый файл через контракт check-sprites.
//
// Использование:
//   node client/scripts/sprite-stub.mjs [--check] [--only worker|desk|iso] [--roles dev,tester,...]
//
// Флаги:
//   --check           только проверка: всё ли сгенерировано и зарегистрировано в sprites.json
//   --only <тип>      генерировать только worker, desk или iso (по умолчанию все)
//   --roles <список>  генерировать только указанные роли через запятую
//   --procedural-iso  дополнительно сгенерировать процедурные iso-плитки пола (iso_floor_<role>)
//   --help, -h        показать эту справку
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import { checkSpriteImage } from './lib/sprite-check.mjs'
import {
  ROLE_STUBS,
  recolorWorker,
  recolorDesk,
  recolorIsoDesk,
  drawProceduralIsoTile,
  buildManifestEntries,
  updateManifestText,
} from './lib/sprite-stub-core.mjs'

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))
const CLIENT_DIR = dirname(SCRIPTS_DIR)
const MANIFEST_PATH = join(CLIENT_DIR, 'src', 'assets', 'sprites.json')
const SPRITES_DIR = join(CLIENT_DIR, 'public', 'assets', 'sprites')

function showHelp() {
  console.log(`sprite-stub — генерация заглушек спрайтов по ролям (ITGAME-243)

Использование:
  node client/scripts/sprite-stub.mjs [опции]

Опции:
  --check            проверить наличие заглушек и регистрацию в манифесте (dry run)
  --only <тип>       генерировать только worker | desk | iso (по умолчанию все)
  --roles <список>   список ролей через запятую (developer,tester,support,designer,pm,lead,analyst)
  --procedural-iso   дополнительно генерировать процедурные iso-плитки пола (iso_floor_<role>)
  --help, -h         показать эту справку

Роли:
${Object.values(ROLE_STUBS)
  .map((r) => `  ${r.slug.padEnd(12)} — ${r.title} (акцент: #${r.accent})`)
  .join('\n')}
`)
}

// ── Аргументы ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
let isCheck = false
let onlyType = null
let roleFilter = null
let withProceduralIso = false

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (arg === '--help' || arg === '-h') {
    showHelp()
    process.exit(0)
  } else if (arg === '--check') {
    isCheck = true
  } else if (arg === '--only') {
    onlyType = argv[++i]
    if (!['worker', 'desk', 'iso'].includes(onlyType)) {
      console.error(`error: неизвестный тип --only '${onlyType}' (ожидается worker, desk или iso)`)
      process.exit(1)
    }
  } else if (arg === '--roles') {
    roleFilter = new Set(argv[++i].split(',').map((s) => s.trim().toLowerCase()))
  } else if (arg === '--procedural-iso') {
    withProceduralIso = true
  } else {
    console.error(`error: неизвестный аргумент '${arg}' (см. --help)`)
    process.exit(1)
  }
}

// Отбираем роли
const targetRoles = {}
for (const [slug, conf] of Object.entries(ROLE_STUBS)) {
  if (!roleFilter || roleFilter.has(slug)) {
    targetRoles[slug] = conf
  }
}

if (Object.keys(targetRoles).length === 0) {
  console.error('error: не выбрано ни одной роли для генерации')
  process.exit(1)
}

if (!existsSync(MANIFEST_PATH)) {
  console.error(`error: нет манифеста ${MANIFEST_PATH}`)
  process.exit(1)
}

const manifestRaw = readFileSync(MANIFEST_PATH, 'utf8')
const manifest = JSON.parse(manifestRaw)
const hd32 = manifest.palettes.hd32

// Проверка базовых исходников
const workerPath = join(SPRITES_DIR, 'worker.png')
const deskPath = join(SPRITES_DIR, 'desk_pc.png')
const isoDeskPath = join(SPRITES_DIR, 'iso_desk_crt.png')

for (const p of [workerPath, deskPath, isoDeskPath]) {
  if (!existsSync(p)) {
    console.error(`error: базовый спрайт ${p} не найден`)
    process.exit(1)
  }
}

const baseWorker = PNG.sync.read(readFileSync(workerPath))
const baseDesk = PNG.sync.read(readFileSync(deskPath))
const baseIsoDesk = PNG.sync.read(readFileSync(isoDeskPath))

// ── Режим --check (dry run) ──────────────────────────────────────────────
if (isCheck) {
  let missingFiles = 0
  let missingManifest = 0
  console.log(`Проверка заглушек ролей (${Object.keys(targetRoles).length} ролей)...`)

  for (const [slug, conf] of Object.entries(targetRoles)) {
    const keysToCheck = []
    if (!onlyType || onlyType === 'worker') keysToCheck.push({ key: `worker_${slug}`, file: `worker_${slug}.png` })
    if (!onlyType || onlyType === 'desk') keysToCheck.push({ key: `desk_pc_${slug}`, file: `desk_pc_${slug}.png` })
    if (!onlyType || onlyType === 'iso') keysToCheck.push({ key: `iso_desk_${slug}`, file: `iso_desk_${slug}.png` })
    if (withProceduralIso) keysToCheck.push({ key: `iso_floor_${slug}`, file: `iso_floor_${slug}.png` })

    for (const { key, file } of keysToCheck) {
      const filePath = join(SPRITES_DIR, file)
      const hasFile = existsSync(filePath)
      const hasKey = Boolean(manifest.sprites[key])

      if (!hasFile) {
        console.error(`  MISSING FILE: ${file}`)
        missingFiles++
      }
      if (!hasKey) {
        console.error(`  MISSING KEY IN MANIFEST: ${key}`)
        missingManifest++
      }
      if (hasFile && hasKey) {
        console.log(`  OK: ${key} (${conf.title})`)
      }
    }
  }

  if (missingFiles > 0 || missingManifest > 0) {
    console.error(`CHECK FAIL: ${missingFiles} файлов отсутствует, ${missingManifest} ключей нет в sprites.json`)
    process.exit(1)
  }
  console.log('CHECK OK: все заглушки ролей на месте и зарегистрированы')
  process.exit(0)
}

// ── Генерация ────────────────────────────────────────────────────────────
console.log(`Генерация заглушек ролей: ${Object.keys(targetRoles).join(', ')}...`)

const { sprites: newSprites, aliases: newAliases } = buildManifestEntries(targetRoles)
const generated = []
const violations = []

for (const [slug, conf] of Object.entries(targetRoles)) {
  // 1. Worker (2D, 128px)
  if (!onlyType || onlyType === 'worker') {
    const key = `worker_${slug}`
    const outPng = recolorWorker(baseWorker, conf)
    const spec = newSprites[key]
    const { problems, stats } = checkSpriteImage(outPng, spec, hd32, 'hd32')
    if (problems.length > 0) {
      violations.push(`${key}: ${problems.join('; ')}`)
    } else {
      const outPath = join(SPRITES_DIR, `${key}.png`)
      writeFileSync(outPath, PNG.sync.write(outPng))
      generated.push({ key, file: `${key}.png`, size: 128, role: conf.title, stats })
    }
  }

  // 2. Desk (2D, 128px)
  if (!onlyType || onlyType === 'desk') {
    const key = `desk_pc_${slug}`
    const outPng = recolorDesk(baseDesk, conf)
    const spec = newSprites[key]
    const { problems, stats } = checkSpriteImage(outPng, spec, hd32, 'hd32')
    if (problems.length > 0) {
      violations.push(`${key}: ${problems.join('; ')}`)
    } else {
      const outPath = join(SPRITES_DIR, `${key}.png`)
      writeFileSync(outPath, PNG.sync.write(outPng))
      generated.push({ key, file: `${key}.png`, size: 128, role: conf.title, stats })
    }
  }

  // 3. Iso Desk (iso, 256px)
  if (!onlyType || onlyType === 'iso') {
    const key = `iso_desk_${slug}`
    const outPng = recolorIsoDesk(baseIsoDesk, conf)
    const spec = newSprites[key]
    const { problems, stats } = checkSpriteImage(outPng, spec, hd32, 'hd32')
    if (problems.length > 0) {
      violations.push(`${key}: ${problems.join('; ')}`)
    } else {
      const outPath = join(SPRITES_DIR, `${key}.png`)
      writeFileSync(outPath, PNG.sync.write(outPng))
      generated.push({ key, file: `${key}.png`, size: 256, role: conf.title, stats })
    }
  }

  // 4. Опционально: процедурная изо-плитка пола (iso_floor_<role>)
  if (withProceduralIso) {
    const key = `iso_floor_${slug}`
    const outPng = drawProceduralIsoTile(conf)
    const spec = {
      size: 256,
      frames: 1,
      palette: 'hd32',
      class: 'iso',
      fallback: 'iso_floor_office',
      note: `процедурная изо-плитка роли: ${conf.title} (ITGAME-243)`,
    }
    newSprites[key] = spec
    const { problems, stats } = checkSpriteImage(outPng, spec, hd32, 'hd32')
    if (problems.length > 0) {
      violations.push(`${key}: ${problems.join('; ')}`)
    } else {
      const outPath = join(SPRITES_DIR, `${key}.png`)
      writeFileSync(outPath, PNG.sync.write(outPng))
      generated.push({ key, file: `${key}.png`, size: 256, role: conf.title, stats })
    }
  }
}

if (violations.length > 0) {
  console.error(`ОШИБКИ КОНТРАКТА при генерации:\n  ${violations.join('\n  ')}`)
  process.exit(1)
}

// ── Обновление sprites.json ──────────────────────────────────────────────
// Фильтруем записи манифеста под то, что реально сгенерировали
const spritesToRegister = {}
for (const item of generated) {
  spritesToRegister[item.key] = newSprites[item.key]
}
const aliasesToRegister = {}
for (const [slug] of Object.entries(targetRoles)) {
  if (!onlyType || onlyType === 'desk') {
    aliasesToRegister[`desk_${slug}`] = `desk_pc_${slug}`
  }
}

const updatedManifest = updateManifestText(manifestRaw, spritesToRegister, aliasesToRegister)
writeFileSync(MANIFEST_PATH, updatedManifest, 'utf8')

console.log('')
console.log(`Успешно сгенерировано ${generated.length} спрайтов-заглушек:`)
for (const g of generated) {
  console.log(`  ✓ ${g.file.padEnd(26)} (${g.size}×${g.size}) — ${g.role} [прозрачность ${g.stats.transparentPct}%${g.stats.noiseSummary}]`)
}
console.log('')
console.log(`Манифест ${MANIFEST_PATH} обновлён.`)
console.log(`Проверка контракта: npm run check:sprites`)
