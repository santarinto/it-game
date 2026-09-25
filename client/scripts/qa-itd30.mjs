// QA контракта агента (ITGAME-30): два пробела живой приёмки, которые
// чинила задача. Запуск из client/ при живом dev-сервере (make dev):
//   node scripts/qa-itd30.mjs
//
// A — «фоновая вкладка»: страница со visibilityState=hidden и RAF, который
//     не выдаёт ни одного кадра (сильнее реальной скрытой вкладки). itd
//     обязан сам вести луп: ids() непуст, wait(menuReady) без слепого
//     setTimeout, click() живой, pause() до коннекта честно отказывает.
// I — «найм с занятым ПК»: fixed soft_lock + itd.cmd('hire') возвращает
//     квитанцию сервера {ok:false, code:'no_free_pc'}, а не молчаливое
//     ok:true; sid берётся из sessionStorage (вкладка-локально).
import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const BASE = process.env.QA_BASE || 'http://localhost:5173'

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

const report = []
const note = (item, name, pass, fact) => report.push({ item, name, pass, fact })

// ── A: «скрытая вкладка» — visibilityState=hidden и RAF не звонит вовсе ──
{
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  // Сильнее скрытой вкладки: RAF не выдаёт НИ ОДНОГО кадра, а страница
  // «спрятана». Живой itd обязан сам вести луп (пульс + прогрев).
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(document, 'visibilityState', {
      get: () => 'hidden',
      configurable: true,
    })
    window.requestAnimationFrame = () => 0
  })
  await page.goto(`${BASE}/?debug=1`, { waitUntil: 'domcontentloaded' })
  await new Promise((r) => setTimeout(r, 100))

  const a = await page.evaluate(async () => {
    const out = {}
    out.visibility = document.visibilityState
    out.hasItd = typeof window.itd === 'object'
    out.pauseBeforeConnect = window.itd.pause() // честный отказ до коннекта
    // слепой setTimeout не нужен: wait по menuReady сам прогревает
    try {
      const s = await window.itd.wait((s) => s.menuReady === true, 8000)
      out.menuReady = s.menuReady
    } catch (e) {
      out.menuReady = 'timeout: ' + e.message
    }
    out.idsCount = window.itd.ids().length
    out.hasMenuDiffNormal = window.itd.ids().some((x) => x.id === 'menu.diff.normal')
    out.clickMenu = window.itd.click('menu.diff.normal')
    out.warm = typeof window.itd.warm() === 'number'
    out.errors = window.itd.errors()
    return out
  })
  note('A', 'visibilityState скрыт', a.visibility === 'hidden', a.visibility)
  note('A', 'window.itd есть', a.hasItd === true, String(a.hasItd))
  note('A', 'pause() до коннекта честен', a.pauseBeforeConnect?.ok === false && a.pauseBeforeConnect?.code === 'not_connected', JSON.stringify(a.pauseBeforeConnect))
  note('A', 'wait(menuReady) без setTimeout', a.menuReady === true, String(a.menuReady))
  note('A', 'ids() непуст без кадров RAF', a.idsCount > 0 && a.hasMenuDiffNormal === true, `ids=${a.idsCount}, menu.diff.normal=${a.hasMenuDiffNormal}`)
  note('A', 'click() работает в скрытой', a.clickMenu?.ok === true, JSON.stringify(a.clickMenu))
  note('A', 'warm() есть', a.warm === true, String(a.warm))
  note('A', 'ошибок страницы нет', a.errors.length === 0 && errors.length === 0, JSON.stringify({ itd: a.errors, page: errors }))
  await page.close()
}

