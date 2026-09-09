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
// Self-serve: без BASE_URL поднимает Go-сервер на :4173 (static+ws+api из
// client/dist) — как прод, одним процессом; бинаррь собирает сама (go в PATH).
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'
import puppeteer from 'puppeteer-core'

const CLIENT_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const VISREG_DIR = join(CLIENT_DIR, 'scripts', 'visreg')
const SHOTS_DIR = join(VISREG_DIR, 'shots')
const BASELINE = join(VISREG_DIR, 'baseline.json')
const SELF_PORT = 4173
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

// ── Self-serve: Go раздаёт dist и держит /ws + /api одним процессом ───────
let server = null
async function selfServe() {
  const dist = join(CLIENT_DIR, 'dist')
  if (!existsSync(join(dist, 'index.html'))) {
    console.error('VISREG FAIL: нет client/dist — сначала npm run build')
    process.exit(1)
  }
  const bin = join(CLIENT_DIR, '..', 'bin', 'itdirector')
  if (!existsSync(bin)) {
    execFileSync('go', ['build', '-o', bin, './cmd/server'], {
      cwd: join(CLIENT_DIR, '..', 'server'),
      stdio: 'inherit',
    })
  }
  server = spawn(bin, ['-addr', `127.0.0.1:${SELF_PORT}`, '-static', dist, '-saves', 'off'], {
    stdio: 'ignore',
  })
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${SELF_PORT}/admin`)
      if (r.ok) return
      r.body.cancel()
    } catch {
      // поднимается
    }
    await delay(250)
  }
  console.error('VISREG FAIL: Go-сервер не поднялся на :' + SELF_PORT)
  process.exit(1)
}

// ── Загрузка сцены: детерминированное состояние для скриншота ─────────────
async function loadScenario(page, base, name) {
  if (name === 'menu') {
    await page.goto(`${base}/?debug=1`)
    await page.waitForFunction(() => window.itd != null, { timeout: 20000 })
    await delay(400) // логотип/кнопки устаканились
    return
  }
  await page.goto(`${base}/?scenario=${name}&seed=1&debug=1`)
  await page.waitForFunction(() => window.itd != null, { timeout: 20000 })
  // уникальный sid на прогон: серверные сейвы живут 24ч и резюмятся
  await page.evaluate((sc) => localStorage.setItem('itd.sid', 'visreg-' + sc + '-' + Date.now().toString(36)), name)
  await page.evaluate(() => window.itd.click('menu.diff.normal'))
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
try {
  if (!process.env.BASE_URL) await selfServe()
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
  if (server) server.kill('SIGKILL')
}

const failed = results.filter((r) => !r.ok)
console.log(failed.length === 0 ? '\nVISREG OK — регрессий нет' : `\nVISREG FAIL — ${failed.length}`)
process.exit(failed.length === 0 ? 0 : 1)
