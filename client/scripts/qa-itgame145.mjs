// qa-itgame145 — отдел админов (ITGAME-101/145): комната «АДМ» рядом с «СРВ»,
// закрыта и покупается, как офис; админ закреплён за офисом и нанимается
// кнопками колонки отдела. Настоящими кликами мыши (точки из itd.screen()):
//   D1  вкладка nav.adminDept: замок, цена $3,000; закрытая комната — «Отдел
//       админов закрыт», dept.buy, колонки найма нет
//   D2  dept.buy без денег — not_enough_money, отдел закрыт
//   D3  dept.buy с деньгами — buy_admin_dept, −$3,000, три места, вкладка «0/3»
//   D4  btn.admin.0 доступна; btn.admin.1/2 — D, тултип «Офис N не куплен»
//   D5  клик по выключенной btn.admin.1 ничего не шлёт
//   D6  клик по btn.admin.0 — hire_admin 0, «Админ О1 ✓», место с админом,
//       «свободен», вкладка «1/3»
//   D7  фикстура admin_dept, живые тики: строка цели идёт «чистит место 2» →
//       «чистит место 7» → «чинит место 4» → «свободен»
//   D8  наведение на dept.admin.0 — тултип: имя, «Админ офиса 1», зарплата, цель
//   D8b тултип переживает снапшот под курсором и не залипает, когда курсор ушёл
//   D9  ПКМ по админу — «Уволить админа?» с компенсацией; подтверждение —
//       fire_admin 0, место пустое
//   D10 офис: тултип места, которое админ кликает, — «чистит админ»; у
//       чистого места строки нет
//   D11 гонка с тиком админа: not_infected в офисе с админом — без тоста;
//       not_broken в офисе без админа — тост «ПК не сломан»
//   D12 отчёт дня — «Админы:    починили k ПК,» и под колонкой значений «вычистили m мест»
//   D13 три админа с длинными именами: overlaps()/offscreen() пусты на 1× и 1.4×
//   Z   нет pageerror
//
// Self-serve: без QA_BASE поднимает Go-сервер на QA_PORT (по умолчанию :4192)
// с ITGAME_DEBUG=1; нужен client/dist (npm run build). saves: 'off'.
import { setTimeout as delay } from 'node:timers/promises'
import puppeteer from 'puppeteer-core'
import { chromePath } from './lib/chrome.mjs'
import { selfServe } from './lib/selfserve.mjs'
import { waitMenuReady } from './lib/menu.mjs'

const SELF_PORT = Number(process.env.QA_PORT) || 4192
const BASE = process.env.QA_BASE || `http://127.0.0.1:${SELF_PORT}`

const results = []
const check = (name, pass, fact) => {
  results.push({ name, pass, fact })
  console.log(`${pass ? 'PASS' : 'FAIL'}: ${name} — ${fact}`)
}

let stopServer = null
if (!process.env.QA_BASE) {
  try {
    ;({ stop: stopServer } = await selfServe({ port: SELF_PORT, saves: 'off', label: 'QA-ITGAME145' }))
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  }
}

