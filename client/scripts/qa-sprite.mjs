// qa-sprite — приёмочный прогон конвейера спрайтов (ITGAME-157, docs/design/sprite-pipeline.md,
// «Приёмочный прогон»): для каждого ключа задания minipc в статусе final ставит финальную
// ревизию во вкладку (itd.sprite.pull), проходит шаги seenIn манифеста на зуме 1× и 1.4×,
// сравнивает линтеры (contrast, tiny, overlaps, offscreen) с прогоном на исходной текстуре,
// снимает кроп места и выносит вердикт в minipc: accepted — контракт чист и новых находок
// в месте ключа нет, иначе returned с причиной и кропом.
//
//   npm run qa:sprite -- --task <id> [--key <k>] [--dry] [--out <dir>]
//
// Окружение: ITGAME_MINIPC_URL, ITGAME_MINIPC_CLI_TOKEN (вердикты); Go-серверу —
// ITGAME_MINIPC_TOKEN (без него берётся тот же токен координатора). --dry — без
// вердиктов. Отчёт: <out>/report.json (по умолчанию client/.qa/sprite/<task>/) — его
// sha256 сверяет sprite:take. Self-serve: Go-сервер на QA_PORT (default 4195) поверх
// client/dist (npm run build — заранее).
//
// Выход 0 — у каждого ключа вердикт (accepted или returned). 1 — прогон не смог
// вынести вердикт: minipc или сервер отказали, ключа нет в манифесте, нет seenIn, ключ
// не найден на сцене — это поломка нашей стороны, а не спрайта, в minipc ничего не уходит.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'
import { chromePath } from './lib/chrome.mjs'
import { waitMenuReady } from './lib/menu.mjs'
import { getJob, jobItems, minipcFromEnv, postStatus } from './lib/minipc-client.mjs'
import { selfServe } from './lib/selfserve.mjs'
import { loadManifest } from './lib/sprite-check.mjs'

const CLIENT_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const SCALES = ['1', '1.4']
const REASON_MAX = 900

function arg(name) {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}
const TASK = arg('--task')
const ONLY_KEY = arg('--key')
const DRY = process.argv.includes('--dry')
const OUT = arg('--out') ?? join(CLIENT_DIR, '.qa', 'sprite', String(TASK))
const PORT = Number(process.env.QA_PORT || 4195)

function die(msg) {
  console.error(`QA-SPRITE FAIL: ${msg}`)
  process.exit(1)
}
if (!TASK || !/^[0-9]+$/.test(TASK)) die('нужен --task <номер задания minipc>')

let mp
try {
  mp = minipcFromEnv()
} catch (e) {
  die(e.message)
}
const manifest = loadManifest(CLIENT_DIR)

const job = await getJob(mp, TASK).catch((e) => die(e.message))
const items = jobItems(job)
if (ONLY_KEY && !items.some((it) => it.key === ONLY_KEY)) die(`ключа ${ONLY_KEY} нет в задании ${TASK}`)
const targets = items.filter((it) => (!ONLY_KEY || it.key === ONLY_KEY) && it.status === 'final')
for (const it of items) {
  if ((!ONLY_KEY || it.key === ONLY_KEY) && it.status !== 'final') console.log(`skip ${it.key}: статус ${it.status} — прогон только по final`)
}
if (targets.length === 0) {
  console.log(`QA-SPRITE: в задании ${TASK} нет ключей в final — гнать нечего`)
  process.exit(0)
}
// Поломки нашей стороны — до сервера и браузера.
for (const it of targets) {
  const spec = manifest.sprites[it.key]
  if (!spec) die(`ключа ${it.key} нет в sprites.json — место в сцене и запись манифеста появляются раньше задания`)
  if (!spec.seenIn?.length) die(`у ${it.key} нет seenIn в sprites.json — прогону негде смотреть`)
  if (!Number.isInteger(it.final?.rev)) die(`у ${it.key} в final нет указателя final.rev`)
}

process.env.ITGAME_MINIPC_URL = mp.url
process.env.ITGAME_MINIPC_TOKEN = process.env.ITGAME_MINIPC_TOKEN || mp.token
let stopServer = async () => {}
let base
try {
  ;({ base, stop: stopServer } = await selfServe({ port: PORT, saves: 'off', label: 'QA-SPRITE' }))
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e)) // selfServe уже пишет «QA-SPRITE FAIL: …»
  process.exit(1)
}
mkdirSync(OUT, { recursive: true })

