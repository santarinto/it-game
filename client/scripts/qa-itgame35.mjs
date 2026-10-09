// QA сценарий ITGAME-35:
// «Мульти-вкладки: извещение о живой соседней вкладке перед «ПРОДОЛЖИТЬ» (война session_taken)»
//
// Запуск из корня проекта:
//   node client/scripts/qa-itgame35.mjs
//
// Self-serve: без QA_BASE поднимает Go-сервер на QA_PORT (по умолчанию
// :4179) с временным каталогом сейвов (saves:'tmp', удаляется в конце).
// ВАЖНО: вытеснение вкладки (session_taken) реализовано только через
// серверный стор сейвов (server/internal/ws/session.go, ~строка 268,
// store.Begin/kick) — внешнему серверу, заданному через QA_BASE, НУЖНЫ
// сейвы (не запускайте его с -saves off, иначе шаги 5-7 не пройдут).
import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'
import { selfServe } from './lib/selfserve.mjs'

const SELF_PORT = Number(process.env.QA_PORT) || 4179

function chromePath() {
  const cands = [
    process.env.CHROME_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable',
  ].filter(Boolean)
  const found = cands.find((p) => existsSync(p))
  if (!found) throw new Error('chromium не найден — задайте CHROME_PATH')
  return found
}

let stopServer = null
if (!process.env.QA_BASE) {
  try {
    ;({ stop: stopServer } = await selfServe({ port: SELF_PORT, saves: 'tmp', label: 'QA-ITGAME35' }))
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  }
}
const BASE = process.env.QA_BASE || `http://127.0.0.1:${SELF_PORT}`

const report = []
const note = (name, pass, fact) => report.push({ name, pass, fact })

// launch внутри try: упавший Chromium не должен оставлять bin/itdirector на порту
let browser = null
try {
  browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })

  // 1. Первая вкладка: чистый старт и запуск игры
  const tab1 = await browser.newPage()
  await tab1.evaluateOnNewDocument(() => localStorage.clear())
  await tab1.goto(`${BASE}/?debug=1`, { waitUntil: 'domcontentloaded' })

  const tab1Info = await tab1.evaluate(async () => {
    await window.itd.wait((s) => s.menuReady === true, 8000)
    window.itd.click('menu.diff.normal')
    await window.itd.wait((s) => s.connected === true, 10000)
    return {
      sid: window.itd.server().sid,
      socket: window.itd.net(1).socket,
      connected: window.itd.state().connected,
    }
  })

  note('Вкладка 1 запустила партию', tab1Info.connected && tab1Info.socket === 'open', JSON.stringify(tab1Info))

  // 2. Вторая вкладка: открывает сайт, видит «ПРОДОЛЖИТЬ»
  const tab2 = await browser.newPage()
  await tab2.goto(`${BASE}/?debug=1`, { waitUntil: 'domcontentloaded' })

  const tab2Menu = await tab2.evaluate(async () => {
    await window.itd.wait((s) => s.menuReady === true, 8000)
    return {
      hasContinue: window.itd.ids().some((x) => x.id === 'menu.continue'),
    }
  })

  note('Вкладка 2 видит кнопку ПРОДОЛЖИТЬ', tab2Menu.hasContinue === true, String(tab2Menu.hasContinue))

  // 3. Вкладка 2 нажимает «ПРОДОЛЖИТЬ»
  await tab2.evaluate(async () => {
    window.itd.click('menu.continue')
    // Ждём появления модалки конфликта
    await window.itd.wait(() => window.itd.ids().some((x) => x.id === 'modal.btn.takeover'), 3000)
  })

  const conflictState = await tab2.evaluate(() => {
    const ids = window.itd.ids().map((x) => x.id)
    return {
      hasTakeover: ids.includes('modal.btn.takeover'),
      hasCancel: ids.includes('modal.btn.cancel'),
    }
  })

  note(
    'Появилась модалка предупреждения о живой соседней вкладке',
    conflictState.hasTakeover && conflictState.hasCancel,
    JSON.stringify(conflictState),
  )

  // 4. Проверяем, что первая вкладка ВСЁ ЕЩЁ в игре и не получила session_taken
  const tab1Still = await tab1.evaluate(() => ({
    socket: window.itd.net(1).socket,
    connected: window.itd.state().connected,
    errors: window.itd.errors().length,
  }))

  note(
    'Вкладка 1 осталась в игре без session_taken после клика «ПРОДОЛЖИТЬ» во второй',
    tab1Still.socket === 'open' && tab1Still.connected === true,
    JSON.stringify(tab1Still),
  )

  // 5. Вкладка 2 нажимает «Остаться в меню» (отмена)
  await tab2.evaluate(async () => {
    window.itd.click('modal.btn.cancel')
    await window.itd.wait(() => !window.itd.ids().some((x) => x.id === 'modal.btn.takeover'), 2000)
  })

  const tab2AfterCancel = await tab2.evaluate(() => ({
    modalClosed: !window.itd.ids().some((x) => x.id === 'modal.btn.takeover'),
    hasContinue: window.itd.ids().some((x) => x.id === 'menu.continue'),
  }))

  note(
    'Модалка закрылась по отмене, вкладка 2 осталась в меню',
    tab2AfterCancel.modalClosed && tab2AfterCancel.hasContinue,
    JSON.stringify(tab2AfterCancel),
  )

  const tab1AfterCancel = await tab1.evaluate(() => ({
    socket: window.itd.net(1).socket,
    connected: window.itd.state().connected,
  }))

  note(
    'Вкладка 1 по-прежнему спокойно играет',
    tab1AfterCancel.socket === 'open' && tab1AfterCancel.connected === true,
    JSON.stringify(tab1AfterCancel),
  )

  // 6. Вкладка 2 снова нажимает «ПРОДОЛЖИТЬ» и явно подтверждает перехват
  await tab2.evaluate(async () => {
    window.itd.click('menu.continue')
    await window.itd.wait(() => window.itd.ids().some((x) => x.id === 'modal.btn.takeover'), 3000)
    window.itd.click('modal.btn.takeover')
    await window.itd.wait((s) => s.connected === true, 10000)
  })

  const tab2TakenOver = await tab2.evaluate(() => ({
    sid: window.itd.server().sid,
    connected: window.itd.state().connected,
    socket: window.itd.net(1).socket,
  }))

  note(
    'Вкладка 2 успешно забрала управление партией после подтверждения',
    tab2TakenOver.connected === true && tab2TakenOver.sid === tab1Info.sid,
    JSON.stringify(tab2TakenOver),
  )

  // 7. Первая вкладка теперь честно отключена сервером по session_taken
  await new Promise((r) => setTimeout(r, 300))
  const tab1TakenOver = await tab1.evaluate(() => ({
    socket: window.itd.net(1).socket,
    sessionTakenOver: window.itd.server().takenOver,
  }))

  note(
    'Вкладка 1 теперь вытеснена (session_taken)',
    tab1TakenOver.socket === 'closed' || tab1TakenOver.sessionTakenOver === true,
    JSON.stringify(tab1TakenOver),
  )

  await tab1.close()
  await tab2.close()
} finally {
  if (browser) await browser.close()
  if (stopServer) await stopServer()
}

let failed = 0
for (const r of report) {
  if (!r.pass) failed++
  console.log(`${r.pass ? 'PASS' : 'FAIL'}: ${r.name} — ${r.fact}`)
}

console.log(failed === 0 ? '\nQA ITGAME-35: ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : `\nQA ITGAME-35: ПРОВАЛОВ — ${failed}`)
process.exit(failed === 0 ? 0 : 1)
