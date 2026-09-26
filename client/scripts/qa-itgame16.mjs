// qa-itgame16 — верхняя панель HUD не пересекается и не уходит за экран
// (ITGAME-16). По каждому кейсу (0/1/9/15 сотрудников, длинные суммы,
// длинные цель/рынок/долг, стресс тостов) на зумах 1× и 1.4×:
//   (a) hud.* с непустым текстом — top >= 0 и bottom <= HUD_H
//   (b) левый блок (money/income/payroll/net/dayProfit/debt) — right <= 416;
//       правая колонка (goal/day/market) — left >= 848
//   (c) itd.overlaps() и itd.offscreen() пусты
//   (d) тостов на якорь не больше 3, попарно не пересекаются, шире 924 нет,
//       целиком внутри канваса
//   (e) bounds hud.* на зуме 1 и 1.4 совпадают (uiScale — CSS-зум канваса,
//       игровые координаты не меняет)
//   (f) на странице нет pageerror
//
// Self-serve: без QA_BASE поднимает Go-сервер на :4174 (dist + собранный
// bin/itdirector, как visreg.mjs).
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const CLIENT_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const SELF_PORT = 4174
const SHOTS_DIR = process.env.QA_SHOTS_DIR || join(tmpdir(), 'qa-itgame16')
const HUD_H = 96
const GAME_W = 1280
const GAME_H = 720

const LEFT_IDS = ['hud.money', 'hud.income', 'hud.payroll', 'hud.net', 'hud.dayProfit', 'hud.debt']
const RIGHT_IDS = ['hud.goal', 'hud.day', 'hud.market']
const HUD_IDS = [...LEFT_IDS, ...RIGHT_IDS]

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

// ── Self-serve: Go раздаёт dist + /ws + /api одним процессом (как visreg) ──
let server = null
async function selfServe() {
  const dist = join(CLIENT_DIR, 'dist')
  if (!existsSync(join(dist, 'index.html'))) {
    console.error('QA-ITGAME16 FAIL: нет client/dist — сначала npm run build')
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
      r.body?.cancel()
    } catch {
      // поднимается
    }
    await delay(250)
  }
  console.error('QA-ITGAME16 FAIL: Go-сервер не поднялся на :' + SELF_PORT)
  process.exit(1)
}

const BASE = process.env.QA_BASE || `http://127.0.0.1:${SELF_PORT}`

const results = []
function check(name, pass, fact) {
  results.push({ name, pass, fact })
  console.log(`${pass ? 'PASS' : 'FAIL'}: ${name}${fact ? ` — ${fact}` : ''}`)
}

// ── Загрузка сцены (см. visreg.mjs/qa-itgame17.mjs): меню → сложность →
// коннект → пауза. window.itd появляется раньше кнопок меню — ждём id.
async function waitMenuReady(page) {
  await page.waitForFunction(
    () => window.itd != null && window.itd.ids().some((n) => n.id === 'menu.diff.normal'),
    { timeout: 20000 },
  )
}

async function loadScenario(page, scenario, diff, sidTag) {
  await page.goto(`${BASE}/?scenario=${scenario}&seed=1&debug=1`, { waitUntil: 'domcontentloaded' })
  await waitMenuReady(page)
  // уникальный sid: серверные сейвы живут 24ч и резюмятся по общему ключу
  await page.evaluate((t) => localStorage.setItem('itd.sid', 'qa16-' + t + '-' + Date.now().toString(36)), sidTag)
  const clicked = await page.evaluate((d) => window.itd.click('menu.diff.' + d), diff)
  if (!clicked.ok) throw new Error(`${sidTag}: клик menu.diff.${diff} не прошёл — ${JSON.stringify(clicked)}`)
  await page.waitForFunction(() => window.itd.state().connected === true, { timeout: 20000 })
  await page.evaluate(() => window.itd.pause()) // время не меняет кадр
}

// Перечитать сейв, урезать/добавить сотрудников через restore (разведка
// ITGAME-16, probe2.mjs): дельта над текущим состоянием.
async function restoreEmployees(page, count) {
  return page.evaluate(async (n) => {
    const snap = await window.itd.snapshot()
    const save = snap.save
    const e = save.offices[0].Employees
    if (n <= e.length) {
      save.offices[0] = { ...save.offices[0], Employees: e.slice(0, n) }
    } else {
      // 15 = 12 (office0 как есть) + 3 в новом офисе 1
      save.offices[1] = { ...save.offices[1], Unlocked: true, PCs: 3, Employees: e.slice(0, n - e.length) }
    }
    await window.itd.restore({ offices: save.offices })
    return true
  }, count)
}

