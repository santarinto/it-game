// qa-itgame47 — две партии подряд в одной вкладке (ITGAME-47, закрывает ITGAME-41/42):
//   P1a  первая партия (fresh): connected, день 1, sid получен
//   P1b  уходим в комнату «Офис 2» (nav.office1): он active, виден «Офис 2 закрыт»
//        (ITGAME-41: activeOffice ≠ 0 на выходе)
//   P1c  nav.serverRoom → btn.menu → modal.btn.0 («Сохранить и выйти») без пауз в одном
//        evaluate: HUD останавливается, пока таймер дребезга switchRoom (250 мс) ещё
//        висит, switching === true (ITGAME-42)
//   P2-0 вторая партия (fresh): состояние HUD сразу после create(), до первого снапшота —
//        switching false, все списки UI пусты, hoveredButtonId null
//   P2a  sid новый, день 1; при живом сейве партии 1 старт спросил подтверждение (ITGAME-19)
//   P2b  nav.office0 active, nav.office1 нет (ITGAME-41)
//   P2c  в офисе нет «закрыт», есть «ОФИС 1» (ITGAME-41)
//   P2d  btn.pc покупает в офисе 0: buy_pc.office === 0, нет office_locked, pcs +1
//        (HUD шлёт office из nav.activeOffice; itd.cmd() слал бы 0 явно и ничего не доказал бы)
//   P2e  nav.serverRoom работает: он active, сцена serverRoom живая (ITGAME-42)
//   P2f  nav.office0 возвращает офис; itd.click ответил ok:true
//   P2g  два nav-клика в одном evaluate: первый ok:true, второй ok:false + code 'debounced'
//        (дребезг switchRoom проглотил клик — ITGAME-58); итог — первая комната, не вторая
//   S1   itd.scenario('fresh') из «Офис 2» (nav.office1 active): после него nav.office0 active,
//        nav.office1 нет (ITGAME-55)
//   S2   в офисе нет «закрыт», есть «ОФИС 1», день 1 (ITGAME-55)
//   C1   пауза, set({money:12345}), тот же выход в меню — «Продолжить» есть
//   C2   «Продолжить»: тот же sid, balance 12345, тот же день (партия не сбрасывается)
//   C3   nav.office0 active (партия осталась в офисе 0)
//   C4   nav.serverRoom работает и после «Продолжить»
//   E1   выход из «Офис 2» в меню, sid в хранилище подменён на неизвестный серверу,
//        «Продолжить» — сервер создал новую партию под этим sid, день 1 (ITGAME-54)
//   E2   после этого nav.office0 active, nav.office1 нет (ITGAME-54)
//   E3   в офисе нет «закрыт», есть «ОФИС 1» (ITGAME-54)
//   E4   btn.pc шлёт buy_pc с office 0, нет office_locked (ITGAME-54)
//   R1   живая партия с открытым О2 (купили через itd.cmd), выход в меню на nav.office1,
//        «Продолжить»: сервер сообщил resumed === true в первом снапшоте сокета (ITGAME-54)
//   R2   после этого nav.office1 по-прежнему active, nav.office0 нет — восстановленная партия
//        НЕ сбрасывается (страж условия !msg.resumed в net.ts: без него R2 краснеет)
//   R3   в офисе нет «закрыт», есть «ОФИС 2»
//        (R идёт после E: после S1/E партия вкладки уже в офисе 0, и C1–C4 не отличили бы
//        «сброс на каждом первом снапшоте» от «сброс только при resumed: false»)
//   X1   itd.restore(save) с открытым О2 (вкладка на nav.office1): nav.office1 active, нет «закрыт»,
//        есть «ОФИС 2» — контроль, restore остаётся дельтой (ITGAME-63)
//   X2   itd.restore() с offices[1].Unlocked=false при nav.office1: вкладка → nav.office0, нет
//        «закрыт», есть «ОФИС 1» (ITGAME-63)
//   O1a  itd.scenario('fresh') из открытого отчёта дня (скорость была 1): ok, HUD не слал set_speed
//        (сервер пушит снапшот новой партии раньше ответа — refresh() не должен «вернуть»
//        скорость старой) (ITGAME-64)
//   O1b  нет btn.next_day, reportUI пуст
//   O1c  sessionStorage itd.speedBeforeReport === null, reportPauseSeq === 0
//   O1d  день 1, phase running, скорость сессии 0 не тронута (владелец: партия остаётся на паузе)
//   O2a  открытая карточка события (restore activeEvent 'deadline') → после scenario() нет
//        btn.event.*, eventUI пуст
//   O2b  lastEventId === ''
//   O3   «Пока вас не было» (showOfflineReport напрямую) → после scenario() нет btn.offline.*
//   O4   окно выхода (btn.menu → modal.btn.0) → после scenario() нет modal.*, HUD жив, меню нет,
//        connected
//   O5a  финал: scenario('pre_victory') → btn.victory.menu, sessionStorage itd.sid стёрт
//        (clearSession) → scenario('fresh') ok (сессия на сервере жива до «В меню»)
//   O5b  экран победы закрыт, день 1, phase running
//   O5c  sid партии снова в хранилище вкладки и равен исходному
//   Z    на странице нет pageerror
//
// Self-serve: без QA_BASE поднимает Go-сервер на QA_PORT (по умолчанию :4181; порт не из
// WHATWG bad-ports — fetch/Chromium такие отказываются открывать) с временным каталогом
// сейвов (saves:'tmp'). Сейвы нужны: «Продолжить» без стора (-saves off) нечего
// восстанавливать. Внешнему серверу (QA_BASE) тоже нужны сейвы и ITGAME_DEBUG=1.
//
// sid скрипт НЕ задаёт: при включённых сейвах реконнект под тем же sid поднимает сейв и
// игнорирует ?scenario= (server/internal/ws/session.go), а prepareNewGame() сохраняет
// явно выставленный sessionStorage['itd.sid'] — партия 2 тогда не была бы новой.
//
// Хук create: P2-0 читает приватные поля HudScene через window.__itd.scene.getScene('hud')
// в событии 'create' — единственный детерминированный способ увидеть состояние, которое
// create() оставляет до того, как первый снапшот его «вылечит». Прецедент — qa-itgame38 C8
// (трогает объекты сцен через __itd).
//
// Не используем бросающие ожидания на условиях, которые ломает баг: после delay() читаем
// и пишем FAIL, а не умираем — чтобы до фикса прогон показал красные строки.
import { existsSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import puppeteer from 'puppeteer-core'
import { selfServe } from './lib/selfserve.mjs'

const SELF_PORT = Number(process.env.QA_PORT) || 4181

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
function check(name, pass, fact) {
  results.push({ name, pass, fact })
  console.log(`${pass ? 'PASS' : 'FAIL'}: ${name}${fact ? ` — ${fact}` : ''}`)
}

async function run() {
  let stopServer = null
  if (!process.env.QA_BASE) {
    try {
      ;({ stop: stopServer } = await selfServe({ port: SELF_PORT, saves: 'tmp', label: 'QA-ITGAME47' }))
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e))
      process.exit(1)
    }
  }
  const BASE = process.env.QA_BASE || `http://127.0.0.1:${SELF_PORT}`
  const pageErrors = []
  // launch внутри try: упавший Chromium не должен оставлять bin/itdirector на порту
  let browser = null
  try {
    browser = await puppeteer.launch({
      executablePath: chromePath(),
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    })
    const page = await browser.newPage()
    page.on('pageerror', (e) => pageErrors.push(String(e)))
    await page.setViewport({ width: 1920, height: 1080 })
    await page.goto(`${BASE}/?scenario=fresh&seed=1&debug=1`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.itd != null && window.itd.state().menuReady === true, {
      timeout: 20000,
    })

    const navIds = () => page.evaluate(() => window.itd.ids().filter((n) => n.id.startsWith('nav.')))
    const isActive = (list, id) => list.find((n) => n.id === id)?.active === true
    const officeTexts = () =>
      page.evaluate(() =>
        window.itd
          .text()
          .filter((n) => n.scene === 'office')
          .map((n) => n.text),
      )
    const sceneActive = (key) => page.evaluate((k) => window.__itd.scene.isActive(k), key)
    const waitMenu = () =>
      page.waitForFunction(() => window.itd.state().menuReady === true, { timeout: 20000 })
    // Дребезг switchRoom (250 мс) считается по игровому времени Phaser, а в headless оно
    // может отставать от стенного, поэтому перед кликом ждём switching === false
    // (без throw: на таймауте просто кликаем и читаем итог).
    const waitSwitchIdle = () =>
      page
        .waitForFunction(() => window.__itd.scene.getScene('hud').switching === false, { timeout: 3000 })
        .catch(() => {})
    // nav → меню → «Сохранить и выйти» без пауз между кликами (одна синхронная пачка)
    const fastExit = () =>
      page.evaluate(() => {
        const a = window.itd.click('nav.serverRoom')
        const b = window.itd.click('btn.menu')
        const c = window.itd.click('modal.btn.0')
        const sw = window.__itd.scene.getScene('hud').switching
        return { a, b, c, sw }
      })

    // ── Партия 1 ───────────────────────────────────────────────────────────
    const p1 = await page.evaluate(async () => {
      window.itd.click('menu.diff.normal')
      await window.itd.wait((s) => s.connected === true && s.day === 1, 15000)
      return { sid: window.itd.server().sid, day: window.itd.state().day, connected: window.itd.state().connected }
    })
    const sid1 = p1.sid
    check('P1a: первая партия — connected, день 1, sid получен', p1.connected === true && p1.day === 1 && !!sid1, JSON.stringify(p1))

    await page.evaluate(() => window.itd.click('nav.office1'))
    await delay(400)
    const p1b = await navIds()
    const p1bTexts = await officeTexts()
    check(
      'P1b: nav.office1 active, виден «Офис 2 закрыт»',
      isActive(p1b, 'nav.office1') && p1bTexts.some((t) => /^Офис 2 закрыт$/.test(t)),
      `active=${isActive(p1b, 'nav.office1')} texts=${JSON.stringify(p1bTexts)}`,
    )

    await waitSwitchIdle()
    const p1c = await fastExit()
    await waitMenu()
    check(
      'P1c: быстрый выход (nav→menu→save): clicks ok, switching === true на момент остановки HUD',
      p1c.a.ok && p1c.b.ok && p1c.c.ok && p1c.sw === true,
      JSON.stringify(p1c),
    )

    // ── Партия 2 ───────────────────────────────────────────────────────────
    const p2 = await page.evaluate(async () => {
      const hud = window.__itd.scene.getScene('hud')
      window.__qa47 = null
      hud.events.once('create', () => {
        // Phaser шлёт CREATE сразу после create(), до первого снапшота
        window.__qa47 = {
          switching: hud.switching,
          reportUI: hud.reportUI.length,
          eventUI: hud.eventUI.length,
          gameOverUI: hud.gameOverUI.length,
          victoryUI: hud.victoryUI.length,
          offlineUI: hud.offlineUI.length,
          reconnectUI: hud.reconnectUI.length,
          debugFrames: hud.debugFrames.length,
          hoveredButtonId: hud.hoveredButtonId,
        }
      })
      window.itd.click('menu.diff.normal')
      // сейв партии 1 жив — новая партия спрашивает подтверждение (ITGAME-19)
      const confirm = window.itd.click('modal.btn.confirm')
      await window.itd.wait((s) => s.connected === true && s.day === 1, 15000)
      return { at: window.__qa47, sid: window.itd.server().sid, confirm: confirm.ok }
    })
    const at = p2.at
    const lens = at ? ['reportUI', 'eventUI', 'gameOverUI', 'victoryUI', 'offlineUI', 'reconnectUI', 'debugFrames'] : []
    check(
      'P2-0: HUD после create() чист — switching false, списки UI пусты, hoveredButtonId null',
      at != null && at.switching === false && lens.every((k) => at[k] === 0) && at.hoveredButtonId === null,
      JSON.stringify(at),
    )

    const day2 = await page.evaluate(() => window.itd.state().day)
    check('P2a: партия новая — sid другой, день 1', !!p2.sid && p2.sid !== sid1 && day2 === 1, `sid1=${sid1} sid2=${p2.sid} day=${day2}`)
    check('P2a-confirm: новая партия при живом сейве спросила подтверждение (ITGAME-19)', p2.confirm === true, `modal.btn.confirm ok=${p2.confirm}`)

    await delay(300)
    const p2b = await navIds()
    check(
      'P2b: nav.office0 active, nav.office1 нет (ITGAME-41)',
      isActive(p2b, 'nav.office0') && !isActive(p2b, 'nav.office1'),
      JSON.stringify(p2b.map((n) => `${n.id}:${n.active}`)),
    )

    const p2cTexts = await officeTexts()
    check(
      'P2c: в офисе нет «закрыт», есть «ОФИС 1» (ITGAME-41)',
      !p2cTexts.some((t) => /закрыт/.test(t)) && p2cTexts.some((t) => t === 'ОФИС 1'),
      JSON.stringify(p2cTexts),
    )

    await page.evaluate(async () => {
      await window.itd.set({ money: 5000 })
      await window.itd.wait((s) => s.balance === 5000, 5000)
    })
    await delay(200)
    const pcs0 = await page.evaluate(() => window.itd.server().snapshot.offices[0].pcs)
    const tr = await page.evaluate(() => window.itd.trace(() => window.itd.click('btn.pc'), 1500))
    await delay(300)
    const pcs1 = await page.evaluate(() => window.itd.server().snapshot.offices[0].pcs)
    const buy = tr.sent.find((m) => m.type === 'buy_pc')
    check(
      'P2d: btn.pc покупает в офисе 0 — buy_pc.office 0, нет office_locked, pcs +1 (ITGAME-41)',
      buy?.office === 0 && !JSON.stringify(tr.recv).includes('office_locked') && pcs1 === pcs0 + 1,
      JSON.stringify({ sent: tr.sent, recv: tr.recv, pcs0, pcs1 }),
    )

    await page.evaluate(() => window.itd.click('nav.serverRoom'))
    await delay(400)
    const p2e = await navIds()
    const p2eScene = await sceneActive('serverRoom')
    check(
      'P2e: nav.serverRoom работает — active, сцена serverRoom живая (ITGAME-42)',
      isActive(p2e, 'nav.serverRoom') && p2eScene === true,
      `active=${isActive(p2e, 'nav.serverRoom')} scene=${p2eScene}`,
    )

    await waitSwitchIdle()
    const p2fClick = await page.evaluate(() => window.itd.click('nav.office0'))
    await delay(400)
    const p2f = await navIds()
    const p2fScene = await sceneActive('office')
    check(
      'P2f: nav.office0 возвращает офис — active, сцена office живая',
      isActive(p2f, 'nav.office0') && p2fScene === true && p2fClick.ok === true,
      `click=${JSON.stringify(p2fClick)} active=${isActive(p2f, 'nav.office0')} scene=${p2fScene}`,
    )

    // ── P2g: второй клик внутри окна дребезга честно отвечает ok:false (ITGAME-58)
    await waitSwitchIdle()
    const p2g = await page.evaluate(() => {
      const a = window.itd.click('nav.serverRoom')
      const b = window.itd.click('nav.office0')
      return { a, b }
    })
    await delay(400)
    const p2gNav = await navIds()
    check(
      'P2g: два nav-клика подряд — первый ok:true, второй ok:false code debounced; активна первая комната (ITGAME-58)',
      p2g.a.ok === true &&
        p2g.b.ok === false &&
        p2g.b.code === 'debounced' &&
        isActive(p2gNav, 'nav.serverRoom') &&
        !isActive(p2gNav, 'nav.office0'),
      `${JSON.stringify(p2g)} serverRoom=${isActive(p2gNav, 'nav.serverRoom')} office0=${isActive(p2gNav, 'nav.office0')}`,
    )
    // возвращаемся в офис, чтобы C1 стартовал из прежнего состояния
    await waitSwitchIdle()
    await page.evaluate(() => window.itd.click('nav.office0'))
    await delay(400)

    // ── S: itd.scenario() из «Офис 2» (ITGAME-55) ──────────────────────────
    await waitSwitchIdle()
    await page.evaluate(() => window.itd.click('nav.office1'))
    await delay(400)
    const s0 = await navIds()
    const s1Pre = isActive(s0, 'nav.office1')
    await page.evaluate(() => window.itd.scenario('fresh'))
    await delay(300)
    const s1Nav = await navIds()
    check(
      'S1: itd.scenario("fresh") из «Офис 2» — nav.office0 active, nav.office1 нет (ITGAME-55)',
      s1Pre && isActive(s1Nav, 'nav.office0') && !isActive(s1Nav, 'nav.office1'),
      `pre=${s1Pre} nav=${JSON.stringify(s1Nav.map((n) => `${n.id}:${n.active}`))}`,
    )
    const s2Texts = await officeTexts()
    const s2Day = await page.evaluate(() => window.itd.state().day)
    check(
      'S2: после scenario нет «закрыт», есть «ОФИС 1», день 1 (ITGAME-55)',
      !s2Texts.some((t) => /закрыт/.test(t)) && s2Texts.some((t) => t === 'ОФИС 1') && s2Day === 1,
      `day=${s2Day} texts=${JSON.stringify(s2Texts)}`,
    )

    // ── «Продолжить»: сбрасываться нечему ──────────────────────────────────
    const c1 = await page.evaluate(async () => {
      await window.itd.pause()
      await window.itd.wait((s) => s.speed === 0, 5000)
      await window.itd.set({ money: 12345 })
      await window.itd.wait((s) => s.balance === 12345, 5000)
      return { sid: window.itd.server().sid, day: window.itd.state().day }
    })
    const exit2 = await fastExit()
    await waitMenu()
    const menuIds = await page.evaluate(() => window.itd.ids().map((n) => n.id))
    check(
      'C1: пауза, 12345$, выход в меню — «Продолжить» есть',
      exit2.a.ok && exit2.b.ok && exit2.c.ok && menuIds.includes('menu.continue'),
      JSON.stringify({ exit2, hasContinue: menuIds.includes('menu.continue') }),
    )

    await page.evaluate(async () => {
      window.itd.click('menu.continue')
      await window.itd.wait((s) => s.connected === true, 15000)
    })
    await delay(300)
    const c2 = await page.evaluate(() => ({
      sid: window.itd.server().sid,
      balance: window.itd.state().balance,
      day: window.itd.state().day,
    }))
    check(
      'C2: «Продолжить» — тот же sid, balance 12345, тот же день',
      c2.sid === c1.sid && c2.balance === 12345 && c2.day === c1.day,
      `before=${JSON.stringify(c1)} after=${JSON.stringify(c2)}`,
    )

    const c3 = await navIds()
    check('C3: после «Продолжить» nav.office0 active', isActive(c3, 'nav.office0'), JSON.stringify(c3.map((n) => `${n.id}:${n.active}`)))

    await page.evaluate(() => window.itd.click('nav.serverRoom'))
    await delay(400)
    const c4 = await navIds()
    check('C4: после «Продолжить» nav.serverRoom работает (ITGAME-42)', isActive(c4, 'nav.serverRoom'), JSON.stringify(c4.map((n) => `${n.id}:${n.active}`)))

    // ── E: «Продолжить» на сейве, которого у сервера уже нет (ITGAME-54) ────
    await waitSwitchIdle()
    await page.evaluate(() => window.itd.click('nav.office1'))
    await delay(400)
    await waitSwitchIdle()
    const e0 = await fastExit()
    await waitMenu()
    const e0Menu = await page.evaluate(() => window.itd.ids().map((n) => n.id))
    // sid, которого сервер не знает: сейв «истёк/удалён». Файл в каталоге сейвов не трогаем —
    // стор держит записи в памяти, так что подмена sid в хранилище вкладки — чистый способ.
    const gone = 'qa54-gone-' + Date.now()
    await page.evaluate((g) => {
      sessionStorage.setItem('itd.sid', g)
      sessionStorage.setItem('itd.sid.auto', g)
    }, gone)
    await page.evaluate(async () => {
      window.itd.click('menu.continue')
      try {
        await window.itd.wait((s) => s.connected === true, 15000)
      } catch {
        /* читаем и пишем FAIL ниже */
      }
    })
    await delay(300)
    const e1 = await page.evaluate(() => ({
      sid: window.itd.server().sid,
      day: window.itd.state().day,
      connected: window.itd.state().connected,
    }))
    check(
      'E1: выход из «Офис 2», «Продолжить» на неизвестном серверу sid — новая партия под тем же sid, день 1 (ITGAME-54)',
      e0.a.ok && e0.b.ok && e0.c.ok && e0Menu.includes('menu.continue') && e1.connected === true && e1.sid === gone && e1.day === 1,
      JSON.stringify({ e0ok: [e0.a.ok, e0.b.ok, e0.c.ok], hasContinue: e0Menu.includes('menu.continue'), gone, e1 }),
    )
    const e2 = await navIds()
    check(
      'E2: nav.office0 active, nav.office1 нет (ITGAME-54)',
      isActive(e2, 'nav.office0') && !isActive(e2, 'nav.office1'),
      JSON.stringify(e2.map((n) => `${n.id}:${n.active}`)),
    )
    const e3Texts = await officeTexts()
    check(
      'E3: в офисе нет «закрыт», есть «ОФИС 1» (ITGAME-54)',
      !e3Texts.some((t) => /закрыт/.test(t)) && e3Texts.some((t) => t === 'ОФИС 1'),
      JSON.stringify(e3Texts),
    )
    await page.evaluate(async () => {
      await window.itd.set({ money: 5000 })
      try {
        await window.itd.wait((s) => s.balance === 5000, 5000)
      } catch {
        /* читаем ниже */
      }
    })
    await delay(200)
    const e4tr = await page.evaluate(() => window.itd.trace(() => window.itd.click('btn.pc'), 1500))
    await delay(300)
    const e4buy = e4tr.sent.find((m) => m.type === 'buy_pc')
    check(
      'E4: btn.pc шлёт buy_pc с office 0, нет office_locked (ITGAME-54)',
      e4buy?.office === 0 && !JSON.stringify(e4tr.recv).includes('office_locked'),
      JSON.stringify({ sent: e4tr.sent, recv: e4tr.recv }),
    )

    // ── R: «Продолжить» на живом сейве НЕ сбрасывает офис (страж !msg.resumed) ──
    // Партия E (новая, под sid gone) жива, вкладка в офисе 0: открываем О2 покупкой.
    const r0 = await page.evaluate(async () => {
      await window.itd.set({ money: 100000 })
      try {
        await window.itd.wait((s) => s.balance === 100000, 5000)
      } catch {
        /* читаем ниже */
      }
      const buy = await window.itd.cmd('buy_office', 1)
      try {
        await window.itd.wait((s) => s.officesUnlocked >= 2, 5000)
      } catch {
        /* читаем ниже */
      }
      await window.itd.pause()
      return { buy, unlocked: window.itd.server().snapshot?.offices?.[1]?.unlocked === true }
    })
    await waitSwitchIdle()
    await page.evaluate(() => window.itd.click('nav.office1'))
    await delay(400)
    const r0Nav = await navIds()
    const r0Texts = await officeTexts()
    const r0Ready =
      r0.buy.ok === true &&
      r0.unlocked &&
      isActive(r0Nav, 'nav.office1') &&
      !r0Texts.some((t) => /закрыт/.test(t))
    await waitSwitchIdle()
    const rExit = await fastExit() // nav.serverRoom не меняет nav.activeOffice (office -1)
    await waitMenu()
    const rMenu = await page.evaluate(() => window.itd.ids().map((n) => n.id))
    await page.evaluate(async () => {
      window.__qa47r = null
      window.itd.click('menu.continue')
      try {
        // resumed читаем в момент готовности: он true только у первого снапшота сокета
        await window.itd.wait((s) => {
          if (s.connected === true && window.__qa47r === null) {
            window.__qa47r = window.itd.server().snapshot?.resumed ?? null
          }
          return s.connected === true
        }, 15000)
      } catch {
        /* читаем и пишем FAIL ниже */
      }
    })
    await delay(300)
    const rResumed = await page.evaluate(() => window.__qa47r)
    check(
      'R1: живая партия с открытым О2, выход из nav.office1 и «Продолжить» — сервер сообщил resumed === true',
      r0Ready && rExit.a.ok && rExit.b.ok && rExit.c.ok && rMenu.includes('menu.continue') && rResumed === true,
      JSON.stringify({ r0, r0Ready, rExitOk: [rExit.a.ok, rExit.b.ok, rExit.c.ok], hasContinue: rMenu.includes('menu.continue'), resumed: rResumed }),
    )
    const r2 = await navIds()
    check(
      'R2: после «Продолжить» nav.office1 по-прежнему active, nav.office0 нет (восстановленная партия не сбрасывается)',
      isActive(r2, 'nav.office1') && !isActive(r2, 'nav.office0'),
      JSON.stringify(r2.map((n) => `${n.id}:${n.active}`)),
    )
    const r3Texts = await officeTexts()
    check(
      'R3: в офисе нет «закрыт», есть «ОФИС 2»',
      !r3Texts.some((t) => /закрыт/.test(t)) && r3Texts.some((t) => t === 'ОФИС 2'),
      JSON.stringify(r3Texts),
    )

    // ── X: itd.restore() и активный офис (ITGAME-63) ───────────────────────
    // Состояние тут: живая партия под sid gone, О2 куплен, вкладка на nav.office1, пауза.
    const idList = () => page.evaluate(() => window.itd.ids().map((n) => n.id))
    const waitTrue = (fn, ms, ...args) =>
      page.waitForFunction(fn, { timeout: ms, polling: 100 }, ...args).then(
        () => true,
        () => false,
      )
    const hudRead = () =>
      page.evaluate(() => {
        const h = window.__itd.scene.getScene('hud')
        return {
          reportUI: h.reportUI.length,
          eventUI: h.eventUI.length,
          offlineUI: h.offlineUI.length,
          victoryUI: h.victoryUI.length,
          lastEventId: h.lastEventId,
          reportPauseSeq: h.reportPauseSeq,
          sbr: sessionStorage.getItem('itd.speedBeforeReport'),
        }
      })
    const snapState = () =>
      page.evaluate(() => {
        const st = window.itd.state()
        return { day: st.day, phase: st.phase, speed: window.itd.server().snapshot?.speed ?? null }
      })

    const xSave = await page.evaluate(async () => (await window.itd.snapshot()).save)
    const x1pre = await navIds()
    await page.evaluate(async (save) => {
      try {
        await window.itd.restore(save)
      } catch {
        /* читаем и пишем FAIL ниже */
      }
    }, xSave)
    await delay(300)
    const x1Nav = await navIds()
    const x1Texts = await officeTexts()
    check(
      'X1: restore(save) с открытым О2 — nav.office1 по-прежнему active, нет «закрыт», есть «ОФИС 2» (контроль, ITGAME-63)',
      isActive(x1pre, 'nav.office1') &&
        isActive(x1Nav, 'nav.office1') &&
        !x1Texts.some((t) => /закрыт/.test(t)) &&
        x1Texts.some((t) => t === 'ОФИС 2'),
      JSON.stringify({ pre: isActive(x1pre, 'nav.office1'), nav: x1Nav.map((n) => `${n.id}:${n.active}`), texts: x1Texts }),
    )

    const x2Keys = Object.keys(xSave.offices[1] ?? {})
    const x2Copy = JSON.parse(JSON.stringify(xSave))
    x2Copy.offices[1].Unlocked = false
    const x2Err = await page.evaluate(async (save) => {
      try {
        await window.itd.restore(save)
        return null
      } catch (e) {
        return String(e?.message ?? e)
      }
    }, x2Copy)
    await delay(300)
    const x2Nav = await navIds()
    const x2Texts = await officeTexts()
    const x2Unlocked = await page.evaluate(() => window.itd.state().officesUnlocked)
    check(
      'X2: restore() с offices[1].Unlocked=false при nav.office1 — вкладка переходит в nav.office0, нет «закрыт», есть «ОФИС 1» (ITGAME-63)',
      x2Err === null &&
        isActive(x2Nav, 'nav.office0') &&
        !isActive(x2Nav, 'nav.office1') &&
        !x2Texts.some((t) => /закрыт/.test(t)) &&
        x2Texts.some((t) => t === 'ОФИС 1'),
      JSON.stringify({ err: x2Err, officeKeys: x2Keys, officesUnlocked: x2Unlocked, nav: x2Nav.map((n) => `${n.id}:${n.active}`), texts: x2Texts }),
    )

    // ── O: itd.scenario() не оставляет ничего от старой партии (ITGAME-64) ──
    // Вкладка в офисе 0 (после X2), партия на паузе в сессионной скорости 0.
    // O1: открытый отчёт дня
    await page.evaluate(() => window.itd.speed(1))
    const o1Speed = await waitTrue(() => window.itd.server().snapshot?.speed === 1, 5000)
    await page.evaluate(async () => {
      await window.itd.set({ tickInDay: 53 })
    })
    const o1Open = await waitTrue(() => window.itd.ids().some((n) => n.id === 'btn.next_day'), 8000)
    const o1Pre = { phase: (await snapState()).phase, hudRead: await hudRead() }
    const o1Ready = o1Speed && o1Open && o1Pre.hudRead.sbr === '1' && o1Pre.hudRead.reportPauseSeq > 0
    const o1tr = await page.evaluate(() => window.itd.trace(() => window.itd.scenario('fresh'), 1500))
    await delay(300)
    const o1Ids = await idList()
    const o1Hud = await hudRead()
    const o1State = await snapState()
    const o1SetSpeed = o1tr.sent.filter((m) => m.type === 'set_speed')
    check(
      'O1a: scenario(\'fresh\') из открытого отчёта — ok, HUD не слал set_speed (ITGAME-64)',
      o1Ready && o1tr.ok === true && o1SetSpeed.length === 0,
      JSON.stringify({ o1Ready, pre: o1Pre, ok: o1tr.ok, error: o1tr.error, sent: o1tr.sent }),
    )
    check(
      'O1b: после scenario() нет btn.next_day, reportUI пуст (ITGAME-64)',
      o1Ready && !o1Ids.includes('btn.next_day') && o1Hud.reportUI === 0,
      JSON.stringify({ hasNextDay: o1Ids.includes('btn.next_day'), reportUI: o1Hud.reportUI }),
    )
    check(
      'O1c: после scenario() sessionStorage itd.speedBeforeReport === null и reportPauseSeq === 0 (ITGAME-64)',
      o1Ready && o1Hud.sbr === null && o1Hud.reportPauseSeq === 0,
      JSON.stringify({ sbr: o1Hud.sbr, reportPauseSeq: o1Hud.reportPauseSeq }),
    )
    check(
      'O1d: новая партия — день 1, phase running, скорость сессии 0 не тронута (владелец: остаётся на паузе) (ITGAME-64)',
      o1Ready && o1State.day === 1 && o1State.phase === 'running' && o1State.speed === 0,
      JSON.stringify(o1State),
    )

    // O2: карточка события. Партия на паузе (O1d): тик её не разрешит.
    const o2Snap = await page.evaluate(async () => (await window.itd.snapshot()).save)
    await page.evaluate(async (tick) => {
      try {
        await window.itd.restore({ activeEvent: { ID: 'deadline', Tick: tick } })
      } catch {
        /* читаем и пишем FAIL ниже */
      }
    }, o2Snap.tickInDay)
    const o2Open = await waitTrue(() => window.itd.ids().some((n) => n.id === 'btn.event.0'), 5000)
    const o2Pre = await hudRead()
    await page.evaluate(async () => {
      try {
        await window.itd.scenario('fresh')
      } catch {
        /* читаем и пишем FAIL ниже */
      }
    })
    await delay(300)
    const o2Ids = await idList()
    const o2Hud = await hudRead()
    const o2Ready = o2Open && o2Pre.eventUI > 0 && o2Pre.lastEventId === 'deadline'
    check(
      'O2a: после scenario() нет btn.event.*, eventUI пуст (ITGAME-64)',
      o2Ready && !o2Ids.some((id) => id.startsWith('btn.event.')) && o2Hud.eventUI === 0,
      JSON.stringify({ o2Open, pre: o2Pre, eventIds: o2Ids.filter((id) => id.startsWith('btn.event.')), eventUI: o2Hud.eventUI }),
    )
    check(
      'O2b: после scenario() lastEventId === \'\' (ITGAME-64)',
      o2Ready && o2Hud.lastEventId === '',
      JSON.stringify({ lastEventId: o2Hud.lastEventId }),
    )

    // O3: «Пока вас не было». Настоящий офлайн-отчёт требует сейва возрастом в игровой день,
    // поэтому зовём настоящий обработчик HUD напрямую (юнит-стиль).
    await page.evaluate(() => {
      window.__itd.scene.getScene('hud').showOfflineReport({
        type: 'offline_report', ticks: 54, days: 1, income: 0, payroll: 0, balance: 0, gameOver: false, victory: false,
      })
    })
    await delay(200)
    const o3PreIds = await idList()
    const o3Pre = await hudRead()
    await page.evaluate(async () => {
      try {
        await window.itd.scenario('fresh')
      } catch {
        /* читаем и пишем FAIL ниже */
      }
    })
    await delay(300)
    const o3Ids = await idList()
    const o3Hud = await hudRead()
    check(
      'O3: после scenario() нет btn.offline.*, offlineUI пуст (ITGAME-64)',
      o3PreIds.includes('btn.offline.continue') &&
        o3Pre.offlineUI > 0 &&
        !o3Ids.some((id) => id.startsWith('btn.offline.')) &&
        o3Hud.offlineUI === 0,
      JSON.stringify({ preHasBtn: o3PreIds.includes('btn.offline.continue'), preUI: o3Pre.offlineUI, offlineIds: o3Ids.filter((id) => id.startsWith('btn.offline.')), offlineUI: o3Hud.offlineUI }),
    )

    // O4: окно выхода в меню
    await waitSwitchIdle()
    const o4Click = await page.evaluate(() => window.itd.click('btn.menu'))
    await delay(300)
    const o4PreIds = await idList()
    await page.evaluate(async () => {
      try {
        await window.itd.scenario('fresh')
      } catch {
        /* читаем и пишем FAIL ниже */
      }
    })
    await delay(300)
    const o4Ids = await idList()
    const o4Hud = await page.evaluate(() => ({
      hud: window.__itd.scene.isActive('hud'),
      menu: window.__itd.scene.isActive('menu'),
      connected: window.itd.state().connected,
    }))
    check(
      'O4: после scenario() нет modal.*, HUD жив, меню не открыто, connected (ITGAME-64)',
      o4Click.ok === true &&
        o4PreIds.includes('modal.btn.0') &&
        !o4Ids.some((id) => id.startsWith('modal.')) &&
        o4Hud.hud === true &&
        o4Hud.menu === false &&
        o4Hud.connected === true,
      JSON.stringify({ click: o4Click.ok, preHasModal: o4PreIds.includes('modal.btn.0'), modalIds: o4Ids.filter((id) => id.startsWith('modal.')), ...o4Hud }),
    )

    // O5: финал → scenario(). После победы net.ts стёр sid из хранилища (clearSession),
    // а сессия на сервере жива до «В меню» — партия должна воскреснуть под тем же sid.
    const o5Sid = await page.evaluate(() => window.itd.server().sid)
    await page.evaluate(async () => {
      try {
        await window.itd.scenario('pre_victory')
      } catch {
        /* читаем и пишем FAIL ниже */
      }
      window.itd.speed(3)
    })
    const o5Open = await waitTrue(() => window.itd.ids().some((n) => n.id === 'btn.victory.menu'), 10000)
    const o5PreSid = await page.evaluate(() => sessionStorage.getItem('itd.sid'))
    const o5tr = await page.evaluate(() => window.itd.trace(() => window.itd.scenario('fresh'), 800))
    await delay(300)
    const o5Ids = await idList()
    const o5Hud = await hudRead()
    const o5State = await snapState()
    const o5After = await page.evaluate(() => ({
      stored: sessionStorage.getItem('itd.sid'),
      server: window.itd.server().sid,
    }))
    const o5Ready = o5Open && o5PreSid === null
    check(
      'O5a: scenario(\'fresh\') на экране победы — ok (ITGAME-64)',
      o5Ready && o5tr.ok === true,
      JSON.stringify({ open: o5Open, preSid: o5PreSid, ok: o5tr.ok, error: o5tr.error }),
    )
    check(
      'O5b: после scenario() нет btn.victory.menu, victoryUI пуст, день 1, phase running (ITGAME-64)',
      o5Ready && !o5Ids.includes('btn.victory.menu') && o5Hud.victoryUI === 0 && o5State.day === 1 && o5State.phase === 'running',
      JSON.stringify({ hasVictoryBtn: o5Ids.includes('btn.victory.menu'), victoryUI: o5Hud.victoryUI, ...o5State }),
    )
    check(
      'O5c: sid партии снова в хранилище вкладки и совпадает с исходным (реконнект / «Продолжить» найдут её) (ITGAME-64)',
      o5Ready && o5After.stored === o5Sid && o5After.server === o5Sid,
      JSON.stringify({ before: o5Sid, ...o5After }),
    )
  } catch (e) {
    check('сценарий выполнен без исключений', false, e instanceof Error ? e.message : String(e))
  } finally {
    if (browser) await browser.close()
    if (stopServer) await stopServer()
  }
  check('Z: на странице нет pageerror', pageErrors.length === 0, pageErrors.join(' | '))
}

await run()
const failed = results.filter((r) => !r.pass)
console.log(`\nИтог QA-ITGAME47: ${results.length - failed.length}/${results.length} проверок прошло`)
if (failed.length > 0) {
  console.error(`Провалено: ${failed.map((f) => f.name).join(', ')}`)
  process.exit(1)
}
