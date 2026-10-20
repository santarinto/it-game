// qa-itgame37 — живая трассировка itd.trace() (ITGAME-37):
//   1  из меню: trace(() => click('menu.diff.normal'), 3000) → переход
//      сцен содержит office+hud, фаза null → running
//   2  set({money:50000}), trace(() => click('btn.pc')) → sent[0] =
//      {type:'buy_pc', office:0}, sounds содержит name 'select'
//   3  set({money:0}), trace(() => cmd('buy_pc'), 800) → recv
//      {type:'error', info.code:'not_enough_money'}, тост из ERROR_TEXTS,
//      звук 'error'
//   4  trace(() => pause()) → sent set_speed{speed:0} с src itd (ITGAME-179), transition speed
//      1 → 0 (стартовая скорость сессии — 1, protocol_test.go)
//   5  на паузе trace(() => {}, 500) → все массивы пустые, t1−t0 ≥ 500
//   6  граница окна: resume() за окном (700мс > 300) → sent пуст;
//      resume() внутри окна (100мс < 300) → одна запись
//   7  параллельность: A=trace(resume, 1500), через 800мс B=trace(pause, 300)
//      → A.sent=[speed1,speed0], B.sent=[speed0]
//   8  itd.key: esc → {key:'ESC', source:'itd', handled:true, scenes:['hud']}
//      (hud слушает ESC безусловно — createNavPanel навешивает kb.on ещё в
//      create(), обработка НЕ зависит от того, открыт ли отчёт дня);
//      key('1') в игре → handled:false (клавишу слушает только MenuScene)
//   9  DOM-клавиши (реальный keyboard.press): Escape → {source:'dom',
//      handled:true}; KeyA → {key:'A', handled:false}
//  10  отчёт дня: speed(2), set({tickInDay:53}), ждём btn.next_day, затем
//      DOM Enter внутри окна → keys ENTER dom handled:true, sent строго
//      [set_speed{speed:2}, next_day] c src ui — настоящая клавиша (proceedNextDay
//      восстанавливает скорость ДО отчёта, затем next_day), transition phase
//      day_report → running
//  10b каноническая форма: key('enter') на открытом отчёте → ENTER itd
//      handled:true, acted [{hud,next_day}], sent [set_speed, next_day] c src itd
//  10c каноническая форма: click('btn.next_day') → ok, sent
//      [set_speed, next_day] c src itd, keys пуст (клик — не клавиша)
//  10d отчёт закрыт, игра идёт: key('enter') → handled:true, acted [],
//      sent пуст (клавиша дошла до HUD, guard отбросил)
//  11  trace(() => throw, 100) → {ok:false, error:'boom'}; проверка утечки:
//      объект закрытого окна не растёт от новых стимулов (key/sent/переходы/
//      тосты/звуки), контроль — те же стимулы внутри живого окна дают записи
//  12  windowMs −1 и 20000 → reject
//  13  квитанции по id (ITGAME-45): отказ cmd('buy_pc') — {id, rev}, тот же
//      id в trace.sent и в info.re ошибки (trace.recv) и в itd.net(); успех —
//      states[] окна содержит {re: id, cause:'cmd', rev}; server().rev/cause
//  13b гонка с тиком в настоящем клиенте: speed(3), главный поток занят
//      400 мс (> тика 333 мс — тиковый state «в пути»), затем cmd с отказом
//      → квитанция bad_speed, а не ok от тика (FIFO дал бы ok)
//  13c гонка с наблюдателем: страница открывает /ws/agent на свой sid,
//      агент шлёт hire, главный поток занят 150 мс (снапшот найма «в пути»),
//      затем cmd с отказом → bad_speed; снапшот найма у вкладки без re
//  14  (ITGAME-88) открытое окно + настоящий клик: itd.trace.start() → page.mouse.click
//      по центру btn.pc (screen() x/y) ОТДЕЛЬНЫМ вызовом → itd.trace.stop(id): pointer
//      down/up, onCanvas, x/y ≈ cx/cy, wins — метка 'btn:pc' (хит-тест Phaser, как got; ITGAME-179),
//      got ['btn:pc'], sent buy_pc с src ui; клик по #build (#topbar) — onCanvas false, wins null, got []
//  14b (ITGAME-112) got у кнопки, удалившей себя в pointerdown: настоящий клик по ✕ «Выйти в меню?» —
//      got на down [modal:close], на up его нет; тестовые прямоугольники в hud: удаляющий себя в
//      pointerdown — got [probe:gone] на down и [] на up, второй — [probe:keep] на down и up;
//      на up — gone: ✕ [modal:close], probe.gone [probe:gone], probe.hide (прячет себя)
//      [probe:hide], probe.keep и btn:menu [] (ITGAME-148)
//  15  (ITGAME-88) окно: stop() без окна — no_trace; start({maxMs:300}) само закрылось —
//      cut, windowMs ≈ 300; bad_max; два окна — stop() закрывает последнее, stop(id) первое;
//      itd.click() внутри окна — sent есть, pointer пуст (мимо input-слоя);
//      классическая форма trace(action, ms) тоже несёт pointer []; itd.click() — src itd
//  15b (ITGAME-160) peek: no_trace без окна; копия растёт между кликами, мутация не течёт; окно в start().open;
//      stop(id) — тот же id; peek после stop — no_trace; peek cut-окна — cut:true и итоговый windowMs
//  16  (ITGAME-179) itd.trace.summary(id) открытого окна = summary(tr) после stop, строки по t,
//      каждая разновидность по образцу; no_trace с lines [] без окна и для не-TraceResult
//   + на странице нет pageerror
//
// Отклонения от буквального сценария в трекере (см. отчёт агента): нет —
// все шаги воспроизведены как описаны, п.10 подтверждён по коду
// HUDScene.proceedNextDay()/onDayReport (restore-скорость ДО next_day).
//
// Self-serve: без QA_BASE поднимает Go-сервер на QA_PORT (по умолчанию
// :4176 — свой порт задачи, соседи 4173/4174/4175/4177/8091 заняты).
// Общий self-serve — client/scripts/lib/selfserve.mjs.
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'
import { chromePath } from './lib/chrome.mjs'
import { selfServe } from './lib/selfserve.mjs'
import { waitMenuReady } from './lib/menu.mjs'