// ── I: квитанции отказов сервера ──
// soft_lock: $100 против найма $300 → not_enough_money.
// full_office: 12 ПК и 12 сотрудников, денег хватает → no_free_pc.
{
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.evaluateOnNewDocument(() => {
    // агрессивный сценарий: sid в sessionStorage — вкладка-локально
    sessionStorage.setItem('itd.sid', 'qa30-i-' + Date.now())
  })
  await page.goto(`${BASE}/?debug=1&scenario=soft_lock&seed=1`, { waitUntil: 'domcontentloaded' })

  const i = await page.evaluate(async () => {
    const out = {}
    out.sidFromSession = sessionStorage.getItem('itd.sid')
    await window.itd.wait((s) => s.menuReady === true, 8000)
    out.click = window.itd.click('menu.diff.normal')
    await window.itd.wait((s) => s.connected === true, 10000)
    const st = window.itd.state()
    out.state = { day: st.day, scenario: st.scenario, staff: st.staff, balance: st.balance }
    out.serverSid = window.itd.server().sid
    out.sidSwitches = window.itd.server().sidSwitches
    out.cmdUnknown = await window.itd.cmd('nonsense')
    out.hire = await window.itd.cmd('hire') // $100 < $300 → not_enough_money
    out.pauseNow = window.itd.pause()       // подключены — ок
    out.resumeNow = window.itd.resume()
    out.errors = window.itd.errors()
    return out
  })
  note('I', 'sid взят из sessionStorage', (i.sidFromSession ?? '').startsWith('qa30-i-') && i.serverSid === i.sidFromSession, `${i.sidFromSession} / server=${i.serverSid}`)
  note('I', 'soft_lock стартизуется', i.state.scenario === 'soft_lock' && i.state.day === 40, JSON.stringify(i.state))
  note('I', 'cmd(nonsense) отклонён', i.cmdUnknown?.ok === false && typeof i.cmdUnknown.error === 'string', JSON.stringify(i.cmdUnknown))
  note('I', "cmd('hire') на soft_lock → not_enough_money", i.hire?.ok === false && i.hire?.code === 'not_enough_money', JSON.stringify(i.hire))
  note('I', 'pause/resume на коннекте ок', i.pauseNow?.ok === true && i.resumeNow?.ok === true, JSON.stringify({ p: i.pauseNow, r: i.resumeNow }))
  note('I', 'ошибок страницы нет', i.errors.length === 0 && errors.length === 0, JSON.stringify({ itd: i.errors, page: errors }))
  await page.close()
}
{
  const page = await browser.newPage()
  await page.evaluateOnNewDocument(() => {
    sessionStorage.setItem('itd.sid', 'qa30-i2-' + Date.now())
  })
  await page.goto(`${BASE}/?debug=1&scenario=full_office&seed=1`, { waitUntil: 'domcontentloaded' })
  const i2 = await page.evaluate(async () => {
    const out = {}
    await window.itd.wait((s) => s.menuReady === true, 8000)
    window.itd.click('menu.diff.normal')
    await window.itd.wait((s) => s.connected === true, 10000)
    out.state = { scenario: window.itd.state().scenario, staff: window.itd.state().staff, staffLimit: window.itd.state().staffLimit }
    out.hire = await window.itd.cmd('hire') // staff=12=limit → staff_limit (проверка штата раньше ПК)
    return out
  })
  note('I', 'full_office: staff=12', i2.state.staff === 12, JSON.stringify(i2.state))
  note('I', "cmd('hire') при полном штате → staff_limit", i2.hire?.ok === false && i2.hire?.code === 'staff_limit', JSON.stringify(i2.hire))
  await page.close()
}
{
  const page = await browser.newPage()
  await page.evaluateOnNewDocument(() => {
    sessionStorage.setItem('itd.sid', 'qa30-i3-' + Date.now())
  })
  await page.goto(`${BASE}/?debug=1&scenario=mid_day10&seed=1`, { waitUntil: 'domcontentloaded' })
  const i3 = await page.evaluate(async () => {
    const out = {}
    await window.itd.wait((s) => s.menuReady === true, 8000)
    window.itd.click('menu.diff.normal')
    await window.itd.wait((s) => s.connected === true, 10000)
    out.state = { scenario: window.itd.state().scenario, staff: window.itd.state().staff, staffLimit: window.itd.state().staffLimit }
    out.hire = await window.itd.cmd('hire') // 5 ПК и 5 сотрудников, лимит 9 → no_free_pc
    return out
  })
  note('I', 'mid_day10: staff=5, все ПК заняты', i3.state.staff === 5 && i3.state.staffLimit > i3.state.staff, JSON.stringify(i3.state))
  note('I', "cmd('hire') при занятых ПК → no_free_pc", i3.hire?.ok === false && i3.hire?.code === 'no_free_pc', JSON.stringify(i3.hire))
  await page.close()
}

