// sprite-job — завести задание minipc из спеки в репо (ITGAME-182, docs/design/sprite-pipeline.md,
// «Задание»): координатор пишет требования, minipc хранит задание, владелец рисует в планшете.
//
//   npm run sprite:job -- --spec scripts/sprites/minipc/jobs/<about>.json [--dry-run] [--out <dir>] [--allow-dirty]
//
// Спека: {about, class, render?, common?, items: [{key, brief, context: {text?, bg?, crop:
// {fixture, scene, open?, ids: [...], textures?, pad?, scale?}}}]}. Класс (screenPx,
// sourcePx, palette, colors) — из таблицы классов docs/design/graphics.md и sprites.json;
// профиль — снимок graphics.md под класс плюс common задания, ≤ 4000 знаков, version —
// graphics@<коммит graphics.md>. Кроп контекста каждого ключа снимается со своей копии
// игры (self-serve на QA_PORT, default 4197, client/dist собран заранее): фикстура, сцена,
// open (itd.click), рамка — узлы ids из itd.nodes() плюс картинки сцены с ключом текстуры
// под textures, поле pad (24) мировых px, зум scale ('1.4'); красные рамки ?debug=1 сняты.
//
// --dry-run: в minipc ничего не уходит, токен не нужен; печать тела с кропами вместо base64
// (размер и sha256), кропы и тело — в <out> (по умолчанию client/.qa/sprite-job/<about>/).
// Настоящий прогон: POST /jobs токеном координатора (lib/minipc-client.mjs, minipcFromEnv),
// проверка, что все ключи open, запись <спека>.task.json рядом со спекой — taskId для
// qa:sprite и sprite:take. Запись уже есть — отказ: одно задание на спеку. graphics.md или
// sprites.json с правками без коммита — отказ (профиль не совпал бы с version);
// --allow-dirty — только для прогонов против заглушки, version получает «+dirty».
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'
import { chromePath } from './lib/chrome.mjs'
import { createJob, describeSource, jobItems, minipcFromEnv } from './lib/minipc-client.mjs'
import { openStep, PLACE_OF_IDS } from './lib/scene-step.mjs'
import { selfServe } from './lib/selfserve.mjs'
import { buildProfile, classFromDocs, jobPayload, payloadForPrint, validateSpec } from './lib/sprite-job-core.mjs'

const CLIENT = dirname(dirname(fileURLToPath(import.meta.url)))
const ROOT = join(CLIENT, '..')
const GRAPHICS = join(ROOT, 'docs', 'design', 'graphics.md')
const MANIFEST = join(CLIENT, 'src', 'assets', 'sprites.json')
const MAX_CROP = 2 * 1024 * 1024

function arg(name) {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}
function die(msg) {
  console.error(`SPRITE-JOB FAIL: ${msg}`)
  process.exit(1)
}
const sha256 = (b) => createHash('sha256').update(b).digest('hex')
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim()

const DRY = process.argv.includes('--dry-run')
const ALLOW_DIRTY = process.argv.includes('--allow-dirty')
const SPEC_ARG = arg('--spec')
if (!SPEC_ARG) die('нужен --spec <путь к спеке задания>, например scripts/sprites/minipc/jobs/ITGAME-134.json')
const SPEC = isAbsolute(SPEC_ARG) ? SPEC_ARG : existsSync(join(process.cwd(), SPEC_ARG)) ? join(process.cwd(), SPEC_ARG) : join(ROOT, SPEC_ARG)
if (!existsSync(SPEC)) die(`нет спеки ${SPEC_ARG}`)
const RECORD = SPEC.replace(/\.json$/, '') + '.task.json'
const PORT = Number(process.env.QA_PORT || 4197)

