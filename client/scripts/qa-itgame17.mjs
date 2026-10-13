// qa-itgame17 — кнопки покупки: затемнение alpha, тултипы дефицита,
// клик по недоступной кнопке, скрытие тултипа модалом, линтер (ITGAME-17).
// С ITGAME-94 кнопки живут в комнатах, а не в шапке HUD: btn.pc/btn.hire/
// btn.boss — колонка действий офиса, btn.gateway — серверной (тултип —
// room.tooltip.text сцены комнаты). Блок R в конце — раскладка ITGAME-94:
// сцены кнопок, колонка x 1142..1270, тултип слева, закрытый офис без колонки
// (itd.click → code hidden), хит-тест настоящего клика, окно роутера и отчёт
// дня накрывают кнопки (hit не ok, флаг X).
//
// Self-serve: без QA_BASE поднимает Go-сервер на QA_PORT (по умолчанию
// :4180 — 4173…4179 заняты соседними скриптами) с ITGAME_DEBUG=1 (скрипт
// зовёт itd.set() → /api/debug/*). Общий self-serve —
// client/scripts/lib/selfserve.mjs; нужен client/dist (npm run build).
// QA_BASE — прогон против внешнего сервера. saves: 'off' — партия всегда
// свежая, уникальный sid не нужен.
import { setTimeout as delay } from 'node:timers/promises'
import puppeteer from 'puppeteer-core'
import { chromePath } from './lib/chrome.mjs'
import { selfServe } from './lib/selfserve.mjs'

const SELF_PORT = Number(process.env.QA_PORT) || 4180
const BASE = process.env.QA_BASE || `http://127.0.0.1:${SELF_PORT}`

const results = []
const check = (name, pass, fact) => {
  results.push({ name, pass, fact })
  console.log(`${pass ? 'PASS' : 'FAIL'}: ${name} — ${fact}`)
}
const alphaOf = (page, id) => page.evaluate((i) => window.itd.nodes().find((n) => n.id === i)?.alpha, id)
// Комната: клик по пункту навигации; дребезг switchRoom (250 мс игрового
// времени — в headless кадры редкие) отвечает code debounced — повторяем.
const goRoom = async (page, nav) => {
  for (let i = 0; i < 20; i++) {
    const r = await page.evaluate((n) => window.itd.click(n), nav)
    if (r.code !== 'debounced') break
    await delay(150)
  }
  await delay(300)
}

let stopServer = null
if (!process.env.QA_BASE) {
  try {
    ;({ stop: stopServer } = await selfServe({ port: SELF_PORT, saves: 'off', label: 'QA-ITGAME17' }))
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  }
}