// ── Кейсы ────────────────────────────────────────────────────────────────
const CASES = [
  { name: 'fresh_0emp', setup: (p) => loadScenario(p, 'fresh', 'normal', 'fresh0') },
  { name: 'pre_victory_1emp', setup: (p) => loadScenario(p, 'pre_victory', 'normal', 'previc1') },
  { name: 'full_office_12emp', setup: (p) => loadScenario(p, 'full_office', 'normal', 'full12') },
  {
    name: 'full_office_9emp',
    setup: async (p) => {
      await loadScenario(p, 'full_office', 'normal', 'full9')
      await restoreEmployees(p, 9)
    },
  },
  {
    name: 'full_office_15emp',
    setup: async (p) => {
      await loadScenario(p, 'full_office', 'normal', 'full15')
      await restoreEmployees(p, 15)
    },
  },
  {
    name: 'full_office_longmoney',
    setup: async (p) => {
      await loadScenario(p, 'full_office', 'normal', 'longmoney')
      await p.evaluate(() => window.itd.set({ money: 1234567 }))
    },
  },
  {
    name: 'broke_day3_hardcore_debt',
    setup: async (p) => {
      await loadScenario(p, 'broke_day3', 'hardcore', 'brokehc')
      await p.evaluate(() => window.itd.set({ money: -9999 }))
    },
  },
  {
    name: 'fresh_hard_debt',
    // самая длинная цель/рынок/долг (winStaff+winCore на hard)
    setup: async (p) => {
      await loadScenario(p, 'fresh', 'hard', 'freshhard')
      await p.evaluate(() => window.itd.set({ money: -4999 }))
    },
  },
  {
    name: 'toast_stress',
    setup: async (p) => {
      await loadScenario(p, 'fresh', 'normal', 'toaststress')
      await p.evaluate(() => window.itd.set({ money: 0 }))
      await delay(300)
      // buy_office офиса 9 — всегда bad_office: 5 ошибок подряд, каждая — тост
      for (let i = 0; i < 5; i++) await p.evaluate(() => window.itd.cmd('buy_office', 9))
    },
    stress: true,
  },
]

// ── Снятие состояния сцены 'hud' ────────────────────────────────────────
async function dumpPanel(page) {
  return page.evaluate((ids) => {
    const scene = window.__itd.scene.getScene('hud')
    const out = []
    for (const o of scene.children.list) {
      if (o.type !== 'Text' || !ids.includes(o.getData('id'))) continue
      if (!o.visible || o.text === '') continue
      const b = o.getBounds()
      out.push({ id: o.getData('id'), text: o.text, top: b.top, bottom: b.bottom, left: b.left, right: b.right })
    }
    return out
  }, HUD_IDS)
}

async function dumpToasts(page) {
  return page.evaluate(() => {
    const scene = window.__itd.scene.getScene('hud')
    return scene.children.list
      .filter((o) => o.type === 'Text' && o.visible && o.getData('id') === 'toast')
      .map((o) => {
        const b = o.getBounds()
        return { text: o.text.slice(0, 30), top: b.top, bottom: b.bottom, left: b.left, right: b.right }
      })
  })
}

function rectsOverlap(a, b) {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left)
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
  return w > 1 && h > 1
}

function near(a, b, eps = 0.5) {
  return Math.abs(a - b) <= eps
}

