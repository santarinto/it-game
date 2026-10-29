// QA-сценарий ITGAME-201: «Новый UI: трекер задач — пока заглушка»
//
// Проверяет:
//   T1: вкладка nav.tracker («ТРК», «задачи») присутствует в левой панели HUD
//   T2: клик по nav.tracker открывает сцену tracker
//   T3: на сцене видны заголовок, плашка «В РАЗРАБОТКЕ», описание, 3 колонки канбана и карточки
//   T4: линтер вёрстки itd.overlaps() и itd.offscreen() пусты на обоих масштабах (1× и 1.4×)
//   T5: клик по nav.office0 возвращает в офис (сцена tracker гаснет, office активна)
//   Z: нет ошибок страницы (pageerror)

import puppeteer from 'puppeteer-core'
import { setTimeout as delay } from 'node:timers/promises'
import { chromePath } from './lib/chrome.mjs'
import { selfServe } from './lib/selfserve.mjs'

const SELF_PORT = Number(process.env.QA_PORT) || 4192
let stopServer = null
if (!process.env.QA_BASE) {
  try {
    ;({ stop: stopServer } = await selfServe({ port: SELF_PORT, label: 'QA-ITGAME201' }))
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

  // T1: Вкладка nav.tracker в панели навигации
  const t1 = await page.evaluate(() => {
    const ids = window.itd.ids().map((x) => x.id)
    const texts = window.itd.text().map((t) => t.text)
    const hit = window.itd.hit('nav.tracker')
    return {
      hasTracker: ids.includes('nav.tracker'),
      hasTrkText: texts.includes('ТРК'),
      hasSubText: texts.includes('задачи'),
      hitOk: hit.ok,
    }
  })
  check('T1: вкладка nav.tracker («ТРК», «задачи») присутствует в левой панели HUD',
    t1.hasTracker && t1.hasTrkText && t1.hasSubText && t1.hitOk, JSON.stringify(t1))

  // T2: Клик по nav.tracker открывает сцену tracker
  await page.evaluate(() => window.itd.click('nav.tracker'))
  await delay(500)
  const t2 = await page.evaluate(() => {
    const game = window.__itd
    const trackerNodes = window.itd.ids().filter((x) => x.scene === 'tracker')
    return {
      trackerActive: game.scene.isActive('tracker'),
      officeActive: game.scene.isActive('office'),
      nodesCount: trackerNodes.length,
    }
  })
  check('T2: клик по nav.tracker открывает сцену tracker и деактивирует office',
    t2.trackerActive === true && t2.officeActive === false && t2.nodesCount > 0, JSON.stringify(t2))

  // T3: Содержимое экрана канбан-доски
  const t3 = await page.evaluate(() => {
    const ids = window.itd.ids().map((x) => x.id)
    const texts = window.itd.text().map((t) => t.text)
    return {
      title: ids.includes('tracker.title'),
      badge: ids.includes('tracker.badge'),
      desc: ids.includes('tracker.desc'),
      cols: [0, 1, 2].every((i) => ids.includes(`tracker.col.${i}`)),
      cards: [0, 1, 2, 3].every((i) => ids.includes(`tracker.card.${i}`)),
      footer: ids.includes('tracker.footer'),
      hasDevTag: texts.some((t) => t.includes('В РАЗРАБОТКЕ')),
      hasBacklogText: texts.some((t) => t === 'БЭКЛОГ'),
      hasInProgressText: texts.some((t) => t === 'В РАБОТЕ'),
      hasDoneText: texts.some((t) => t === 'ГОТОВО'),
    }
  })
  check('T3: на сцене видны заголовок, бейдж «В РАЗРАБОТКЕ», колонки канбана и карточки',
    t3.title && t3.badge && t3.desc && t3.cols && t3.cards && t3.footer && t3.hasDevTag && t3.hasBacklogText && t3.hasInProgressText && t3.hasDoneText,
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
  check('T4: линтер вёрстки overlaps() и offscreen() пусты на двух масштабах (включая строгий режим)',
    z1.ov.length === 0 && z1.ovStrict.length === 0 && z1.off.length === 0 &&
    z2.ov.length === 0 && z2.ovStrict.length === 0 && z2.off.length === 0 && z1.scale !== z2.scale,
    JSON.stringify({ z1, z2 }))

  // T5: Возврат в офис по клику на nav.office0
  await page.evaluate(() => window.itd.click('nav.office0'))
  await delay(500)
  const t5 = await page.evaluate(() => {
    const game = window.__itd
    return {
      trackerActive: game.scene.isActive('tracker'),
      officeActive: game.scene.isActive('office'),
    }
  })
  check('T5: клик по nav.office0 возвращает в офис (tracker неактивен, office активен)',
    t5.trackerActive === false && t5.officeActive === true, JSON.stringify(t5))

  check('Z: нет pageerror', pageErrors.length === 0, JSON.stringify(pageErrors))
} catch (e) {
  check('сценарий выполнен без исключений', false, e instanceof Error ? e.stack : String(e))
} finally {
  if (browser) await browser.close()
  if (stopServer) await stopServer()
}

const failed = results.filter((r) => !r.pass)
console.log(`\nИтог QA-ITGAME201: ${results.length - failed.length}/${results.length} проверок прошло`)
if (failed.length > 0) {
  console.error(`Провалено: ${failed.map((f) => f.name).join(', ')}`)
  process.exit(1)
}
console.log('Все проверки пройдены успешно!')
