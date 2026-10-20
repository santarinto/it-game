// node --test: sprite-job-core (ITGAME-182) — класс из graphics.md и манифеста, профиль
// ≤ 4000 знаков, проверка спеки задания до minipc, тело POST /jobs; createJob из
// minipc-client против заглушки — тело, которое строит sprite:job, minipc принимает.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createJob, getJob, jobItems } from './minipc-client.mjs'
import { startMinipcStub } from './minipc-stub.mjs'
import { buildProfile, classFromDocs, jobPayload, payloadForPrint, PROFILE_MAX_CHARS, validateSpec } from './sprite-job-core.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const graphicsMd = readFileSync(join(ROOT, 'docs', 'design', 'graphics.md'), 'utf8')
const manifest = JSON.parse(readFileSync(join(ROOT, 'client', 'src', 'assets', 'sprites.json'), 'utf8'))
const ENV = { fixtures: ['broken_pc', 'fresh', 'worn_pcs'], scenes: ['menu', 'office'] }
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('crop')])
const spec = (over = {}) => ({
  about: 'ITGAME-134',
  class: 'desk',
  common: 'общая часть',
  items: [
    { key: 'desk_pc_crt', brief: 'стол с ЭЛТ', context: { text: '9px', bg: '2B2F4A', crop: { fixture: 'worn_pcs', scene: 'office', ids: ['office.slot.3'] } } },
    { key: 'desk_ov_off', brief: 'оверлей' },
  ],
  ...over,
})

let stub
before(async () => {
  stub = await startMinipcStub()
})
after(() => stub.stop())

test('classFromDocs: desk — 64/128 hd32 pixel из таблицы graphics.md, цвета из палитры манифеста; icon смешан — нужен render', () => {
  const desk = classFromDocs(graphicsMd, manifest, 'desk')
  assert.deepEqual({ ...desk, colors: desk.colors.length }, { name: 'desk', screenPx: 64, sourcePx: 128, palette: 'hd32', colors: manifest.palettes.hd32.length, render: 'pixel' })
  assert.throws(() => classFromDocs(graphicsMd, manifest, 'icon'), /и smooth, и pixel — задайте render/)
  assert.equal(classFromDocs(graphicsMd, manifest, 'icon', 'smooth').sourcePx, 64)
  assert.throws(() => classFromDocs(graphicsMd, manifest, 'icon16'), /класса icon16 нет в таблице классов/)
  const wrong = { ...manifest, sprites: { ...manifest.sprites, desk_x: { size: 64, frames: 1, palette: 'hd32', class: 'desk' } } }
  assert.throws(() => classFromDocs(graphicsMd, wrong, 'desk'), /desk_x в sprites.json — 64 px hd32, а graphics.md — 128 px hd32/)
})

test('buildProfile: pixel — правила §1, палитры, рендер, строка класса, контракт, common; smooth — решения пилота; sha256 от текста; > 4000 — отказ', () => {
  const desk = classFromDocs(graphicsMd, manifest, 'desk')
  const p = buildProfile(graphicsMd, desk, { version: 'graphics@abc1234', about: 'ITGAME-134', common: 'Три силуэта и четыре оверлея.' })
  assert.equal(p.version, 'graphics@abc1234')
  assert.equal(p.sha256, createHash('sha256').update(p.text).digest('hex'))
  assert.ok(p.text.length <= PROFILE_MAX_CHARS)
  for (const part of ['## 1. Что уже жёстко задано кодом', '### Палитры', '### Рендер и размеры', '| `desk`, `person`, `rack`, `amenity` | 64 | 128 | hd32 |', 'PNG RGBA 128×128', '## Задание ITGAME-134\n\nТри силуэта и четыре оверлея.']) {
    assert.ok(p.text.includes(part), part)
  }
  assert.ok(!p.text.includes('Пилот кубка'))
  const icon = buildProfile(graphicsMd, classFromDocs(graphicsMd, manifest, 'icon', 'smooth'), { version: 'v', about: 'X-1' })
  assert.ok(icon.text.includes('Пилот кубка') && !icon.text.includes('## 1. Что уже') && icon.text.includes('ориентир по тону'))
  assert.throws(() => buildProfile(graphicsMd, desk, { version: 'v', about: 'X-1', common: 'я'.repeat(4000) }), /знаков > 4000/)
})

