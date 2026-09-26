// visreg — регресс-скриншоты и линт вёрстки по сценариям (ITGAME-27).
//
//   npm run visreg              # сравнение с эталонами (падает на регрессии)
//   npm run visreg -- --update  # обновить эталоны (коммитить вместе с правками)
//   BASE_URL=http://localhost:5173 npm run visreg   # против dev-сервера
//
// По каждому сценарию (?scenario=X&seed=1&debug=1): старт из меню → пауза →
// quiet() → скриншот канваса → пиксельный diff с эталоном (pixelmatch) +
// линтер вёрстки itd.overlaps/offscreen/contrast/tiny — падает, если стало
// ХУЖЕ эталона (известные проблемы ITGAME-16 живут в бейзлайне до их
// отдельного фикса). Эталоны: scripts/visreg/baseline.json + shots/*.png.
//
// Self-serve: без BASE_URL поднимает Go-сервер на :4173 (VISREG_PORT
// переопределяет порт — static+ws+api из client/dist) — как прод, одним
// процессом; бинарь собирает сама (go в PATH). Общий self-serve —
// client/scripts/lib/selfserve.mjs (проверка порта/dist до spawn).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'
import puppeteer from 'puppeteer-core'
import { selfServe } from './lib/selfserve.mjs'

const CLIENT_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const VISREG_DIR = join(CLIENT_DIR, 'scripts', 'visreg')
const SHOTS_DIR = join(VISREG_DIR, 'shots')
const BASELINE = join(VISREG_DIR, 'baseline.json')
const SELF_PORT = Number(process.env.VISREG_PORT) || 4173
const UPDATE = process.argv.includes('--update')

// Сценарии = фикстуры ITGAME-26 + меню без сценария.
const SCENARIOS = ['menu', 'fresh', 'broke_day3', 'mid_day10', 'full_office', 'soft_lock', 'pre_victory']

function chromePath() {
  const cands = [
    process.env.CHROME_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable',
  ].filter((p) => !!p)
  const found = cands.find((p) => existsSync(p))
  if (!found) {
    console.error('VISREG FAIL: chromium не найден — задайте CHROME_PATH')
    process.exit(1)
  }
  return found
}

// ── Загрузка сцены: детерминированное состояние для скриншота ─────────────
// window.itd появляется раньше, чем меню создаст кнопки: клик в этот зазор
// молча промахивался (id не найден), и прогон висел 20с на connected.
async function waitMenuReady(page) {
  await page.waitForFunction(
    () => window.itd != null && window.itd.ids().some((n) => n.id === 'menu.diff.normal'),
    { timeout: 20000 },
  )
}

async function loadScenario(page, base, name) {
  if (name === 'menu') {
    await page.goto(`${base}/?debug=1`)
    await waitMenuReady(page)
    await delay(400) // логотип/кнопки устаканились
    return
  }
  await page.goto(`${base}/?scenario=${name}&seed=1&debug=1`)
  await waitMenuReady(page)
  // уникальный sid на прогон: серверные сейвы живут 24ч и резюмятся
  await page.evaluate((sc) => localStorage.setItem('itd.sid', 'visreg-' + sc + '-' + Date.now().toString(36)), name)
  const clicked = await page.evaluate(() => window.itd.click('menu.diff.normal'))
  if (!clicked.ok) throw new Error(`${name}: клик menu.diff.normal не прошёл — ${clicked.error}`)
  await page.waitForFunction(() => window.itd.state().connected === true, { timeout: 20000 })
  await page.evaluate(() => window.itd.pause()) // время не меняет кадр
  await delay(500) // перерисовки после снапшота
  await page.evaluate(() => window.itd.quiet()) // твиины/мигания замерли
  await delay(200)
}

// Линт вёрстки: считаем нарушения каждого рода.
async function lintCounts(page) {
  return page.evaluate(() => ({
    overlaps: window.itd.overlaps().length,
    offscreen: window.itd.offscreen().length,
    contrast: window.itd.contrast().length,
    tiny: window.itd.tiny().length,
  }))
}