// ── C2: ключ появляется только с партиёй; чужой game_over не осиротит ──
{
  // 1) свежая страница: чтения (state/server/pause) не создают ключей
  const page = await browser.newPage()
  await page.evaluateOnNewDocument(() => localStorage.clear())
  await page.goto(`${BASE}/?debug=1`, { waitUntil: 'domcontentloaded' })
  const c1 = await page.evaluate(async () => {
    window.itd.state(); window.itd.server(); window.itd.pause()
    return {
      local: localStorage.getItem('itd.sid'),
      session: sessionStorage.getItem('itd.sid'),
    }
  })
  note('C2', 'чтение не пишет sid в хранилища', c1.local === null && c1.session === null, JSON.stringify(c1))
  // 2) агентский sid (sessionStorage) не попадает в общий ключ
  const c2 = await page.evaluate(async () => {
    sessionStorage.setItem('itd.sid', 'qa30-c2-agent')
    await window.itd.wait((s) => s.menuReady === true, 8000)
    window.itd.click('menu.diff.normal')
    await window.itd.wait((s) => s.connected === true, 10000)
    return {
      local: localStorage.getItem('itd.sid'),
      session: sessionStorage.getItem('itd.sid'),
      server: window.itd.server().sid,
    }
  })
  note('C2', 'агентский sid не загрязняет localStorage', c2.local === null && c2.server === 'qa30-c2-agent', JSON.stringify(c2))
  await page.close()

  // 3) «игрок»: sid в localStorage, партия жива; соседняя вкладка вытирает
  //    общий ключ (чужой game_over) — живая вкладка возвращает его на место
  const player = await browser.newPage()
  await player.evaluateOnNewDocument(() => {
    localStorage.clear()
    localStorage.setItem('itd.sid', 'qa30-c2-player')
  })
  await player.goto(`${BASE}/?debug=1`, { waitUntil: 'domcontentloaded' })
  await player.evaluate(async () => {
    await window.itd.wait((s) => s.menuReady === true, 8000)
    window.itd.click('menu.diff.normal')
    await window.itd.wait((s) => s.connected === true, 10000)
  })
  const neighbor = await browser.newPage()
  await neighbor.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  await neighbor.evaluate(() => localStorage.removeItem('itd.sid'))
  await new Promise((r) => setTimeout(r, 300)) // storage event долетает асинхронно
  const after = await player.evaluate(() => ({
    local: localStorage.getItem('itd.sid'),
    sessionMirror: sessionStorage.getItem('itd.sid'),
    connected: window.itd.state().connected,
  }))
  note('C2', 'живая вкладка вернула вытертый ключ', after.local === 'qa30-c2-player' && after.connected === true, JSON.stringify(after))
  note('C2', 'зеркало вкладки лежит в sessionStorage', after.sessionMirror === 'qa30-c2-player', JSON.stringify(after))
  await neighbor.close()

  // 4) перезагрузка живой вкладки после вытирания — партия та же (не день 1):
  //    сервер живёт своей скоростью, поэтому сверяем sid и «день не уехал назад»
  const dayBefore = await player.evaluate(() => window.itd.state().day)
  await player.reload({ waitUntil: 'domcontentloaded' })
  const resumed = await player.evaluate(async () => {
    await window.itd.wait((s) => s.menuReady === true, 8000)
    const hasContinue = window.itd.ids().some((x) => x.id === 'menu.continue')
    window.itd.click('menu.continue')
    await window.itd.wait((s) => s.connected === true, 10000)
    const st = window.itd.state()
    return { hasContinue, day: st.day, sid: window.itd.server().sid }
  })
  note('C2', 'после вытирания+перезагрузки партия та же', resumed.hasContinue === true && resumed.sid === 'qa30-c2-player' && resumed.day >= dayBefore, `day ${dayBefore} → ${resumed.day}, sid=${resumed.sid}`)
  await player.close()
}

await browser.close()

let failed = 0
for (const r of report) {
  if (!r.pass) failed++
  console.log(`${r.pass ? 'PASS' : 'FAIL'} [${r.item}] ${r.name} — ${r.fact}`)
}
console.log(failed === 0 ? '\nQA ITGAME-30: ВСЁ ЗЕЛЁНОЕ' : `\nQA ITGAME-30: ПРОВАЛОВ — ${failed}`)
process.exit(failed === 0 ? 0 : 1)
