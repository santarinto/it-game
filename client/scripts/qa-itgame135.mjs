// qa-itgame135 — рабочие места (ITGAME-135): уровни ПК (ЭЛТ → ЖК → 2×ЖК), износ и
// «требуется замена». Фикстура worn_pcs, партия НА ПАУЗЕ весь прогон (каждое живое
// занятое место на пределе износа: живая поломка убила бы ПК). Настоящими кликами
// мыши (точки из itd.screen()), числа — из itd.server().snapshot, не литералами:
//   W1  подписи уровней office.pc.i: 0 «ЖК», 1 «2×ЖК», 3/4/5 «ЭЛТ»; на мёртвом столе (2)
//       и столе без ПК (6) их нет; itd.state().deadPCs === 1
//   W2  мёртвое место: «✖ замена» (office.dead.2), «заменить $500» (office.replace.2),
//       стол desk_pc_broken с серым тоном, ровно одна серая мигающая зона office.slot.2
//   W3  оранжевая подпись у места на пределе износа (0), у чистого (5) — нет
//   W4  тултип «ПК: ЭЛТ ×1.0 · износ k/N — следующая поломка: замена»; наведение на
//       подпись office.pc.3 тултип сотрудника не гасит
//   W5  клик по office.pc.3 — окно «Рабочее место 4 — офис 1», кнопки апгрейда и замены
//   W6  «Апгрейд до ЖК $350» — upgrade_pc слот 3, подпись «ЖК», выработка ×1.1, окно закрыто
//   W7  свободный стол (5): окно открывается, апгрейд есть, замены нет (износ 0)
//   W8  при нехватке денег кнопка апгрейда неактивна (D): клик ничего не шлёт, окно на месте
//   W9  правый клик по подписи — «Уволить сотрудника?», ничего не ушло
//   W10 отказы itd.cmd: pc_fresh, pc_max_level, pc_dead (апгрейд, ремонт, мастер); деньги целы
//   W11 ЛКМ по мёртвому месту (зона office.slot.2) — окно места, только замена, ни ремонта, ни мотивации;
//       ПКМ — «Уволить» со строкой «требует замены»
//   W12 «заменить $500» — replace_pc слот 2: ЭЛТ, износ 0, стол desk_pc без тона, доход вырос
//   W13 обед при мёртвом месте: «обед» только у живых, кнопка замены на месте, линтер пуст
//   W14 линтер на свежей worn_pcs: overlaps()/offscreen() пусты на двух масштабах
//   Z   нет pageerror
//
// Self-serve: без QA_BASE поднимает Go-сервер на QA_PORT (по умолчанию :4193)
// с ITGAME_DEBUG=1; нужен client/dist (npm run build). saves: 'off'.
import { setTimeout as delay } from 'node:timers/promises'
import puppeteer from 'puppeteer-core'
import { chromePath } from './lib/chrome.mjs'
import { selfServe } from './lib/selfserve.mjs'
import { waitMenuReady } from './lib/menu.mjs'
import { fmtMoney } from '../src/format.ts'

const SELF_PORT = Number(process.env.QA_PORT) || 4193
const BASE = process.env.QA_BASE || `http://127.0.0.1:${SELF_PORT}`

const results = []
const check = (name, pass, fact) => {
  results.push({ name, pass, fact })
  console.log(`${pass ? 'PASS' : 'FAIL'}: ${name} — ${fact}`)
}

