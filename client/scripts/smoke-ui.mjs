// UI-смоук релиза (ITGAME-11): headless-Chromium открывает страницу,
// ждёт старта сцены menu и падает на ЛЮБОЙ ошибке консоли/страницы.
// Инцидент-обоснование: подмена текстур в boot валила create() молча —
// чёрный экран был неотличим от загрузки, релиз уехал непроверенным.
//
// Запуск из client/:
//   npm run smoke-ui                      # собрать и проверить dist
//   npm run smoke-ui -- https://…         # проверить живой URL (напр., прод)
//   OFFICE=1 npm run smoke-ui [-- URL]    # + клик «НОРМА» и сцена office
//                                          # (нужен живой WS за URL)
// Браузер: CHROME_PATH, иначе /usr/bin/chromium, /usr/bin/google-chrome-stable.
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const CLIENT_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const DEFAULT_URL = 'http://localhost:4173'
const url = process.argv[2] || DEFAULT_URL

function chromePath() {
  const cands = [
    process.env.CHROME_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable',
  ].filter((p) => !!p)
  const found = cands.find((p) => existsSync(p))
  if (!found) {
    console.error('SMOKE-UI FAIL: chromium не найден — задайте CHROME_PATH')
    process.exit(1)
  }
  return found
}

// Самобслуживание: без URL поднимаем vite preview над dist и сами гасим.
let preview = null
async function selfServe() {
  preview = spawn('npx', ['vite', 'preview', '--port', '4173', '--strictPort'], {
    cwd: CLIENT_DIR,
    stdio: 'ignore',
    detached: true,
  })
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(DEFAULT_URL)
      if (r.ok) return
    } catch {
      // сервер ещё поднимается
    }
    await delay(500)
  }
  console.error('SMOKE-UI FAIL: vite preview не поднялся за 30с')
  process.exit(1)
}

const browser = await puppeteer.launch({
  executablePath: chromePath(),
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
try {
  if (url === DEFAULT_URL && !process.argv[2]) await selfServe()

  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 720 })
  const errors = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`HTTP ${r.status()}: ${r.url()}`)
  })

  // Короткие ретраи goto: preview/сеть могут подниматься дольше захода.
  let opened = false
  for (let i = 0; i < 10 && !opened; i++) {
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 10_000 })
      opened = true
    } catch {
      await delay(1000)
    }
  }
  if (!opened) {
    console.error(`SMOKE-UI FAIL: страница ${url} не открылась`)
    process.exit(1)
  }

  // menu стартовала? Хук window.__itd ставит main.ts.
  try {
    await page.waitForFunction(`window.__itd && window.__itd.scene.isActive('menu')`, {
      timeout: 20_000,
    })
  } catch {
    await page.screenshot({ path: join(CLIENT_DIR, 'smoke-menu.png') })
    console.error('SMOKE-UI FAIL: сцена menu не стартовала за 20с (скриншот client/smoke-menu.png)')
    for (const e of errors) console.error('  console:', e)
    process.exit(1)
  }
  await page.screenshot({ path: join(CLIENT_DIR, 'smoke-menu.png') })

  if (errors.length > 0) {
    console.error('SMOKE-UI FAIL: сцена menu стартовала, но консоль не чистая:')
    for (const e of errors) console.error('  ', e)
    process.exit(1)
  }
  console.log(`SMOKE-UI OK — ${url}: сцена menu стартовала, консоль чистая (скриншот client/smoke-menu.png)`)

  // Режим OFFICE=1 (инцидент ITGAME-12): клик по «НОРМА», сцена office
  // стартует, спрайты рисуются, консоль по-прежнему чистая. Нужен живой
  // WS-сервер за проверяемым URL (локально: go run ./cmd/server + proxy).
  if (process.env.OFFICE === '1') {
    const box = await page.evaluate(() => {
      const c = document.querySelector('canvas')
      const r = c.getBoundingClientRect()
      return { x: r.x, y: r.y }
    })
    // Кнопка «НОРМА» — вторая в колонке уровней, центр (640, 336) в координатах канваса.
    await page.mouse.click(box.x + 640, box.y + 336)
    try {
      await page.waitForFunction(`window.__itd && window.__itd.scene.isActive('office')`, {
        timeout: 20_000,
      })
    } catch {
      await page.screenshot({ path: join(CLIENT_DIR, 'smoke-office.png') })
      console.error('SMOKE-UI FAIL: сцена office не стартовала за 20с после клика')
      for (const e of errors) console.error('  console:', e)
      process.exit(1)
    }
    await delay(4000) // пара снапшотов — офис успевает отрисоваться
    await page.screenshot({ path: join(CLIENT_DIR, 'smoke-office.png') })
    if (errors.length > 0) {
      console.error('SMOKE-UI FAIL: в игре консоль не чистая:')
      for (const e of errors) console.error('  ', e)
      process.exit(1)
    }
    console.log('SMOKE-UI OK — сцена office стартовала, консоль чистая (скриншот client/smoke-office.png)')
  }
} finally {
  await browser.close()
  if (preview?.pid) {
    // npx мог пересобрать процесс-группу иначе — гасим без истерик.
    try { process.kill(-preview.pid, 'SIGTERM') } catch { /* уже мёртв */ }
    try { preview.kill('SIGTERM') } catch { /* уже мёртв */ }
  }
}
