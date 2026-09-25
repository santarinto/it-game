import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const BASE = process.env.QA_BASE || 'http://localhost:8089'

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

const browser = await puppeteer.launch({
  executablePath: chromePath(),
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})

const results = []
const check = (name, pass, fact) => {
  results.push({ name, pass, fact })
  console.log(`${pass ? 'PASS' : 'FAIL'}: ${name} — ${fact}`)
}

try {
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  page.on('console', (msg) => console.log('PAGE:', msg.text()))

  await page.evaluateOnNewDocument(() => {
    sessionStorage.setItem('itd.sid', 'qa18-test-' + Date.now())
    localStorage.removeItem('itd.skipReports')
  })

  await page.goto(`${BASE}/?debug=1&scenario=fresh&seed=42`, { waitUntil: 'domcontentloaded' })
  await new Promise((r) => setTimeout(r, 200))

  // 1. Старт игры
  await page.evaluate(async () => {
    await window.itd.wait((s) => s.menuReady === true, 8000)
    window.itd.click('menu.diff.normal')
    await window.itd.wait((s) => s.connected === true, 8000)
    await window.itd.set({ money: 50000 })
  })

  // 2. Установим скорость 2x перед окончанием дня
  const set2x = await page.evaluate(async () => {
    window.itd.speed(2)
    await window.itd.wait((s, srv) => srv.snapshot?.speed === 2, 5000)
    return window.itd.server().snapshot?.speed
  })
  check('Скорость установлена на 2x', set2x === 2, `speed=${set2x}`)

  // 3. Перемотаем к концу дня (тик 23 из 24)
  await page.evaluate(async () => {
    await window.itd.set({ tickInDay: 53 })
  })

  // 4. Ждем открытия модала отчета дня
  const reportOpened = await page.evaluate(async () => {
    await window.itd.wait(() => window.itd.ids().some((x) => x.id === 'btn.next_day'), 8000)
    const st = window.itd.server().snapshot
    return {
      hasBtn: window.itd.ids().some((x) => x.id === 'btn.next_day'),
      speed: st?.speed,
      day: st?.day,
      phase: st?.phase,
      balance: st?.money,
    }
  })
  check('Модал дня открылся', reportOpened.hasBtn === true, `hasBtn=${reportOpened.hasBtn}`)
  check('Скорость на паузе (0) во время модала', reportOpened.speed === 0, `speed=${reportOpened.speed}`)

  // 5. Ждем 2 секунды и проверяем, что время стоит и баланс не изменился
  await new Promise((r) => setTimeout(r, 2000))
  const pausedState = await page.evaluate(() => {
    const st = window.itd.server().snapshot
    return {
      day: st?.day,
      balance: st?.money,
      speed: st?.speed,
    }
  })
  check('Время стоит во время модала (день тот же)', pausedState.day === reportOpened.day, `day=${pausedState.day}`)
  check('Баланс не изменился (нет тиков/событий)', pausedState.balance === reportOpened.balance, `balance=${pausedState.balance}`)
  check('Скорость остается 0', pausedState.speed === 0, `speed=${pausedState.speed}`)

  // 6. Нажимаем Enter (itd.key('enter')) — переход на следующий день
  await page.evaluate(async () => {
    window.itd.key('enter')
  })

  // 7. Проверяем, что модал закрылся, наступил День 2, и восстановилась скорость 2x!
  const day2State = await page.evaluate(async () => {
    await window.itd.wait(() => !window.itd.ids().some((x) => x.id === 'btn.next_day'), 5000)
    await window.itd.wait((s) => s.day === 2 && s.phase === 'running', 5000)
    const st = window.itd.server().snapshot
    return {
      day: st?.day,
      phase: st?.phase,
      speed: st?.speed,
      noModal: !window.itd.ids().some((x) => x.id === 'btn.next_day'),
    }
  })
  check('Модал закрыт', day2State.noModal === true, `noModal=${day2State.noModal}`)
  check('День 2 наступил', day2State.day === 2 && day2State.phase === 'running', `day=${day2State.day}, phase=${day2State.phase}`)
  check('Скорость восстановлена на 2x', day2State.speed === 2, `speed=${day2State.speed}`)

  // 8. Проверяем Space на следующем дне
  await page.evaluate(async () => {
    window.itd.speed(3) // сменим на 3x
    await window.itd.wait((s, srv) => srv.snapshot?.speed === 3, 5000)
    const beforeSet = window.itd.server().snapshot
    console.log('[test] day 2 state before set:', beforeSet?.day, beforeSet?.tickInDay, beforeSet?.phase)
    await window.itd.set({ tickInDay: 53 })
    const afterSet = window.itd.server().snapshot
    console.log('[test] day 2 state after set:', afterSet?.day, afterSet?.tickInDay, afterSet?.phase)
    try {
      await window.itd.wait(() => window.itd.ids().some((x) => x.id === 'btn.next_day'), 8000)
    } catch (e) {
      const snap = window.itd.server().snapshot
      throw new Error(`Timeout waiting btn.next_day on day 2. Current snap: day=${snap?.day}, tick=${snap?.tickInDay}, phase=${snap?.phase}, money=${snap?.money}, ids=${window.itd.ids().map(x => x.id).join(',')}`)
    }
  })
  const day2ReportSpeed = await page.evaluate(() => window.itd.server().snapshot?.speed)
  check('День 2: скорость на паузе (0)', day2ReportSpeed === 0, `speed=${day2ReportSpeed}`)

  // Нажимаем Space
  await page.evaluate(async () => {
    window.itd.key('space')
  })
  const day3State = await page.evaluate(async () => {
    await window.itd.wait(() => !window.itd.ids().some((x) => x.id === 'btn.next_day'), 5000)
    await window.itd.wait((s) => s.day === 3 && s.phase === 'running', 5000)
    const st = window.itd.server().snapshot
    return {
      day: st?.day,
      speed: st?.speed,
    }
  })
  check('Space перевел на день 3', day3State.day === 3, `day=${day3State.day}`)
  check('Скорость 3x восстановлена после Space', day3State.speed === 3, `speed=${day3State.speed}`)

  // 9. Проверяем режим skipReports
  await page.evaluate(async () => {
    // Включаем skipReports через localStorage и выставляем скорость 2x
    localStorage.setItem('itd.skipReports', '1')
    window.itd.speed(2)
    await window.itd.wait((s, srv) => srv.snapshot?.speed === 2, 5000)
    // Промотаем день 3 к концу
    await window.itd.set({ tickInDay: 53 })
  })

  // С включенным skipReports игра должна автоматически перейти на следующий день (день 4) без паузы
  const skipResult = await page.evaluate(async () => {
    await window.itd.wait((s) => s.day === 4 && s.phase === 'running', 8000)
    const st = window.itd.server().snapshot
    const hasModal = window.itd.ids().some((x) => x.id === 'btn.next_day')
    return {
      day: st?.day,
      speed: st?.speed,
      hasModal,
    }
  })
  check('skipReports: день перешел на 4 без модала', skipResult.day === 4 && !skipResult.hasModal, `day=${skipResult.day}, modal=${skipResult.hasModal}`)
  check('skipReports: скорость не залипла на 0 (осталась 2)', skipResult.speed === 2, `speed=${skipResult.speed}`)

  check('Ошибок на странице нет', pageErrors.length === 0, `errors=${pageErrors.length}`)
  await page.close()
} finally {
  await browser.close()
}

const failed = results.filter((r) => !r.pass)
if (failed.length > 0) {
  console.error(`\nITGAME-18 QA FAILED: ${failed.length} checks failed!`)
  process.exit(1)
} else {
  console.log(`\nITGAME-18 QA PASSED: All ${results.length} checks passed!`)
}
