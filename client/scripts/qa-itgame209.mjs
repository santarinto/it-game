// qa-itgame209 — itd.sprite.place/unplace (ITGAME-209, пилот изометрии): картинка ключа
// манифеста поверх сцены без места в раскладке, сетка клеток 2:1, примерка try поверх.
// Self-serve: без QA_BASE поднимает Go-сервер на QA_PORT (default 4209) поверх
// client/dist + bin/itdirector (npm run build — заранее). QA_SHOT=<png> — кадр сцены.
import puppeteer from 'puppeteer-core'
import { chromePath } from './lib/chrome.mjs'
import { selfServe } from './lib/selfserve.mjs'
import { waitMenuReady } from './lib/menu.mjs'

const SELF_PORT = Number(process.env.QA_PORT || 4209)
const BASE = process.env.QA_BASE || `http://127.0.0.1:${SELF_PORT}`

const results = []
function check(name, pass, fact) {
  results.push({ name, pass, fact })
  console.log(`${pass ? 'PASS' : 'FAIL'}: ${name}${fact !== undefined ? ` — ${JSON.stringify(fact)}` : ''}`)
}

let stopServer = async () => {}
if (!process.env.QA_BASE) {
  try {
    ;({ stop: stopServer } = await selfServe({ port: SELF_PORT, saves: 'off', label: 'QA-ITGAME209' }))
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  }
}

const browser = await puppeteer.launch({
  executablePath: chromePath(),
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 720 })
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  await page.goto(`${BASE}/?seed=1&debug=1`, { waitUntil: 'domcontentloaded' })
  await waitMenuReady(page)
  await page.evaluate(() => localStorage.setItem('itd.sid', 'qa209-' + Date.now().toString(36)))
  await page.evaluate(() => window.itd.click('menu.diff.normal'))
  await page.waitForFunction(() => window.itd.state().connected === true, { timeout: 20000 })
  await page.evaluate(() => window.itd.pause())
  await page.waitForFunction(() => window.__itd.scene.getScene('office')?.sys.isActive(), { timeout: 10000 })

  // T1: плитка сеткой 3×3 и стол в средней клетке; экранный размер — класс iso (128),
  // id в itd.nodes(), порядок глубины сзади вперёд.
  const t1 = await page.evaluate(() => {
    // Задняя клетка — мировая точка под (560, 330) экрана: камера офиса с зумом, сетка в кадре.
    const at = window.__itd.scene.getScene('office').cameras.main.getWorldPoint(560, 330)
    const floor = window.itd.sprite.place('iso_floor_office', { x: at.x, y: at.y, grid: [3, 3] })
    const desk = window.itd.sprite.place('iso_desk_crt', { x: at.x, y: at.y + 64 })
    const ids = new Set(window.itd.nodes().map((n) => n.id))
    const scene = window.__itd.scene.getScene('office')
    const imgs = scene.children.list.filter((o) => String(o.getData?.('id') ?? '').startsWith('pilot.'))
    const depths = imgs.map((o) => o.depth)
    return {
      floor, desk, n: imgs.length,
      inNodes: [...floor.ids, ...desk.ids].every((id) => ids.has(id)),
      origin: imgs.map((o) => o.originY),
      deskOnTop: Math.max(...depths.slice(0, 9)) < depths[9],
    }
  })
  check('T1: place плитки 3×3 — 9 картинок 128×128 на сцене office', t1.floor.ok && t1.floor.ids.length === 9 && t1.floor.displayW === 128 && t1.floor.displayH === 128, t1.floor)
  check('T1: стол в средней клетке — поверх плиток, якорь iso (originY 0.75), id в itd.nodes()', t1.desk.ok && t1.n === 10 && t1.deskOnTop && t1.origin.every((y) => y === 0.75) && t1.inNodes, t1)

  if (process.env.QA_SHOT) await page.screenshot({ path: process.env.QA_SHOT })

  // T2: try по ключу перевешивает и положенные картинки, размер держится.
  const t2 = await page.evaluate(async () => {
    const c = document.createElement('canvas')
    c.width = 256
    c.height = 256
    const ctx = c.getContext('2d')
    ctx.fillStyle = '#41a6f6'
    ctx.beginPath()
    ctx.moveTo(128, 128)
    ctx.lineTo(256, 192)
    ctx.lineTo(128, 256)
    ctx.lineTo(0, 192)
    ctx.fill()
    const r = await window.itd.sprite.try('iso_floor_office', c.toDataURL('image/png'))
    const scene = window.__itd.scene.getScene('office')
    const sizes = scene.children.list
      .filter((o) => o.texture?.key === 'iso_floor_office')
      .map((o) => [Math.round(o.displayWidth), Math.round(o.displayHeight)])
    window.itd.sprite.reset('iso_floor_office')
    return { ok: r.ok, objects: r.objects, sizes }
  })
  check('T2: try(iso_floor_office) перевешивает все 9 плиток, 128×128 держится', t2.ok && t2.objects === 9 && t2.sizes.every(([w, h]) => w === 128 && h === 128), t2)

  // T3: отказы и unplace.
  const t3 = await page.evaluate(() => ({
    key: window.itd.sprite.place('no_such_key', { x: 0, y: 0 }).code,
    scene: window.itd.sprite.place('iso_desk_crt', { x: 0, y: 0, scene: 'nope' }).code,
    grid: window.itd.sprite.place('iso_desk_crt', { x: 0, y: 0, grid: [0, 2] }).code,
    xy: window.itd.sprite.place('iso_desk_crt', { x: Number.NaN, y: 0 }).code,
    un: window.itd.sprite.unplace(),
    left: window.__itd.scene.getScene('office').children.list.filter((o) => String(o.getData?.('id') ?? '').startsWith('pilot.')).length,
    again: window.itd.sprite.unplace().removed,
  }))
  check('T3: отказы unknown_key, bad_scene, bad_place (grid, NaN)', t3.key === 'unknown_key' && t3.scene === 'bad_scene' && t3.grid === 'bad_place' && t3.xy === 'bad_place', t3)
  check('T3: unplace убирает все 10, повтор — 0', t3.un.ok && t3.un.removed === 10 && t3.left === 0 && t3.again === 0, t3)
  check('нет ошибок страницы', pageErrors.length === 0, pageErrors)
} finally {
  await browser.close()
  await stopServer()
}

const failed = results.filter((r) => !r.pass)
console.log(`\nQA-ITGAME209: ${results.length - failed.length}/${results.length} PASS`)
process.exit(failed.length ? 1 : 0)
