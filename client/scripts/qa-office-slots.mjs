// qa-office-slots — регрессия слотов офиса/серверной после единого
// манифеста ассетов: занятое место рисует РОВНО одну
// картинку (worker, без отдельного desk_pc — includesDesk), на обеде
// слот превращается в desk_pc + подпись «обед», сломанный ПК кликается
// мышью по всей зоне ремонта (не только по краям — раньше сотрудник
// перехватывал левую треть), слот шлюза серверной рисует gateway (не
// router). Стиль/selfServe — как client/scripts/qa-itgame16.mjs.
//
// Self-serve: без QA_BASE поднимает Go-сервер на QA_PORT (default 4177)
// поверх client/dist + bin/itdirector (npm run build — заранее). Общий
// self-serve — client/scripts/lib/selfserve.mjs.
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'
import { selfServe } from './lib/selfserve.mjs'

const CLIENT_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const SELF_PORT = Number(process.env.QA_PORT || 4177)
const SHOTS_DIR = process.env.QA_SHOTS_DIR || join(tmpdir(), 'qa-office-slots')
const GAME_W = 1280
const GAME_H = 720

function chromePath() {
  const cands = [
    process.env.CHROME_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable',
  ].filter((p) => !!p)
  const found = cands.find((p) => existsSync(p))
  if (!found) throw new Error('chromium не найден — задайте CHROME_PATH')
  return found
}

const BASE = process.env.QA_BASE || `http://127.0.0.1:${SELF_PORT}`

const results = []
function check(name, pass, fact) {
  results.push({ name, pass, fact })
  console.log(`${pass ? 'PASS' : 'FAIL'}: ${name}${fact ? ` — ${fact}` : ''}`)
}

// ── Загрузка сцены (см. qa-itgame16.mjs): меню → сложность → коннект → пауза ──
async function waitMenuReady(page) {
  await page.waitForFunction(
    () => window.itd != null && window.itd.ids().some((n) => n.id === 'menu.diff.normal'),
    { timeout: 20000 },
  )
}

async function loadScenario(page, scenario, sidTag) {
  await page.goto(`${BASE}/?scenario=${scenario}&seed=1&debug=1`, { waitUntil: 'domcontentloaded' })
  await waitMenuReady(page)
  // уникальный sid: серверные сейвы живут 24ч и резюмятся по общему ключу
  await page.evaluate((t) => localStorage.setItem('itd.sid', 'qaslots-' + t + '-' + Date.now().toString(36)), sidTag)
  const clicked = await page.evaluate(() => window.itd.click('menu.diff.normal'))
  if (!clicked.ok) throw new Error(`${sidTag}: клик menu.diff.normal не прошёл — ${JSON.stringify(clicked)}`)
  await page.waitForFunction(() => window.itd.state().connected === true, { timeout: 20000 })
  await page.evaluate(() => window.itd.pause()) // время не меняет кадр под курсором
  await delay(300) // первый снапшот дорисовался
}

// ── Прямой доступ к сцене (мимо itd.nodes(), которому не хватает texture.key) ──
async function dumpImages(page, sceneKey) {
  return page.evaluate((key) => {
    const scene = window.__itd.scene.getScene(key)
    if (!scene) return []
    return scene.children.list
      .filter((o) => o.type === 'Image')
      .map((o) => ({
        id: o.getData('id') ?? null,
        key: o.texture?.key ?? null,
        x: o.x,
        y: o.y,
        visible: o.visible,
        depth: o.depth ?? 0,
      }))
  }, sceneKey)
}

async function dumpTexts(page, sceneKey) {
  return page.evaluate((key) => {
    const scene = window.__itd.scene.getScene(key)
    if (!scene) return []
    return scene.children.list
      .filter((o) => o.type === 'Text' && o.visible && o.text !== '')
      .map((o) => ({ id: o.getData('id') ?? null, text: o.text, x: o.x, y: o.y }))
  }, sceneKey)
}