const specBytes = readFileSync(SPEC)
let spec
try {
  spec = JSON.parse(specBytes.toString())
} catch (e) {
  die(`${relative(ROOT, SPEC)} — не JSON: ${e.message}`)
}
const fixtures = readdirSync(join(ROOT, 'server', 'internal', 'game', 'fixtures')).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort()
const scenes = []
for (const f of readdirSync(join(CLIENT, 'src', 'scenes')).filter((f) => f.endsWith('.ts'))) {
  for (const m of readFileSync(join(CLIENT, 'src', 'scenes', f), 'utf8').matchAll(/super\(\{\s*key:\s*'(\w+)'/g)) scenes.push(m[1])
}
try {
  validateSpec(spec, { fixtures, scenes: scenes.sort() })
} catch (e) {
  die(e.message)
}
if (!DRY && existsSync(RECORD)) {
  const prev = JSON.parse(readFileSync(RECORD, 'utf8'))
  die(`по ${relative(ROOT, SPEC)} задание уже заведено — taskId ${prev.taskId} (${relative(ROOT, RECORD)}); второе задание по той же спеке — уберите запись осознанно`)
}

const graphicsMd = readFileSync(GRAPHICS, 'utf8')
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
let cls
try {
  cls = classFromDocs(graphicsMd, manifest, spec.class, spec.render)
} catch (e) {
  die(e.message)
}
// Снимок должен совпадать с коммитом из version: правка graphics.md или sprites.json без
// коммита дала бы профиль, которого в репо нет.
const dirty = git('status', '--porcelain', '--', relative(ROOT, GRAPHICS), relative(ROOT, MANIFEST))
if (dirty && !DRY && !ALLOW_DIRTY) die(`graphics.md или sprites.json изменены без коммита — профиль не совпал бы с version:\n${dirty}`)
const version = `graphics@${git('log', '-1', '--format=%h', '--', relative(ROOT, GRAPHICS))}${dirty ? '+dirty' : ''}`
let profile
try {
  profile = buildProfile(graphicsMd, cls, { version, about: spec.about, common: spec.common })
} catch (e) {
  die(e.message)
}
for (const it of spec.items) {
  if (!manifest.sprites[it.key]) console.warn(`SPRITE-JOB: ${it.key} нет в sprites.json — pull/watch и qa:sprite его не возьмут, пока сторона игры не заведёт ключ (место в сцене, запись, PNG)`)
}

// Кропы мест — своей копией игры.
const OUT = arg('--out') ?? join(CLIENT, '.qa', 'sprite-job', spec.about)
mkdirSync(OUT, { recursive: true })
const crops = {}
const withCrop = spec.items.filter((it) => it.context?.crop)
if (withCrop.length) {
  let stopServer = async () => {}
  let base
  try {
    ;({ base, stop: stopServer } = await selfServe({ port: PORT, saves: 'off', label: 'SPRITE-JOB' }))
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  }
  const browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    defaultViewport: { width: 1920, height: 1080 },
  })
  try {
    for (const it of withCrop) {
      const c = it.context.crop
      const { page, errors } = await openStep(browser, base, c, c.scale ?? '1.4', `spritejob-${it.key}-${Date.now().toString(36)}`, { frames: false })
      try {
        const place = await page.evaluate(PLACE_OF_IDS, [c.scene, c.ids, c.textures ?? null, c.pad ?? 24])
        if (place.missing.length) throw new Error(`${it.key}: на сцене ${c.scene} (фикстура ${c.fixture}${c.open ? `, open ${c.open}` : ''}) нет ${place.missing.join(', ')}`)
        const png = Buffer.from(await page.screenshot({ clip: place.css }))
        if (png.length > MAX_CROP) throw new Error(`${it.key}: кроп ${png.length} байт > 2 MiB`)
        if (errors.length) throw new Error(`${it.key}: ошибки страницы: ${errors.join(' | ')}`)
        crops[it.key] = png
        writeFileSync(join(OUT, `${it.key}.png`), png)
        console.log(`crop ${it.key}: ${c.fixture}/${c.scene}${c.open ? ` +${c.open}` : ''} [${c.ids.join(', ')}${place.textured.length ? ` + ${place.textured.join(', ')}` : ''}] → ${Math.round(place.css.width)}×${Math.round(place.css.height)} px, ${png.length} байт`)
      } finally {
        await page.close()
      }
    }
  } catch (e) {
    die(e instanceof Error ? e.message : String(e))
  } finally {
    await browser.close()
    await stopServer()
  }
}

const payload = jobPayload(spec, cls, profile, crops)
const printable = payloadForPrint(payload)
writeFileSync(join(OUT, 'payload.json'), JSON.stringify(printable, null, 2) + '\n')
writeFileSync(join(OUT, 'profile.txt'), profile.text + '\n')
if (DRY) {
  console.log(JSON.stringify(printable, null, 2))
  console.log(`\nSPRITE-JOB --dry-run: ${spec.items.length} ключ., профиль ${profile.version} (${profile.text.length} знаков), кропы и тело — ${relative(ROOT, OUT)}; в minipc ничего не ушло`)
  process.exit(0)
}

let mp
try {
  mp = minipcFromEnv()
} catch (e) {
  die(e.message)
}
console.log(describeSource(mp))
const job = await createJob(mp, payload).catch((e) => die(e.message))
const got = jobItems(job)
const notOpen = spec.items.filter((it) => got.find((g) => g.key === it.key)?.status !== 'open').map((it) => it.key)
const record = {
  taskId: job.taskId,
  about: job.about ?? spec.about,
  createdAt: job.created_at ?? null,
  spec: relative(ROOT, SPEC),
  specSha256: sha256(specBytes),
  profile: { version: profile.version, sha256: profile.sha256 },
  class: payload.class.name,
  keys: got.map((g) => ({ key: g.key, status: g.status })),
  crops: Object.fromEntries(Object.entries(crops).map(([k, b]) => [k, { bytes: b.length, sha256: sha256(b) }])),
}
writeFileSync(RECORD, JSON.stringify(record, null, 2) + '\n')
console.log(`SPRITE-JOB: задание ${job.taskId} (${record.about}) заведено, ключей ${got.length}; запись — ${relative(ROOT, RECORD)}`)
if (notOpen.length || got.length !== spec.items.length) {
  die(`задание ${job.taskId} заведено, но ключи не те: ждали ${spec.items.length} open, не open — ${notOpen.join(', ') || '—'}, всего ${got.length}`)
}
