// qa-itgame17 — кнопки покупки HUD: затемнение alpha, тултипы дефицита,
// клик по недоступной кнопке, скрытие тултипа модалом, линтер (ITGAME-17).
//
// Self-serve: без QA_BASE поднимает Go-сервер на QA_PORT (по умолчанию
// :4180 — 4173…4179 заняты соседними скриптами) с ITGAME_DEBUG=1 (скрипт
// зовёт itd.set() → /api/debug/*). Общий self-serve —
// client/scripts/lib/selfserve.mjs; нужен client/dist (npm run build).
// QA_BASE — прогон против внешнего сервера. saves: 'off' — партия всегда
// свежая, уникальный sid не нужен.
import { existsSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import puppeteer from 'puppeteer-core'
import { selfServe } from './lib/selfserve.mjs'

const SELF_PORT = Number(process.env.QA_PORT) || 4180
const BASE = process.env.QA_BASE || `http://127.0.0.1:${SELF_PORT}`

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

const results = []
const check = (name, pass, fact) => {
  results.push({ name, pass, fact })
  console.log(`${pass ? 'PASS' : 'FAIL'}: ${name} — ${fact}`)
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
    const gw = nodes.find((n) => n.id === 'btn.gateway')
    return {
      pcAlpha: pc?.alpha,
      hireAlpha: hire?.alpha,
      bossAlpha: boss?.alpha,
      gwAlpha: gw?.alpha,
    }
  })

  check('btn.pc затемнена при нехватке денег (alpha ~ 0.45)', Math.abs(lowMoneyState.pcAlpha - 0.45) < 0.05, `alpha=${lowMoneyState.pcAlpha}`)
  check('btn.hire затемнена при нехватке денег (alpha ~ 0.45)', Math.abs(lowMoneyState.hireAlpha - 0.45) < 0.05, `alpha=${lowMoneyState.hireAlpha}`)
  check('btn.boss затемнена при нехватке денег (alpha ~ 0.45)', Math.abs(lowMoneyState.bossAlpha - 0.45) < 0.05, `alpha=${lowMoneyState.bossAlpha}`)
  check('btn.gateway затемнена при нехватке денег (alpha ~ 0.45)', Math.abs(lowMoneyState.gwAlpha - 0.45) < 0.05, `alpha=${lowMoneyState.gwAlpha}`)

  // 3. Проверяем тултип дефицита при наведении
  await page.evaluate(() => window.itd.hover('btn.pc'))
  await delay(100)
  const pcTooltip = await page.evaluate(() => {
    const nodes = window.itd.nodes()
    const tt = nodes.find((n) => n.id === 'hud.tooltip.text')
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
    const tt = nodes.find((n) => n.id === 'hud.tooltip.text')
    return { visible: tt?.visible, text: tt?.text }
  })
  check('Тултип btn.hire показывает нехватку денег', hireTooltip.text?.includes('не хватает $'), `text="${hireTooltip.text}"`)

  await page.evaluate(() => window.itd.hover('btn.boss'))
  await delay(100)
  const bossTooltip = await page.evaluate(() => {
    const nodes = window.itd.nodes()
    const tt = nodes.find((n) => n.id === 'hud.tooltip.text')
    return { visible: tt?.visible, text: tt?.text }
  })
  check('Тултип btn.boss показывает нехватку денег', bossTooltip.text?.includes('не хватает $'), `text="${bossTooltip.text}"`)

  await page.evaluate(() => window.itd.hover('btn.gateway'))
  await delay(100)
  const gwTooltip = await page.evaluate(() => {
    const nodes = window.itd.nodes()
    const tt = nodes.find((n) => n.id === 'hud.tooltip.text')
    return { visible: tt?.visible, text: tt?.text }
  })
  check('Тултип btn.gateway показывает нехватку денег', gwTooltip.text?.includes('не хватает $'), `text="${gwTooltip.text}"`)

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
    const gw = nodes.find((n) => n.id === 'btn.gateway')
    return {
      pcAlpha: pc?.alpha,
      hireAlpha: hire?.alpha,
      bossAlpha: boss?.alpha,
      gwAlpha: gw?.alpha,
    }
  })
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
    const tt = nodes.find((n) => n.id === 'hud.tooltip.text')
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
  await delay(200)

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
    const tt = nodes.find((n) => n.id === 'hud.tooltip.text')
    return { visible: tt?.visible, text: tt?.text }
  })
  check('Тултип btn.gateway сообщает, что шлюз уже подключён', gwBoughtTooltip.text?.includes('уже подключён'), `text="${gwBoughtTooltip.text}"`)

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
    const tt = nodes.find((n) => n.id === 'hud.tooltip.text')
    return { visible: tt?.visible, text: tt?.text }
  })
  check('Тултип btn.boss сообщает, что начальник уже нанят', bossHiredTooltip.text?.includes('уже нанят'), `text="${bossHiredTooltip.text}"`)

  // 10. Проверяем скрытие тултипа при открытии модального окна (confirmExitToMenu)
  await page.evaluate(() => window.itd.hover('btn.boss'))
  await delay(100)
  const ttBeforeModal = await page.evaluate(() => {
    const tt = window.itd.nodes().find((n) => n.id === 'hud.tooltip.text')
    return tt?.visible
  })
  check('Тултип отображается до открытия модала', ttBeforeModal === true, `visible=${ttBeforeModal}`)

  await page.evaluate(() => window.itd.click('btn.menu'))
  await delay(100)
  const ttAfterModal = await page.evaluate(() => {
    const tt = window.itd.nodes().find((n) => n.id === 'hud.tooltip.text')
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
      contrast: window.itd.contrast(),
      tiny: window.itd.tiny(),
    }
  })
  const hudOffscreen = lintResults.offscreen.filter((o) => o.scene === 'hud')
  check('Линтер: 0 вылезаний HUD за экран', hudOffscreen.length === 0, `offscreen=${hudOffscreen.length}`)

  const buttonOverlaps = lintResults.overlaps.filter(
    (o) => o.scene === 'hud' && (o.a.includes('btn.') || o.b.includes('btn.') || o.a.includes('tooltip') || o.b.includes('tooltip'))
  )
  check('Линтер: 0 оверлапов кнопок покупки и тултипов', buttonOverlaps.length === 0, `overlaps=${buttonOverlaps.length}`)

  const tooltipContrast = lintResults.contrast.filter(
    (c) => c.text && (c.text.includes('не хватает') || c.text.includes('уже') || c.text.includes('свободного'))
  )
  check('Линтер: 0 проблем контраста тултипа', tooltipContrast.length === 0, `contrast=${tooltipContrast.length}`)

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