// ── Мир → CSS-координаты канваса (см. scripts/smoke-ui.mjs, OFFICE=1) ────────
async function canvasBox(page) {
  return page.evaluate(() => {
    const c = document.querySelector('canvas')
    const r = c.getBoundingClientRect()
    return { x: r.x, y: r.y, k: r.width / 1280 }
  })
}

async function worldClick(page, box, wx, wy) {
  await page.mouse.click(box.x + wx * box.k, box.y + wy * box.k)
}

async function shot(page, name) {
  mkdirSync(SHOTS_DIR, { recursive: true })
  const canvas = await page.$('canvas')
  const box = await canvas?.boundingBox()
  if (box) {
    await page.screenshot({ path: join(SHOTS_DIR, `${name}.png`), clip: box })
  }
}

// Восстановить save с дельтой над офисом 0 (см. probe2/qa-itgame16.mjs):
// snapshot() → правим Employees[slot] → restore({offices}) — дельта над
// текущим состоянием, остальные поля офиса/сейва не трогаем.
async function setPcBroken(page, slot, broken) {
  return page.evaluate(async (args) => {
    const { slot, broken } = args
    const snap = await window.itd.snapshot()
    const save = snap.save
    const emps = save.offices[0].Employees.map((e, i) => (i === slot ? { ...e, PCBroken: broken } : e))
    save.offices[0] = { ...save.offices[0], Employees: emps }
    await window.itd.restore({ offices: save.offices })
    return true
  }, { slot, broken })
}

async function lastOut(page, n = 8) {
  return page.evaluate((n) => window.itd.net(n).last.filter((m) => m.dir === 'out'), n)
}

// ── Кейс 1: full_office — ровно одна картинка на занятый слот ────────────────
async function caseFullOffice(browser) {
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  await page.setViewport({ width: 1920, height: 1080 })
  try {
    await loadScenario(page, 'full_office', 'full')
    const images = await dumpImages(page, 'office')
    const workers = images.filter((n) => n.id && /^office\.worker\.\d+$/.test(n.id))
    check('full_office: 12 занятых слотов рисуют office.worker.i', workers.length === 12,
      `n=${workers.length}`)
    // includesDesk=true (worker.png содержит свой стол) — слот рисует
    // ТОЛЬКО worker, никакого desk_pc/desk_empty в той же точке.
    const wrongTexture = workers.filter((w) => w.key !== 'worker')
    check('full_office: office.worker.i рисует текстуру worker', wrongTexture.length === 0,
      wrongTexture.length ? JSON.stringify(wrongTexture) : 'ok')
    const stacked = workers.filter((w) =>
      images.some((img) => img !== w && !img.id
        && Math.abs(img.x - w.x) < 1 && Math.abs(img.y - w.y) < 1
        && (img.key === 'desk_pc' || img.key === 'desk_empty')))
    check('full_office: нет desk_pc/desk_empty под office.worker.i (два стола)', stacked.length === 0,
      stacked.length ? JSON.stringify(stacked) : 'ok')
    const boss = images.find((n) => n.id === 'office.boss')
    check('full_office: office.boss рисуется текстурой boss', boss?.key === 'boss',
      boss ? `key=${boss.key}` : 'office.boss не найден')
    const overlaps = await page.evaluate(() => window.itd.overlaps())
    check('full_office: itd.overlaps() пуст', overlaps.length === 0, `n=${overlaps.length}`)
    check('full_office: нет pageerror', pageErrors.length === 0, pageErrors.join(' | '))
    await shot(page, 'full_office')
  } catch (e) {
    check('full_office: кейс выполнен без ошибок', false, e instanceof Error ? e.message : String(e))
  } finally {
    await page.close().catch(() => {})
  }
}