const CLIENT_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const SELF_PORT = Number(process.env.QA_PORT) || 4176
const HINT_IDS = ['master', 'router', 'core', 'server', 'cooler', 'fridge', 'motivate', 'softlock']

const BASE = process.env.QA_BASE || `http://127.0.0.1:${SELF_PORT}`

const results = []
function check(name, pass, fact) {
  results.push({ name, pass, fact })
  console.log(`${pass ? 'PASS' : 'FAIL'}: ${name}${fact ? ` — ${fact}` : ''}`)
}

// Готовность меню — waitMenuReady (lib/menu.mjs): sid выставлен до документа, меню ждёт
// сводку сейва, и ранний клик открывал «Начать заново?» — п.1 видел transitions [] (ITGAME-130).

// sent-запись командного типа type/speed — { t, type, office, speed? }.
const speedSent = (list) => list.filter((e) => e.type === 'set_speed').map((e) => e.speed)

async function run() {
  let stopServer = null
  if (!process.env.QA_BASE) {
    try {
      ;({ stop: stopServer } = await selfServe({ port: SELF_PORT, saves: 'off', label: 'QA-ITGAME37' }))
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e))
      process.exit(1)
    }
  }

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

    // sid уникален (агрессивный прогон) и онбординг-хинты помечены
    // показанными — тосты хинтов не мешают проверкам toasts/sounds.
    const sid = 'qa37-' + Date.now().toString(36)
    await page.evaluateOnNewDocument(
      (sid, hintIds) => {
        try {
          sessionStorage.setItem('itd.sid', sid)
          for (const id of hintIds) localStorage.setItem('itd.hint:' + id, '1')
        } catch {
          // приватная вкладка/заблокированное хранилище — не критично для QA
        }
      },
      sid,
      HINT_IDS,
    )

    await page.goto(`${BASE}/?scenario=fresh&seed=1&debug=1`, { waitUntil: 'domcontentloaded' })
    await waitMenuReady(page)

    // ── 1: из меню — переход сцен menu → office+hud, фаза null → running
    const t1 = await page.evaluate(() => window.itd.trace(() => window.itd.click('menu.diff.normal'), 3000))
    const scenesT1 = t1.transitions.find(
      (tr) => tr.kind === 'scenes' && typeof tr.to === 'string' && tr.to.includes('office') && tr.to.includes('hud'),
    )
    check('1: переход сцен menu → office+hud', t1.ok && !!scenesT1, JSON.stringify(scenesT1 ?? t1.transitions))
    const phaseT1 = t1.transitions.find((tr) => tr.kind === 'phase')
    check('1: фаза null → running', phaseT1?.from === null && phaseT1?.to === 'running', JSON.stringify(phaseT1))

    await page.waitForFunction(() => window.itd.state().connected === true, { timeout: 20000 })
    await delay(300)

    // ── 2: покупка ПК — sent[0] строго buy_pc/office:0, звук select
    await page.evaluate(() => window.itd.set({ money: 50000 }))
    await page.waitForFunction(() => window.itd.state().balance === 50000, { timeout: 5000 })
    const t2 = await page.evaluate(() => window.itd.trace(() => window.itd.click('btn.pc')))
    check(
      '2: sent[0] = buy_pc/office:0',
      t2.sent[0]?.type === 'buy_pc' && t2.sent[0]?.office === 0,
      JSON.stringify(t2.sent),
    )
    check('2: sounds содержит name select, key sfx:select', t2.sounds.some((s) => s.name === 'select' && s.key === 'sfx:select'), JSON.stringify(t2.sounds))

    // ── 3: отказ сервера — recv error/not_enough_money, тост, звук error
    await page.evaluate(() => window.itd.set({ money: 0 }))
    await page.waitForFunction(() => window.itd.state().balance === 0, { timeout: 5000 })
    const t3 = await page.evaluate(() => window.itd.trace(() => window.itd.cmd('buy_pc'), 800))
    const errRecvT3 = t3.recv.find((e) => e.type === 'error')
    check(
      '3: recv error info.code=not_enough_money',
      errRecvT3?.info?.code === 'not_enough_money',
      JSON.stringify(errRecvT3),
    )
    check(
      '3: тост «Не хватает денег»',
      t3.toasts.some((tt) => tt.text === 'Не хватает денег'),
      JSON.stringify(t3.toasts),
    )
    check('3: sounds содержит name error, key sfx:error', t3.sounds.some((s) => s.name === 'error' && s.key === 'sfx:error'), JSON.stringify(t3.sounds))

    // Деньги обратно — иначе конец дня в п.10 уйдёт в deadlock/game_over,
    // а не в day_report (см. отчёт qa-itgame38 про MinCostToEarn).
    await page.evaluate(() => window.itd.set({ money: 20000 }))
    await page.waitForFunction(() => window.itd.state().balance === 20000, { timeout: 5000 })

    // ── 4: pause() — sent set_speed{0}, transition speed 1 → 0 (старт сессии)
    const t4 = await page.evaluate(() => window.itd.trace(() => window.itd.pause()))
    check('4: sent set_speed speed:0', speedSent(t4.sent).includes(0), JSON.stringify(t4.sent))
    check(
      '4: set_speed от itd.pause() — src itd (ITGAME-179)',
      t4.sent.some((e) => e.type === 'set_speed') && t4.sent.filter((e) => e.type === 'set_speed').every((e) => e.src === 'itd'),
      JSON.stringify(t4.sent),
    )
    const speedT4 = t4.transitions.find((tr) => tr.kind === 'speed')
    check('4: transition speed 1 → 0', speedT4?.from === 1 && speedT4?.to === 0, JSON.stringify(speedT4))
    await page.waitForFunction(() => window.itd.state().speed === 0, { timeout: 5000 })

    // ── 5: на паузе — окно без единого события, длительность выдержана
    const t5 = await page.evaluate(() => window.itd.trace(() => {}, 500))
    const emptyT5 =
      t5.keys.length === 0 && t5.sent.length === 0 && t5.recv.length === 0 &&
      t5.transitions.length === 0 && t5.toasts.length === 0 && t5.sounds.length === 0
    check('5: на паузе все массивы пустые', emptyT5, JSON.stringify(t5))
    check('5: t1 − t0 ≥ 500', t5.t1 - t5.t0 >= 500, `t1-t0=${t5.t1 - t5.t0}`)

    // ── 6: граница окна — resume() за окном не виден, внутри — виден
    const t6outside = await page.evaluate(() => {
      return new Promise((resolve) => {
        const p = window.itd.trace(() => {}, 300)
        setTimeout(() => window.itd.resume(), 700)
        p.then(resolve)
      })
    })
    check('6: resume() за окном (700 > 300) → sent пуст', t6outside.sent.length === 0, JSON.stringify(t6outside.sent))
    await page.waitForFunction(() => window.itd.state().speed === 1, { timeout: 5000 })
    await page.evaluate(() => window.itd.pause())
    await page.waitForFunction(() => window.itd.state().speed === 0, { timeout: 5000 })

    const t6inside = await page.evaluate(() => {
      return new Promise((resolve) => {
        const p = window.itd.trace(() => {}, 300)
        setTimeout(() => window.itd.resume(), 100)
        p.then(resolve)
      })
    })
    check(
      '6: resume() внутри окна (100 < 300) → ровно одна запись',
      speedSent(t6inside.sent).length === 1 && speedSent(t6inside.sent)[0] === 1,
      JSON.stringify(t6inside.sent),
    )
    check(
      '6: t ∈ [0, t1−t0] для всех событий (допуск 50мс)',
      t6inside.sent.every((e) => e.t >= -50 && e.t <= t6inside.t1 - t6inside.t0 + 50),
      JSON.stringify(t6inside.sent.map((e) => e.t)),
    )
    await page.waitForFunction(() => window.itd.state().speed === 1, { timeout: 5000 })
    await page.evaluate(() => window.itd.pause())
    await page.waitForFunction(() => window.itd.state().speed === 0, { timeout: 5000 })

    // ── 7: параллельность — независимые окна видят общий эфир
    const parallel = await page.evaluate(() => {
      return (async () => {
        const A = window.itd.trace(() => window.itd.resume(), 1500)
        await new Promise((r) => setTimeout(r, 800))
        const B = window.itd.trace(() => window.itd.pause(), 300)
        const [a, b] = await Promise.all([A, B])
        return { a, b }
      })()
    })
    check(
      '7: A.sent = [speed1, speed0]',
      JSON.stringify(speedSent(parallel.a.sent)) === JSON.stringify([1, 0]),
      JSON.stringify(speedSent(parallel.a.sent)),
    )
    check(
      '7: B.sent = [speed0]',
      JSON.stringify(speedSent(parallel.b.sent)) === JSON.stringify([0]),
      JSON.stringify(speedSent(parallel.b.sent)),
    )
    await page.waitForFunction(() => window.itd.state().speed === 0, { timeout: 5000 })

    // ── 8: itd.key — esc обрабатывает hud безусловно, '1' в игре — никто
    const t8esc = await page.evaluate(() => window.itd.trace(() => window.itd.key('esc'), 300))
    const keyT8esc = t8esc.keys[0]
    check(
      "8: key('esc') → {key:'ESC', source:'itd', handled:true, scenes:['hud']}, acted:[] (отчёт закрыт — guard)",
      keyT8esc?.key === 'ESC' && keyT8esc?.source === 'itd' && keyT8esc?.handled === true &&
        JSON.stringify(keyT8esc?.scenes) === JSON.stringify(['hud']) &&
        JSON.stringify(keyT8esc?.acted) === '[]',
      JSON.stringify(keyT8esc),
    )
    const t8one = await page.evaluate(() => window.itd.trace(() => window.itd.key('1'), 300))
    const keyT8one = t8one.keys[0]
    check("8: key('1') в игре → handled:false, acted:[]", keyT8one?.handled === false && JSON.stringify(keyT8one?.acted) === '[]', JSON.stringify(keyT8one))

    // ── 9: реальная клавиатура — Escape (handled), KeyA (не обработана)
    await page.evaluate(() => {
      window.__tr9a = window.itd.trace(() => new Promise((r) => setTimeout(r, 100)), 1200)
    })
    await page.keyboard.press('Escape')
    const t9a = await page.evaluate(() => window.__tr9a)
    const keyT9a = t9a.keys.find((k) => k.source === 'dom')
    check(
      '9: DOM Escape → {key:ESC, source:dom, handled:true}',
      keyT9a?.key === 'ESC' && keyT9a?.handled === true,
      JSON.stringify(keyT9a),
    )

    await page.evaluate(() => {
      window.__tr9b = window.itd.trace(() => new Promise((r) => setTimeout(r, 100)), 1200)
    })
    await page.keyboard.press('KeyA')
    const t9b = await page.evaluate(() => window.__tr9b)
    const keyT9b = t9b.keys.find((k) => k.source === 'dom')
    check(
      '9: DOM KeyA → {key:A, handled:false}',
      keyT9b?.key === 'A' && keyT9b?.handled === false,
      JSON.stringify(keyT9b),
    )

    // ── 10: отчёт дня — Enter внутри окна восстанавливает скорость и next_day
    await page.evaluate(() => window.itd.speed(2))
    await page.waitForFunction(() => window.itd.state().speed === 2, { timeout: 5000 })
    await page.evaluate(() => window.itd.set({ tickInDay: 53 })) // 53 < dayTicks=54 (running)
    await page.waitForFunction(() => window.itd.ids().some((n) => n.id === 'btn.next_day'), { timeout: 30000 })
    await delay(300)

    await page.evaluate(() => {
      window.__tr10 = window.itd.trace(() => new Promise((r) => setTimeout(r, 100)), 1200)
    })
    await page.keyboard.press('Enter')
    const t10 = await page.evaluate(() => window.__tr10)
    const keyT10 = t10.keys.find((k) => k.source === 'dom' && k.key === 'ENTER')
    check('10: DOM Enter → handled:true', keyT10?.handled === true, JSON.stringify(keyT10))
    check(
      '10: DOM Enter → acted [{hud,next_day}]',
      JSON.stringify(keyT10?.acted) === JSON.stringify([{ scene: 'hud', action: 'next_day' }]),
      JSON.stringify(keyT10),
    )
    const sentTypesT10 = t10.sent.map((e) => e.type)
    check(
      '10: sent строго [set_speed, next_day] (speed:2 → 0), src ui — настоящая клавиша',
      JSON.stringify(sentTypesT10) === JSON.stringify(['set_speed', 'next_day']) && t10.sent[0]?.speed === 2 && t10.sent.every((e) => e.src === 'ui'),
      JSON.stringify(t10.sent),
    )
    const phaseT10 = t10.transitions.find((tr) => tr.kind === 'phase')
    check(
      '10: transition phase day_report → running',
      phaseT10?.from === 'day_report' && phaseT10?.to === 'running',
      JSON.stringify(phaseT10),
    )

    // ── 10b/10c: две канонические формы вызова из задачи; скорость после п.10 уже 2
    const openReport = async () => {
      await page.evaluate(() => window.itd.set({ money: 20000 }))
      await page.waitForFunction(() => window.itd.state().balance === 20000, { timeout: 5000 })
      await page.evaluate(() => window.itd.set({ tickInDay: 53 }))
      await page.waitForFunction(() => window.itd.ids().some((n) => n.id === 'btn.next_day'), { timeout: 30000 })
      await delay(300)
    }
    await openReport()
    const t10b = await page.evaluate(() => window.itd.trace(() => window.itd.key('enter'), 1500))
    const keyT10b = t10b.keys[0]
    check(
      '10b: key(enter) → {ENTER, itd, handled:true}, acted [{hud,next_day}]',
      keyT10b?.key === 'ENTER' && keyT10b?.source === 'itd' && keyT10b?.handled === true &&
        JSON.stringify(keyT10b?.acted) === JSON.stringify([{ scene: 'hud', action: 'next_day' }]),
      JSON.stringify(keyT10b),
    )
    check(
      '10b: sent строго [set_speed, next_day], speed:2, src itd',
      JSON.stringify(t10b.sent.map((e) => e.type)) === JSON.stringify(['set_speed', 'next_day']) && t10b.sent[0]?.speed === 2 && t10b.sent.every((e) => e.src === 'itd'),
      JSON.stringify(t10b.sent),
    )
    const phT10b = t10b.transitions.find((tr) => tr.kind === 'phase')
    check('10b: transition phase day_report → running', phT10b?.from === 'day_report' && phT10b?.to === 'running', JSON.stringify(phT10b))

    await openReport()
    const t10c = await page.evaluate(() => window.itd.trace(() => window.itd.click('btn.next_day'), 1000))
    check('10c: click(btn.next_day) ok', t10c.result?.ok === true, JSON.stringify(t10c.result))
    check(
      '10c: sent строго [set_speed, next_day], src itd',
      JSON.stringify(t10c.sent.map((e) => e.type)) === JSON.stringify(['set_speed', 'next_day']) && t10c.sent.every((e) => e.src === 'itd'),
      JSON.stringify(t10c.sent),
    )
    const phT10c = t10c.transitions.find((tr) => tr.kind === 'phase')
    check('10c: transition phase day_report → running', phT10c?.from === 'day_report' && phT10c?.to === 'running', JSON.stringify(phT10c))
    check('10c: keys пуст (клик — не клавиша)', t10c.keys.length === 0, JSON.stringify(t10c.keys))

    // ── 10d: отчёт закрыт, игра идёт — клавиша дошла до HUD, guard отбросил
    const t10d = await page.evaluate(() => window.itd.trace(() => window.itd.key('enter'), 300))
    check(
      '10d: key(enter) при закрытом отчёте → handled:true, acted [], sent пуст',
      t10d.keys[0]?.handled === true && t10d.keys[0]?.acted.length === 0 && t10d.sent.length === 0,
      JSON.stringify(t10d),
    )

    // ── 11: ошибка в action не глотает окно; подписки не текут
    const t11 = await page.evaluate(() =>
      window.itd.trace(() => {
        throw new Error('boom')
      }, 100),
    )
    check('11: ok:false, error:boom', t11.ok === false && t11.error === 'boom', JSON.stringify(t11))
    // утечка: объект закрытого окна не меняется от новых событий; контроль — те же
    // раздражители видны живому окну
    const leak = await page.evaluate(async () => {
      const itd = window.itd
      const closed = await itd.trace(() => { throw new Error('boom') }, 100)
      const before = JSON.stringify(closed)
      await itd.set({ money: 0 }); await itd.wait((s) => s.balance === 0)
      const live = await itd.trace(async () => {
        itd.key('esc') // itd-клавиша
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA' })) // DOM
        itd.resume(); await itd.wait((s) => s.speed === 1) // sent + transition
        itd.pause(); await itd.wait((s) => s.speed === 0)
        await itd.cmd('buy_pc') // error → тост + звук
      }, 300)
      return { same: JSON.stringify(closed) === before, live: {
        keys: live.keys.length, sent: live.sent.length, tr: live.transitions.length,
        toasts: live.toasts.length, sounds: live.sounds.length } }
    })
    check('11: закрытое окно не растёт (все 6 подписок сняты)', leak.same, JSON.stringify(leak.live))
    check('11: контроль — раздражители видны живому окну',
      leak.live.keys >= 2 && leak.live.sent >= 3 && leak.live.tr >= 2 && leak.live.toasts >= 1 && leak.live.sounds >= 1,
      JSON.stringify(leak.live))

    // ── 12: windowMs вне 0..10000 — reject
    const rejNeg = await page.evaluate(() =>
      window.itd.trace(() => {}, -1).then(
        () => 'resolved',
        (e) => 'rejected:' + e.message,
      ),
    )
    check('12: windowMs=-1 → reject', rejNeg.startsWith('rejected:'), rejNeg)
    const rejBig = await page.evaluate(() =>
      window.itd.trace(() => {}, 20000).then(
        () => 'resolved',
        (e) => 'rejected:' + e.message,
      ),
    )
    check('12: windowMs=20000 → reject', rejBig.startsWith('rejected:'), rejBig)

    // ── 13: квитанции по id (ITGAME-45)
    const t13 = await page.evaluate(async () => {
      const itd = window.itd
      itd.pause()
      await itd.wait((s) => s.speed === 0)
      await itd.set({ money: 0 })
      await itd.wait((s) => s.balance === 0)
      let fail = null
      const tr = await itd.trace(async () => {
        fail = await itd.cmd('buy_pc')
      }, 200)
      const net = itd.net(10)
      await itd.set({ money: 50000 })
      await itd.wait((s) => s.balance === 50000)
      let okR = null
      const tr2 = await itd.trace(async () => {
        okR = await itd.cmd('buy_pc')
      }, 200)
      return { fail, sent: tr.sent, recv: tr.recv, net: net.last, netRev: net.rev, okR, states: tr2.states, srv: { rev: itd.server().rev, cause: itd.server().cause } }
    })
    const errRecv13 = t13.recv.find((e) => e.type === 'error')
    check(
      '13: отказ — {code, id, rev}, тот же id в sent и в re ошибки',
      t13.fail?.ok === false && t13.fail.code === 'not_enough_money' && Number.isInteger(t13.fail.id) &&
        Number.isInteger(t13.fail.rev) && t13.sent[0]?.id === t13.fail.id &&
        errRecv13?.info?.re === t13.fail.id && errRecv13?.info?.rev === t13.fail.rev,
      JSON.stringify({ fail: t13.fail, sent: t13.sent, err: errRecv13 }),
    )
    const outNet13 = t13.net.filter((e) => e.dir === 'out' && e.info.id === t13.fail?.id)
    const stNet13 = t13.net.filter((e) => e.type === 'state')
    check(
      '13: itd.net() — out с info.id, state с rev/cause',
      outNet13.length === 1 && stNet13.length > 0 && stNet13.every((e) => Number.isInteger(e.info.rev) && typeof e.info.cause === 'string') &&
        Number.isInteger(t13.netRev),
      JSON.stringify(t13.net.slice(-4)),
    )
    const stOk13 = t13.states.find((st) => st.re === t13.okR?.id)
    check(
      '13: успех — states[] окна {re: id, cause:cmd, rev = квитанции}, server().rev ≥ rev',
      t13.okR?.ok === true && !!stOk13 && stOk13.cause === 'cmd' && stOk13.rev === t13.okR.rev &&
        t13.srv.rev >= t13.okR.rev && typeof t13.srv.cause === 'string',
      JSON.stringify({ okR: t13.okR, states: t13.states, srv: t13.srv }),
    )

    // ── 13b: тиковый снапшот «в пути», когда уходит команда
    const t13b = await page.evaluate(async () => {
      const itd = window.itd
      itd.speed(3)
      await itd.wait((s) => s.speed === 3)
      const busy = (ms) => { const t = performance.now(); while (performance.now() - t < ms) { /* занятый главный поток */ } }
      const tr = await itd.trace(async () => {
        busy(400) // тик (333 мс на 3×) приходит в сокет, но не разобран
        return itd.cmd('set_speed', 0, { speed: 9 })
      }, 100)
      itd.pause()
      await itd.wait((s) => s.speed === 0)
      return { r: tr.result, states: tr.states, recv: tr.recv }
    })
    const firstState13b = t13b.states[0]
    check(
      '13b: тик в пути — квитанция bad_speed, не ok от тика',
      t13b.r?.ok === false && t13b.r.code === 'bad_speed' && firstState13b?.cause === 'tick' && firstState13b.re === undefined,
      JSON.stringify(t13b),
    )

    // ── 13c: снапшот команды агента-наблюдателя «в пути»
    const t13c = await page.evaluate(async (sid) => {
      const itd = window.itd
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      const ag = new WebSocket(`${proto}://${location.host}/ws/agent?sid=${encodeURIComponent(sid)}`)
      const agentMsgs = []
      ag.onmessage = (ev) => agentMsgs.push(JSON.parse(ev.data))
      await new Promise((resolve, reject) => {
        ag.onopen = resolve
        ag.onerror = () => reject(new Error('agent ws'))
      })
      await new Promise((r) => setTimeout(r, 200)) // первый снапшот наблюдателя
      const busy = (ms) => { const t = performance.now(); while (performance.now() - t < ms) { /* занятый главный поток */ } }
      const tr = await itd.trace(async () => {
        ag.send(JSON.stringify({ type: 'hire', office: 0, id: 1 })) // id агента = 1, совпадёт с чьим-то id вкладки — re адресный
        busy(150) // сервер нанял и разослал снапшот — у вкладки он «в пути»
        return itd.cmd('set_speed', 0, { speed: 9 })
      }, 200)
      ag.close()
      const agentReply = agentMsgs.find((m) => m.type === 'state' && m.re === 1)
      return { r: tr.result, states: tr.states, agentReply: agentReply ? { rev: agentReply.rev, cause: agentReply.cause } : null }
    }, sid)
    const hireState13c = t13c.states.find((st) => st.rev === t13c.agentReply?.rev)
    check(
      '13c: команда наблюдателя в пути — квитанция вкладки bad_speed; снапшот найма у вкладки cause cmd без re',
      t13c.r?.ok === false && t13c.r.code === 'bad_speed' && t13c.agentReply?.cause === 'cmd' &&
        !!hireState13c && hireState13c.cause === 'cmd' && hireState13c.re === undefined && t13c.r.rev === t13c.agentReply.rev,
      JSON.stringify(t13c),
    )

    // ── 14 (ITGAME-88): открытое окно и настоящий клик мышью другим вызовом
    await page.evaluate(async () => {
      window.itd.pause()
      await window.itd.set({ money: 50000 })
    })
    await page.waitForFunction(() => window.itd.state().speed === 0 && window.itd.state().balance === 50000, { timeout: 5000 })
    const st14 = await page.evaluate(() => window.itd.trace.start())
    const pt14 = await page.evaluate(() => {
      const row = window.itd.screen().items.find((i) => i.startsWith('btn:pc|'))?.split('|')
      const n = window.itd.nodes().find((x) => x.id === 'btn.pc')
      const b = document.getElementById('build')?.getBoundingClientRect()
      return { x: Number(row?.[2]), y: Number(row?.[3]), cx: n?.cx, cy: n?.cy, bx: b ? b.left + b.width / 2 : -1, by: b ? b.top + b.height / 2 : -1 }
    })
    await page.mouse.click(pt14.x, pt14.y)
    await delay(400)
    await page.mouse.click(pt14.bx, pt14.by)
    const t14 = await page.evaluate((id) => window.itd.trace.stop(id), st14.id)
    const down14 = t14.pointer?.find((p) => p.type === 'down' && p.onCanvas)
    const up14 = t14.pointer?.find((p) => p.type === 'up' && p.onCanvas)
    const bar14 = t14.pointer?.find((p) => p.type === 'down' && !p.onCanvas)
    check(
      '14: trace.start() → настоящий клик по btn.pc → trace.stop(id): pointer down/up на канвасе, x/y ≈ cx/cy, wins \'btn:pc\' (метка, как got), got [btn:pc], sent buy_pc src ui',
      st14.ok === true && typeof st14.id === 'number' && t14.id === st14.id && !!down14 && !!up14 &&
        down14.button === 0 && Math.abs(down14.x - pt14.cx) <= 2 && Math.abs(down14.y - pt14.cy) <= 2 &&
        down14.wins === 'btn:pc' && down14.stack[0]?.startsWith('btn:pc ') &&
        JSON.stringify(down14.got) === '["btn:pc"]' && up14.wins === 'btn:pc' &&
        t14.sent.some((e) => e.type === 'buy_pc' && e.src === 'ui') && t14.windowMs >= 400 && t14.actionMs === 0,
      JSON.stringify({ st14, pt14, pointer: t14.pointer, sent: t14.sent, windowMs: t14.windowMs }),
    )
    check(
      '14: клик по #build (мимо холста) — onCanvas false, wins null, got []',
      !!bar14 && bar14.wins === null && bar14.got.length === 0,
      JSON.stringify(bar14 ?? null),
    )

    // ── 14b (ITGAME-112): got у кнопки, удалившей себя в pointerdown. Сценовый GAMEOBJECT_DOWN Phaser
    // такому объекту не шлёт (InputPlugin.processDownEvents: у удалённого нет input) — раньше got был [].
    // (а) настоящий клик по btn.menu → по ✕ окна «Выйти в меню?» (modal.close закрывает окно в pointerdown);
    // (б) два тестовых прямоугольника в hud: один удаляет себя в pointerdown, второй нет.
    const st14b = await page.evaluate(() => window.itd.trace.start())
    const menu14b = await page.evaluate(() => {
      const row = window.itd.screen().items.find((i) => i.startsWith('btn:menu|'))?.split('|')
      return { x: Number(row?.[2]), y: Number(row?.[3]) }
    })
    await page.mouse.click(menu14b.x, menu14b.y)
    const x14b = await page.evaluate(() =>
      window.itd.wait(() => window.itd.nodes().some((n) => n.id === 'modal.close' && n.visible), 5000).then(
        () => {
          const row = window.itd.screen().items.find((i) => i.startsWith('modal:close|'))?.split('|')
          return { x: Number(row?.[2]), y: Number(row?.[3]), title: window.itd.screen().meta.title }
        },
        () => null,
      ))
    if (x14b) await page.mouse.click(x14b.x, x14b.y)
    await delay(200)
    const probe14b = await page.evaluate(async () => {
      const game = window.__itd
      const sc = game.scene.getScene('hud')
      const free = [[24, 700], [640, 700], [1256, 700], [24, 400], [640, 400], [1000, 400], [320, 700], [960, 700], [1256, 400]].filter(([px, py]) => window.itd.stack(px, py).stack.length === 0)
      if (free.length < 3) return null
      const mk = (pt, id, mode) => {
        const r = sc.add.rectangle(pt[0], pt[1], 40, 30, 0xff00ff).setDepth(999).setInteractive()
        r.setData('id', id)
        if (mode === 'gone') r.on('pointerdown', () => r.destroy())
        if (mode === 'hide') r.on('pointerdown', () => r.setVisible(false))
        return r
      }
      window.__qaP14 = [mk(free[0], 'probe.gone', 'gone'), mk(free[1], 'probe.keep', 'keep'), mk(free[2], 'probe.hide', 'hide')]
      await new Promise((r) => requestAnimationFrame(r)) // объект виден хит-тесту со следующего кадра
      const c = game.canvas.getBoundingClientRect()
      const k = c.width / 1280
      return free.slice(0, 3).map(([px, py]) => ({ x: c.left + px * k, y: c.top + py * k }))
    })
    if (probe14b) {
      await page.mouse.click(probe14b[0].x, probe14b[0].y)
      await page.mouse.click(probe14b[1].x, probe14b[1].y)
      await page.mouse.click(probe14b[2].x, probe14b[2].y)
    }
    const t14bRes = await page.evaluate((id) => {
      const tr = window.itd.trace.stop(id)
      const sum = window.itd.trace.summary(tr).lines
      for (const r of window.__qaP14 ?? []) r.destroy()
      delete window.__qaP14
      return { tr, sum }
    }, st14b.id)
    const { tr: t14b, sum: sum14b } = t14bRes
    const upAfter = (d) => (d ? t14b.pointer[t14b.pointer.indexOf(d) + 1] : undefined)
    const ptr14b = (type, win) => t14b.pointer.find((p) => p.type === type && p.wins === win)
    check(
      '14b: настоящий клик по ✕ «Выйти в меню?» (modal.close закрывает окно в pointerdown) — got на down содержит modal:close, окно закрылось',
      !!x14b && x14b.title === 'Выйти в меню?' && !!ptr14b('down', 'modal:close') && ptr14b('down', 'modal:close').got.includes('modal:close'),
      JSON.stringify({ x14b, pointer: t14b.pointer.map((p) => ({ type: p.type, wins: p.wins, got: p.got })) }),
    )
    check(
      '14b: после закрытия окна ✕ нет в nodes(); на up got пуст/без modal:close (удалённый объект до отпускания не получает up)',
      !(await page.evaluate(() => window.itd.nodes().some((n) => n.id === 'modal.close' && n.visible))) &&
        t14b.pointer.filter((p) => p.type === 'up' && p.stack.every((s) => !s.startsWith('modal:close '))).length >= 1 &&
        t14b.pointer.filter((p) => p.type === 'up').every((p) => !p.got.includes('modal:close')),
      JSON.stringify(t14b.pointer.map((p) => ({ type: p.type, wins: p.wins, got: p.got }))),
    )
    check(
      '14b: тестовые прямоугольники — удаливший себя в pointerdown: got [probe:gone] на down и [] на up; второй: [probe:keep] на down и up',
      !!probe14b &&
        JSON.stringify(ptr14b('down', 'probe:gone')?.got) === '["probe:gone"]' &&
        JSON.stringify(t14b.pointer.find((p) => p.type === 'up' && p.x === ptr14b('down', 'probe:gone')?.x)?.got) === '[]' &&
        JSON.stringify(ptr14b('down', 'probe:keep')?.got) === '["probe:keep"]' &&
        JSON.stringify(ptr14b('up', 'probe:keep')?.got) === '["probe:keep"]',
      JSON.stringify(t14b.pointer.map((p) => ({ type: p.type, x: p.x, wins: p.wins, got: p.got }))),
    )

    const dX = ptr14b('down', 'modal:close'), dG = ptr14b('down', 'probe:gone')
    const dH = ptr14b('down', 'probe:hide'), dK = ptr14b('down', 'probe:keep'), dM = ptr14b('down', 'btn:menu')
    check(
      '14b: gone на up (ITGAME-148) — ✕ [modal:close], probe.gone [probe:gone], probe.hide [probe:hide]; probe.keep и btn:menu []; у down gone []',
      !!dX && !!dG && !!dH && !!dK && !!dM &&
        JSON.stringify(upAfter(dX)?.gone) === '["modal:close"]' &&
        JSON.stringify(upAfter(dG)?.gone) === '["probe:gone"]' && JSON.stringify(upAfter(dG)?.got) === '[]' &&
        JSON.stringify(upAfter(dH)?.gone) === '["probe:hide"]' && JSON.stringify(upAfter(dH)?.got) === '[]' &&
        JSON.stringify(upAfter(dK)?.gone) === '[]' && JSON.stringify(upAfter(dM)?.gone) === '[]' &&
        t14b.pointer.filter((p) => p.type === 'down').every((p) => Array.isArray(p.gone) && p.gone.length === 0),
      JSON.stringify(t14b.pointer.map((p) => ({ type: p.type, wins: p.wins, got: p.got, gone: p.gone }))),
    )
    check(
      '14b: summary печатает gone на up — «… got [] gone [probe:gone]», «… gone [modal:close]»',
      sum14b.some((l) => /^t\d+ ptr up \d+,\d+ canvas wins - got \[\] gone \[probe:gone\]$/.test(l)) &&
        sum14b.some((l) => /^t\d+ ptr up -?\d+,-?\d+ canvas wins \S+ got \[[^\]]*\] gone \[modal:close\]$/.test(l)),
      JSON.stringify(sum14b.filter((l) => l.includes(' ptr '))),
    )

    // ── 15 (ITGAME-88): семантика открытого окна
    const t15 = await page.evaluate(async () => {
      const itd = window.itd
      const none = itd.trace.stop()
      const cut = itd.trace.start({ maxMs: 300 })
      await new Promise((r) => setTimeout(r, 700))
      const cutRes = itd.trace.stop(cut.id)
      const bad = itd.trace.start({ maxMs: 0 })
      const a = itd.trace.start()
      const b = itd.trace.start()
      const lastRes = itd.trace.stop()
      itd.click('btn.pc')
      await new Promise((r) => setTimeout(r, 300))
      const firstRes = itd.trace.stop(a.id)
      const again = itd.trace.stop(a.id)
      const classic = await itd.trace(() => {}, 50)
      return {
        none, cut: { id: cut.id, res: { id: cutRes.id, cut: cutRes.cut, windowMs: cutRes.windowMs } }, bad,
        a: a.id, b: b.id, open: b.open, lastId: lastRes.id, firstId: firstRes.id,
        firstSent: firstRes.sent.map((e) => e.type), firstSrc: firstRes.sent.filter((e) => e.type === 'buy_pc').map((e) => e.src), firstPointer: firstRes.pointer.length, again: again.code,
        classicPointer: classic.pointer,
      }
    })
    check(
      '15: stop() без окна — no_trace; maxMs 300 — cut, windowMs ≈ 300; maxMs 0 — bad_max; stop() закрывает последнее, stop(id) — своё; itd.click — sent есть, pointer пуст; trace() несёт pointer []',
      t15.none.ok === false && t15.none.code === 'no_trace' &&
        t15.cut.res.id === t15.cut.id && t15.cut.res.cut === true && t15.cut.res.windowMs >= 290 && t15.cut.res.windowMs < 600 &&
        t15.bad.ok === false && t15.bad.code === 'bad_max' &&
        JSON.stringify(t15.open) === JSON.stringify([t15.a, t15.b]) && t15.lastId === t15.b && t15.firstId === t15.a &&
        t15.firstSent.includes('buy_pc') && JSON.stringify(t15.firstSrc) === '["itd"]' && t15.firstPointer === 0 && t15.again === 'no_trace' &&
        Array.isArray(t15.classicPointer) && t15.classicPointer.length === 0,
      JSON.stringify(t15),
    )

    // ── 15b (ITGAME-160): peek — прочитать открытое окно, не закрывая
    const t15b = await page.evaluate(async () => {
      const itd = window.itd
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      const none = itd.trace.peek()
      const w = itd.trace.start()
      itd.click('btn.pc')
      await sleep(200)
      const p1 = itd.trace.peek(w.id)
      const p1Sent = p1.sent.length
      p1.sent.push({ t: 0, type: 'mutated', src: 'ui' }) // копия — в окно не протекает
      itd.click('btn.pc')
      await sleep(200)
      const p2 = itd.trace.peek() // без id — последнее открытое
      const other = itd.trace.start()
      const listed = other.open.includes(w.id)
      itd.trace.stop(other.id)
      const fin = itd.trace.stop(w.id)
      const after = itd.trace.peek(w.id)
      const c = itd.trace.start({ maxMs: 200 })
      await sleep(500)
      const pc = itd.trace.peek(c.id)
      const sc = itd.trace.stop(c.id)
      return {
        none, listed, after, id: w.id,
        p1: { ok: p1.ok, id: p1.id, sent: p1Sent, t1: p1.t1, t0: p1.t0, windowMs: p1.windowMs },
        p2: { id: p2.id, sent: p2.sent.map((e) => e.type) },
        fin: { id: fin.id, sent: fin.sent.map((e) => e.type) },
        pc: { id: pc.id, cut: pc.cut, windowMs: pc.windowMs }, sc: { id: sc.id, cut: sc.cut, windowMs: sc.windowMs },
      }
    })
    check(
      '15b: peek (ITGAME-160) — без окна no_trace; копия растёт между кликами, мутация не течёт; окно открыто; stop(id) — тот же id; peek после stop — no_trace; peek cut-окна — cut и итоговый windowMs',
      t15b.none.ok === false && t15b.none.code === 'no_trace' &&
        t15b.p1.ok === true && t15b.p1.id === t15b.id && t15b.p1.sent === 1 && t15b.p1.t1 > 0 && t15b.p1.windowMs === t15b.p1.t1 - t15b.p1.t0 &&
        JSON.stringify(t15b.p2.sent) === '["buy_pc","buy_pc"]' && t15b.p2.id === t15b.id && t15b.listed === true &&
        t15b.fin.id === t15b.id && JSON.stringify(t15b.fin.sent) === '["buy_pc","buy_pc"]' &&
        t15b.after.ok === false && t15b.after.code === 'no_trace' &&
        t15b.pc.cut === true && t15b.sc.cut === true && t15b.pc.id === t15b.sc.id && t15b.pc.windowMs === t15b.sc.windowMs,
      JSON.stringify(t15b),
    )

    // ── 16 (ITGAME-179): itd.trace.summary — окно строками по времени, по строке каждой разновидности
    await page.evaluate(async () => {
      const itd = window.itd
      itd.pause()
      await itd.set({ money: 50000 })
      await itd.wait((s) => s.speed === 0 && s.balance === 50000)
    })
    const st16 = await page.evaluate(() => window.itd.trace.start())
    const pt16 = await page.evaluate(() => {
      const row = window.itd.screen().items.find((i) => i.startsWith('btn:pc|'))?.split('|')
      return { x: Number(row?.[2]), y: Number(row?.[3]) }
    })
    await page.mouse.click(pt16.x, pt16.y) // ptr down/up, sent buy_pc ui, state cmd re, sound select
    await delay(300)
    const t16 = await page.evaluate(async (id) => {
      const itd = window.itd
      await itd.set({ money: 0 })
      await itd.wait((s) => s.balance === 0)
      await itd.cmd('buy_pc') // sent itd, recv error not_enough_money, тост, звук error
      itd.key('1') // в игре клавишу 1 никто не слушает — key ONE itd unhandled
      itd.resume()
      await itd.wait((s) => s.speed === 1) // trans speed 0→1, sent set_speed itd
      itd.pause()
      await itd.wait((s) => s.speed === 0)
      const live = itd.trace.summary(id) // открытое окно — не закрывая
      const tr = itd.trace.stop(id)
      const closed = itd.trace.summary(tr)
      return { live, closed, last: itd.trace.summary(), shut: itd.trace.summary(id), bad: itd.trace.summary({}) }
    }, st16.id)
    const L16 = t16.closed.lines ?? []
    const ts16 = L16.map((l) => Number(/^t(\d+) /.exec(l)?.[1]))
    const pat16 = {
      down: /^t\d+ ptr down \d+,\d+ canvas wins btn:pc got \[btn:pc\]$/,
      up: /^t\d+ ptr up \d+,\d+ canvas wins btn:pc got \[btn:pc\]$/,
      sentUi: /^t\d+ sent buy_pc o0 id\d+ ui$/,
      sentItd: /^t\d+ sent buy_pc o0 id\d+ itd$/,
      speed: /^t\d+ sent set_speed o0 speed=1 id\d+ itd$/,
      recv: /^t\d+ recv error not_enough_money re\d+ rev\d+$/,
      state: /^t\d+ state rev\d+ cmd re\d+$/,
      trans: /^t\d+ trans speed 0→1$/,
      toast: /^t\d+ toast "Не хватает денег"$/,
      sound: /^t\d+ sound (select|error) (ok|fail)$/,
      key: /^t\d+ key ONE itd unhandled$/,
    }
    const miss16 = Object.entries(pat16).filter(([, re]) => !L16.some((l) => re.test(l))).map(([k]) => k)
    check(
      '16: summary(id) открытого окна = summary(tr) после stop, строки по возрастанию t, каждая разновидность по образцу (ITGAME-179)',
      t16.live.ok === true && t16.live.id === st16.id && t16.closed.id === st16.id &&
        JSON.stringify(t16.live.lines) === JSON.stringify(L16) && L16.length > 0 &&
        ts16.every((t, i) => Number.isFinite(t) && (i === 0 || t >= ts16[i - 1])) && miss16.length === 0,
      JSON.stringify({ miss16, lines: L16, live: t16.live.lines?.length }),
    )
    check(
      '16: summary() без открытых окон, summary(id) закрытого и summary({}) — {ok:false, code:no_trace, lines:[]}',
      [t16.last, t16.shut, t16.bad].every((s) => s.ok === false && s.code === 'no_trace' && Array.isArray(s.lines) && s.lines.length === 0),
      JSON.stringify({ last: t16.last, shut: t16.shut, bad: t16.bad }),
    )

    // ── нет ошибок на странице за весь прогон
    check('на странице нет pageerror', pageErrors.length === 0, pageErrors.join(' | '))
  } finally {
    if (browser) await browser.close()
    if (stopServer) await stopServer()
  }
}

await run()

const failed = results.filter((r) => !r.pass)
console.log(`\nИтог QA-ITGAME37: ${results.length - failed.length}/${results.length} проверок прошло`)
if (failed.length > 0) {
  console.error(`Провалено: ${failed.map((f) => f.name).join(', ')}`)
  process.exit(1)
} else {
  console.log('Все проверки пройдены успешно!')
}
