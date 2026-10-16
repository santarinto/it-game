// qa-office-slots — регрессия слотов офиса/серверной после единого
// манифеста ассетов: занятое место рисует ОДНУ картинку сотрудника
// (worker — includesDesk=true, легаси 64px) либо стол
// desk_pc/_broken + сотрудника поверх в ТОЙ ЖЕ точке (includesDesk=false,
// HD 128px), на обеде слот превращается в desk_pc + подпись «обед» (стол
// рисуется РОВНО один раз, не дважды), сломанный ПК (fixtures/broken_pc.json)
// кликается мышью по всему значку поломки — сотрудник и метка «✖ чинить k/N»
// одной зоной места office.slot.i, после починки та же зона мотивирует
// (ITGAME-75/92/93; проверка — itd.stack/itd.zones, настоящий хит-тест Phaser),
// тултип не остаётся рядом с окном роутера/увольнения (ITGAME-89),
// рамки ?debug=1 объектов под окном (роутер, выход в меню, карточка события, «Пока вас не было», отчёт дня) лежат под его
// подложкой, рамки кнопок окна — над ней (ITGAME-84/97), слот шлюза серверной рисует gateway (не router), полка
// быта (office.amenity.cooler/fridge/coffee_machine) и слот сети офиса
// рисуют свои HD-текстуры, занятые/пустые серверные стойки — rack_server/
// rack_empty (пустая — с подсветкой первой свободной, ITGAME-11), ПК куплен
// без сотрудника рисует desk_pc_off и слот вовсе без ПК — desk_empty
// (fixtures/spare_pcs.json), всё без itd.overlaps()/itd.offscreen(). Стиль/
// selfServe — как client/scripts/qa-itgame16.mjs.
//
// includesDesk читаем из манифеста напрямую (не из сцены) — ожидания
// кейсов зависят от текущего режима ассетов (легаси 64px vs HD 128px).
//
// Self-serve: без QA_BASE поднимает Go-сервер на QA_PORT (default 4177)
// поверх client/dist + bin/itdirector (npm run build — заранее). Общий
// self-serve — client/scripts/lib/selfserve.mjs.
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'
import { chromePath } from './lib/chrome.mjs'
import { selfServe } from './lib/selfserve.mjs'
import { waitMenuReady } from './lib/menu.mjs'

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

const BASE = process.env.QA_BASE || `http://127.0.0.1:${SELF_PORT}`

const results = []
function check(name, pass, fact) {
  results.push({ name, pass, fact })
  console.log(`${pass ? 'PASS' : 'FAIL'}: ${name}${fact ? ` — ${fact}` : ''}`)
}

// ── Загрузка сцены (см. qa-itgame16.mjs): меню → сложность → коннект → пауза ──
// Готовность меню — lib/menu.mjs (ITGAME-133).
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
    // desk_pc_off (ПК есть, не нанят) нигде быть не должно (кейс на
    // desk_pc_off — caseSparePcs ниже, фикстура spare_pcs).
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

