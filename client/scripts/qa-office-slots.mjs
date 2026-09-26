// qa-office-slots — регрессия слотов офиса/серверной после единого
// манифеста ассетов: занятое место рисует ОДНУ картинку сотрудника
// (worker — includesDesk=true, легаси 64px) либо стол
// desk_pc/_broken + сотрудника поверх в ТОЙ ЖЕ точке (includesDesk=false,
// HD 128px), на обеде слот превращается в desk_pc + подпись «обед» (стол
// рисуется РОВНО один раз, не дважды), сломанный ПК кликается мышью по
// всей зоне ремонта (не только по краям — раньше сотрудник перехватывал
// левую треть), слот шлюза серверной рисует gateway (не router), полка
// быта (office.amenity.cooler/fridge/coffee_machine) и слот сети офиса
// рисуют свои HD-текстуры, занятые/пустые серверные стойки — rack_server/
// rack_empty (пустая — с подсветкой первой свободной, ITGAME-11) без
// itd.overlaps()/itd.offscreen() в серверной. Стиль/selfServe — как
// client/scripts/qa-itgame16.mjs.
//
// includesDesk читаем из манифеста напрямую (не из сцены) — ожидания
// кейсов зависят от текущего режима ассетов (легаси 64px vs HD 128px).
//
// Self-serve: без QA_BASE поднимает Go-сервер на QA_PORT (default 4177)
// поверх client/dist + bin/itdirector (npm run build — заранее). Общий
// self-serve — client/scripts/lib/selfserve.mjs.
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
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