// Пиксельный diff двух PNG; null если эталона нет (первый прогон).
function diffPixels(actual, referencePath) {
  if (!existsSync(referencePath)) return null
  const ref = PNG.sync.read(readFileSync(referencePath))
  // puppeteer 25 возвращает Uint8Array, pngjs ждёт Buffer
  const act = PNG.sync.read(Buffer.from(actual))
  if (ref.width !== act.width || ref.height !== act.height) {
    return { pixels: Math.max(ref.width * ref.height, act.width * act.height), total: 1 } // размер изменился = регрессия
  }
  const diff = new PNG({ width: ref.width, height: ref.height })
  const pixels = pixelmatch(ref.data, act.data, diff.data, ref.width, ref.height, { threshold: 0.1 })
  return { pixels, total: ref.width * ref.height }
}

const results = []
function report(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const base = process.env.BASE_URL || `http://127.0.0.1:${SELF_PORT}`
async function newBrowser() {
  return puppeteer.launch({ executablePath: chromePath(), args: ['--no-sandbox', '--disable-dev-shm-usage'] })
}
let stopServer = null
if (!process.env.BASE_URL) {
  try {
    ;({ stop: stopServer } = await selfServe({ port: SELF_PORT, saves: 'off', label: 'VISREG' }))
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  }
}
try {
  if (UPDATE) mkdirSync(SHOTS_DIR, { recursive: true })
  const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {}

  for (const sc of SCENARIOS) {
    // Браузер НА сценарий: software-WebGL контексты не утекают между
    // страницами (6-й подряд в одном браузере умирает от stalls).
    const browser = await newBrowser()
    const page = await browser.newPage()
    await page.setViewport({ width: 1920, height: 1080 })
    page.on('pageerror', (e) => report(`${sc}: ошибка страницы`, false, e.message))
    if (process.env.VISREG_DEBUG) {
      page.on('console', (m) => console.log(`   [${sc} cons]`, m.type(), m.text().slice(0, 100)))
      page.on('requestfailed', (r) => console.log(`   [${sc} reqfail]`, r.url().slice(-60), r.failure()?.errorText))
    }
    try {
      await loadScenario(page, base, sc)

      // линт: не хуже эталона (известные находки ITGAME-16 живут в бейзлайне)
    const lint = await lintCounts(page)
    const ref = baseline[sc]?.lint
    if (UPDATE) {
      baseline[sc] = { lint }
    } else if (ref) {
      for (const k of ['overlaps', 'offscreen', 'contrast', 'tiny']) {
        if (lint[k] > ref[k]) {
          report(`${sc}: вёрстка хуже эталона (${k}: ${lint[k]} > ${ref[k]})`, false)
        }
      }
    }

    // скриншот канваса (не страницы: topbar/html — вне регрессий игры)
    const canvas = await page.$('canvas')
    if (!canvas) {
      report(`${sc}: канвас не найден`, false)
      await page.close()
      continue
    }
    const shot = await canvas.screenshot({ type: 'png' })
    const shotPath = join(SHOTS_DIR, `${sc}.png`)
    if (UPDATE) {
      writeFileSync(shotPath, shot)
      report(`${sc}: эталон обновлён`, true, JSON.stringify(lint))
    } else {
      const d = diffPixels(shot, shotPath)
      if (d === null) {
        report(`${sc}: нет эталона ${shotPath}`, false, 'запустите npm run visreg -- --update')
      } else {
        const pct = ((d.pixels / d.total) * 100).toFixed(3)
        report(`${sc}: пиксельный diff ${pct}%`, d.pixels / d.total <= 0.005, `${d.pixels} px (${pct}%)`)
      }
    }
    } finally {
      // браузер гасится при ЛЮБОМ исходе сценария: упавший по таймауту
      // прогон без этого оставлял зомби-хромы (до сотни процессов)
      await page.close().catch(() => {})
      await browser.close()
    }
  }
  if (UPDATE) writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + '\n')
} finally {
  if (stopServer) await stopServer()
}

const failed = results.filter((r) => !r.ok)
console.log(failed.length === 0 ? '\nVISREG OK — регрессий нет' : `\nVISREG FAIL — ${failed.length}`)
process.exit(failed.length === 0 ? 0 : 1)