// ── Кейс 3: сломанный ПК — одна зона места, реальные клики k/N ─────────────
// Фикстура broken_pc (ITGAME-74): у слота 0 сломан ПК (N=3 зафиксирован в
// фикстуре, ITGAME-93), слоты 1-2 работают.
// ITGAME-92: у занятого места ОДНА зона клика office.slot.i. Пока ПК сломан,
// она накрывает весь видимый значок поломки — сотрудника/стол и метку
// «✖ чинить k/N» (ITGAME-75), мигает красным, ЛКМ шлёт repair_click; после
// починки та же зона (уже без метки, 64×64) шлёт motivate. ПКМ и тултип общие.
// office.worker.i/office.repair.i — картинки без ввода (itd.click/hover
// переадресуют зоне). Проверяем настоящим хит-тестом Phaser (itd.stack/zones) и мышью.
async function caseBrokenPc(browser) {
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  await page.setViewport({ width: 1920, height: 1080 })
  try {
    await loadScenario(page, 'broken_pc', 'broken')

    const readGeo = () => page.evaluate(() => {
      const ns = window.itd.nodes()
      const by = (id) => ns.find((n) => n.id === id) ?? null
      return {
        slot: by('office.slot.0'), worker: by('office.worker.0'), label: by('office.repair.0'),
        others: [by('office.repair.1'), by('office.repair.2')], slots: [by('office.slot.1'), by('office.slot.2')],
      }
    })
    const geo = await readGeo()
    if (!geo.slot || !geo.worker || !geo.label) throw new Error(`broken_pc: нет узлов ${JSON.stringify(geo)}`)
    check('broken_pc: сломан только слот 0 (office.repair.1/2 нет)', geo.others.every((n) => n === null), JSON.stringify(geo.others))
    check('broken_pc: у целых мест 1/2 свои зоны office.slot.1/2', geo.slots.every((n) => n && n.interactive),
      JSON.stringify(geo.slots.map((n) => n && [n.w, n.h])))
    check('broken_pc: метка «✖ чинить 0/3» (N=3 из фикстуры)', geo.label.text === '✖ чинить 0/3', geo.label.text)
    // ITGAME-92: картинка сотрудника и метка — без ввода, вводом владеет зона.
    check('broken_pc: office.worker.0 и office.repair.0 без ввода (одна зона на место)',
      geo.worker.interactive === false && geo.label.interactive === false && geo.slot.interactive === true,
      JSON.stringify({ worker: geo.worker.interactive, label: geo.label.interactive, slot: geo.slot.interactive }))
    const inside = (a, b) => a.cx - a.w / 2 >= b.cx - b.w / 2 - 0.5 && a.cx + a.w / 2 <= b.cx + b.w / 2 + 0.5
      && a.cy - a.h / 2 >= b.cy - b.h / 2 - 0.5 && a.cy + a.h / 2 <= b.cy + b.h / 2 + 0.5
    check('broken_pc: зона office.slot.0 накрывает сотрудника и метку целиком',
      inside(geo.worker, geo.slot) && inside(geo.label, geo.slot),
      JSON.stringify({ slot: [geo.slot.cx, geo.slot.cy, geo.slot.w, geo.slot.h], worker: [geo.worker.w, geo.worker.h], label: [geo.label.w, geo.label.h] }))

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

    // Точки значка поломки: метка «✖ чинить» (✖ — её левый край), зазор над
    // сотрудником, углы и края кадра сотрудника, центр.
    const w = geo.worker
    const l = geo.label
    const spots = [
      { label: '✖ метки', x: l.cx - l.w / 2 + 4, y: l.cy },
      { label: 'центр метки', x: l.cx, y: l.cy },
      { label: 'зазор метка/сотрудник', x: w.cx, y: (l.cy + l.h / 2 + w.cy - w.h / 2) / 2 },
      { label: 'верх сотрудника', x: w.cx, y: w.cy - w.h / 2 + 4 },
      { label: 'левый верхний угол сотрудника', x: w.cx - w.w / 2 + 1, y: w.cy - w.h / 2 + 1 },
      { label: 'правый край сотрудника', x: w.cx + w.w / 2 - 1, y: w.cy },
      { label: 'левый нижний угол сотрудника', x: w.cx - w.w / 2 + 1, y: w.cy + w.h / 2 - 1 },
      { label: 'центр', x: w.cx, y: w.cy },
    ]
    const stacks = await page.evaluate((pts) => pts.map((p) => window.itd.stack(p.x, p.y)), spots)
    spots.forEach((p, k) => {
      const st = stacks[k]
      const own = st.stack.filter((x) => / office d/.test(x))
      check(`broken_pc: itd.stack «${p.label}» → wins office.slot.0, другой зоны офиса под точкой нет`,
        st.wins?.id === 'office.slot.0' && own.length === 1,
        JSON.stringify({ at: st.at, stack: st.stack, wins: st.wins?.id ?? null }))
    })
    // Кнопка мастера — снаружи зоны: ни одна точка не делится.
    const zones = await page.evaluate(() => window.itd.zones('office:slot:0', 'office:master:0'))
    check('broken_pc: itd.zones(slot.0, master.0) — зона места и кнопка мастера не пересекаются',
      zones.ok && zones.area.a > 0 && zones.area.b > 0 && zones.aUnderB.length === 0 && zones.bUnderA.length === 0,
      JSON.stringify({ area: zones.area }))
    // Подсветка поломки = кликабельная зона (владелец, 10.10): видимая красная
    // заливка только у office.slot.0 (у целых мест заливка прозрачная).
    const glow = await page.evaluate(() => window.__itd.scene.getScene('office').children.list
      .filter((o) => o.type === 'Rectangle' && o.fillColor === 0xb13e53 && o.fillAlpha > 0)
      .map((o) => ({ id: o.getData('id') ?? null, w: Math.round(o.width), h: Math.round(o.height) })))
    check('broken_pc: мигающая подсветка — сама зона office.slot.0 (одна красная заливка, размер зоны)',
      glow.length === 1 && glow[0].id === 'office.slot.0' && glow[0].w === Math.round(geo.slot.w) && glow[0].h === Math.round(geo.slot.h),
      JSON.stringify({ glow, zone: [geo.slot.w, geo.slot.h] }))
    const lint = await page.evaluate(() => ({ ov: window.itd.overlaps(), off: window.itd.offscreen() }))
    check('broken_pc: itd.overlaps()/offscreen() пусты', lint.ov.length === 0 && lint.off.length === 0,
      JSON.stringify({ ov: lint.ov.slice(0, 5), off: lint.off.slice(0, 5) }))

    // Тултип общий: настоящее наведение на метку поломки показывает тултип сотрудника с k/N.
    const box = await canvasBox(page)
    await page.mouse.move(box.x + spots[1].x * box.k, box.y + spots[1].y * box.k)
    await delay(150)
    const tip = await page.evaluate(() => {
      const c = window.__itd.scene.getScene('office').children.list.find((o) => o.type === 'Container')
      return { visible: c?.visible ?? null, text: c?.list?.find((o) => o.type === 'Text')?.text ?? '' }
    })
    const tipLines = tip.text.split('\n')
    check('broken_pc: наведение мышью на метку — тултип сотрудника с «0/3»',
      tip.visible === true && tip.text.startsWith('Артём Соколов') && tip.text.includes('кликайте по месту: 0/3'),
      JSON.stringify({ visible: tip.visible, lines: [tipLines[0], ...tipLines.filter((x) => x.includes('СЛОМАН'))] }))

    // ПКМ по зоне — увольнение (общий для обоих состояний места).
    const lastAt = (await lastOut(page, 50)).at(-1)?.at ?? 0
    await page.mouse.click(box.x + w.cx * box.k, box.y + w.cy * box.k, { button: 'right' })
    await delay(200)
    const fireOpen = await page.evaluate(() => window.itd.text().some((n) => n.text === 'Уволить сотрудника?'))
    const sentRight = (await lastOut(page, 50)).filter((m) => m.at > lastAt)
    check('broken_pc: ПКМ по зоне места открывает «Уволить сотрудника?», ничего не шлёт',
      fireOpen && sentRight.length === 0,
      JSON.stringify({ fireOpen, sent: sentRight.map((m) => m.type) }))
    await page.evaluate(() => window.itd.click('modal.close'))
    await delay(150)

    // Три настоящих клика по точкам значка: каждый — ровно repair_click
    // слота 0, метка идёт 1/3 → 2/3, третий чинит.
    const clickSpots = [spots[0], spots[2], spots[3]]
    for (let k = 0; k < clickSpots.length; k++) {
      const p = clickSpots[k]
      const since = (await lastOut(page, 50)).at(-1)?.at ?? 0
      await worldClick(page, box, p.x, p.y)
      await delay(250)
      const sent = (await lastOut(page, 50)).filter((m) => m.at > since)
      check(`broken_pc: клик мышью «${p.label}» шлёт ровно repair_click слота 0, не motivate`,
        sent.length === 1 && sent[0].type === 'repair_click' && sent[0].info?.slot === 0,
        JSON.stringify(sent.map((m) => ({ type: m.type, info: m.info }))))
      if (k < clickSpots.length - 1) {
        const txt = await page.evaluate(() => window.itd.nodes().find((n) => n.id === 'office.repair.0')?.text ?? null)
        check(`broken_pc: после клика ${k + 1} метка «✖ чинить ${k + 1}/3»`, txt === `✖ чинить ${k + 1}/3`, String(txt))
      }
    }
    const snap = await page.evaluate(() => window.itd.snapshot())
    const e = snap.save.offices[0].Employees[0]
    check('broken_pc: 3 реальных клика полностью чинят ПК (N=3 фикстуры)', e.PCBroken === false && !e.RepairNeeded,
      `RepairClicks=${e.RepairClicks} RepairNeeded=${e.RepairNeeded} PCBroken=${e.PCBroken}`)
    await delay(300)
    const after = await readGeo()
    const afterWins = await page.evaluate(() => window.itd.stack('office:worker:0').wins?.id ?? null)
    check('broken_pc: после починки метки нет, та же зона office.slot.0 (64×64) берёт клик',
      !after.label && afterWins === 'office.slot.0' && !!after.slot && Math.round(after.slot.w) === 64 && Math.round(after.slot.h) === 64,
      JSON.stringify({ label: !!after.label, wins: afterWins, slot: after.slot && [after.slot.w, after.slot.h] }))
    const since = (await lastOut(page, 50)).at(-1)?.at ?? 0
    await worldClick(page, box, w.cx, w.cy)
    await delay(250)
    const sentAfter = (await lastOut(page, 50)).filter((m) => m.at > since)
    check('broken_pc: после починки клик мышью по месту шлёт motivate слота 0',
      sentAfter.length === 1 && sentAfter[0].type === 'motivate' && sentAfter[0].info?.slot === 0,
      JSON.stringify(sentAfter.map((m) => ({ type: m.type, info: m.info }))))

    check('broken_pc: нет pageerror', pageErrors.length === 0, pageErrors.join(' | '))
    await shot(page, 'broken_pc')
  } catch (e) {
    check('broken_pc: кейс выполнен без ошибок', false, e instanceof Error ? e.message : String(e))
  } finally {
    await page.close().catch(() => {})
  }
}