// ── Кейс 2: обед — слот рисует desk_pc + «обед», клик/тултип живы ───────────
async function caseLunch(browser) {
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  await page.setViewport({ width: 1920, height: 1080 })
  try {
    await loadScenario(page, 'full_office', 'lunch')
    // тик 24 — начало обеда (LunchStart=14, WorkdayStart=10, TicksPerHour=6:
    // (14-10)*6=24, см. server/internal/game/clock_test.go TestIsLunch).
    await page.evaluate(() => window.itd.set({ tickInDay: 24 }))
    await delay(300)
    const isLunch = (await page.evaluate(() => window.itd.state().lunch)) === true
    check('lunch: itd.state().lunch === true после set(tickInDay:24)', isLunch, String(isLunch))

    const images = await dumpImages(page, 'office')
    const worker0 = images.find((n) => n.id === 'office.worker.0')
    check('lunch: office.worker.0 на обеде рисует desk_pc', worker0?.key === 'desk_pc',
      worker0 ? `key=${worker0.key}` : 'office.worker.0 не найден')

    const texts = await dumpTexts(page, 'office')
    const lunchLabel = texts.find((t) => t.text === 'обед')
    check('lunch: подпись «обед» есть на слоте', !!lunchLabel, lunchLabel ? 'ok' : 'не найдена')

    // hover + чтение видимости тултипа — один evaluate: между ними не должно
    // быть await-точки, иначе случайный снапшот с сервера (render() каждый
    // раз гасит тултип) успевает погасить его раньше нашей проверки —
    // hoveredSlot восстанавливается только по РЕАЛЬНОЙ позиции курсора,
    // которую синтетический hover() не двигает.
    const hoverCheck = await page.evaluate(() => {
      const hovered = window.itd.hover('office.worker.0')
      const scene = window.__itd.scene.getScene('office')
      const c = scene.children.list.find((o) => o.type === 'Container')
      return { hovered, tooltipVisible: c ? c.visible : null }
    })
    check('lunch: itd.hover(office.worker.0) не падает', hoverCheck.hovered.ok === true, JSON.stringify(hoverCheck.hovered))
    check('lunch: тултип виден после hover', hoverCheck.tooltipVisible === true, String(hoverCheck.tooltipVisible))

    // Клик — ПОСЛЕ проверки тултипа: motivate меняет состояние сотрудника
    // и провоцирует внеочередной снапшот/рендер, что само по себе не баг,
    // но смешивать его с проверкой тултипа делает кейс мигающим.
    const clicked = await page.evaluate(() => window.itd.click('office.worker.0'))
    check('lunch: itd.click(office.worker.0) не падает', clicked.ok === true, JSON.stringify(clicked))

    check('lunch: нет pageerror', pageErrors.length === 0, pageErrors.join(' | '))
    await shot(page, 'lunch')
  } catch (e) {
    check('lunch: кейс выполнен без ошибок', false, e instanceof Error ? e.message : String(e))
  } finally {
    await page.close().catch(() => {})
  }
}

