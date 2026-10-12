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
// Хранилище закрыто целиком (ITGAME-80), нужны сейвы на диске:
//   T1  «Сохранить и выйти» → «Продолжить» есть (sid в памяти вкладки) и ведёт в ту же партию (тот же sid, день 1)
//   T2  перезагрузка вкладки — «Продолжить» нет, sid новый; нет pageerror
import puppeteer from 'puppeteer-core'
import { chromePath } from './lib/chrome.mjs'
import { selfServe } from './lib/selfserve.mjs'

const SELF_PORT = Number(process.env.QA_PORT) || 4179

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

  // 8. Хранилище закрыто целиком (ITGAME-80): геттеры window.localStorage/sessionStorage и методы
  // Storage.prototype бросают SecurityError (evaluateOnNewDocument переживает reload). Сейвы на диске
  // нужны — без них сводка честно говорит exists:false и карточки «Продолжить» нет.
  const blockStorage = () => {
    const deny = (what) => function () {
      throw new DOMException(`${what}: storage blocked (qa ITGAME-80)`, 'SecurityError')
    }
    for (const name of ['localStorage', 'sessionStorage']) {
      Object.defineProperty(window, name, { configurable: true, get: deny(name) })
    }
    for (const m of ['getItem', 'setItem', 'removeItem', 'key', 'clear']) Storage.prototype[m] = deny(`Storage.${m}`)
  }
  const errsB = []
  const pb = await browser.newPage()
  pb.on('pageerror', (e) => errsB.push(String(e)))
  await pb.evaluateOnNewDocument(blockStorage)
  await pb.goto(`${BASE}/?scenario=fresh&seed=1&debug=1`, { waitUntil: 'domcontentloaded' })
  const t1 = await pb
    .evaluate(async () => {
      await window.itd.wait((s) => s.menuReady === true, 15000)
      window.itd.click('menu.diff.normal')
      const up = await window.itd.wait((s) => s.connected === true && s.day === 1, 15000).then(() => true, () => false)
      if (!up) return { up }
      const sid = window.itd.server().sid
      const a = window.itd.click('btn.menu')
      const b = window.itd.click('modal.btn.0') // «Сохранить и выйти»
      const menu = await window.itd.wait((s) => s.menuReady === true, 15000).then(() => true, () => false)
      const cont = await window.itd.wait(() => window.itd.ids().some((n) => n.id === 'menu.continue'), 8000).then(() => true, () => false)
      const m = window.__itd.scene.getScene('menu')
      const diag = { hadSave: m.hadSave, summary: m.summary === undefined ? 'undef' : m.summary === null ? 'null' : JSON.stringify(m.summary).slice(0, 120) }
      const c = cont ? window.itd.click('menu.continue') : null
      const back = cont ? await window.itd.wait((s) => s.connected === true && s.day === 1, 15000).then(() => true, () => false) : false
      const now = window.itd.server().sid
      return { up, sid, a: a.ok, b: b.ok, menu, cont, c: c?.ok ?? null, back, now, same: now === sid, diag }
    })
    .catch((e) => ({ error: String(e) }))
  note(
    'T1: хранилище закрыто — «Сохранить и выйти» → «Продолжить» есть и возвращает ту же партию (тот же sid, день 1)',
    t1.up === true && t1.a === true && t1.b === true && t1.menu === true && t1.cont === true && t1.c === true && t1.back === true && t1.same === true,
    JSON.stringify(t1),
  )
  let t2 = null
  if (t1.back) {
    await pb.reload({ waitUntil: 'domcontentloaded' })
    t2 = await pb
      .evaluate(async () => {
        await window.itd.wait((s) => s.menuReady === true, 15000)
        const m = window.__itd.scene.getScene('menu')
        return { cont: window.itd.ids().some((n) => n.id === 'menu.continue'), sid: window.itd.server().sid, hadSave: m.hadSave }
      })
      .catch((e) => ({ error: String(e) }))
  }
  note(
    'T2: перезагрузка при закрытом хранилище — «Продолжить» нет, sid новый, нет pageerror',
    t2 !== null && t2.cont === false && typeof t2.sid === 'string' && t2.sid !== t1.sid && errsB.length === 0,
    JSON.stringify({ t2, was: t1.sid, errs: errsB }),
  )
  await pb.close()
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
