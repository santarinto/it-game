import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import { checkSpriteImage } from './sprite-check.mjs'
import {
  ROLE_STUBS,
  recolorWorker,
  recolorDesk,
  recolorIsoDesk,
  drawProceduralIsoTile,
  buildManifestEntries,
  updateManifestText,
} from './sprite-stub-core.mjs'

const CLIENT_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const MANIFEST_PATH = join(CLIENT_DIR, 'src', 'assets', 'sprites.json')
const SPRITES_DIR = join(CLIENT_DIR, 'public', 'assets', 'sprites')

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
const hd32 = manifest.palettes.hd32
const hd32Set = new Set(hd32)

test('ROLE_STUBS: все цвета ролей входят в палитру hd32', () => {
  const roles = Object.values(ROLE_STUBS)
  assert.equal(roles.length, 7, 'должно быть 7 ролей')

  for (const role of roles) {
    assert(hd32Set.has(role.accent), `акцент ${role.slug}: #${role.accent} отсутствует в hd32`)
    assert(hd32Set.has(role.isoScreen), `isoScreen ${role.slug}: #${role.isoScreen} отсутствует в hd32`)

    for (const [from, to] of Object.entries(role.shirt)) {
      assert(hd32Set.has(to), `shirt ${role.slug} (${from}->${to}): #${to} отсутствует в hd32`)
    }
    for (const [from, to] of Object.entries(role.screen)) {
      assert(hd32Set.has(to), `screen ${role.slug} (${from}->${to}): #${to} отсутствует в hd32`)
    }
  }
})

test('ROLE_STUBS: акцентные цвета ролей уникальны и различимы', () => {
  const accents = new Set()
  for (const role of Object.values(ROLE_STUBS)) {
    assert(!accents.has(role.accent), `дубликат акцентного цвета #${role.accent} у роли ${role.slug}`)
    accents.add(role.accent)
  }
  assert.equal(accents.size, 7)
})

test('recolorWorker: генерирует валидные спрайты сотрудников для всех ролей', () => {
  const basePng = PNG.sync.read(readFileSync(join(SPRITES_DIR, 'worker.png')))
  const spec = { size: 128, frames: 1, palette: 'hd32', class: 'person' }

  for (const role of Object.values(ROLE_STUBS)) {
    const recolored = recolorWorker(basePng, role)
    assert.equal(recolored.width, 128)
    assert.equal(recolored.height, 128)

    const { problems, stats } = checkSpriteImage(recolored, spec, hd32, 'hd32')
    assert.equal(problems.length, 0, `worker_${role.slug} нарушает контракт: ${problems.join('; ')}`)
    assert.equal(stats.totalSpecks, 0, `worker_${role.slug} содержит шум`)
  }
})

test('recolorDesk: генерирует валидные спрайты столов для всех ролей', () => {
  const basePng = PNG.sync.read(readFileSync(join(SPRITES_DIR, 'desk_pc.png')))
  const spec = { size: 128, frames: 1, palette: 'hd32', class: 'desk' }

  for (const role of Object.values(ROLE_STUBS)) {
    const recolored = recolorDesk(basePng, role)
    assert.equal(recolored.width, 128)
    assert.equal(recolored.height, 128)

    const { problems, stats } = checkSpriteImage(recolored, spec, hd32, 'hd32')
    assert.equal(problems.length, 0, `desk_pc_${role.slug} нарушает контракт: ${problems.join('; ')}`)
    assert.equal(stats.totalSpecks, 0, `desk_pc_${role.slug} содержит шум`)
  }
})

test('recolorIsoDesk: генерирует валидные изо-спрайты столов для всех ролей', () => {
  const basePng = PNG.sync.read(readFileSync(join(SPRITES_DIR, 'iso_desk_crt.png')))
  const spec = { size: 256, frames: 1, palette: 'hd32', class: 'iso' }

  for (const role of Object.values(ROLE_STUBS)) {
    const recolored = recolorIsoDesk(basePng, role)
    assert.equal(recolored.width, 256)
    assert.equal(recolored.height, 256)

    const { problems, stats } = checkSpriteImage(recolored, spec, hd32, 'hd32')
    assert.equal(problems.length, 0, `iso_desk_${role.slug} нарушает контракт: ${problems.join('; ')}`)
    assert.equal(stats.totalSpecks, 0, `iso_desk_${role.slug} содержит шум`)
  }
})

test('drawProceduralIsoTile: рисует геометрически корректную плитку 2:1', () => {
  const spec = { size: 256, frames: 1, palette: 'hd32', class: 'iso' }

  for (const role of Object.values(ROLE_STUBS)) {
    const tile = drawProceduralIsoTile(role)
    assert.equal(tile.width, 256)
    assert.equal(tile.height, 256)

    const { problems, stats } = checkSpriteImage(tile, spec, hd32, 'hd32')
    assert.equal(problems.length, 0, `tile_${role.slug} нарушает контракт: ${problems.join('; ')}`)
    assert.equal(stats.totalSpecks, 0, `tile_${role.slug} содержит шум`)
  }
})

test('buildManifestEntries: формирует полные записи манифеста для ролей', () => {
  const { sprites, aliases } = buildManifestEntries(ROLE_STUBS)
  const keys = Object.keys(sprites)
  // 7 ролей × 3 спрайта = 21 ключ
  assert.equal(keys.length, 21)

  for (const slug of Object.keys(ROLE_STUBS)) {
    assert(sprites[`worker_${slug}`], `нет worker_${slug}`)
    assert.equal(sprites[`worker_${slug}`].fallback, 'worker')
    assert.equal(sprites[`worker_${slug}`].class, 'person')

    assert(sprites[`desk_pc_${slug}`], `нет desk_pc_${slug}`)
    assert.equal(sprites[`desk_pc_${slug}`].fallback, 'desk_pc')
    assert.equal(sprites[`desk_pc_${slug}`].class, 'desk')

    assert(sprites[`iso_desk_${slug}`], `нет iso_desk_${slug}`)
    assert.equal(sprites[`iso_desk_${slug}`].fallback, 'iso_desk_crt')
    assert.equal(sprites[`iso_desk_${slug}`].class, 'iso')

    assert.equal(aliases[`desk_${slug}`], `desk_pc_${slug}`)
  }
})

test('updateManifestText: корректно сериализует и сохраняет идемпотентность', () => {
  const raw = readFileSync(MANIFEST_PATH, 'utf8')
  const { sprites, aliases } = buildManifestEntries(ROLE_STUBS)
  const updated1 = updateManifestText(raw, sprites, aliases)
  const parsed1 = JSON.parse(updated1)

  assert(parsed1.sprites.worker_developer)
  assert.equal(parsed1.aliases.desk_developer, 'desk_pc_developer')

  // Идемпотентность: повторный запуск поверх обновлённого текста даёт идентичный результат
  const updated2 = updateManifestText(updated1, sprites, aliases)
  assert.equal(updated1, updated2)
})