// Находка линтера без чисел: соседний спрайт другого размера сдвигает пересечение,
// но пара та же — новой находкой считается новая пара, а не новые пиксели. Новая
// находка идёт в вердикт, только если лежит в рамке места ключа: подмена сохраняет
// экранный размер объектов (swap), а contrast() и tiny() текстуры не видят и позиции
// не отдают — всё, что всплыло вне места (тост, плашка), шум кадра, а не спрайт.
// Он пишется в отчёт (noise) и вердикт не меняет: returned в minipc не отзывается.
const LINT = () => ({
  contrast: window.itd.contrast(),
  tiny: window.itd.tiny(),
  overlaps: window.itd.overlaps(),
  offscreen: window.itd.offscreen(),
})
function signatures(lint) {
  const out = new Map()
  for (const [linter, list] of Object.entries(lint)) {
    for (const e of list) {
      const strings = Object.fromEntries(Object.entries(e).filter(([, v]) => typeof v === 'string'))
      const where = e.at ? { x: e.at.x, y: e.at.y, w: 0, h: 0 } : e.bounds ?? null
      out.set(`${linter} ${JSON.stringify(strings)}`, { linter, ...strings, where })
    }
  }
  return out
}

// Находка в месте ключа: та же сцена и пересечение с его мировой рамкой (+4 px).
function inPlace(f, sceneKey, w) {
  if (f.scene !== sceneKey || !f.where) return false
  const m = 4
  return f.where.x <= w.x1 + m && f.where.x + f.where.w >= w.x0 - m && f.where.y <= w.y1 + m && f.where.y + f.where.h >= w.y0 - m
}

// Объекты ключа на сцене → мировая рамка (1280×720) и прямоугольник в CSS px страницы
// через рамку канваса, с полями 32 px — видны соседи места. null — ключ не нарисован.
const PLACE = ([sceneKey, key]) => {
  const game = window.__itd
  const scene = game.scene.getScene(sceneKey)
  if (!scene) return null
  const boxes = []
  const walk = (list) => {
    for (const o of list) {
      if (o.texture?.key === key && o.visible !== false) boxes.push(o.getBounds())
      if (Array.isArray(o.list)) walk(o.list)
    }
  }
  walk(scene.children.list)
  if (!boxes.length) return null
  const x0 = Math.min(...boxes.map((b) => b.x))
  const y0 = Math.min(...boxes.map((b) => b.y))
  const x1 = Math.max(...boxes.map((b) => b.right))
  const y1 = Math.max(...boxes.map((b) => b.bottom))
  const r = game.canvas.getBoundingClientRect()
  const k = r.width / 1280
  const pad = 32
  const x = Math.max(0, r.left + x0 * k - pad)
  const y = Math.max(0, r.top + y0 * k - pad)
  return {
    world: { x0, y0, x1, y1 },
    css: { x, y, width: Math.min(r.right, r.left + x1 * k + pad) - x, height: Math.min(r.bottom, r.top + y1 * k + pad) - y },
    objects: boxes.length,
  }
}

const browser = await puppeteer.launch({
  executablePath: chromePath(),
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  defaultViewport: { width: 1920, height: 1080 },
})

async function openStep(step, scale, tag) {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.evaluateOnNewDocument((v) => localStorage.setItem('itd.uiScale', v), scale)
  await page.goto(`${base}/?scenario=${step.fixture}&seed=1&debug=1`, { waitUntil: 'domcontentloaded' })
  await waitMenuReady(page)
  if (step.scene !== 'menu') {
    // Партия под своим sid: серверные сейвы живут сутки и резюмятся по общему ключу.
    await page.evaluate((t) => localStorage.setItem('itd.sid', `qasprite-${t}-${Date.now().toString(36)}`), tag)
    const clicked = await page.evaluate(() => window.itd.click('menu.diff.normal'))
    if (!clicked.ok) throw new Error(`старт партии: ${JSON.stringify(clicked)}`)
    await page.waitForFunction(() => window.itd.state().connected === true, { timeout: 20000 })
    await page.evaluate(() => window.itd.pause())
  }
  if (step.open) {
    const opened = await page.evaluate((id) => window.itd.click(id), step.open)
    if (!opened.ok) throw new Error(`seenIn.open '${step.open}': ${JSON.stringify(opened)}`)
  }
  await delay(400)
  return { page, errors }
}

const report = { taskId: TASK, about: job.about ?? null, at: new Date().toISOString(), commit: gitHead(), dry: DRY, keys: [] }
let broken = false