// Ключ office.worker.i рисует стол сам (легаси 64px) или нет (HD 128px,
// стол — отдельный desk_pc/_off/_broken в той же точке слота): см.
// OfficeScene.ts (workerIncludesDesk) и client/src/assets/manifest.ts.
const spriteManifest = JSON.parse(
  readFileSync(join(CLIENT_DIR, 'src', 'assets', 'sprites.json'), 'utf8'),
)
const WORKER_INCLUDES_DESK = spriteManifest.sprites.worker?.includesDesk === true
const WORKER_KEY_RE = /^worker(_[1-3])?$/

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
// alpha/tint — для кейса пустых стоек (ServerRoomScene.ts затемняет стойки
// закрытых офисов setAlpha(0.3) и подсвечивает первую пустую setTint();
// tint читаем через .tint — геттер Phaser отдаёт tintTopLeft, дефолт без
// тинта 0xffffff, см. Tint.js).
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
        alpha: o.alpha,
        tint: o.tint,
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
    // includesDesk=true (легаси 64px, worker.png содержит свой стол) — слот
    // рисует ТОЛЬКО worker; includesDesk=false (HD 128px) — worker/worker_1..3
    // по уровню сотрудника, поверх отдельного desk_pc/_broken в той же точке
    // (см. OfficeScene.ts).
    const badKey = workers.filter((w) => !WORKER_KEY_RE.test(w.key))
    check('full_office: office.worker.i рисует worker/worker_1..3', badKey.length === 0,
      badKey.length ? JSON.stringify(badKey) : 'ok')

    // Текстура должна соответствовать уровню сотрудника (0 → worker, 1..3 →
    // worker_N в HD-режиме) — уровень берём из snapshot() (level — производная
    // от XP, считает сервер), а не из фикстуры.
    const snap = await page.evaluate(() => window.itd.snapshot())
    const employees = snap.state.offices[0].employees
    const levelOf = (id) => employees[Number(id.split('.').pop())]?.level ?? 0
    const mismatched = workers.filter((w) => {
      const level = levelOf(w.id)
      const expected = !WORKER_INCLUDES_DESK && level >= 1 && level <= 3 ? `worker_${level}` : 'worker'
      return w.key !== expected
    })
    check('full_office: текстура office.worker.i соответствует уровню сотрудника', mismatched.length === 0,
      mismatched.length
        ? JSON.stringify(mismatched.map((w) => ({ id: w.id, key: w.key, level: levelOf(w.id) })))
        : 'ok')

    if (WORKER_INCLUDES_DESK) {
      // Легаси: стол запечён в worker.png — под office.worker.i не должно
      // быть НИКАКОГО desk_* (иначе два стола в разных ракурсах).
      const stacked = workers.filter((w) =>
        images.some((img) => img !== w && !img.id
          && Math.abs(img.x - w.x) < 1 && Math.abs(img.y - w.y) < 1
          && /^desk_/.test(img.key)))
      check('full_office (includesDesk=true): нет стола под office.worker.i (два стола)', stacked.length === 0,
        stacked.length ? JSON.stringify(stacked) : 'ok')
    } else {
      // HD: РОВНО один desk_pc/_broken в той же точке слота.
      const badDesk = workers.filter((w) => {
        const deskHere = images.filter((img) => img !== w && !img.id
          && Math.abs(img.x - w.x) < 1 && Math.abs(img.y - w.y) < 1
          && (img.key === 'desk_pc' || img.key === 'desk_pc_broken'))
        return deskHere.length !== 1
      })
      check('full_office (includesDesk=false): ровно один desk_pc/_broken под office.worker.i', badDesk.length === 0,
        badDesk.length ? JSON.stringify(badDesk) : 'ok')
    }
    // Все 12 мест заняты (PCs=12=Employees) — desk_empty (нет ПК) и
    // desk_pc_off (ПК есть, не нанят) нигде быть не должно. Фикстура
    // full_office не заводит слот «ПК без сотрудника», так что отдельного
    // кейса на desk_pc_off здесь нет — добавить, когда появится фикстура.
    const stray = images.filter((img) => img.key === 'desk_empty' || img.key === 'desk_pc_off')
    check('full_office: нет desk_empty/desk_pc_off — все места заняты', stray.length === 0,
      stray.length ? JSON.stringify(stray) : 'ok')

    const boss = images.find((n) => n.id === 'office.boss')
    check('full_office: office.boss рисуется текстурой boss', boss?.key === 'boss',
      boss ? `key=${boss.key}` : 'office.boss не найден')

    // Полка быта (office.amenity.<key>, все три куплены в full_office —
    // см. fixtures/full_office.json Cooler/Fridge/CoffeeMachine) — HD
    // 128px/hd32 замена бывших 64px sweetie16.
    for (const key of ['cooler', 'fridge', 'coffee_machine']) {
      const item = images.find((n) => n.id === `office.amenity.${key}`)
      check(`full_office: office.amenity.${key} рисуется текстурой ${key}`, item?.key === key,
        item ? `key=${item.key}` : `office.amenity.${key} не найден`)
    }
    // Слот сети (office.router — тег на прозрачной зоне-прямоугольнике, не
    // на самой картинке, см. OfficeScene.ts: routerImg без tag()) — ищем
    // по текстуре, она в слоте одна.
    const routerImg = images.find((n) => n.key === 'router')
    check('full_office: слот сети рисует текстуру router', !!routerImg, routerImg ? 'ok' : 'не найдена')

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

    // Начальник на обеде — та же фигура, но с кофе и сэндвичем (boss_lunch),
    // как и у сотрудников (см. OfficeScene.ts, s.isLunch).
    const boss = images.find((n) => n.id === 'office.boss')
    check('lunch: office.boss на обеде рисует boss_lunch', boss?.key === 'boss_lunch',
      boss ? `key=${boss.key}` : 'office.boss не найден')

    // Сотрудника в точке нет (обед убирает только его, стол остаётся) —
    // и desk_pc нарисован РОВНО один раз, а не дважды под одним слотом
    // (office.worker.0 и есть тот единственный desk_pc — двойной отрисовки
    // desk_pc «под собой» на обеде быть не должно).
    const samePoint = worker0
      ? images.filter((img) => Math.abs(img.x - worker0.x) < 1 && Math.abs(img.y - worker0.y) < 1)
      : []
    const deskCount = samePoint.filter((img) => img.key === 'desk_pc').length
    check('lunch: desk_pc в точке слота ровно один', deskCount === 1, `n=${deskCount}`)
    const strayWorker = samePoint.filter((img) => img !== worker0 && WORKER_KEY_RE.test(img.key))
    check('lunch: сотрудника в точке слота нет', strayWorker.length === 0,
      strayWorker.length ? JSON.stringify(strayWorker) : 'ok')

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

    if (!WORKER_INCLUDES_DESK) {
      // HD: стол слота — desk_pc_broken (экран красный), сотрудник поверх
      // него в той же точке (легаси-режим брокенность десктопа не рисует —
      // только мигающий оверлей поверх запечённого worker.png).
      const images = await dumpImages(page, 'office')
      const worker0 = images.find((n) => n.id === 'office.worker.0')
      const deskHere = worker0
        ? images.find((img) => img !== worker0 && !img.id
            && Math.abs(img.x - worker0.x) < 1 && Math.abs(img.y - worker0.y) < 1)
        : null
      check('broken_pc: в точке слота стол desk_pc_broken', deskHere?.key === 'desk_pc_broken',
        deskHere ? `key=${deskHere.key}` : 'стол не найден в точке слота')
    }

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

    // full_office: офис 1 занят целиком (Servers [3,3,3], см. fixtures) —
    // все 3 стойки room.rack.0.* рисуют rack_server (не rack_empty).
    const racks = images.filter((n) => n.id && /^room\.rack\.0\.\d+$/.test(n.id))
    check('serverRoom: 3 занятые стойки офиса 1 рисуют rack_server', racks.length === 3 && racks.every((r) => r.key === 'rack_server'),
      JSON.stringify(racks.map((r) => ({ id: r.id, key: r.key }))))

    // Core (стойка роутеров слева) — картинка без id: тег room.core висит
    // на прозрачной зоне поверх неё (ServerRoomScene.ts).
    const core = images.find((n) => !n.id && n.key === 'rack_server')
    check('serverRoom: core (coreLevel>0) рисует текстуру rack_server', !!core, core ? 'ok' : 'не найден')

    // Единый линтер раскладки — тот же itd.overlaps()/offscreen(), что и
    // для офиса (client/scripts/qa-itgame16.mjs): переключение комнаты
    // глушит сцену office (HUDScene.switchRoom → scene.stop), так что
    // здесь линтер видит только серверную + HUD.
    const overlaps = await page.evaluate(() => window.itd.overlaps())
    check('serverRoom: itd.overlaps() пуст', overlaps.length === 0, `n=${overlaps.length}`)
    const offscreen = await page.evaluate(() => window.itd.offscreen())
    check('serverRoom: itd.offscreen() пуст', offscreen.length === 0, `n=${offscreen.length}`)

    check('serverRoom: нет pageerror', pageErrors.length === 0, pageErrors.join(' | '))
    await shot(page, 'server_room_gateway')
  } catch (e) {
    check('serverRoom: кейс выполнен без ошибок', false, e instanceof Error ? e.message : String(e))
  } finally {
    await page.close().catch(() => {})
  }
}

