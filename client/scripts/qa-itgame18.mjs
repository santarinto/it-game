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
    if (!sessionStorage.getItem('itd.sid')) {
      sessionStorage.setItem('itd.sid', 'qa18-test-' + Date.now())
    }
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
    await window.itd.wait((s, srv) => srv.snapshot?.speed === 0, 5000)
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

  // 6. Нажимаем Enter через реальное клавиатурное событие страницы
  await page.keyboard.press('Enter')

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
  check('Модал закрыт по Enter', day2State.noModal === true, `noModal=${day2State.noModal}`)
  check('День 2 наступил', day2State.day === 2 && day2State.phase === 'running', `day=${day2State.day}, phase=${day2State.phase}`)
  check('Скорость восстановлена на 2x', day2State.speed === 2, `speed=${day2State.speed}`)

  // 8. Проверяем Space на следующем дне через реальное клавиатурное событие
  await page.evaluate(async () => {
    window.itd.speed(3) // сменим на 3x
    await window.itd.wait((s, srv) => srv.snapshot?.speed === 3, 5000)
    await window.itd.set({ tickInDay: 53 })
    await window.itd.wait(() => window.itd.ids().some((x) => x.id === 'btn.next_day'), 8000)
  })
  const day2ReportSpeed = await page.evaluate(() => window.itd.server().snapshot?.speed)
  check('День 2: скорость на паузе (0)', day2ReportSpeed === 0, `speed=${day2ReportSpeed}`)

  // Нажимаем Space
  await page.keyboard.press('Space')
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

  // 9. Перезагрузка F5 при открытом отчёте дня (ITGAME-18 Opus review)
  await page.evaluate(async () => {
    window.itd.speed(3)
    await window.itd.wait((s, srv) => srv.snapshot?.speed === 3, 5000)
    await window.itd.set({ tickInDay: 53 })
    await window.itd.wait(() => window.itd.ids().some((x) => x.id === 'btn.next_day'), 8000)
  })
  const beforeReloadStorage = await page.evaluate(() => sessionStorage.getItem('itd.speedBeforeReport'))
  check('sessionStorage хранит 3x до перезагрузки', beforeReloadStorage === '3', `val=${beforeReloadStorage}`)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await new Promise((r) => setTimeout(r, 200))

  const afterReloadReady = await page.evaluate(async () => {
    await window.itd.wait((s) => s.menuReady === true, 8000)
    const storageBeforeClick = sessionStorage.getItem('itd.speedBeforeReport')
    window.itd.click('menu.continue')
    await window.itd.wait((s) => s.connected === true, 8000)
    await window.itd.wait(() => window.itd.ids().some((x) => x.id === 'btn.next_day'), 8000)
    return {
      storageVal: storageBeforeClick,
      storageAfterConnect: sessionStorage.getItem('itd.speedBeforeReport'),
      speed: window.itd.server().snapshot?.speed,
    }
  })
  check('sessionStorage сохранил 3x после F5', afterReloadReady.storageVal === '3', `val=${afterReloadReady.storageVal}`)
  check('Скорость на сервере 0 после F5', afterReloadReady.speed === 0, `speed=${afterReloadReady.speed}`)

  // Закрываем модал кликом по кнопке btn.next_day
  await page.evaluate(() => {
    window.itd.click('btn.next_day')
  })
  const day4State = await page.evaluate(async () => {
    await window.itd.wait(() => !window.itd.ids().some((x) => x.id === 'btn.next_day'), 5000)
    await window.itd.wait((s) => s.day === 4 && s.phase === 'running', 5000)
    return {
      day: window.itd.server().snapshot?.day,
      speed: window.itd.server().snapshot?.speed,
      storageCleared: sessionStorage.getItem('itd.speedBeforeReport') === null,
    }
  })
  check('День 4 наступил после F5', day4State.day === 4, `day=${day4State.day}`)
  check('Скорость 3x восстановлена после F5 (не сбросилась в 1)', day4State.speed === 3, `speed=${day4State.speed}`)
  check('sessionStorage очищен после закрытия модала', day4State.storageCleared === true, `cleared=${day4State.storageCleared}`)

  // 10. Прямой вызов itd.cmd('next_day') во время открытого отчёта
  await page.evaluate(async () => {
    window.itd.speed(2)
    await window.itd.wait((s, srv) => srv.snapshot?.speed === 2, 5000)
    await window.itd.set({ tickInDay: 53 })
    await window.itd.wait(() => window.itd.ids().some((x) => x.id === 'btn.next_day'), 8000)
    // Шлём команду напрямую на сервер в обход proceedNextDay UI
    window.itd.cmd('next_day')
  })
  const day5State = await page.evaluate(async () => {
    await window.itd.wait(() => !window.itd.ids().some((x) => x.id === 'btn.next_day'), 5000)
    await window.itd.wait((s) => s.day === 5 && s.phase === 'running', 5000)
    return {
      day: window.itd.server().snapshot?.day,
      speed: window.itd.server().snapshot?.speed,
    }
  })
  check('itd.cmd(next_day): день 5 наступил', day5State.day === 5, `day=${day5State.day}`)
  check('itd.cmd(next_day): скорость 2x восстановлена через refresh()', day5State.speed === 2, `speed=${day5State.speed}`)

  // 11. Сохранение внешней паузы при закрытии через ENTER (путь игрока)
  await page.evaluate(async () => {
    window.itd.speed(3)
    await window.itd.wait((s, srv) => srv.snapshot?.speed === 3, 5000)
    await window.itd.set({ tickInDay: 53 })
    await window.itd.wait(() => window.itd.ids().some((x) => x.id === 'btn.next_day'), 8000)
    // Проверяем гарду itd.set({ tickInDay }) в фазе day_report
    let setRejected = false
    try {
      await window.itd.set({ tickInDay: 10 })
    } catch {
      setRejected = true
    }
    window.__setRejectedInReport = setRejected

    // Внешняя пауза, например агент или пользователь вызвал itd.speed(0)
    window.itd.speed(0)
  })
  const setCheck = await page.evaluate(() => window.__setRejectedInReport)
  check('itd.set(tickInDay) отклонён во время day_report', setCheck === true, `rejected=${setCheck}`)

  // Закрываем модал нажатием клавиши Enter (реальное DOM-событие игрока!)
  await page.keyboard.press('Enter')

  const day6State = await page.evaluate(async () => {
    await window.itd.wait(() => !window.itd.ids().some((x) => x.id === 'btn.next_day'), 5000)
    await window.itd.wait((s) => s.day === 6 && s.phase === 'running', 5000)
    return {
      day: window.itd.server().snapshot?.day,
      speed: window.itd.server().snapshot?.speed,
    }
  })
  check('День 6 наступил', day6State.day === 6, `day=${day6State.day}`)
  check('Внешняя пауза не снята (скорость осталась 0)', day6State.speed === 0, `speed=${day6State.speed}`)

  // 12. Проверяем режим skipReports
  await page.evaluate(async () => {
    // Включаем skipReports через localStorage и выставляем скорость 2x
    localStorage.setItem('itd.skipReports', '1')
    window.itd.speed(2)
    await window.itd.wait((s, srv) => srv.snapshot?.speed === 2, 5000)
    // Промотаем день 6 к концу
    await window.itd.set({ tickInDay: 53 })
  })

  // С включенным skipReports игра должна автоматически перейти на следующий день (день 7) без паузы
  const skipResult = await page.evaluate(async () => {
    await window.itd.wait((s) => s.day === 7 && s.phase === 'running', 8000)
    const st = window.itd.server().snapshot
    const hasModal = window.itd.ids().some((x) => x.id === 'btn.next_day')
    return {
      day: st?.day,
      speed: st?.speed,
      hasModal,
    }
  })
  check('skipReports: день перешел на 7 без модала', skipResult.day === 7 && !skipResult.hasModal, `day=${skipResult.day}, modal=${skipResult.hasModal}`)
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
