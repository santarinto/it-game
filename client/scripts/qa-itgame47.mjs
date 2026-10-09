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