// ── Кейс 5: пустые стойки — rack_empty, подсветка первой пустой, закрытые ───
// офисы затемнены. mid_day10 (см. server/internal/game/fixtures/mid_day10.json):
// офис 1 — Servers [2,1] при serverSlots=3 (OfficeSlots/EmployeesPerServer
// = 12/4, server/internal/game/config.go) → 2 занятые стойки + 1 пустая;
// офисы 2/3 — Unlocked:false, их 3+3 стойки всегда rack_empty (Servers==[]).
async function caseServerRoomEmptyRacks(browser) {
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  await page.setViewport({ width: 1920, height: 1080 })
  try {
    await loadScenario(page, 'mid_day10', 'emptyracks')
    await page.evaluate(() => window.itd.click('nav.serverRoom'))
    await delay(300)

    const images = await dumpImages(page, 'serverRoom')

    const filled = images.filter((n) => n.id && /^room\.rack\.0\.[01]$/.test(n.id))
    check('mid_day10: 2 занятые стойки офиса 1 рисуют rack_server', filled.length === 2 && filled.every((r) => r.key === 'rack_server'),
      JSON.stringify(filled.map((r) => ({ id: r.id, key: r.key }))))

    // Третья стойка офиса 1 — пустая и, как первая пустая (firstEmpty),
    // подсвечена setTint(0x9be3ba) (ServerRoomScene.ts) — «сюда встанет
    // сервер».
    const empty = images.find((n) => n.id === 'room.rack.0.2')
    check('mid_day10: пустая стойка room.rack.0.2 рисует rack_empty', empty?.key === 'rack_empty',
      empty ? `key=${empty.key}` : 'room.rack.0.2 не найден')
    check('mid_day10: первая пустая стойка подсвечена тинтом 0x9be3ba', empty?.tint === 0x9be3ba,
      empty ? `tint=0x${(empty.tint ?? 0).toString(16)}` : 'не найдена')

    // Офисы 2/3 закрыты — их стойки нетегированы (пропущены до tag() в
    // ServerRoomScene.ts) и затемнены setAlpha(0.3), но БЕЗ тинта: ветка
    // !o.unlocked делает `continue` раньше строки с setTint.
    const closedRacks = images.filter((n) => !n.id && n.key === 'rack_empty' && n.alpha < 1)
    check('mid_day10: 6 стоек закрытых офисов (2/3) рисуют затемнённый rack_empty', closedRacks.length === 6,
      `n=${closedRacks.length}`)
    check('mid_day10: стойки закрытых офисов без тинта', closedRacks.every((r) => r.tint === 0xffffff),
      JSON.stringify(closedRacks.map((r) => r.tint)))

    // Подпись «сервер сюда» над первой пустой стойкой есть только здесь
    // (на full_office пустых стоек нет) — линтер раскладки и на ней.
    const overlaps = await page.evaluate(() => window.itd.overlaps())
    check('mid_day10: itd.overlaps() в серверной пуст', overlaps.length === 0, `n=${overlaps.length}`)
    const offscreen = await page.evaluate(() => window.itd.offscreen())
    check('mid_day10: itd.offscreen() в серверной пуст', offscreen.length === 0, `n=${offscreen.length}`)

    check('mid_day10: нет pageerror', pageErrors.length === 0, pageErrors.join(' | '))
    await shot(page, 'server_room_empty_racks')
  } catch (e) {
    check('mid_day10: кейс выполнен без ошибок', false, e instanceof Error ? e.message : String(e))
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
  for (const runCase of [caseFullOffice, caseLunch, caseBrokenPc, caseServerRoomGateway, caseServerRoomEmptyRacks]) {
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