let stopServer = null
if (!process.env.QA_BASE) {
  try {
    ;({ stop: stopServer } = await selfServe({ port: SELF_PORT, saves: 'off', label: 'QA-ITGAME135' }))
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
  const moveTo = async (id) => {
    const r = await row(id)
    if (!r) throw new Error(`нет ${id} в itd.screen()`)
    await page.mouse.move(Number(r[2]), Number(r[3]))
    await delay(300)
  }
  const sentSince = (at) => page.evaluate((t) => window.itd.net(80).last.filter((m) => m.dir === 'out' && m.at > t).map((m) => ({ type: m.type, office: m.info?.office, slot: m.info?.slot })), at)
  const lastAt = () => page.evaluate(() => window.itd.net(80).last.at(-1)?.at ?? 0)
  const texts = () => page.evaluate(() => window.itd.text().map((t) => t.text ?? ''))
  const textOf = (id) => page.evaluate((i) => window.itd.nodes().find((n) => n.id === i)?.text ?? null, id)
  const snap = () => page.evaluate(() => window.itd.server().snapshot)
  const title = () => page.evaluate(() => window.itd.screen().meta.title)
  const flags = async (id) => (await row(id))?.[4] ?? null
  const closeModal = async () => {
    await page.evaluate(() => window.itd.click('modal.close'))
    await delay(300)
  }
  // Подпись и цвет Text-объекта сцены office по id (стиль не отдаёт itd.nodes()).
  const colorOf = (id) => page.evaluate((i) => window.__itd.scene.getScene('office').children.list.find((o) => o.getData('id') === i)?.style?.color ?? null, id)
  // Стол слота: картинка без id в точке сотрудника слота (стол и сотрудник — в одной точке).
  const deskAt = (slot) => page.evaluate((i) => {
    const list = window.__itd.scene.getScene('office').children.list
    const w = list.find((o) => o.getData('id') === `office.worker.${i}`)
    if (!w) return null
    const d = list.find((o) => o.type === 'Image' && !o.getData('id') && o.x === w.x && o.y === w.y && String(o.texture?.key).startsWith('desk_pc'))
    return d ? { key: d.texture.key, tint: d.tint } : null
  }, slot)
  const tipText = () => page.evaluate(() => {
    const c = window.__itd.scene.getScene('office').children.list.find((o) => o.type === 'Container' && o.visible)
    return c?.list?.find((x) => x.type === 'Text')?.text ?? null
  })
  const cmd = (c, slot) => page.evaluate((a, s) => window.itd.cmd(a, 0, { slot: s }), c, slot)

  await page.goto(`${BASE}/?debug=1&scenario=fresh&seed=1`, { waitUntil: 'domcontentloaded' })
  await waitMenuReady(page)
  await page.evaluate(() => localStorage.setItem('itd.onboard', 'done'))
  await page.evaluate(() => window.itd.click('menu.diff.normal'))
  await page.waitForFunction(() => window.itd.state().connected === true, { timeout: 20000 })
  await page.evaluate(() => window.itd.pause())
  await page.evaluate(() => window.itd.scenario('worn_pcs'))
  await delay(1000)
  await page.evaluate(() => window.itd.pause())
  await delay(300)

  const s0 = await snap()
  const levels = s0.prices.pcLevels
  const limit = s0.pcWearLimit
  const replace = s0.prices.pcReplace
  const money = async () => (await snap()).money

  // W1
  const w1 = {
    l0: await textOf('office.pc.0'), l1: await textOf('office.pc.1'),
    l3: await textOf('office.pc.3'), l4: await textOf('office.pc.4'), l5: await textOf('office.pc.5'),
    l2: await row('office.pc.2'), l6: await row('office.pc.6'),
    dead: await page.evaluate(() => window.itd.state().deadPCs),
  }
  check('W1: подписи уровней — 0 «ЖК», 1 «2×ЖК», 3/4/5 «ЭЛТ»; на мёртвом (2) и без ПК (6) нет; deadPCs 1',
    w1.l0 === levels[1].name && w1.l1 === levels[2].name && [w1.l3, w1.l4, w1.l5].every((t) => t === levels[0].name) &&
      w1.l2 === null && w1.l6 === null && w1.dead === 1, JSON.stringify(w1))

  // W2
  const w2 = {
    label: await textOf('office.dead.2'), btn: (await texts()).find((x) => x.startsWith('заменить')) ?? null,
    btnZone: !!(await row('office.replace.2')),
    desk: await deskAt(2),
    glow: await page.evaluate(() => window.__itd.scene.getScene('office').children.list
      .filter((o) => o.type === 'Rectangle' && o.fillColor === 0x94b0c2 && o.fillAlpha > 0).map((o) => o.getData('id') ?? null)),
  }
  check('W2: мёртвое место — «✖ замена», «заменить $500», desk_pc_broken с тоном, одна серая зона office.slot.2',
    w2.label === '✖ замена' && w2.btn === `заменить ${fmtMoney(replace)}` && w2.btnZone && w2.desk?.key === 'desk_pc_broken' &&
      w2.desk.tint !== 0xffffff && w2.glow.length === 1 && w2.glow[0] === 'office.slot.2', JSON.stringify(w2))

  // W3
  const w3 = { worn: await colorOf('office.pc.0'), fresh: await colorOf('office.pc.5') }
  check('W3: подпись места на пределе износа — оранжевая, у чистого — нет',
    w3.worn === '#ef7d57' && w3.fresh !== '#ef7d57', JSON.stringify({ ...w3, limit }))

  // W4
  await moveTo('office.slot.3')
  const tip4 = await tipText()
  await moveTo('office.pc.3')
  const tip4b = await tipText()
  check('W4: тултип «ПК: ЭЛТ ×1.0 · износ k/N — следующая поломка: замена»; над подписью тултип остаётся',
    !!tip4 && tip4.includes(`ПК: ${levels[0].name} ×1.0 · износ ${limit}/${limit}`) && tip4.includes('следующая поломка: замена') &&
      !!tip4b && tip4b === tip4, JSON.stringify({ tip4, same: tip4b === tip4 }))
  await page.mouse.move(5, 5)
  await delay(200)

  // W5
  let at = await lastAt()
  await realClick('office.pc.3')
  const w5 = {
    title: await title(), up: (await row('modal.pc.upgrade'))?.[1] ?? null, rep: (await row('modal.pc.replace'))?.[1] ?? null,
    sent: await sentSince(at),
  }
  check('W5: клик по подписи — «Рабочее место 4 — офис 1», «Апгрейд до ЖК $350», «Заменить ПК $500», ничего не ушло',
    w5.title === 'Рабочее место 4 — офис 1' && w5.up === `Апгрейд до ${levels[1].name} ${fmtMoney(levels[1].price)}` &&
      w5.rep === `Заменить ПК ${fmtMoney(replace)}` && w5.sent.length === 0, JSON.stringify(w5))

  // W6
  const before6 = await snap()
  at = await lastAt()
  await realClick('modal.pc.upgrade')
  const after6 = await snap()
  const w6 = {
    sent: (await sentSince(at)).filter((m) => m.type === 'upgrade_pc'),
    level: after6.offices[0].workplaces[3].level, dm: before6.money - after6.money,
    label: await textOf('office.pc.3'), title: await title(),
    eff: [before6.offices[0].employees[3].effectiveIncomePerTick, after6.offices[0].employees[3].effectiveIncomePerTick],
  }
  check('W6: апгрейд — один upgrade_pc слот 3, уровень 1, −$350, подпись «ЖК», выработка ×1.1, окно закрыто',
    w6.sent.length === 1 && w6.sent[0].office === 0 && w6.sent[0].slot === 3 && w6.level === 1 && w6.dm === levels[1].price &&
      w6.label === levels[1].name && Math.abs(w6.eff[1] - Math.round(w6.eff[0] * levels[1].mult)) <= 1 && w6.title === null, JSON.stringify(w6))

  // W7
  await realClick('office.pc.5')
  const w7a = { title: await title(), up: !!(await row('modal.pc.upgrade')), rep: !!(await row('modal.pc.replace')) }
  at = await lastAt()
  await realClick('modal.pc.upgrade')
  const w7b = { sent: (await sentSince(at)).filter((m) => m.type === 'upgrade_pc'), label: await textOf('office.pc.5') }
  check('W7: свободный стол 6 — окно с апгрейдом и без замены (износ 0); upgrade_pc слот 5, «ЖК»',
    w7a.title === 'Рабочее место 6 — офис 1' && w7a.up && !w7a.rep && w7b.sent.length === 1 && w7b.sent[0].slot === 5 &&
      w7b.label === levels[1].name, JSON.stringify({ w7a, w7b }))

  // W8
  await page.evaluate(() => window.itd.set({ money: 100 }))
  await delay(400)
  await realClick('office.pc.4')
  const f8 = await flags('modal.pc.upgrade')
  at = await lastAt()
  await realClick('modal.pc.upgrade')
  const w8 = { flag: f8, sent: await sentSince(at), title: await title() }
  check('W8: без денег кнопка апгрейда — D, клик ничего не шлёт, окно остаётся',
    (f8 ?? '').includes('D') && w8.sent.length === 0 && w8.title === 'Рабочее место 5 — офис 1', JSON.stringify(w8))
  await closeModal()
  await page.evaluate(() => window.itd.set({ money: 5000 }))
  await delay(400)

  // W9
  at = await lastAt()
  await realClick('office.pc.0', 'right')
  const w9 = { title: await title(), sent: await sentSince(at) }
  check('W9: правый клик по подписи — «Уволить сотрудника?», ничего не ушло',
    w9.title === 'Уволить сотрудника?' && w9.sent.length === 0, JSON.stringify(w9))
  await closeModal()

  // W10
  const m10 = await money()
  const w10 = {
    fresh: (await cmd('replace_pc', 5)).code, max: (await cmd('upgrade_pc', 1)).code,
    deadUp: (await cmd('upgrade_pc', 2)).code, deadRepair: (await cmd('repair_click', 2)).code, deadMaster: (await cmd('call_master', 2)).code,
    dm: m10 - (await money()),
  }
  check('W10: отказы — pc_fresh, pc_max_level, pc_dead (апгрейд, ремонт, мастер); деньги целы',
    w10.fresh === 'pc_fresh' && w10.max === 'pc_max_level' && w10.deadUp === 'pc_dead' && w10.deadRepair === 'pc_dead' &&
      w10.deadMaster === 'pc_dead' && w10.dm === 0, JSON.stringify(w10))

  // W11
  at = await lastAt()
  await realClick('office.slot.2')
  const w11a = {
    title: await title(), rep: !!(await row('modal.pc.replace')), up: !!(await row('modal.pc.upgrade')),
    sent: (await sentSince(at)).map((m) => m.type),
  }
  await closeModal()
  await realClick('office.slot.2', 'right')
  const w11b = { title: await title(), note: (await texts()).some((t) => t.includes('требует замены')) }
  await closeModal()
  check('W11: ЛКМ по мёртвому месту — окно «Рабочее место 3 — офис 1», только замена, ни ремонта, ни мотивации; ПКМ — «требует замены»',
    w11a.title === 'Рабочее место 3 — офис 1' && w11a.rep && !w11a.up && !w11a.sent.some((t) => t === 'repair_click' || t === 'motivate') &&
      w11b.title === 'Уволить сотрудника?' && w11b.note, JSON.stringify({ w11a, w11b }))

  // W12
  const before12 = await snap()
  at = await lastAt()
  await realClick('office.replace.2')
  const after12 = await snap()
  const w12 = {
    sent: (await sentSince(at)).filter((m) => m.type === 'replace_pc'), wp: after12.offices[0].workplaces[2],
    gone: [await row('office.dead.2'), await row('office.replace.2')], label: await textOf('office.pc.2'),
    desk: await deskAt(2), dm: before12.money - after12.money, inc: [before12.incomePerTick, after12.incomePerTick],
    dead: await page.evaluate(() => window.itd.state().deadPCs),
  }
  check('W12: «заменить $500» — replace_pc слот 2: ЭЛТ, износ 0, desk_pc без тона, доход вырос, deadPCs 0',
    w12.sent.length === 1 && w12.sent[0].slot === 2 && w12.wp.level === 0 && w12.wp.wear === 0 && w12.wp.dead === false &&
      w12.gone.every((r) => r === null) && w12.label === levels[0].name && w12.desk?.key === 'desk_pc' && w12.desk.tint === 0xffffff &&
      w12.dm === replace && w12.inc[1] > w12.inc[0] && w12.dead === 0, JSON.stringify(w12))

  // W13: обед при мёртвом месте
  await page.evaluate(async () => {
    const save = (await window.itd.snapshot()).save
    save.offices[0].Workplaces[1] = { Level: 0, Wear: 8, Dead: true }
    await window.itd.restore({ offices: save.offices })
  })
  await page.evaluate(() => window.itd.set({ tickInDay: 24 }))
  await delay(600)
  await page.evaluate(() => window.itd.pause())
  const s13 = await snap()
  const deadOcc = s13.offices[0].workplaces.filter((w, i) => w.dead && i < s13.offices[0].employees.length).length
  const w13 = {
    lunch: s13.isLunch, deadOcc,
    obed: (await texts()).filter((t) => t === 'обед').length, replace: !!(await row('office.replace.1')),
    ov: await page.evaluate(() => window.itd.overlaps()), off: await page.evaluate(() => window.itd.offscreen()),
  }
  check('W13: обед при мёртвом месте — «обед» только у живых, кнопка замены на месте, overlaps/offscreen пусты',
    w13.lunch === true && w13.deadOcc === 1 && w13.obed === s13.offices[0].employees.length - w13.deadOcc && w13.replace &&
      w13.ov.length === 0 && w13.off.length === 0, JSON.stringify(w13).slice(0, 600))

  // W14
  await page.evaluate(() => window.itd.scenario('worn_pcs'))
  await delay(1000)
  await page.evaluate(() => window.itd.pause())
  const lint = async () => page.evaluate(() => ({ ov: window.itd.overlaps(), off: window.itd.offscreen(), scale: localStorage.getItem('itd.uiScale') }))
  const z1 = await lint()
  await page.evaluate(() => window.itd.click('btn.zoom'))
  await delay(300)
  await page.evaluate(() => window.itd.click('btn.zoom'))
  await delay(400)
  const z2 = await lint()
  check('W14: worn_pcs — overlaps()/offscreen() пусты на двух масштабах',
    z1.ov.length === 0 && z1.off.length === 0 && z2.ov.length === 0 && z2.off.length === 0 && z1.scale !== z2.scale,
    JSON.stringify({ z1: { ov: z1.ov.slice(0, 3), off: z1.off.slice(0, 3), scale: z1.scale }, z2: { ov: z2.ov.slice(0, 3), off: z2.off.slice(0, 3), scale: z2.scale } }))

  check('Z: нет pageerror', pageErrors.length === 0, JSON.stringify(pageErrors))
} catch (e) {
  check('сценарий выполнен без исключений', false, e instanceof Error ? e.stack : String(e))
} finally {
  if (browser) await browser.close()
  if (stopServer) await stopServer()
}

const failed = results.filter((r) => !r.pass)
console.log(`\nИтог QA-ITGAME135: ${results.length - failed.length}/${results.length} проверок прошло`)
if (failed.length > 0) {
  console.error(`Провалено: ${failed.map((f) => f.name).join(', ')}`)
  process.exit(1)
}
console.log('Все проверки пройдены успешно!')