let browser = null
try {
  browser = await puppeteer.launch({ executablePath: chromePath(), headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const page = await browser.newPage()
  await page.setViewport({ width: 1920, height: 1080 })
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  const row = (id) => page.evaluate((k) => window.itd.screen().items.find((i) => i.startsWith(k + '|'))?.split('|') ?? null, id.replace(/\./g, ':'))
  const realClick = async (id, button = 'left') => {
    const r = await row(id)
    if (!r) throw new Error(`нет ${id} в itd.screen()`)
    await page.mouse.click(Number(r[2]), Number(r[3]), { button })
    await delay(400)
    return r
  }
  const sentSince = (at) => page.evaluate((t) => window.itd.net(80).last.filter((m) => m.dir === 'out' && m.at > t).map((m) => ({ type: m.type, office: m.info?.office })), at)
  const lastAt = () => page.evaluate(() => window.itd.net(80).last.at(-1)?.at ?? 0)
  const texts = () => page.evaluate(() => window.itd.text().map((t) => t.text ?? ''))
  const textOf = (id) => page.evaluate((i) => window.itd.nodes().find((n) => n.id === i)?.text ?? null, id)
  const goRoom = async (nav) => {
    for (let i = 0; i < 20; i++) {
      const r = await page.evaluate((n) => window.itd.click(n), nav)
      if (r.code !== 'debounced') break
      await delay(150)
    }
    await delay(400)
  }
  const navSub = () => page.evaluate(() => {
    const bg = window.itd.nodes().find((n) => n.id === 'nav.adminDept')
    const sub = window.itd.text().find((t) => t.scene === 'hud' && Math.abs((t.x ?? 0) - 32) < 40 && Math.abs((t.y ?? 0) - ((bg?.y ?? 0) + 36)) < 12 && t.text !== 'АДМ')
    const lock = window.itd.nodes().find((n) => n.id === 'hud.lock.adminDept')
    return { sub: sub?.text ?? null, lock: lock?.visible ?? null }
  })

  await page.goto(`${BASE}/?debug=1&scenario=fresh&seed=1`, { waitUntil: 'domcontentloaded' })
  await waitMenuReady(page)
  await page.evaluate(() => localStorage.setItem('itd.onboard', 'done'))
  await page.evaluate(() => window.itd.click('menu.diff.normal'))
  await page.waitForFunction(() => window.itd.state().connected === true, { timeout: 20000 })
  await page.evaluate(() => window.itd.pause())
  await delay(300)

  // D1
  await goRoom('nav.adminDept')
  const d1 = {
    scene: await page.evaluate(() => window.__itd.scene.isActive('adminDept')),
    title: (await texts()).includes('Отдел админов закрыт'),
    buy: await row('dept.buy'),
    hire: await row('btn.admin.0'),
    nav: await navSub(),
  }
  check('D1: вкладка АДМ — замок и $3,000, «Отдел админов закрыт», dept.buy есть, колонки найма нет',
    d1.scene && d1.title && !!d1.buy && d1.hire === null && d1.nav.sub === '$3,000' && d1.nav.lock === true, JSON.stringify(d1))

  // D2
  let at = await lastAt()
  await realClick('dept.buy')
  const d2 = { sent: await sentSince(at), dept: await page.evaluate(() => window.itd.state().adminDept) }
  check('D2: dept.buy при $600 — buy_admin_dept ушёл, сервер отказал, отдел закрыт',
    d2.sent.some((m) => m.type === 'buy_admin_dept') && d2.dept === false, JSON.stringify(d2))

  // D3
  await page.evaluate(() => window.itd.set({ money: 10000 }))
  await delay(300)
  at = await lastAt()
  await realClick('dept.buy')
  const d3 = {
    sent: await sentSince(at),
    dept: await page.evaluate(() => window.itd.state().adminDept),
    money: await page.evaluate(() => window.itd.state().balance),
    seats: (await texts()).filter((t) => /^офис [123]$/.test(t)).length,
    nav: await navSub(),
  }
  check('D3: покупка — buy_admin_dept, отдел открыт, $7,000, три места, вкладка «0/3» без замка',
    d3.sent.filter((m) => m.type === 'buy_admin_dept').length === 1 && d3.dept === true && d3.money === 7000 && d3.seats === 3 &&
      d3.nav.sub === '0/3' && d3.nav.lock === false, JSON.stringify(d3))

  // D4
  const flags = async (id) => (await row(id))?.[4] ?? null
  await page.evaluate(() => window.itd.hover('btn.admin.1'))
  await delay(150)
  const d4 = {
    b0: await flags('btn.admin.0'), b1: await flags('btn.admin.1'), b2: await flags('btn.admin.2'),
    tip: await textOf('room.tooltip.text'),
    label: await page.evaluate(() => window.itd.text().find((t) => (t.text ?? '').startsWith('Админ О1'))?.text ?? null),
  }
  check('D4: btn.admin.0 доступна «Админ О1 / $600»; О2/О3 — D, тултип «Офис 2 не куплен»',
    !(d4.b0 ?? 'D').includes('D') && (d4.b1 ?? '').includes('D') && (d4.b2 ?? '').includes('D') && d4.tip === 'Офис 2 не куплен' && d4.label === 'Админ О1\n$600',
    JSON.stringify(d4))

  // D5
  at = await lastAt()
  await realClick('btn.admin.1')
  const d5 = await sentSince(at)
  check('D5: клик по выключенной btn.admin.1 ничего не шлёт', d5.length === 0, JSON.stringify(d5))

  // D6: найм смен админов по очереди (ITGAME-144)
  at = await lastAt()
  await realClick('btn.admin.0')
  const d6a = {
    sent: await sentSince(at),
    admin: await page.evaluate(() => window.itd.server().snapshot.offices[0].admin),
    label: await page.evaluate(() => window.itd.text().find((t) => (t.text ?? '').startsWith('Админ О1'))?.text ?? null),
    seat: !!(await row('dept.admin.0')),
    status: await textOf('dept.status.0'),
    nav: await navSub(),
  }
  at = await lastAt()
  await realClick('btn.admin.0')
  await realClick('btn.admin.0')
  const d6b = {
    sent: await sentSince(at),
    label: await page.evaluate(() => window.itd.text().find((t) => (t.text ?? '').startsWith('Админ О1'))?.text ?? null),
    shifts: await page.evaluate(() => window.itd.server().snapshot.offices[0].adminShifts.length),
  }
  check('D6: найм смен по очереди — 1-й найм «Админ О1 (н1)», 3-й найм «Админ О1 ✓», 3 смены в офисе',
    d6a.sent.length === 1 && d6a.sent[0].type === 'hire_admin' && d6a.admin !== '' && d6a.label === 'Админ О1 (н1)\n$600' &&
      d6a.seat && d6a.status === 'свободен' && d6a.nav.sub === '1/3' && d6b.shifts === 3 && d6b.label === 'Админ О1 ✓',
    JSON.stringify({ d6a, d6b }))

  // D7: очередь админа на живых тиках
  await page.evaluate(() => window.itd.scenario('admin_dept'))
  await delay(1000)
  await page.evaluate(() => window.itd.pause())
  await goRoom('nav.adminDept')
  const seen = []
  const push = async () => {
    const s = await textOf('dept.status.0')
    if (s && seen.at(-1) !== s) seen.push(s)
  }
  await push()
  await page.evaluate(() => window.itd.speed(1))
  for (let i = 0; i < 60 && seen.at(-1) !== 'свободен'; i++) {
    await delay(200)
    await push()
  }
  await page.evaluate(() => window.itd.pause())
  check('D7: строка цели вживую: «чистит место 2» → «чистит место 7» → «чинит место 4» → «свободен»',
    JSON.stringify(seen) === JSON.stringify(['чистит место 2', 'чистит место 7', 'чинит место 4', 'свободен']), JSON.stringify(seen))

  // D8: тултип админа
  await page.evaluate(() => window.itd.scenario('admin_dept'))
  await delay(1000)
  await page.evaluate(() => window.itd.pause())
  await goRoom('nav.adminDept')
  await page.evaluate(() => window.itd.hover('dept.admin.0'))
  await delay(200)
  const tip8 = await page.evaluate(() => window.__itd.scene.getScene('adminDept').children.list.find((o) => o.type === 'Container' && o.visible)?.list?.find((x) => x.type === 'Text')?.text ?? null)
  check('D8: тултип админа — имя, «Админ офиса 1», зарплата $300, «Сейчас: чистит место 2 — 0/3», увольнение $300',
    !!tip8 && tip8.startsWith('Олег Смирнов\n') && tip8.includes('Админ офиса 1') && tip8.includes('Зарплата:  $300/день') &&
      tip8.includes('Сейчас: чистит место 2 — 0/3') && tip8.includes('уволить: $300'), JSON.stringify(tip8))

  // D8b: тултип не залипает (как место в офисе, ITGAME-89): курсор над админом —
  // снапшот пересоздаёт спрайт, тултип на месте; курсор ушёл одним движением —
  // по новому спрайту pointerout не приходит, и следующий снапшот тултип не поднимает
  const deptTip = () => page.evaluate(() => window.__itd.scene.getScene('adminDept').children.list.some((o) => o.type === 'Container' && o.visible))
  const seat8 = await row('dept.admin.0')
  const away8 = await row('nav.office0')
  await page.mouse.move(Number(seat8[2]), Number(seat8[3]))
  await delay(200)
  const over8 = await deptTip()
  await page.evaluate(() => window.itd.set({ money: 8001 }))
  await delay(300)
  const kept8 = await deptTip()
  await page.mouse.move(Number(away8[2]), Number(away8[3]))
  await delay(100)
  await page.evaluate(() => window.itd.set({ money: 8002 }))
  await delay(300)
  const left8 = await deptTip()
  check('D8b: тултип админа переживает снапшот под курсором и не залипает, когда курсор ушёл',
    over8 && kept8 && !left8, JSON.stringify({ over8, kept8, left8 }))

  // D9: ПКМ — увольнение
  await page.mouse.move(5, 5)
  await realClick('dept.admin.0', 'right')
  const modal9 = (await texts()).filter((t) => t === 'Уволить админа?' || t.includes('Компенсация: $300'))
  at = await lastAt()
  const btn9 = await page.evaluate(() => window.itd.screen().items.find((i) => i.startsWith('modal:btn:0|'))?.split('|') ?? null)
  if (btn9) await page.mouse.click(Number(btn9[2]), Number(btn9[3]))
  await delay(500)
  const d9 = {
    modal9, btn: btn9?.[1] ?? null, sent: await sentSince(at),
    admin: await page.evaluate(() => window.itd.server().snapshot.offices[0].admin),
    empty: (await texts()).includes('нет админа'),
  }
  check('D9: ПКМ по админу — «Уволить админа?», «Компенсация: $300»; подтверждение — fire_admin 0, место пустое',
    d9.modal9.includes('Уволить админа?') && d9.modal9.some((t) => t.includes('Компенсация: $300')) && d9.sent.length === 1 && d9.sent[0].type === 'fire_admin' &&
      d9.sent[0].office === 0 && d9.admin === '' && d9.empty, JSON.stringify(d9))

  // D10: тултип места в офисе
  await page.evaluate(() => window.itd.scenario('admin_dept'))
  await delay(1000)
  await page.evaluate(() => window.itd.pause())
  await goRoom('nav.office0')
  const officeTip = async (slot) => {
    await page.evaluate((i) => window.itd.hover(`office.slot.${i}`), slot)
    await delay(200)
    return page.evaluate(() => window.__itd.scene.getScene('office').children.list.find((o) => o.type === 'Container' && o.visible)?.list?.find((x) => x.type === 'Text')?.text ?? null)
  }
  const tipSick = await officeTip(1)
  const tipWell = await officeTip(4)
  check('D10: тултип места 2 (цель админа) — «чистит админ»; у чистого места 5 строки нет',
    (tipSick ?? '').split('\n').includes('чистит админ') && !!tipWell && !tipWell.includes('админ'), JSON.stringify({ tipSick, tipWell }))

  // D11: гонка с тиком админа
  const toastLike = (needle) => page.evaluate((n) => window.itd.text().filter((t) => (t.text ?? '').includes(n)).length, needle)
  const before11 = await toastLike('На этом ПК нет вируса')
  const r11 = await page.evaluate(() => window.itd.cmd('virus_click', 0, { slot: 4 }))
  await delay(400)
  const after11 = await toastLike('На этом ПК нет вируса')
  await goRoom('nav.office1')
  const beforeNb = await toastLike('ПК не сломан')
  const r11b = await page.evaluate(() => window.itd.cmd('repair_click', 1, { slot: 0 }))
  await delay(400)
  const afterNb = await toastLike('ПК не сломан')
  check('D11: not_infected в офисе с админом — без тоста; not_broken в офисе без админа — тост «ПК не сломан»',
    r11.code === 'not_infected' && after11 === before11 && r11b.code === 'not_broken' && afterNb > beforeNb,
    JSON.stringify({ r11: r11.code, before11, after11, r11b: r11b.code, beforeNb, afterNb }))

  // D12: строки «Админы» отчёта дня (ITGAME-159) — что админы сделали, глаголами. Одной строкой
  // («Админы:    починили k ПК, вычистили m мест», 42–44 знака) панель 440 не вмещает, поэтому обе
  // части — две строки, вторая под колонкой значений. Админа сначала отпускаем (adminSlot −1: места
  // 2 и 7 вычищены, 4 починено) — обе части есть; k и m — счётчики дня из сейва (до next_day их не
  // обнуляют). Ширина строк — мерой контекста самого Text отчёта (тело шире их за счёт журнала),
  // тело — внутри рамки с полями ≥ 16 px (правило R1 qa:report-pause), линтер HUD пуст.
  await page.evaluate(() => window.itd.scenario('admin_dept'))
  await delay(1000)
  await page.evaluate(() => window.itd.speed(3))
  const free12 = await page.evaluate(() =>
    window.itd.wait((s, srv) => srv.snapshot?.offices?.[0]?.adminSlot === -1, 15000).then(() => true, () => false))
  await page.evaluate(() => window.itd.set({ tickInDay: 53 }))
  await page.waitForFunction(() => window.itd.text().some((n) => /^День \d+ завершён$/.test(n.text ?? '')), { timeout: 10000 }).catch(() => {})
  const d12 = await page.evaluate(async () => {
    const save = (await window.itd.snapshot()).save
    const box = (n) => n && { left: n.cx - n.w / 2, right: n.cx + n.w / 2, top: n.cy - n.h / 2, bottom: n.cy + n.h / 2 }
    const body = window.itd.text().find((n) => n.scene === 'hud' && (n.text ?? '').startsWith('Доход:'))
    const panel = window.itd.nodes().find((n) => n.scene === 'hud' && n.type === 'Rectangle' && n.depth === 51 && n.fill === '#14162b')
    const obj = window.__itd.scene.getScene('hud').children.list.find((o) => o.type === 'Text' && (o.text ?? '').startsWith('Доход:'))
    const lines = (body?.text ?? '').split('\n')
    const i = lines.findIndex((l) => l.startsWith('Админы:'))
    const admin = i < 0 ? [] : lines.slice(i, i + 2)
    return {
      repairs: save.dayAdminRepairs, cleaned: save.dayAdminCleaned, admin,
      widths: admin.map((l) => (obj ? Math.round(obj.context.measureText(l).width) : -1)),
      body: box(body), panel: box(panel),
      overlaps: window.itd.overlaps().filter((e) => e.scene === 'hud'),
      offscreen: window.itd.offscreen().filter((e) => e.scene === 'hud'),
    }
  })
  const inside12 = (b, p) => !!b && !!p && b.left >= p.left + 16 && b.right <= p.right - 16 && b.top >= p.top && b.bottom <= p.bottom
  check('D12: отчёт дня — «Админы:    починили k ПК,» и под колонкой значений «вычистили m мест» по счётчикам дня; строки ≤ 392 px, тело в рамке, линтер HUD пуст',
    free12 && d12.repairs > 0 && d12.cleaned > 0 && d12.admin.length === 2
      && d12.admin[0] === `Админы:    починили ${d12.repairs} ПК,`
      && new RegExp(`^ {11}вычистили ${d12.cleaned} (место|места|мест)$`).test(d12.admin[1]) && !/\b[234] мест$/.test(d12.admin[1])
      && d12.widths.every((w) => w > 0 && w <= 440 - 2 * 24)
      && inside12(d12.body, d12.panel) && d12.overlaps.length === 0 && d12.offscreen.length === 0,
    JSON.stringify({ free12, ...d12 }).slice(0, 800))
  await page.evaluate(() => window.itd.key('enter'))
  await delay(400)

  // D13: три админа с длинными именами, оба масштаба
  await page.evaluate(() => window.itd.scenario('admin_dept'))
  await delay(1000)
  await page.evaluate(() => window.itd.pause())
  await page.evaluate(async () => {
    const save = (await window.itd.snapshot()).save
    const long = ['Константин Константинопольский', 'Александра Преображенская', 'Владислав Венедиктов-Яблоков']
    save.offices = save.offices.map((o, i) => ({ ...o, Unlocked: true, Admin: long[i] }))
    await window.itd.restore({ offices: save.offices })
  })
  await goRoom('nav.adminDept')
  const lint = async () => page.evaluate(() => ({ ov: window.itd.overlaps(), off: window.itd.offscreen(), scale: localStorage.getItem('itd.uiScale') }))
  const z1 = await lint()
  await page.evaluate(() => window.itd.click('btn.zoom'))
  await delay(300)
  await page.evaluate(() => window.itd.click('btn.zoom'))
  await delay(400)
  const z2 = await lint()
  const names = (await texts()).filter((t) => t.startsWith('Константин') || t.startsWith('Александра') || t.startsWith('Владислав')).length
  check('D13: три админа с длинными именами — overlaps()/offscreen() пусты на двух масштабах',
    names === 3 && z1.ov.length === 0 && z1.off.length === 0 && z2.ov.length === 0 && z2.off.length === 0 && z1.scale !== z2.scale,
    JSON.stringify({ names, z1, z2 }))

  // D14: ночная работа админов (ITGAME-144) — ночные админы чинят и вычищают офис за ночь
  await page.evaluate(async () => {
    const save = (await window.itd.snapshot()).save
    save.offices[0].AdminShifts = [
      { Shift: 1, Name: 'День Админ', UnpaidToday: false, HireDay: 1 },
      { Shift: 2, Name: 'Ночь1 Админ', UnpaidToday: false, HireDay: 1 },
      { Shift: 3, Name: 'Ночь2 Админ', UnpaidToday: false, HireDay: 1 },
    ]
    save.offices[0].Admin = 'День Админ'
    save.offices[0].Employees.forEach((e) => { e.Infected = false; e.PCBroken = false })
    save.offices[0].Employees[0].Infected = true
    save.offices[0].Employees[1].PCBroken = true
    save.offices[0].Employees[1].RepairNeeded = 5
    save.phase = 'day_report'
    save.tickInDay = 54
    await window.itd.restore({ offices: save.offices, phase: save.phase, tickInDay: save.tickInDay })
  })
  await delay(400)
  await page.evaluate(() => window.itd.cmd('next_day'))
  await delay(500)
  const d14 = await page.evaluate(async () => {
    const save = (await window.itd.snapshot()).save
    const log = save.eventLog ?? []
    return {
      infected: save.offices[0].Employees[0].Infected,
      pcBroken: save.offices[0].Employees[1].PCBroken,
      repairs: save.dayAdminRepairs,
      cleaned: save.dayAdminCleaned,
      summary: log.find((l) => l.includes('ночью админы починили')),
    }
  })
  check('D14: ночная работа админов — за ночь починили и вычистили, сводка в журнале утра',
    d14.infected === false && d14.pcBroken === false && d14.repairs === 1 && d14.cleaned === 1 &&
      d14.summary === '10:00 ночью админы починили 1 ПК, вычистили 1 мест', JSON.stringify(d14))

  check('Z: нет pageerror', pageErrors.length === 0, JSON.stringify(pageErrors))
} catch (e) {
  check('сценарий выполнен без исключений', false, e instanceof Error ? e.stack : String(e))
} finally {
  if (browser) await browser.close()
  if (stopServer) await stopServer()
}

const failed = results.filter((r) => !r.pass)
console.log(`\nИтог QA-ITGAME145: ${results.length - failed.length}/${results.length} проверок прошло`)
if (failed.length > 0) {
  console.error(`Провалено: ${failed.map((f) => f.name).join(', ')}`)
  process.exit(1)
}
console.log('Все проверки пройдены успешно!')