try {
  for (const it of targets) {
    const rev = it.final.rev
    const entry = { key: it.key, rev, sha256: null, verdict: null, problems: [], findings: [], noise: [], crops: [], posted: null, error: null }
    report.keys.push(entry)
    const findings = new Map()
    const noise = new Map()
    let receipt = null
    try {
      for (const step of manifest.sprites[it.key].seenIn) {
        for (const scale of SCALES) {
          const tag = `${it.key}-${step.fixture}-${step.scene}-${scale}`
          const { page, errors } = await openStep(step, scale, tag)
          try {
            const place0 = await page.evaluate(PLACE, [step.scene, it.key])
            if (!place0) throw new Error(`${it.key} не нарисован на сцене ${step.scene} (фикстура ${step.fixture}${step.open ? `, open ${step.open}` : ''}) — seenIn неверен`)
            const before = signatures(await page.evaluate(LINT))
            const r = await page.evaluate((t, k, n) => window.itd.sprite.pull(t, k, n), TASK, it.key, rev)
            receipt ??= r
            if (!r.ok && r.code !== 'bad_size' && r.code !== 'bad_src') throw new Error(`pull ${it.key}#${rev}: ${r.code} — ${r.error}`)
            await delay(200)
            const after = signatures(await page.evaluate(LINT))
            let fresh = 0
            for (const [sig, f] of after) {
              if (before.has(sig)) continue
              if (inPlace(f, step.scene, place0.world)) {
                findings.set(sig, { ...f, step: tag })
                fresh++
              } else noise.set(sig, { ...f, step: tag })
            }
            const place = (await page.evaluate(PLACE, [step.scene, it.key])) ?? place0
            const file = join(OUT, `${tag}.png`)
            await page.screenshot({ path: file, clip: place.css })
            entry.crops.push(relative(OUT, file))
            if (errors.length) throw new Error(`ошибки страницы: ${errors.join(' | ')}`)
            console.log(`step ${tag}: ${r.ok ? `rev ${r.rev}, контракт ${r.problems.length ? 'брак' : 'чист'}` : r.code}, новых находок в месте ${fresh}`)
          } finally {
            await page.close()
          }
        }
      }
    } catch (e) {
      entry.error = e instanceof Error ? e.message : String(e)
      broken = true
      console.error(`ERROR ${it.key}: ${entry.error}`)
      continue
    }

    entry.sha256 = receipt.sha256 ?? null
    entry.problems = receipt.ok ? receipt.problems : [`${receipt.code}: ${receipt.error}`]
    entry.findings = [...findings.values()]
    entry.noise = [...noise.values()].slice(0, 20)
    entry.verdict = entry.problems.length === 0 && entry.findings.length === 0 ? 'accepted' : 'returned'
    const reason = entry.verdict === 'accepted'
      ? `qa:sprite: контракт чист, новых находок линтеров в месте ключа нет (${entry.crops.length} кадр.)`
      : `qa:sprite: ${[...entry.problems.map((p) => `контракт — ${p}`), ...entry.findings.map((f) => `${f.linter} — ${JSON.stringify(f)}`)].join('; ')}`.slice(0, REASON_MAX)
    console.log(`${entry.verdict === 'accepted' ? 'ACCEPTED' : 'RETURNED'} ${it.key}#${rev}: ${reason}`)
    if (!DRY) {
      const body = { status: entry.verdict, reason }
      if (entry.verdict === 'returned' && entry.crops.length) {
        body.cropPng = readFileSync(join(OUT, entry.crops[0])).toString('base64')
      }
      const res = await postStatus(mp, TASK, it.key, body).catch((e) => ({ ok: false, status: 0, error: e.message }))
      entry.posted = res.ok ? entry.verdict : null
      if (!res.ok) {
        entry.error = `вердикт не принят: ${res.status} ${res.error}`
        broken = true
        console.error(`ERROR ${it.key}: ${entry.error}`)
      }
    }
  }
} finally {
  await browser.close()
  await stopServer()
}

// Отчёт сливается по ключам: прогон --key A не стирает принятый раньше B, которого
// ждёт sprite:take.
const REPORT = join(OUT, 'report.json')
if (existsSync(REPORT)) {
  try {
    const prev = JSON.parse(readFileSync(REPORT, 'utf8'))
    if (prev.taskId === TASK) report.keys = [...prev.keys.filter((k) => !report.keys.some((n) => n.key === k.key)), ...report.keys]
  } catch {
    // битый прежний отчёт — пишем новый целиком
  }
}
writeFileSync(REPORT, JSON.stringify(report, null, 2) + '\n')
console.log(`\nотчёт: ${REPORT}`)
process.exit(broken ? 1 : 0)

function gitHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: CLIENT_DIR, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}