test('validateSpec: все нарушения сразу — about, ключ, brief в байтах, bg, фикстура, сцена, ids, лишние поля', () => {
  assert.equal(validateSpec(spec(), ENV).about, 'ITGAME-134')
  const bad = spec({
    about: 'не код',
    items: [
      { key: 'Desk', brief: 'x' },
      { key: 'ok', brief: 'ж'.repeat(251) },
      { key: 'ok', brief: 'y', context: { bg: '#123456', crop: { fixture: 'nope', scene: 'void', ids: [], extra: 1 } } },
    ],
  })
  assert.throws(() => validateSpec(bad, ENV), (e) => {
    for (const re of [/about —/, /items\.0 \(Desk\)\.key/, /items\.1 \(ok\)\.brief — .*502/, /items\.2 \(ok\)\.key повторяется/, /context\.bg/, /crop\.fixture — одна из broken_pc, fresh, worn_pcs/, /crop\.scene — одна из menu, office/, /crop\.ids/, /лишние поля extra/]) {
      assert.match(e.message, re)
    }
    return true
  })
})

test('jobPayload: класс, профиль, context с cropPng base64 только у ключей с кропом; печать — размер и sha256 вместо base64', () => {
  const desk = classFromDocs(graphicsMd, manifest, 'desk')
  const profile = buildProfile(graphicsMd, desk, { version: 'v', about: 'ITGAME-134' })
  const body = jobPayload(spec(), desk, profile, { desk_pc_crt: png })
  assert.deepEqual(body.items[0], { key: 'desk_pc_crt', brief: 'стол с ЭЛТ', context: { text: '9px', bg: '2b2f4a', cropPng: png.toString('base64') } })
  assert.deepEqual(body.items[1], { key: 'desk_ov_off', brief: 'оверлей' })
  assert.deepEqual(body.class, { name: 'desk', screenPx: 64, sourcePx: 128, palette: 'hd32', colors: manifest.palettes.hd32 })
  const pr = payloadForPrint(body)
  assert.deepEqual(pr.items[0].context.cropPng, { bytes: png.length, sha256: createHash('sha256').update(png).digest('hex') })
  assert.deepEqual(pr.profile, { version: 'v', sha256: profile.sha256, chars: profile.text.length })
})

test('createJob против заглушки: тело sprite:job принимается, все ключи open; отказ minipc — исключение с полем', async () => {
  const mp = { url: stub.url, token: stub.tokens.cli }
  const desk = classFromDocs(graphicsMd, manifest, 'desk')
  const body = jobPayload(spec(), desk, buildProfile(graphicsMd, desk, { version: 'graphics@abc1234', about: 'ITGAME-134' }), { desk_pc_crt: png })
  const job = await createJob(mp, body)
  assert.match(job.taskId, /^[0-9]+$/)
  assert.deepEqual(jobItems(job).map((x) => [x.key, x.status]), [['desk_pc_crt', 'open'], ['desk_ov_off', 'open']])
  // GET отдаёт ключи по алфавиту, как minipc
  assert.deepEqual(jobItems(await getJob(mp, job.taskId)).map((x) => [x.key, x.ctx]), [['desk_ov_off', { text: null, bg: null }], ['desk_pc_crt', { text: '9px', bg: '2b2f4a' }]])
  await assert.rejects(createJob(mp, { ...body, profile: { ...body.profile, sha256: 'p' } }), /POST \/jobs: 422 .*\(profile\.sha256\)/)
  await assert.rejects(createJob({ ...mp, token: stub.tokens.go }, body), /POST \/jobs: 403 forbidden — the itgame-cli token is required/)
})
