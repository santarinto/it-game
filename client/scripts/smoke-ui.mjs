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
  // Вьюпорт больше канваса: дефолтный зум UI 1.4× (ITGAME-15) разворачивает
  // канвас до 1792×1008 и на 1280×720 не влезает.
  await page.setViewport({ width: 1920, height: 1080 })
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
      return { x: r.x, y: r.y, k: r.width / 1280 } // k: CSS-зум канваса (ITGAME-15)
    })
    // Кнопка «НОРМА» — вторая в колонке уровней, центр (640, 336) в координатах канваса.
    await page.mouse.click(box.x + 640 * box.k, box.y + 336 * box.k)
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

    // Рендер 2× (render.ts): itd.click() и itd.hover() обходят Phaser-хиттест
    // (шлют события напрямую по id), так что камера со scroll/zoom (render.ts,
    // HIRES_CAMERA) ими не проверяется — нужен РЕАЛЬНЫЙ курсор мыши, который
    // идёт через настоящий Phaser input и трансформацию камеры. Проверяем на
    // зумах 1× и 2× (localStorage 'itd.uiScale', см. uiscale.ts ZOOM_KEY):
    // (а) наведение на office.worker.0 показывает тултип, (б) клик по
    // btn.zoom меняет CSS-ширину канваса, (в) клик по nav.serverRoom
    // переключает активную сцену. window.itd в проде требует ?debug=1.
    const debugUrl = url + (url.includes('?') ? '&' : '?') + 'debug=1'
    const canvasBox = () => page.evaluate(() => {
      const c = document.querySelector('canvas')
      const r = c.getBoundingClientRect()
      return { x: r.x, y: r.y, k: r.width / 1280 }
    })
    for (const z of [1, 2]) {
      await page.goto(debugUrl, { waitUntil: 'load' })
      // localStorage И sessionStorage — hasSavedSession() (net.ts) читает оба
      // ключа SID_KEY; без sessionStorage.clear() второй проход (второй zoom)
      // видит «сохранённую» сессию с первого прохода, меню показывает
      // «ПРОДОЛЖИТЬ» и сдвигает кнопки сложности вниз — клик по (640,336) мимо.
      await page.evaluate((zz) => {
        localStorage.clear()
        sessionStorage.clear()
        localStorage.setItem('itd.uiScale', String(zz))
      }, z)
      await page.reload({ waitUntil: 'load' })
      await page.waitForFunction(
        `window.itd && window.itd.ids().some((n) => n.id === 'menu.diff.normal')`,
        { timeout: 20_000 },
      )
      await page.evaluate(() => localStorage.setItem('itd.sid', 'smoke-render2x-' + Date.now().toString(36)))
      let box = await canvasBox()
      await page.mouse.click(box.x + 640 * box.k, box.y + 336 * box.k)
      await page.waitForFunction(`window.__itd && window.__itd.scene.isActive('office')`, { timeout: 20_000 })
      await delay(500)

      // Свежая сессия — офис пуст; itd.cmd() тут не проверка ввода, а
      // подготовка фикстуры (нанять кого-то в слот 0 для реального hover).
      let nodes = await page.evaluate(() => window.itd.nodes())
      if (!nodes.some((n) => n.id === 'office.worker.0')) {
        await page.evaluate(() => window.itd.cmd('hire'))
        await delay(400)
        nodes = await page.evaluate(() => window.itd.nodes())
      }
      const worker0 = nodes.find((n) => n.id === 'office.worker.0')
      if (!worker0) {
        console.error(`SMOKE-UI FAIL (z=${z}): office.worker.0 не появился после hire`)
        process.exit(1)
      }

      // (а) реальный hover мышью по office.worker.0 — тултип виден.
      box = await canvasBox()
      await page.mouse.move(box.x + worker0.x * box.k, box.y + worker0.y * box.k)
      await delay(200)
      const tooltipVisible = await page.evaluate(() => {
        const scene = window.__itd.scene.getScene('office')
        const c = scene.children.list.find((o) => o.type === 'Container')
        return c ? c.visible : null
      })
      if (tooltipVisible !== true) {
        console.error(`SMOKE-UI FAIL (z=${z}): реальный hover по office.worker.0 не показал тултип`)
        process.exit(1)
      }

      // (б) реальный клик по btn.zoom — CSS-ширина канваса меняется.
      const zoomNode = nodes.find((n) => n.id === 'btn.zoom')
      const cssWBefore = box.k * 1280
      await page.mouse.click(box.x + (zoomNode.x + zoomNode.w / 2) * box.k, box.y + (zoomNode.y + zoomNode.h / 2) * box.k)
      await delay(200)
      const cssWAfter = await page.evaluate(() => document.querySelector('canvas').getBoundingClientRect().width)
      if (cssWAfter === cssWBefore) {
        console.error(`SMOKE-UI FAIL (z=${z}): реальный клик по btn.zoom не изменил CSS-ширину канваса`)
        process.exit(1)
      }

      // (в) реальный клик по nav.serverRoom — активна сцена serverRoom
      // (клик по btn.zoom поменял CSS-размер канваса — box пересчитываем).
      box = await canvasBox()
      nodes = await page.evaluate(() => window.itd.nodes())
      const navSrv = nodes.find((n) => n.id === 'nav.serverRoom')
      await page.mouse.click(box.x + (navSrv.x + navSrv.w / 2) * box.k, box.y + (navSrv.y + navSrv.h / 2) * box.k)
      await delay(300)
      const srvActive = await page.evaluate(() => window.__itd.scene.isActive('serverRoom'))
      if (srvActive !== true) {
        console.error(`SMOKE-UI FAIL (z=${z}): реальный клик по nav.serverRoom не переключил сцену`)
        process.exit(1)
      }

      if (errors.length > 0) {
        console.error(`SMOKE-UI FAIL (z=${z}): консоль не чистая после проверки ввода через камеру:`)
        for (const e of errors) console.error('  ', e)
        process.exit(1)
      }
      console.log(`SMOKE-UI OK — ввод мышью через камеру (zoom=${z}): hover office.worker.0, клик btn.zoom, клик nav.serverRoom`)
    }
  }
} finally {
  await browser.close()
  if (preview?.pid) {
    // npx мог пересобрать процесс-группу иначе — гасим без истерик.
    try { process.kill(-preview.pid, 'SIGTERM') } catch { /* уже мёртв */ }
    try { preview.kill('SIGTERM') } catch { /* уже мёртв */ }
  }
}