// ── Кейс 3б: тултип не остаётся рядом с окном (ITGAME-89) ───────────────────
// Наведение мышью на сотрудника, затем окно без увода курсора: окно роутера
// через itd.click (pointerout не приходит — как у агента на приёмке), окно
// увольнения настоящим ПКМ по тому же месту. Тултип прячется сразу, не
// возвращается со следующим снапшотом, itd.hover под окном его не показывает;
// после закрытия окна наведение снова работает.
async function caseTooltipUnderModal(browser) {
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  await page.setViewport({ width: 1920, height: 1080 })
  try {
    await loadScenario(page, 'broken_pc', 'tipmodal')
    const tipState = () => page.evaluate(() => {
      const c = window.__itd.scene.getScene('office').children.list.find((o) => o.type === 'Container')
      // строка тултипа, которой нет в окне увольнения (там тоже имя)
      const name = window.itd.text().some((n) => n.visible && n.text.startsWith('Мария Кузнецова') && n.text.includes('Выработка:'))
      return { visible: c?.visible ?? null, name }
    })
    const w1 = await page.evaluate(() => window.itd.nodes().find((n) => n.id === 'office.worker.1'))
    const box = await canvasBox(page)
    const overW1 = async () => {
      await page.mouse.move(box.x + 10, box.y + 600 * box.k)
      await delay(100)
      await page.mouse.move(box.x + w1.cx * box.k, box.y + w1.cy * box.k)
      await delay(150)
    }
    const windows = [
      { label: 'окно роутера (itd.click office.router)', open: () => page.evaluate(() => window.itd.click('office.router')) },
      { label: 'окно увольнения (настоящий ПКМ по месту 1)', open: () => page.mouse.click(box.x + w1.cx * box.k, box.y + w1.cy * box.k, { button: 'right' }) },
    ]
    for (const win of windows) {
      await overW1()
      const before = await tipState()
      check(`tooltip/modal: перед «${win.label}» наведение мышью на сотрудника 1 — тултип виден`,
        before.visible === true && before.name, JSON.stringify(before))
      await win.open()
      await delay(150)
      const opened = await tipState()
      // Внеочередной снапшот: раньше render() возвращал тултип (hoveredSlot
      // оставался 1, курсор над местом).
      await page.evaluate(() => window.itd.set({ money: 2345 }))
      await delay(300)
      const afterSnap = await tipState()
      const hovered = await page.evaluate(() => {
        window.itd.hover('office.worker.1')
        const c = window.__itd.scene.getScene('office').children.list.find((o) => o.type === 'Container')
        return c?.visible ?? null
      })
      const title = await page.evaluate(() => window.itd.blocker()?.title ?? null)
      check(`tooltip/modal: ${win.label} — тултипа нет сразу, после снапшота и после itd.hover`,
        title !== null && opened.visible === false && !opened.name && afterSnap.visible === false && !afterSnap.name && hovered === false,
        JSON.stringify({ title, opened, afterSnap, hovered }))
      await page.evaluate(() => window.itd.click('modal.close'))
      await delay(150)
    }
    // Окна закрыты — наведение снова показывает тултип.
    await overW1()
    const back = await tipState()
    check('tooltip/modal: после закрытия окна наведение снова показывает тултип', back.visible === true && back.name, JSON.stringify(back))
    check('tooltip/modal: нет pageerror', pageErrors.length === 0, pageErrors.join(' | '))
  } catch (e) {
    check('tooltip/modal: кейс выполнен без ошибок', false, e instanceof Error ? e.message : String(e))
  } finally {
    await page.close().catch(() => {})
  }
}