// ── Кейс 3: сломанный ПК — реальный клик мышью по всей зоне ремонта ─────────
async function caseBrokenPc(browser) {
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  await page.setViewport({ width: 1920, height: 1080 })
  try {
    await loadScenario(page, 'full_office', 'broken')
    await setPcBroken(page, 0, true)
    await delay(300)

    const repair = await page.evaluate(() => window.itd.nodes().find((n) => n.id === 'office.repair.0'))
    if (!repair) throw new Error('office.repair.0 не найден после restore(PCBroken=true)')
    const box = await canvasBox(page)
    const spots = [
      { label: 'центр', wx: repair.x, wy: repair.y },
      { label: 'левая треть', wx: repair.x - repair.w / 3, wy: repair.y },
      { label: 'правая треть', wx: repair.x + repair.w / 3, wy: repair.y },
    ]
    for (const spot of spots) {
      await worldClick(page, box, spot.wx, spot.wy)
      await delay(150)
      const out = await lastOut(page, 5)
      const last = out[out.length - 1]
      check(`broken_pc: клик по «${spot.label}» зоны ремонта шлёт repair_click`,
        last?.type === 'repair_click' && last?.info?.slot === 0,
        JSON.stringify(last))
    }
    // RepairClicksNeeded=3 (server/internal/game/commands.go) — три реальных
    // клика подряд должны полностью починить ПК (RepairClicks сбрасывается
    // в 0 вместе с PCBroken=false), а не просто накопить клики.
    const snap = await page.evaluate(() => window.itd.snapshot())
    const e = snap.save.offices[0].Employees[0]
    check('broken_pc: 3 реальных клика полностью чинят ПК', e.PCBroken === false,
      `RepairClicks=${e.RepairClicks} PCBroken=${e.PCBroken}`)

    check('broken_pc: нет pageerror', pageErrors.length === 0, pageErrors.join(' | '))
    await shot(page, 'broken_pc')
  } catch (e) {
    check('broken_pc: кейс выполнен без ошибок', false, e instanceof Error ? e.message : String(e))
  } finally {
    await page.close().catch(() => {})
  }
}

// ── Кейс 4: серверная — слот шлюза рисует gateway, не router ────────────────
async function caseServerRoomGateway(browser) {
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  await page.setViewport({ width: 1920, height: 1080 })
  try {
    await loadScenario(page, 'full_office', 'gateway')
    const hasGateway = (await page.evaluate(() => window.itd.state().gateway)) === true
    if (!hasGateway) {
      // full_office всегда покупает шлюз (см. fixtures/full_office.json),
      // но на случай смены фикстуры — докупаем через команду с квитанцией.
      const r = await page.evaluate(() => window.itd.cmd('buy_gateway'))
      check('serverRoom: buy_gateway прошёл (фикстура без шлюза)', r.ok === true, JSON.stringify(r))
      await delay(300)
    }
    await page.evaluate(() => window.itd.click('nav.serverRoom'))
    await delay(300)

    const images = await dumpImages(page, 'serverRoom')
    const gateway = images.find((n) => n.key === 'gateway')
    check('serverRoom: слот шлюза рисует текстуру gateway', !!gateway, gateway ? 'ok' : 'не найдена')
    const wrongRouter = images.some((n) => n.key === 'router')
    check('serverRoom: текстура router в слоте шлюза больше не используется', !wrongRouter,
      wrongRouter ? 'найден router в serverRoom' : 'ok')

    check('serverRoom: нет pageerror', pageErrors.length === 0, pageErrors.join(' | '))
    await shot(page, 'server_room_gateway')
  } catch (e) {
    check('serverRoom: кейс выполнен без ошибок', false, e instanceof Error ? e.message : String(e))
  } finally {
    await page.close().catch(() => {})
  }
}

// ── Главный прогон: свежий браузер на кейс (без утечек между сценариями) ────
let stopServer = null
if (!process.env.QA_BASE) {
  try {
    ;({ stop: stopServer } = await selfServe({ port: SELF_PORT, saves: 'off', label: 'QA-OFFICE-SLOTS' }))
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  }
}

try {
  for (const runCase of [caseFullOffice, caseLunch, caseBrokenPc, caseServerRoomGateway]) {
    const browser = await puppeteer.launch({
      executablePath: chromePath(),
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    })
    try {
      await runCase(browser)
    } finally {
      await browser.close()
    }
  }
} finally {
  if (stopServer) await stopServer()
}

const failed = results.filter((r) => !r.pass)
console.log(`\nИтог QA-OFFICE-SLOTS: ${results.length - failed.length}/${results.length} проверок прошло`)
console.log(`Скриншоты: ${SHOTS_DIR}`)
if (failed.length > 0) {
  console.error(`Провалено: ${failed.map((f) => f.name).join(', ')}`)
  process.exit(1)
} else {
  console.log('Все проверки пройдены успешно!')
}
