// qa-itgame176 — экран банкротства (ITGAME-176, решение владельца 21.10, вариант В): две
// строки денег — «Долг на момент банкротства: $X» (весь минус) и «На зарплаты не хватило: $Y»
// (то, на сколько долг последнего вечера вышел за порог). Фикстура broke_day3 доживает до
// вечера на скорости 3:
//   B1  Норма — овердрафт: порог — расходы вечера (state.debtLimit); заголовок «БАНКРОТСТВО»,
//       строки подряд, X = state.debt, Y = X − debtLimit > 0, строки «Баланс» нет;
//       overlaps()/offscreen() без записей о заголовке, тексте и кнопке экрана проигрыша
//       (shortfall в самом game_over закрепляет TestSessionBankruptcyAndRestart)
//   B2  Хардкор — кредит: долг −$9,999 перед вечером, порог — лимит $10,000; то же
//   Z   нет pageerror
//
// Self-serve: без QA_BASE поднимает Go-сервер на QA_PORT (по умолчанию :4185) с
// ITGAME_DEBUG=1; нужен client/dist (npm run build). saves: 'off'.
import { setTimeout as delay } from 'node:timers/promises'
import puppeteer from 'puppeteer-core'
import { chromePath } from './lib/chrome.mjs'
import { selfServe } from './lib/selfserve.mjs'
import { waitMenuReady } from './lib/menu.mjs'

const SELF_PORT = Number(process.env.QA_PORT) || 4185
const BASE = process.env.QA_BASE || `http://127.0.0.1:${SELF_PORT}`

const results = []
const check = (name, pass, fact) => {
  results.push({ name, pass, fact })
  console.log(`${pass ? 'PASS' : 'FAIL'}: ${name} — ${fact}`)
}
const money = (n) => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US')

let stopServer = null
if (!process.env.QA_BASE) {
  try {
    ;({ stop: stopServer } = await selfServe({ port: SELF_PORT, saves: 'off', label: 'QA-ITGAME176' }))
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  }
}

let browser = null
try {
  browser = await puppeteer.launch({ executablePath: chromePath(), headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const pageErrors = []

  // Партия broke_day3 на уровне diff до экрана проигрыша: before — правка стейта до вечера.
  const bankrupt = async (diff, before) => {
    const page = await browser.newPage()
    page.on('pageerror', (e) => pageErrors.push(String(e)))
    await page.setViewport({ width: 1280, height: 720 })
    await page.goto(`${BASE}/?scenario=broke_day3&seed=1&debug=1`, { waitUntil: 'domcontentloaded' })
    await waitMenuReady(page)
    await page.evaluate((t) => {
      localStorage.setItem('itd.onboard', 'done')
      localStorage.setItem('itd.sid', 'qa176-' + t + '-' + Date.now().toString(36))
    }, diff)
    const clicked = await page.evaluate((d) => window.itd.click('menu.diff.' + d), diff)
    if (!clicked.ok) throw new Error(`${diff}: клик menu.diff.${diff} не прошёл — ${JSON.stringify(clicked)}`)
    await page.waitForFunction(() => window.itd.state().connected === true, { timeout: 20000 })
    await page.evaluate(() => window.itd.pause())
    if (before) await page.evaluate(before)
    await page.evaluate(() => window.itd.speed(3))
    await page.waitForFunction(() => window.itd.state().phase === 'game_over', { timeout: 30000 })
    await page.waitForFunction(() => window.itd.text().some((t) => (t.text ?? '').includes('Долг на момент банкротства')), { timeout: 10000 })
    await delay(400)
    const fact = await page.evaluate(() => {
      const s = window.itd.state()
      const body = window.itd.text().find((t) => (t.text ?? '').includes('Долг на момент банкротства'))?.text ?? ''
      const mine = (n) => typeof n === 'string' && (n.startsWith('Прожито дней') || n === 'БАНКРОТСТВО' || n === 'В меню' || n === 'btn.gameover.menu')
      return {
        title: window.itd.screen().meta.title,
        balance: s.balance, debt: s.debt, debtLimit: s.debtLimit, difficulty: s.difficulty,
        lines: body.split('\n'),
        overlaps: window.itd.overlaps().filter((e) => mine(e.a) || mine(e.b)),
        offscreen: window.itd.offscreen().filter((e) => Object.values(e).some(mine)),
      }
    })
    await page.close()
    return fact
  }

  const verify = (tag, f, limitWant) => {
    const debt = f.debt
    const short = debt - f.debtLimit
    const want = ['Долг на момент банкротства: ' + money(debt), 'На зарплаты не хватило: ' + money(short)]
    const at = f.lines.indexOf(want[0])
    check(`${tag}: «БАНКРОТСТВО», порог ${limitWant}, долг и нехватка — две строки подряд, X = state.debt, Y = X − порог > 0`,
      f.title === 'БАНКРОТСТВО' && f.debtLimit === limitWant && short > 0 && at >= 0 && f.lines[at + 1] === want[1] &&
        !f.lines.some((l) => l.startsWith('Баланс')),
      JSON.stringify({ title: f.title, balance: f.balance, debt: f.debt, debtLimit: f.debtLimit, lines: f.lines }))
    check(`${tag}: overlaps()/offscreen() пусты на экране проигрыша`, f.overlaps.length === 0 && f.offscreen.length === 0,
      JSON.stringify({ overlaps: f.overlaps, offscreen: f.offscreen }))
  }

  // B1 — Норма, овердрафт: порог — расходы вечера, 2 сотрудника × $250.
  const b1 = await bankrupt('normal', null)
  verify('B1 Норма (овердрафт)', b1, 500)

  // B2 — Хардкор, кредит $10,000: долг перед вечером $9,999 + ФОТ и процент — сверх лимита.
  const b2 = await bankrupt('hardcore', () => window.itd.set({ money: -9999 }))
  verify('B2 Хардкор (кредит)', b2, 10000)

  check('Z: нет pageerror', pageErrors.length === 0, JSON.stringify(pageErrors))
} catch (e) {
  check('сценарий выполнен без исключений', false, e instanceof Error ? e.stack : String(e))
} finally {
  if (browser) await browser.close()
  if (stopServer) await stopServer()
}

const failed = results.filter((r) => !r.pass)
console.log(`\nИтог QA-ITGAME176: ${results.length - failed.length}/${results.length} проверок прошло`)
if (failed.length > 0) {
  console.error(`Провалено: ${failed.map((f) => f.name).join(', ')}`)
  process.exit(1)
}
console.log('Все проверки пройдены успешно!')