// ── Прогон одного кейса на одном зуме ───────────────────────────────────
async function runCase(browser, zoom, def) {
  const label = `${def.name} @ zoom${zoom}`
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  await page.setViewport({ width: 1920, height: 1080 })
  await page.evaluateOnNewDocument((z) => localStorage.setItem('itd.uiScale', z), zoom)

  let panel = []
  let toasts = []
  let lint = { overlaps: [], offscreen: [] }
  try {
    await def.setup(page)
    await delay(300) // перерисовка снапшота/restore
    await page.evaluate(() => window.itd.quiet())
    await delay(150)

    panel = await dumpPanel(page)
    toasts = await dumpToasts(page)
    lint = await page.evaluate(() => ({
      overlaps: window.itd.overlaps ? window.itd.overlaps() : [],
      offscreen: window.itd.offscreen ? window.itd.offscreen() : [],
    }))

    // (a)+(b) панель: top>=0, bottom<=HUD_H; левый блок right<=416; правая колонка left>=848
    const bad = panel.filter((n) => n.top < -0.01 || n.bottom > HUD_H + 0.01)
    check(`${label}: hud.* в границах 0..${HUD_H}`, bad.length === 0,
      bad.length ? bad.map((n) => `${n.id} ${n.top.toFixed(1)}..${n.bottom.toFixed(1)}`).join(', ') : 'ok')

    const leftOver = panel.filter((n) => LEFT_IDS.includes(n.id) && n.right > 416 + 0.01)
    check(`${label}: левый блок right<=416`, leftOver.length === 0,
      leftOver.length ? leftOver.map((n) => `${n.id} R=${n.right.toFixed(1)}`).join(', ') : 'ok')

    const rightOver = panel.filter((n) => RIGHT_IDS.includes(n.id) && n.left < 848 - 0.01)
    check(`${label}: правая колонка left>=848`, rightOver.length === 0,
      rightOver.length ? rightOver.map((n) => `${n.id} L=${n.left.toFixed(1)}`).join(', ') : 'ok')

    // (c) линтер
    check(`${label}: itd.overlaps() пуст`, lint.overlaps.length === 0, `n=${lint.overlaps.length} ${JSON.stringify(lint.overlaps).slice(0, 200)}`)
    check(`${label}: itd.offscreen() пуст`, lint.offscreen.length === 0, `n=${lint.offscreen.length} ${JSON.stringify(lint.offscreen).slice(0, 200)}`)

    // (d) стек тостов — только у кейса-стресса (у остальных тостов обычно нет)
    if (def.stress) {
      const top = toasts.filter((t) => t.top < GAME_H / 2)
      const bottom = toasts.filter((t) => t.top >= GAME_H / 2)
      check(`${label}: тостов сверху <= 3`, top.length <= 3, `n=${top.length}`)
      check(`${label}: тостов снизу <= 3`, bottom.length <= 3, `n=${bottom.length}`)
      let overlapPair = null
      for (let i = 0; i < toasts.length && !overlapPair; i++) {
        for (let j = i + 1; j < toasts.length; j++) {
          if (rectsOverlap(toasts[i], toasts[j])) { overlapPair = [toasts[i], toasts[j]]; break }
        }
      }
      check(`${label}: тосты попарно не пересекаются`, overlapPair === null,
        overlapPair ? JSON.stringify(overlapPair) : `n=${toasts.length}`)
      const tooWide = toasts.filter((t) => t.right - t.left > 924 + 0.01)
      check(`${label}: ширина тоста <= 924`, tooWide.length === 0,
        tooWide.length ? tooWide.map((t) => (t.right - t.left).toFixed(1)).join(', ') : 'ok')
      const outOfCanvas = toasts.filter((t) => t.left < -0.01 || t.right > GAME_W + 0.01)
      check(`${label}: тосты целиком внутри канваса`, outOfCanvas.length === 0,
        outOfCanvas.length ? JSON.stringify(outOfCanvas) : 'ok')
      check(`${label}: тосты вообще появились`, toasts.length > 0, `n=${toasts.length}`)
    }

    // (f) ошибок на странице нет
    check(`${label}: нет pageerror`, pageErrors.length === 0, pageErrors.join(' | '))

    // Скриншот полосы HUD: канвас × zoom, высота HUD_H·zoom
    mkdirSync(SHOTS_DIR, { recursive: true })
    const canvas = await page.$('canvas')
    const box = await canvas?.boundingBox()
    if (box) {
      const hudHeightCss = (box.height * HUD_H) / GAME_H
      await page.screenshot({
        path: join(SHOTS_DIR, `${def.name}-zoom${zoom}.png`),
        clip: { x: box.x, y: box.y, width: box.width, height: hudHeightCss },
      })
    }
  } catch (e) {
    check(`${label}: кейс выполнен без ошибок`, false, e instanceof Error ? e.message : String(e))
  } finally {
    await page.close().catch(() => {})
  }
  return panel
}

// ── Главный прогон ──────────────────────────────────────────────────────
const ZOOMS = ['1', '1.4']

if (!process.env.QA_BASE) await selfServe()

try {
  for (const def of CASES) {
    const byZoom = {}
    for (const zoom of ZOOMS) {
      // Браузер на комбинацию (кейс×зум): свежий контекст, без утечек между
      // сценариями (как в visreg.mjs).
      const browser = await puppeteer.launch({
        executablePath: chromePath(),
        headless: 'new',
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
      })
      try {
        byZoom[zoom] = await runCase(browser, zoom, def)
      } finally {
        await browser.close()
      }
    }

    // (e) bounds hud.* совпадают на зумах 1 и 1.4 (CSS-зум игровые координаты не меняет)
    const a = byZoom['1'] ?? []
    const b = byZoom['1.4'] ?? []
    const byId = (arr) => Object.fromEntries(arr.map((n) => [n.id, n]))
    const ma = byId(a)
    const mb = byId(b)
    const ids = [...new Set([...Object.keys(ma), ...Object.keys(mb)])]
    const mismatches = ids.filter((id) => {
      const x = ma[id]
      const y = mb[id]
      if (!x || !y) return true // текст пуст на одном из зумов, но не на другом
      return !(near(x.top, y.top) && near(x.bottom, y.bottom) && near(x.left, y.left) && near(x.right, y.right))
    })
    check(`${def.name}: bounds hud.* на zoom 1 и 1.4 совпадают`, mismatches.length === 0,
      mismatches.length ? mismatches.join(', ') : 'ok')
  }
} finally {
  if (server) server.kill('SIGKILL')
}

const failed = results.filter((r) => !r.pass)
console.log(`\nИтог QA-ITGAME16: ${results.length - failed.length}/${results.length} проверок прошло`)
console.log(`Скриншоты: ${SHOTS_DIR}`)
if (failed.length > 0) {
  console.error(`Провалено: ${failed.map((f) => f.name).join(', ')}`)
  process.exit(1)
} else {
  console.log('Все проверки пройдены успешно!')
}
