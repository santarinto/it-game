// QA-сценарий ITGAME-205: «Прокачка директора: уровни и рост запаса очков действий, апгрейды кабинета»
//
// Проверяет:
//   T1: вкладка nav.director («ДИР», «ур. 1») присутствует в левой панели HUD
//   T2: клик по nav.director открывает сцену director
//   T3: на сцене видны аватар директора (boss), уровень, опыт, очки действий и список улучшений
//   T4: линтер вёрстки itd.overlaps() и itd.offscreen() пусты на двух масштабах
//   T5: покупка улучшения кабинета директора списывает деньги, поднимает directorCabinet и actionPointsMax
//   T6: возврат в офис по клику на nav.office0
//   Z: нет ошибок страницы (pageerror)

import puppeteer from 'puppeteer-core'
import { setTimeout as delay } from 'node:timers/promises'
import { chromePath } from './lib/chrome.mjs'
import { selfServe } from './lib/selfserve.mjs'

const SELF_PORT = Number(process.env.QA_PORT) || 4194
let stopServer = null
if (!process.env.QA_BASE) {
  try {
    ;({ stop: stopServer } = await selfServe({ port: SELF_PORT, label: 'QA-ITGAME205' }))
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  }
}
const BASE = process.env.QA_BASE || `http://127.0.0.1:${SELF_PORT}`

const results = []
const check = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}: ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}

let browser = null
const pageErrors = []

try {
  browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const page = await browser.newPage()
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await page.setViewport({ width: 1920, height: 1080 })

  await page.goto(`${BASE}/?debug=1`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(async () => {
    await window.itd.wait((s) => s.menuReady === true, 10000)
    window.itd.click('menu.diff.normal')
    await window.itd.wait((s) => s.connected === true, 10000)
  })
  await delay(800)

  // T1: Вкладка nav.director в панели навигации
  const t1 = await page.evaluate(() => {
    const ids = window.itd.ids().map((x) => x.id)
    const texts = window.itd.text().map((t) => t.text)
    const hit = window.itd.hit('nav.director')
    return {
      hasDirector: ids.includes('nav.director'),
      hasDirText: texts.includes('ДИР'),
      hasLevelSub: texts.some((t) => t.includes('ур. 1')),
      hitOk: hit.ok,
    }
  })
  check('T1: вкладка nav.director («ДИР», «ур. 1») присутствует в панели HUD',
    t1.hasDirector && t1.hasDirText && t1.hasLevelSub && t1.hitOk, JSON.stringify(t1))

  // T2: Клик по nav.director открывает сцену director
  await page.evaluate(() => window.itd.click('nav.director'))
  await delay(500)
  const t2 = await page.evaluate(() => {
    const game = window.__itd
    const directorNodes = window.itd.ids().filter((x) => x.scene === 'director')
    return {
      directorActive: game.scene.isActive('director'),
      officeActive: game.scene.isActive('office'),
      nodesCount: directorNodes.length,
    }
  })
  check('T2: клик по nav.director открывает сцену director и деактивирует office',
    t2.directorActive === true && t2.officeActive === false && t2.nodesCount > 0, JSON.stringify(t2))

  // T3: Содержимое сцены директора
  const t3 = await page.evaluate(() => {
    const ids = window.itd.ids().map((x) => x.id)
    const texts = window.itd.text().map((t) => t.text)
    return {
      avatar: ids.includes('director.avatar'),
      level: ids.includes('director.level'),
      exp: ids.includes('director.exp'),
      points: ids.includes('director.points'),
      hasTitle: texts.some((t) => t.includes('КАБИНЕТ ДИРЕКТОРА')),
      hasPointsText: texts.some((t) => t.includes('Очки действий: 8 / 8')),
      hasUpgradeBtn: ids.includes('director.upgrade'),
    }
  })
  check('T3: на сцене видны аватар, уровень, очки действий и кнопка улучшения',
    t3.avatar && t3.level && t3.exp && t3.points && t3.hasTitle && t3.hasPointsText && t3.hasUpgradeBtn,
    JSON.stringify(t3))

  // T4: Линтер вёрстки на двух масштабах
  const lint = async () => page.evaluate(() => ({
    ov: window.itd.overlaps(),
    ovStrict: window.itd.overlaps({ minAreaRatio: 0 }),
    off: window.itd.offscreen(),
    scale: localStorage.getItem('itd.uiScale'),
  }))
  const z1 = await lint()
  await page.evaluate(() => window.itd.click('btn.zoom'))
  await delay(300)
  await page.evaluate(() => window.itd.click('btn.zoom'))
  await delay(400)
  const z2 = await lint()
  check('T4: линтер вёрстки overlaps() и offscreen() пусты на двух масштабах',
    z1.ov.length === 0 && z1.ovStrict.length === 0 && z1.off.length === 0 &&
    z2.ov.length === 0 && z2.ovStrict.length === 0 && z2.off.length === 0 && z1.scale !== z2.scale,
    JSON.stringify({ z1, z2 }))

  // T5: Покупка апгрейда кабинета за деньги
  // Добавим денег через itd.set({ money: 50000 })
  await page.evaluate(async () => {
    await window.itd.set({ money: 50000 })
    await window.itd.wait((s) => s.balance === 50000, 5000)
  })
  await delay(400)

  // Кликаем по кнопке апгрейда
  await page.evaluate(() => window.itd.click('director.upgrade'))
  await delay(600)

  const t5 = await page.evaluate(() => {
    const snap = window.itd.server().snapshot
    const texts = window.itd.text().map((t) => t.text)
    return {
      directorCabinet: snap?.directorCabinet,
      actionPointsMax: snap?.actionPointsMax,
      hasLevel2Text: texts.some((t) => t.includes('ур. 2')),
      hasPoints9: texts.some((t) => t.includes('/ 9')),
    }
  })
  check('T5: апгрейд кабинета повышает directorCabinet до 1 и actionPointsMax до 9',
    t5.directorCabinet === 1 && t5.actionPointsMax === 9 && t5.hasLevel2Text && t5.hasPoints9,
    JSON.stringify(t5))

  // T6: Возврат в офис по клику на nav.office0
  await page.evaluate(() => window.itd.click('nav.office0'))
  await delay(500)
  const t6 = await page.evaluate(() => {
    const game = window.__itd
    return {
      directorActive: game.scene.isActive('director'),
      officeActive: game.scene.isActive('office'),
    }
  })
  check('T6: клик по nav.office0 возвращает в офис (director неактивен, office активен)',
    t6.directorActive === false && t6.officeActive === true, JSON.stringify(t6))

  check('Z: нет pageerror', pageErrors.length === 0, JSON.stringify(pageErrors))
} catch (e) {
  check('сценарий выполнен без исключений', false, e instanceof Error ? e.stack : String(e))
} finally {
  if (browser) await browser.close()
  if (stopServer) await stopServer()
}

const failed = results.filter((r) => !r.pass)
console.log(`\nИтог QA-ITGAME205: ${results.length - failed.length}/${results.length} проверок прошло`)
if (failed.length > 0) {
  console.error(`Провалено: ${failed.map((f) => f.name).join(', ')}`)
  process.exit(1)
}
console.log('Все проверки пройдены успешно!')