let browser = null
try {
  browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1920, height: 1080 })
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('PAGE ERROR:', msg.text())
  })

  await page.goto(`${BASE}/?debug=1`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction('window.__itd && (window.__itd.scene.isActive("menu") || window.__itd.scene.isActive("hud"))', { timeout: 10000 })

  // 1. Старт новой игры: нажимаем '2' (норма)
  await page.evaluate(() => {
    window.itd.key('2')
  })
  await page.waitForFunction(
    'window.__itd && window.__itd.scene.isActive("hud") && window.itd.state() && window.itd.state().day >= 1',
    { timeout: 10000 },
  )
  await delay(300)

  // 2. Устанавливаем паузу и малый баланс ($100), когда ни на что не хватает
  await page.evaluate(() => {
    window.itd.pause()
    window.itd.set({ money: 100 })
  })
  await delay(150)

  // Проверяем состояние кнопок при нехватке денег
  const lowMoneyState = await page.evaluate(() => {
    const nodes = window.itd.nodes()
    const pc = nodes.find((n) => n.id === 'btn.pc')
    const hire = nodes.find((n) => n.id === 'btn.hire')
    const boss = nodes.find((n) => n.id === 'btn.boss')
    return {
      pcAlpha: pc?.alpha,
      hireAlpha: hire?.alpha,
      bossAlpha: boss?.alpha,
    }
  })
  // Шлюз — в серверной (ITGAME-94).
  await goRoom(page, 'nav.serverRoom')
  lowMoneyState.gwAlpha = await alphaOf(page, 'btn.gateway')
  await page.evaluate(() => window.itd.hover('btn.gateway'))
  await delay(100)
  const gwTooltip = await page.evaluate(() => {
    const tt = window.itd.nodes().find((n) => n.id === 'room.tooltip.text')
    return { visible: tt?.visible, text: tt?.text, scene: tt?.scene }
  })
  await goRoom(page, 'nav.office0')

  check('btn.pc затемнена при нехватке денег (alpha ~ 0.45)', Math.abs(lowMoneyState.pcAlpha - 0.45) < 0.05, `alpha=${lowMoneyState.pcAlpha}`)
  check('btn.hire затемнена при нехватке денег (alpha ~ 0.45)', Math.abs(lowMoneyState.hireAlpha - 0.45) < 0.05, `alpha=${lowMoneyState.hireAlpha}`)
  check('btn.boss затемнена при нехватке денег (alpha ~ 0.45)', Math.abs(lowMoneyState.bossAlpha - 0.45) < 0.05, `alpha=${lowMoneyState.bossAlpha}`)
  check('btn.gateway затемнена при нехватке денег (alpha ~ 0.45)', Math.abs(lowMoneyState.gwAlpha - 0.45) < 0.05, `alpha=${lowMoneyState.gwAlpha}`)

  // 3. Проверяем тултип дефицита при наведении
  await page.evaluate(() => window.itd.hover('btn.pc'))
  await delay(100)
  const pcTooltip = await page.evaluate(() => {
    const nodes = window.itd.nodes()
    const tt = nodes.find((n) => n.id === 'room.tooltip.text')
    return { visible: tt?.visible, text: tt?.text }
  })
  check('Тултип btn.pc виден при hover', pcTooltip.visible === true, `visible=${pcTooltip.visible}`)
  check('Тултип btn.pc показывает нехватку денег', pcTooltip.text?.includes('не хватает $'), `text="${pcTooltip.text}"`)

  // Клик по недоступной кнопке не должен тратить деньги
  const balanceBefore = await page.evaluate(() => window.itd.state().balance)
  await page.evaluate(() => window.itd.click('btn.pc'))
  await delay(250) // даём время на shake (180ms)
  const balanceAfter = await page.evaluate(() => window.itd.state().balance)
  check('Клик по недоступной btn.pc не списал деньги', balanceBefore === balanceAfter, `before=${balanceBefore}, after=${balanceAfter}`)

  // 4. Тултипы других кнопок дефицита
  await page.evaluate(() => window.itd.hover('btn.hire'))
  await delay(100)
  const hireTooltip = await page.evaluate(() => {
    const nodes = window.itd.nodes()
    const tt = nodes.find((n) => n.id === 'room.tooltip.text')
    return { visible: tt?.visible, text: tt?.text }
  })
  check('Тултип btn.hire показывает нехватку денег', hireTooltip.text?.includes('не хватает $'), `text="${hireTooltip.text}"`)

  await page.evaluate(() => window.itd.hover('btn.boss'))
  await delay(100)
  const bossTooltip = await page.evaluate(() => {
    const nodes = window.itd.nodes()
    const tt = nodes.find((n) => n.id === 'room.tooltip.text')
    return { visible: tt?.visible, text: tt?.text }
  })
  check('Тултип btn.boss показывает нехватку денег', bossTooltip.text?.includes('не хватает $'), `text="${bossTooltip.text}"`)

  check('Тултип btn.gateway (серверная) показывает нехватку денег', gwTooltip.text?.includes('не хватает $') && gwTooltip.scene === 'serverRoom', `text="${gwTooltip.text}" scene=${gwTooltip.scene}`)

  // 5. Увеличиваем баланс ($50000) и снимаем паузу — кнопки становятся доступными
  await page.evaluate(() => {
    window.itd.set({ money: 50000 })
    window.itd.resume()
  })
  await delay(200)

  const richState = await page.evaluate(() => {
    const nodes = window.itd.nodes()
    const pc = nodes.find((n) => n.id === 'btn.pc')
    const hire = nodes.find((n) => n.id === 'btn.hire')
    const boss = nodes.find((n) => n.id === 'btn.boss')
    return {
      pcAlpha: pc?.alpha,
      hireAlpha: hire?.alpha,
      bossAlpha: boss?.alpha,
    }
  })
  await goRoom(page, 'nav.serverRoom')
  richState.gwAlpha = await alphaOf(page, 'btn.gateway')
  await goRoom(page, 'nav.office0')
  check('btn.pc доступна при наличии средств (alpha = 1)', richState.pcAlpha === 1, `alpha=${richState.pcAlpha}`)
  check('btn.hire доступна когда есть свободный ПК (alpha = 1)', richState.hireAlpha === 1, `alpha=${richState.hireAlpha}`)
  check('btn.boss доступна при наличии средств (alpha = 1)', richState.bossAlpha === 1, `alpha=${richState.bossAlpha}`)
  check('btn.gateway доступна при наличии средств (alpha = 1)', richState.gwAlpha === 1, `alpha=${richState.gwAlpha}`)

  // 6. Нанимаем сотрудника: теперь 1 ПК и 1 сотрудник — свободных ПК не осталось
  const hireRes = await page.evaluate(async () => {
    return await window.itd.cmd('hire')
  })
  check('Найм первого сотрудника успешен', hireRes.ok === true, `res=${JSON.stringify(hireRes)}`)
  await delay(200)

  const hireNoPcState = await page.evaluate(() => {
    const nodes = window.itd.nodes()
    const hire = nodes.find((n) => n.id === 'btn.hire')
    return { alpha: hire?.alpha }
  })
  check('btn.hire недоступна если нет свободного ПК (alpha ~ 0.45)', Math.abs(hireNoPcState.alpha - 0.45) < 0.05, `alpha=${hireNoPcState.alpha}`)

  await page.evaluate(() => window.itd.hover('btn.hire'))
  await delay(100)
  const hireNoPcTooltip = await page.evaluate(() => {
    const nodes = window.itd.nodes()
    const tt = nodes.find((n) => n.id === 'room.tooltip.text')
    return { visible: tt?.visible, text: tt?.text }
  })
  check('Тултип btn.hire виден при hover', hireNoPcTooltip.visible === true, `visible=${hireNoPcTooltip.visible}`)
  check('Тултип btn.hire сообщает об отсутствии свободного ПК', hireNoPcTooltip.text?.includes('Нет свободного ПК'), `text="${hireNoPcTooltip.text}"`)

  // Клик по недоступной btn.hire не должен отправлять найм
  const staffBefore = await page.evaluate(() => window.itd.state().staff)
  await page.evaluate(() => window.itd.click('btn.hire'))
  await delay(250)
  const staffAfter = await page.evaluate(() => window.itd.state().staff)
  check('Клик по недоступной btn.hire не нанял сотрудника', staffBefore === staffAfter, `before=${staffBefore}, after=${staffAfter}`)

  // 7. Покупаем ПК — теперь 2 ПК и 1 сотрудник -> btn.hire снова становится доступной!
  const buyPcRes = await page.evaluate(async () => {
    return await window.itd.cmd('buy_pc')
  })
  check('Покупка ПК успешна', buyPcRes.ok === true, `res=${JSON.stringify(buyPcRes)}`)
  await delay(200)

  const hireAfterPcState = await page.evaluate(() => {
    const nodes = window.itd.nodes()
    const hire = nodes.find((n) => n.id === 'btn.hire')
    return { alpha: hire?.alpha }
  })
  check('btn.hire снова стала доступной после покупки ПК (alpha = 1)', hireAfterPcState.alpha === 1, `alpha=${hireAfterPcState.alpha}`)

  // 8. Покупаем интернет-шлюз — кнопка переходит в состояние «Шлюз ✓» и отключается
  const buyGwRes = await page.evaluate(async () => {
    return await window.itd.cmd('buy_gateway')
  })
  check('Покупка шлюза успешна', buyGwRes.ok === true, `res=${JSON.stringify(buyGwRes)}`)
  await goRoom(page, 'nav.serverRoom')

  const gwBoughtState = await page.evaluate(() => {
    const nodes = window.itd.nodes()
    const gw = nodes.find((n) => n.id === 'btn.gateway')
    return { alpha: gw?.alpha }
  })
  check('btn.gateway отключена после покупки (alpha ~ 0.45)', Math.abs(gwBoughtState.alpha - 0.45) < 0.05, `alpha=${gwBoughtState.alpha}`)

  await page.evaluate(() => window.itd.hover('btn.gateway'))
  await delay(100)
  const gwBoughtTooltip = await page.evaluate(() => {
    const nodes = window.itd.nodes()
    const tt = nodes.find((n) => n.id === 'room.tooltip.text')
    return { visible: tt?.visible, text: tt?.text }
  })
  check('Тултип btn.gateway сообщает, что шлюз уже подключён', gwBoughtTooltip.text?.includes('уже подключён'), `text="${gwBoughtTooltip.text}"`)
  await goRoom(page, 'nav.office0')

  // 9. Нанимаем начальника — кнопка boss отключается
  const hireBossRes = await page.evaluate(async () => {
    return await window.itd.cmd('hire_boss')
  })
  check('Найм начальника успешен', hireBossRes.ok === true, `res=${JSON.stringify(hireBossRes)}`)
  await delay(200)

  const bossHiredState = await page.evaluate(() => {
    const nodes = window.itd.nodes()
    const boss = nodes.find((n) => n.id === 'btn.boss')
    return { alpha: boss?.alpha }
  })
  check('btn.boss отключена после найма (alpha ~ 0.45)', Math.abs(bossHiredState.alpha - 0.45) < 0.05, `alpha=${bossHiredState.alpha}`)

  await page.evaluate(() => window.itd.hover('btn.boss'))
  await delay(100)
  const bossHiredTooltip = await page.evaluate(() => {
    const nodes = window.itd.nodes()
    const tt = nodes.find((n) => n.id === 'room.tooltip.text')
    return { visible: tt?.visible, text: tt?.text }
  })
  check('Тултип btn.boss сообщает, что начальник уже нанят', bossHiredTooltip.text?.includes('уже нанят'), `text="${bossHiredTooltip.text}"`)

  // 10. Проверяем скрытие тултипа при открытии модального окна (confirmExitToMenu)
  await page.evaluate(() => window.itd.hover('btn.boss'))
  await delay(100)
  const ttBeforeModal = await page.evaluate(() => {
    const tt = window.itd.nodes().find((n) => n.id === 'room.tooltip.text')
    return tt?.visible
  })
  check('Тултип отображается до открытия модала', ttBeforeModal === true, `visible=${ttBeforeModal}`)
  // Контраст тултипа снимаем, пока он на экране: contrast() пропускает скрытые
  // тексты, а п.10 дальше прячет тултип модалом.
  const tooltipContrast = await page.evaluate(() =>
    window.itd.contrast().filter((c) => c.id === 'room.tooltip.text')
  )

  await page.evaluate(() => window.itd.click('btn.menu'))
  await delay(100)
  const ttAfterModal = await page.evaluate(() => {
    const tt = window.itd.nodes().find((n) => n.id === 'room.tooltip.text')
    return tt?.visible
  })
  check('Тултип скрыт при открытии модала', ttAfterModal === false, `visible=${ttAfterModal}`)

  // Закрываем модал кликом по Отмена
  await page.evaluate(() => window.itd.key('escape'))
  await delay(100)

  // 11. Проверяем вёрстку тултипа и кнопок панели покупки
  const lintResults = await page.evaluate(() => {
    return {
      overlaps: window.itd.overlaps(),
      offscreen: window.itd.offscreen(),
      tiny: window.itd.tiny(),
    }
  })
  const hudOffscreen = lintResults.offscreen.filter((o) => o.scene === 'hud' || o.scene === 'office')
  check('Линтер: 0 вылезаний HUD и офиса за экран', hudOffscreen.length === 0, `offscreen=${hudOffscreen.length}`)

  const buttonOverlaps = lintResults.overlaps.filter(
    (o) => (o.scene === 'hud' || o.scene === 'office') &&
      (o.a.includes('btn.') || o.b.includes('btn.') || o.a.includes('tooltip') || o.b.includes('tooltip'))
  )
  check('Линтер: 0 оверлапов кнопок покупки и тултипов', buttonOverlaps.length === 0, `overlaps=${buttonOverlaps.length}`)

  check('Линтер: 0 проблем контраста тултипа', tooltipContrast.length === 0, `contrast=${tooltipContrast.length}`)

  // ── R (ITGAME-94): кнопки — в комнатах, колонка у правого края
  await page.evaluate(() => window.itd.set({ money: 50000 }))
  await delay(200)
  const r1 = await page.evaluate(() => {
    const ids = window.itd.ids()
    const at = (id) => ids.filter((n) => n.id === id).map((n) => n.scene)
    const nodes = window.itd.nodes()
    const box = (n) => ({ id: n.id, x: n.x, y: n.y, w: n.w, h: n.h })
    const btns = ['btn.pc', 'btn.hire', 'btn.boss'].map((id) => nodes.find((n) => n.id === id)).filter(Boolean).map(box)
    // Всё интерактивное и подписи офиса, кроме самих кнопок и тултипов
    const others = nodes
      .filter((n) => n.scene === 'office' && n.visible && n.w > 0 && n.id !== null && !/^btn\.|tooltip/.test(n.id))
      .map(box)
    const hits = []
    for (const b of btns) {
      for (const o of others) {
        if (b.x < o.x + o.w && o.x < b.x + b.w && b.y < o.y + o.h && o.y < b.y + b.h) hits.push(`${b.id}×${o.id}`)
      }
    }
    return { pc: at('btn.pc'), hire: at('btn.hire'), boss: at('btn.boss'), gw: at('btn.gateway'), btns, hits, others: others.length }
  })
  check(
    'R1: btn.pc/btn.hire/btn.boss — в сцене office (не в hud), btn.gateway в офисе нет',
    r1.pc.join() === 'office' && r1.hire.join() === 'office' && r1.boss.join() === 'office' && r1.gw.length === 0,
    JSON.stringify({ pc: r1.pc, hire: r1.hire, boss: r1.boss, gw: r1.gw }),
  )
  check(
    'R2: колонка x 1142, 128×44, y 384/438/492; ни с одним объектом офиса с id не пересекается',
    r1.btns.length === 3 && r1.btns.every((b, i) => b.x === 1142 && b.w === 128 && b.h === 44 && b.y === 384 + i * 54) &&
      r1.hits.length === 0 && r1.others > 5,
    JSON.stringify({ btns: r1.btns, hits: r1.hits, others: r1.others }),
  )

  // R3: тултип недоступной кнопки — слева от колонки, целиком в поле
  await page.evaluate(() => window.itd.hover('btn.boss'))
  await delay(100)
  const r3 = await page.evaluate(() => {
    const n = window.itd.nodes()
    const bg = n.find((x) => x.id === 'room.tooltip.bg')
    const tt = n.find((x) => x.id === 'room.tooltip.text')
    return { visible: tt?.visible, text: tt?.text, scene: tt?.scene, bg: bg ? { x: bg.x, y: bg.y, w: bg.w, h: bg.h } : null }
  })
  check(
    'R3: тултип btn.boss (сцена office) — слева от колонки (right <= 1142), в пределах поля',
    r3.visible === true && r3.scene === 'office' && !!r3.bg && r3.bg.x >= 0 && r3.bg.x + r3.bg.w <= 1142 &&
      r3.bg.y >= 0 && r3.bg.y + r3.bg.h <= 720,
    JSON.stringify(r3),
  )

  // R4: настоящий клик мышью по btn.pc (точка из screen()) — хит-тест Phaser выдаёт кнопку, buy_pc ушёл
  const r4 = await page.evaluate(() => ({
    hit: window.itd.hit('btn.pc'),
    row: window.itd.screen().items.find((i) => i.startsWith('btn:pc|'))?.split('|'),
    pcs: window.itd.server().snapshot.offices[0].pcs,
  }))
  await page.mouse.click(Number(r4.row?.[2]), Number(r4.row?.[3]))
  await delay(500)
  const r4pcs = await page.evaluate(() => window.itd.server().snapshot.offices[0].pcs)
  check(
    'R4: itd.hit(btn.pc).ok, без флага X; настоящий клик в точку screen() купил ПК (pcs +1)',
    r4.hit?.ok === true && !!r4.row && !r4.row[4].includes('X') && r4pcs === r4.pcs + 1,
    JSON.stringify({ hit: r4.hit?.ok, top: r4.hit?.top?.id, row: r4.row, pcs: [r4.pcs, r4pcs] }),
  )

  // R5: окно роутера накрывает колонку: hit не ok, флаг X, тултип не показывается
  await page.evaluate(() => window.itd.click('office.router'))
  await delay(150)
  await page.evaluate(() => window.itd.hover('btn.boss'))
  await delay(100)
  const r5 = await page.evaluate(() => ({
    hit: window.itd.hit('btn.pc').ok,
    row: window.itd.screen().items.find((i) => i.startsWith('btn:pc|')),
    tt: window.itd.nodes().find((n) => n.id === 'room.tooltip.text')?.visible,
  }))
  check(
    'R5: под окном роутера btn.pc — hit не ok, флаг X; наведение на btn.boss тултип не показывает',
    r5.hit === false && typeof r5.row === 'string' && r5.row.split('|')[4].includes('X') && r5.tt === false,
    JSON.stringify(r5),
  )
  await page.evaluate(() => window.itd.click('modal.close'))
  await delay(150)

  // R6: закрытый офис — колонки нет: кнопки невидимы, itd.click отвечает code hidden, команда не уходит
  await goRoom(page, 'nav.office1')
  const r6 = await page.evaluate(async () => {
    const vis = window.itd.nodes().filter((n) => /^btn\.(pc|hire|boss)$/.test(n.id ?? '')).map((n) => n.visible)
    let click = null
    const tr = await window.itd.trace(() => { click = window.itd.click('btn.pc') }, 400)
    return { vis, click, sent: tr.sent.map((m) => m.type), free: window.itd.screen({ free: true }).items.filter((i) => /^btn:(pc|hire|boss)\|/.test(i)) }
  })
  check(
    'R6: офис 2 закрыт — btn.pc/hire/boss невидимы, itd.click(btn.pc) → code hidden, buy_pc не ушёл',
    r6.vis.length === 3 && r6.vis.every((v) => v === false) && r6.click?.ok === false && r6.click?.code === 'hidden' &&
      !r6.sent.includes('buy_pc'),
    JSON.stringify(r6),
  )
  await goRoom(page, 'nav.office0')
  const r6back = await page.evaluate(() => window.itd.nodes().filter((n) => /^btn\.(pc|hire|boss)$/.test(n.id ?? '')).map((n) => n.visible))
  check('R6: назад в офис 1 — колонка снова видна', r6back.length === 3 && r6back.every((v) => v === true), JSON.stringify(r6back))

  // R7: серверная — btn.gateway под слотом шлюза в той же колонке
  await goRoom(page, 'nav.serverRoom')
  const r7 = await page.evaluate(() => {
    const n = window.itd.nodes().find((x) => x.id === 'btn.gateway')
    return n ? { scene: n.scene, x: n.x, y: n.y, w: n.w, h: n.h, hit: window.itd.hit('btn.gateway').ok, ov: window.itd.overlaps().length } : null
  })
  check(
    'R7: btn.gateway — сцена serverRoom, x 1142 y 452 128×44, хит-тест ok, overlaps() пуст',
    !!r7 && r7.scene === 'serverRoom' && r7.x === 1142 && r7.y === 452 && r7.w === 128 && r7.h === 44 && r7.hit === true && r7.ov === 0,
    JSON.stringify(r7),
  )
  await goRoom(page, 'nav.office0')

  check('Ошибок на странице нет', pageErrors.length === 0, `errors=${pageErrors.length}`)

} finally {
  if (browser) await browser.close()
  if (stopServer) await stopServer()
}

const failed = results.filter((r) => !r.pass)
console.log(`\nИтог QA: ${results.length - failed.length}/${results.length} проверок прошло`)
if (failed.length > 0) {
  console.error(`Провалено: ${failed.map((f) => f.name).join(', ')}`)
  process.exit(1)
} else {
  console.log('Все проверки пройдены успешно!')
}