// ── Кейс 3в: рамки ?debug=1 не лежат поверх окон (ITGAME-84) ────────────────
// drawDebugFrames (client/src/debug.ts) кладёт рамку сразу над её объектом —
// depth корня объекта + 0.5 (все слои игры целые), а не на общий depth 90:
// окно, открытое поверх, затемняет рамки накрытых объектов вместе с ними,
// рамки кнопок самого окна — над его подложкой; рамки, перерисованные на
// снапшоте под открытым окном, остаются под ним. Рамку узнаём по виду
// (обводка 0xff0000 без заливки), data 'debugFrame' — её объект. Окна: роутер
// офиса (showModal, подложка 70), диалог выхода HUD (тот же showModal в сцене
// HUD, 70), отчёт дня (подложка 50).
// Карточка события (панель 40 без ввода, кнопки 41) и «Пока вас не было» (подложка 55 с вводом, кнопка 56) держат
// рамки в своих списках eventUI/offlineUI — рамки уходят вместе с окном (ITGAME-97).
async function caseDebugFramesUnderWindows(browser) {
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  await page.setViewport({ width: 1920, height: 1080 })
  try {
    await loadScenario(page, 'broken_pc', 'frames')
    // Рамки сцены относительно подложки окна на глубине dim.
    const framesOf = (sceneKey, dim) => page.evaluate((key, dim) => {
      const scene = window.__itd.scene.getScene(key)
      const rootDepth = (o) => {
        let r = o
        while (r.parentContainer) r = r.parentContainer
        return typeof r.depth === 'number' ? r.depth : 0
      }
      const rows = scene.children.list
        .filter((o) => o.type === 'Rectangle' && o.isStroked && o.strokeColor === 0xff0000 && !o.isFilled)
        .map((f) => {
          const t = f.getData('debugFrame') ?? null
          return {
            of: t ? (t.getData?.('id') ?? t.type) : null,
            depth: f.depth,
            target: t ? rootDepth(t) : null,
            input: f.input?.enabled === true,
          }
        })
      const bound = rows.filter((r) => r.target !== null)
      return {
        n: rows.length,
        unbound: rows.length - bound.length,
        input: rows.filter((r) => r.input).length,
        offset: bound.filter((r) => r.depth !== r.target + 0.5).map((r) => `${r.of}@${r.depth}/${r.target}`),
        leaks: bound.filter((r) => r.target < dim && r.depth >= dim).map((r) => `${r.of}@${r.depth}`),
        under: bound.filter((r) => r.target < dim).map((r) => r.of),
        over: bound.filter((r) => r.target >= dim && r.depth > dim).map((r) => r.of),
        at: bound.map((r) => `${r.of}@${r.depth}`), // по записи на рамку: дубль — две записи
      }
    }, sceneKey, dim)
    const sane = (f) => f.n > 0 && f.unbound === 0 && f.input === 0 && f.offset.length === 0
    // Рамки объекта id ('id@depth'); once — ровно одна рамка на глубине depth.
    const framed = (f, id) => f.at.filter((s) => s.startsWith(`${id}@`))
    const once = (f, id, depth) => JSON.stringify(framed(f, id)) === JSON.stringify([`${id}@${depth}`])
    const count = (f, entry) => f.at.filter((s) => s === entry).length
    // Рамки в собственном списке окна HUD (eventUI/offlineUI) и длина списка.
    const ownFrames = (list) => page.evaluate((l) =>
      window.__itd.scene.getScene('hud')[l].filter((o) => o.getData?.('debugFrame') != null).length, list)
    const uiLen = (list) => page.evaluate((l) => window.__itd.scene.getScene('hud')[l].length, list)

    // 0. Без окна: у каждой рамки офиса есть объект, рамка без ввода, depth объекта + 0.5.
    const idle = await framesOf('office', 70)
    check('debug frames: офис — у каждой рамки data.debugFrame, без ввода, depth = depth объекта + 0.5',
      sane(idle), JSON.stringify({ n: idle.n, unbound: idle.unbound, input: idle.input, offset: idle.offset }))

    // A. Окно роутера офиса (подложка 70) + снапшот под открытым окном.
    const opened = await page.evaluate(() => window.itd.click('office.router'))
    await delay(150)
    const routerTitle = await page.evaluate(() => window.itd.blocker()?.title ?? null)
    if (!opened.ok || routerTitle === null) throw new Error(`окно роутера не открылось: ${JSON.stringify({ opened, routerTitle })}`)
    let f = await framesOf('office', 70)
    check('debug frames: окно роутера — рамки объектов офиса под подложкой 70, ✕ окна в рамке над ней',
      sane(f) && f.leaks.length === 0 && f.under.length >= 5 && f.under.includes('office.slot.0') &&
        f.under.includes('btn.pc') && f.over.includes('modal.close'),
      JSON.stringify({ leaks: f.leaks, under: f.under, over: f.over }))
    await page.evaluate(() => window.itd.set({ money: 2345 })) // снапшот → render() офиса перерисовал рамки
    await delay(300)
    f = await framesOf('office', 70)
    check('debug frames: снапшот под открытым окном роутера — новые рамки офиса остаются под подложкой',
      sane(f) && f.leaks.length === 0 && f.under.includes('office.slot.0') && f.over.includes('modal.close'),
      JSON.stringify({ leaks: f.leaks, under: f.under.length, over: f.over }))
    await page.evaluate(() => window.itd.click('modal.close'))
    await delay(150)

    // B. Диалог выхода HUD (showModal в сцене HUD, подложка 70). Партия на паузе —
    // диалог скорость не трогает; ✕ закрывает без команд.
    await page.evaluate(() => window.itd.click('btn.menu'))
    await delay(150)
    const exitTitle = await page.evaluate(() => window.itd.blocker()?.title ?? null)
    if (exitTitle === null) throw new Error('диалог выхода не открылся')
    f = await framesOf('hud', 70)
    check('debug frames: диалог выхода — рамки шапки HUD под подложкой 70, кнопки окна в рамке над ней',
      sane(f) && f.leaks.length === 0 && f.under.includes('btn.menu') && f.under.includes('btn.speed.1') &&
        f.over.includes('modal.close') && f.over.includes('modal.btn.0'),
      JSON.stringify({ title: exitTitle, leaks: f.leaks, under: f.under, over: f.over }))
    await page.evaluate(() => window.itd.click('modal.close'))
    await delay(150)

    // C. Карточка события (панель 40 без ввода, кнопки btn.event.i 41): рамки кнопок на 41.5 в eventUI —
    // render() пересобирает карточку на каждом снапшоте, рамки вместе с ней (ITGAME-97). Событие ставит
    // itd.restore, как qa:party O2; снимает restore сейва до него: activeEvent null оставил бы дедлайн в плане
    // дня нерешённым (тик блока E поднял бы его снова), клик по btn.event.* шлёт настоящий event_choice.
    const before = await page.evaluate(async () => (await window.itd.snapshot()).save)
    await page.evaluate(async (tick) => {
      await window.itd.restore({ activeEvent: { ID: 'deadline', Tick: tick } })
    }, before.tickInDay)
    const evOpen = await page.evaluate(() =>
      window.itd.wait(() => window.itd.ids().some((n) => n.id === 'btn.event.1'), 5000).then(() => true, () => false))
    if (!evOpen) throw new Error('карточка события (deadline) не открылась')
    await delay(150)
    f = await framesOf('hud', 40)
    let own = await ownFrames('eventUI')
    check('debug frames: EV1 карточка события — btn.event.0/1 в рамке по одной на 41.5, рамки в eventUI, шапка HUD под панелью 40',
      sane(f) && f.leaks.length === 0 && once(f, 'btn.event.0', 41.5) && once(f, 'btn.event.1', 41.5) && own === 2 &&
        f.under.includes('btn.menu') && f.under.includes('btn.speed.1'),
      JSON.stringify({ leaks: f.leaks, event: f.at.filter((s) => s.startsWith('btn.event.')), own, under: f.under }))
    await shot(page, 'debug_frames_event')
    // Метка на кнопке: после снапшота btn.event.0 должна быть уже новым объектом.
    await page.evaluate(() => window.__itd.scene.getScene('hud').eventUI
      .find((o) => o.getData?.('id') === 'btn.event.0')?.setData('qaOld', true))
    await page.evaluate(() => window.itd.set({ money: 3456 })) // снапшот → render() пересобрал карточку
    await delay(300)
    const rebuilt = await page.evaluate(() => {
      const b = window.__itd.scene.getScene('hud').eventUI.find((o) => o.getData?.('id') === 'btn.event.0')
      return b != null && b.getData('qaOld') !== true
    })
    f = await framesOf('hud', 40)
    own = await ownFrames('eventUI')
    check('debug frames: EV2 снапшот под карточкой — карточка пересобрана, рамок кнопок ровно по одной, без дублей',
      rebuilt && sane(f) && f.leaks.length === 0 && once(f, 'btn.event.0', 41.5) && once(f, 'btn.event.1', 41.5) &&
        f.at.filter((s) => s.startsWith('btn.event.')).length === 2 && own === 2,
      JSON.stringify({ rebuilt, event: f.at.filter((s) => s.startsWith('btn.event.')), own }))
    // Диалог выхода HUD (70) поверх карточки: рамки её кнопок уходят под подложку вместе с шапкой.
    await page.evaluate(() => window.itd.click('btn.menu'))
    await delay(150)
    f = await framesOf('hud', 70)
    check('debug frames: EV3 диалог выхода поверх карточки — рамки btn.event.* и шапки под подложкой 70, ✕ окна над ней',
      sane(f) && f.leaks.length === 0 && f.under.includes('btn.event.0') && f.under.includes('btn.event.1') &&
        f.under.includes('btn.menu') && f.over.includes('modal.close'),
      JSON.stringify({ leaks: f.leaks, under: f.under, over: f.over }))
    await page.evaluate(() => window.itd.click('modal.close'))
    await delay(150)
    await page.evaluate(async (save) => { await window.itd.restore(save) }, before)
    const evGone = await page.evaluate(() =>
      window.itd.wait(() => !window.itd.ids().some((n) => n.id.startsWith('btn.event.')), 5000).then(() => true, () => false))
    await delay(150)
    f = await framesOf('hud', 40)
    own = await ownFrames('eventUI')
    const evLen = await uiLen('eventUI')
    check('debug frames: EV4 событие снято — ни одной рамки btn.event.*, eventUI пуст, рамки шапки на месте',
      evGone && sane(f) && f.at.every((s) => !s.startsWith('btn.event.')) && own === 0 && evLen === 0 &&
        f.under.includes('btn.menu'),
      JSON.stringify({ evGone, event: f.at.filter((s) => s.startsWith('btn.event.')), own, evLen }))

    // D. «Пока вас не было» (подложка 55 с вводом, кнопка 56): рамка подложки 55.5, кнопки 56.5, всё в
    // offlineUI (ITGAME-97). Окно открывает настоящий обработчик HUD, как qa:party O3: сначала финал
    // (btn.offline.menu — не кликаем, он уводит в меню), затем обычный отчёт поверх — он сносит прежнее окно
    // вместе с его рамками. Партия на паузе — окно скорость не трогает.
    const offline = (gameOver) => page.evaluate((gameOver) => {
      window.__itd.scene.getScene('hud').showOfflineReport({
        type: 'offline_report', ticks: 54, days: 1, income: 0, payroll: 0, balance: 0, gameOver, victory: false,
      })
    }, gameOver)
    await offline(true)
    await delay(200)
    f = await framesOf('hud', 55)
    own = await ownFrames('offlineUI')
    check('debug frames: OF1 «Пока вас не было» (финал) — btn.offline.menu в рамке на 56.5, подложка на 55.5, рамки в offlineUI, шапка HUD под подложкой 55',
      sane(f) && f.leaks.length === 0 && once(f, 'btn.offline.menu', 56.5) && count(f, 'Rectangle@55.5') === 1 &&
        own === 2 && f.under.includes('btn.menu') && f.under.includes('btn.speed.1'),
      JSON.stringify({ leaks: f.leaks, over: f.at.filter((s) => s.startsWith('btn.offline.') || s === 'Rectangle@55.5'), own, under: f.under }))
    await offline(false)
    await delay(200)
    f = await framesOf('hud', 55)
    own = await ownFrames('offlineUI')
    check('debug frames: OF2 обычный отчёт сменил финальный — рамки btn.offline.menu нет, btn.offline.continue в рамке одной на 56.5, рамка подложки одна',
      sane(f) && f.leaks.length === 0 && framed(f, 'btn.offline.menu').length === 0 &&
        once(f, 'btn.offline.continue', 56.5) && count(f, 'Rectangle@55.5') === 1 && own === 2,
      JSON.stringify({ leaks: f.leaks, over: f.at.filter((s) => s.startsWith('btn.offline.') || s === 'Rectangle@55.5'), own }))
    await shot(page, 'debug_frames_offline')
    await page.evaluate(() => window.itd.set({ money: 4567 })) // снапшот → рамки шапки перерисованы под окном
    await delay(300)
    f = await framesOf('hud', 55)
    check('debug frames: OF3 снапшот под «Пока вас не было» — перерисованные рамки шапки под подложкой 55, рамки окна по одной',
      sane(f) && f.leaks.length === 0 && f.under.includes('btn.speed.1') && once(f, 'btn.offline.continue', 56.5) &&
        count(f, 'Rectangle@55.5') === 1,
      JSON.stringify({ leaks: f.leaks, under: f.under.length, over: f.at.filter((s) => s.startsWith('btn.offline.') || s === 'Rectangle@55.5') }))
    const cont = await page.evaluate(() => window.itd.click('btn.offline.continue'))
    await delay(150)
    f = await framesOf('hud', 55)
    const offIds = await page.evaluate(() => window.itd.ids().filter((n) => n.id.startsWith('btn.offline.')).map((n) => n.id))
    const offLen = await uiLen('offlineUI')
    check('debug frames: OF4 «Продолжить →» — окно ушло с рамками: ни рамки btn.offline.* и подложки 55.5, ни id btn.offline.*',
      cont.ok === true && sane(f) && f.at.every((s) => !s.startsWith('btn.offline.') && s !== 'Rectangle@55.5') &&
        offIds.length === 0 && offLen === 0,
      JSON.stringify({ cont, left: f.at.filter((s) => s.startsWith('btn.offline.') || s === 'Rectangle@55.5'), offIds, offLen }))

    // E. Отчёт дня (подложка 50): конец дня на ходу, затем ответ на его set_speed 0.
    await page.evaluate(async () => {
      await window.itd.set({ money: 50000, tickInDay: 53 }) // 53 — последний тик running (dayTicks 54)
      window.itd.speed(2)
      await window.itd.wait(() => window.itd.ids().some((x) => x.id === 'btn.next_day'), 15000)
    })
    f = await framesOf('hud', 50)
    check('debug frames: отчёт дня — рамки шапки HUD под подложкой 50, «Следующий день» и чекбокс в рамке над ней',
      sane(f) && f.leaks.length === 0 && f.under.includes('btn.menu') && f.under.includes('btn.speed.1') &&
        f.over.includes('btn.next_day') && f.over.includes('btn.skip_reports'),
      JSON.stringify({ leaks: f.leaks, under: f.under, over: f.over }))
    await page.evaluate(() => window.itd.wait((s, srv) => srv.snapshot?.speed === 0, 5000))
    await delay(300)
    f = await framesOf('hud', 50)
    check('debug frames: снапшот под отчётом — перерисованные рамки шапки остаются под подложкой',
      sane(f) && f.leaks.length === 0 && f.under.includes('btn.speed.1') && f.over.includes('btn.next_day'),
      JSON.stringify({ leaks: f.leaks, under: f.under.length, over: f.over }))

    check('debug frames: нет pageerror', pageErrors.length === 0, pageErrors.join(' | '))
    await shot(page, 'debug_frames_report')
  } catch (e) {
    check('debug frames: кейс выполнен без ошибок', false, e instanceof Error ? e.message : String(e))
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

// ── Кейс 6: spare_pcs — desk_pc_off (ПК куплен, сотрудник не нанят) ─────────
// ПК больше, чем сотрудников (см. fixtures/spare_pcs.json): слоты 0-4 —
// стол+сотрудник, 5-7 — ПК без сотрудника (desk_pc_off), 8-11 — вовсе без
// ПК (desk_empty; начальник в фикстуре есть, так что cap=officeSlots=12 —
// это не заглушка «наймите начальника»). Единственная фикстура с
// desk_pc_off — до неё full_office (все места заняты) и mid_day10 (все ПК
// разобраны) кейса не давали.
async function caseSparePcs(browser) {
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  await page.setViewport({ width: 1920, height: 1080 })
  try {
    await loadScenario(page, 'spare_pcs', 'sparepcs')
    const images = await dumpImages(page, 'office')

    // Геометрия слота — та же формула, что в OfficeScene.ts (GRID).
    const slotXY = (i) => ({
      x: 260 + (i % 4) * 270,
      y: 220 + Math.floor(i / 4) * 170,
    })
    const at = (x, y) => images.filter((img) => Math.abs(img.x - x) < 1 && Math.abs(img.y - y) < 1)

    // Слоты 0-4: ровно один desk_pc/_broken (HD) или ничего (легаси,
    // стол запечён в worker.png) + office.worker.i рисует worker/worker_N.
    for (let i = 0; i < 5; i++) {
      const { x, y } = slotXY(i)
      const here = at(x, y)
      const worker = here.find((img) => img.id === `office.worker.${i}`)
      check(`spare_pcs: office.worker.${i} на месте`, !!worker, worker ? `key=${worker.key}` : 'не найден')
      if (worker) {
        check(`spare_pcs: office.worker.${i} рисует worker/worker_1..3`, WORKER_KEY_RE.test(worker.key),
          `key=${worker.key}`)
      }
      const desks = here.filter((img) => !img.id && (img.key === 'desk_pc' || img.key === 'desk_pc_broken'))
      if (WORKER_INCLUDES_DESK) {
        check(`spare_pcs: слот ${i} (includesDesk=true) без отдельного стола`, desks.length === 0,
          desks.length ? JSON.stringify(desks) : 'ok')
      } else {
        check(`spare_pcs: слот ${i} (includesDesk=false) — ровно один desk_pc/_broken`, desks.length === 1,
          `n=${desks.length}`)
      }
    }

    // Слоты 5-7: desk_pc_off, никакого office.worker.i в этой точке.
    for (let i = 5; i <= 7; i++) {
      const { x, y } = slotXY(i)
      const here = at(x, y)
      const off = here.filter((img) => img.key === 'desk_pc_off')
      check(`spare_pcs: слот ${i} рисует desk_pc_off`, off.length === 1, `n=${off.length}`)
      const worker = here.find((img) => img.id === `office.worker.${i}`)
      check(`spare_pcs: слот ${i} без сотрудника`, !worker, worker ? `key=${worker.key}` : 'ok')
    }

    // Слоты 8-11: ПК нет вовсе — desk_empty (начальник открывает cap=12,
    // поэтому это не заглушка «наймите начальника»).
    for (let i = 8; i <= 11; i++) {
      const { x, y } = slotXY(i)
      const here = at(x, y)
      const empty = here.filter((img) => img.key === 'desk_empty')
      check(`spare_pcs: слот ${i} рисует desk_empty`, empty.length === 1, `n=${empty.length}`)
    }

    const overlaps = await page.evaluate(() => window.itd.overlaps())
    check('spare_pcs: itd.overlaps() пуст', overlaps.length === 0, `n=${overlaps.length}`)
    const offscreen = await page.evaluate(() => window.itd.offscreen())
    check('spare_pcs: itd.offscreen() пуст', offscreen.length === 0, `n=${offscreen.length}`)
    check('spare_pcs: нет pageerror', pageErrors.length === 0, pageErrors.join(' | '))
    await shot(page, 'spare_pcs')
  } catch (e) {
    check('spare_pcs: кейс выполнен без ошибок', false, e instanceof Error ? e.message : String(e))
  } finally {
    await page.close().catch(() => {})
  }
}

// ── Кейс 9: полка быта — холодильник и кофеварка только после кулера (ITGAME-102) ──
// spare_pcs: $5000, быта нет. Без кулера ячейки office.amenity.fridge/
// coffee_machine закрыты (disabled, без руки-курсора, «нужен кулер»): настоящий
// клик мышью ничего не шлёт, наведение — тултип «Сначала купите кулер»; после
// покупки кулера те же клики шлют buy_fridge/buy_coffee и сервер их принимает.
// Сервер отказывает и сам (need_cooler) — это go-тест TestFridgeAndCoffeeNeedCooler.
async function caseAmenityShelf(browser) {
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  await page.setViewport({ width: 1920, height: 1080 })
  try {
    await loadScenario(page, 'spare_pcs', 'shelf')
    const box = await canvasBox(page)
    const SHELF = { cooler: 220, fridge: 350, coffee_machine: 480 } // OfficeScene.ts: ax = 220 + i * 130
    const SHELF_Y = 660
    const cell = (key) => page.evaluate((id) => {
      const o = window.__itd.scene.getScene('office').children.list.find((n) => n.getData?.('id') === id)
      if (!o) return null
      return { type: o.type, disabled: o.getData('disabled') === true, cursor: o.input?.cursor ?? null }
    }, `office.amenity.${key}`)
    const tooltip = () => page.evaluate(() => {
      const c = window.__itd.scene.getScene('office').children.list.find((o) => o.type === 'Container')
      return { visible: c?.visible ?? null, text: c?.list?.find((o) => o.type === 'Text')?.text ?? '' }
    })
    const errorsSince = (t) => page.evaluate((t) => window.itd.net(50).last
      .filter((m) => m.dir === 'in' && m.type === 'error' && m.at > t).map((m) => m.info?.code ?? '?'), t)

    for (const key of ['fridge', 'coffee_machine']) {
      const c = await cell(key)
      check(`shelf: без кулера office.amenity.${key} закрыт (disabled, без руки-курсора)`,
        c?.type === 'Rectangle' && c.disabled && c.cursor !== 'pointer', JSON.stringify(c))
    }
    const cooler0 = await cell('cooler')
    check('shelf: кулер открыт (рука-курсор, не disabled)',
      cooler0?.type === 'Rectangle' && !cooler0.disabled && cooler0.cursor === 'pointer', JSON.stringify(cooler0))

    await page.mouse.move(box.x + SHELF.fridge * box.k, box.y + SHELF_Y * box.k)
    await delay(150)
    const tip = await tooltip()
    check('shelf: наведение на закрытый холодильник — тултип «Сначала купите кулер»',
      tip.visible === true && tip.text.includes('Сначала купите кулер'), JSON.stringify(tip))
    await shot(page, 'shelf_locked')

    let t0 = (await lastOut(page, 50)).at(-1)?.at ?? 0
    for (const key of ['fridge', 'coffee_machine']) {
      await worldClick(page, box, SHELF[key], SHELF_Y)
    }
    await delay(300)
    const sentLocked = (await lastOut(page, 50)).filter((m) => m.at > t0)
    check('shelf: клики по закрытым холодильнику и кофеварке ничего не шлют', sentLocked.length === 0,
      JSON.stringify(sentLocked.map((m) => m.type)))

    t0 = (await lastOut(page, 50)).at(-1)?.at ?? 0
    await worldClick(page, box, SHELF.cooler, SHELF_Y)
    await page.waitForFunction((id) => window.__itd.scene.getScene('office').children.list
      .some((n) => n.type === 'Image' && n.getData?.('id') === id), { timeout: 5000 }, 'office.amenity.cooler')
    const sentCooler = (await lastOut(page, 50)).filter((m) => m.at > t0).map((m) => m.type)
    check('shelf: клик по кулеру шлёт buy_cooler, кулер встаёт', sentCooler.join() === 'buy_cooler',
      JSON.stringify(sentCooler))
    await page.mouse.move(0, 0)
    for (const key of ['fridge', 'coffee_machine']) {
      const c = await cell(key)
      check(`shelf: после кулера office.amenity.${key} открыт`,
        c?.type === 'Rectangle' && !c.disabled && c.cursor === 'pointer', JSON.stringify(c))
    }

    t0 = (await lastOut(page, 50)).at(-1)?.at ?? 0
    await worldClick(page, box, SHELF.fridge, SHELF_Y)
    await delay(400)
    await worldClick(page, box, SHELF.coffee_machine, SHELF_Y)
    await delay(400)
    const sentOpen = (await lastOut(page, 50)).filter((m) => m.at > t0).map((m) => m.type)
    const images = await dumpImages(page, 'office')
    const bought = ['fridge', 'coffee_machine'].filter((k) => images.some((n) => n.id === `office.amenity.${k}` && n.key === k))
    const errs = await errorsSince(t0)
    check('shelf: после кулера клики шлют buy_fridge и buy_coffee, оба куплены, ошибок нет',
      sentOpen.join() === 'buy_fridge,buy_coffee' && bought.length === 2 && errs.length === 0,
      JSON.stringify({ sent: sentOpen, bought, errs }))

    check('shelf: нет pageerror', pageErrors.length === 0, pageErrors.join(' | '))
    await shot(page, 'shelf_open')
  } catch (e) {
    check('shelf: кейс выполнен без ошибок', false, e instanceof Error ? e.message : String(e))
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
  for (const runCase of [
    caseFullOffice, caseLunch, caseBrokenPc, caseTooltipUnderModal, caseDebugFramesUnderWindows, caseServerRoomGateway, caseServerRoomEmptyRacks, caseSparePcs, caseAmenityShelf,
  ]) {
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
