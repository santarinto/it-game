// qa-itgame37 — живая трассировка itd.trace() (ITGAME-37):
//   1  из меню: trace(() => click('menu.diff.normal'), 3000) → переход
//      сцен содержит office+hud, фаза null → running
//   2  set({money:50000}), trace(() => click('btn.pc')) → sent[0] =
//      {type:'buy_pc', office:0}, sounds содержит name 'select'
//   3  set({money:0}), trace(() => cmd('buy_pc'), 800) → recv
//      {type:'error', info.code:'not_enough_money'}, тост из ERROR_TEXTS,
//      звук 'error'
//   4  trace(() => pause()) → sent set_speed{speed:0}, transition speed
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
//      [set_speed{speed:2}, next_day] (proceedNextDay восстанавливает
//      скорость ДО отчёта, затем next_day), transition phase
//      day_report → running
//  10b каноническая форма: key('enter') на открытом отчёте → ENTER itd
//      handled:true, acted [{hud,next_day}], sent [set_speed, next_day]
//  10c каноническая форма: click('btn.next_day') → ok, sent
//      [set_speed, next_day], keys пуст (клик — не клавиша)
//  10d отчёт закрыт, игра идёт: key('enter') → handled:true, acted [],
//      sent пуст (клавиша дошла до HUD, guard отбросил)
//  11  trace(() => throw, 100) → {ok:false, error:'boom'}; проверка утечки:
//      объект закрытого окна не растёт от новых стимулов (key/sent/переходы/
//      тосты/звуки), контроль — те же стимулы внутри живого окна дают записи
//  12  windowMs −1 и 20000 → reject
//   + на странице нет pageerror
//
// Отклонения от буквального сценария в трекере (см. отчёт агента): нет —
// все шаги воспроизведены как описаны, п.10 подтверждён по коду
// HUDScene.proceedNextDay()/onDayReport (restore-скорость ДО next_day).
//
// Self-serve: без QA_BASE поднимает Go-сервер на QA_PORT (по умолчанию
// :4176 — свой порт задачи, соседи 4173/4174/4175/4177/8091 заняты).
// Общий self-serve — client/scripts/lib/selfserve.mjs.
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'
import { selfServe } from './lib/selfserve.mjs'

const CLIENT_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const SELF_PORT = Number(process.env.QA_PORT) || 4176
const HINT_IDS = ['master', 'router', 'core', 'server', 'cooler', 'fridge', 'motivate', 'softlock']

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

const BASE = process.env.QA_BASE || `http://127.0.0.1:${SELF_PORT}`

const results = []
function check(name, pass, fact) {
  results.push({ name, pass, fact })
  console.log(`${pass ? 'PASS' : 'FAIL'}: ${name}${fact ? ` — ${fact}` : ''}`)
}

async function waitMenuReady(page) {
  await page.waitForFunction(
    () => window.itd != null && window.itd.ids().some((n) => n.id === 'menu.diff.normal'),
    { timeout: 20000 },
  )
}

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

  const browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const pageErrors = []
  try {
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
      '10: sent строго [set_speed, next_day] (speed:2 → 0)',
      JSON.stringify(sentTypesT10) === JSON.stringify(['set_speed', 'next_day']) && t10.sent[0]?.speed === 2,
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
      '10b: sent строго [set_speed, next_day], speed:2',
      JSON.stringify(t10b.sent.map((e) => e.type)) === JSON.stringify(['set_speed', 'next_day']) && t10b.sent[0]?.speed === 2,
      JSON.stringify(t10b.sent),
    )
    const phT10b = t10b.transitions.find((tr) => tr.kind === 'phase')
    check('10b: transition phase day_report → running', phT10b?.from === 'day_report' && phT10b?.to === 'running', JSON.stringify(phT10b))

    await openReport()
    const t10c = await page.evaluate(() => window.itd.trace(() => window.itd.click('btn.next_day'), 1000))
    check('10c: click(btn.next_day) ok', t10c.result?.ok === true, JSON.stringify(t10c.result))
    check(
      '10c: sent строго [set_speed, next_day]',
      JSON.stringify(t10c.sent.map((e) => e.type)) === JSON.stringify(['set_speed', 'next_day']),
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

    // ── нет ошибок на странице за весь прогон
    check('на странице нет pageerror', pageErrors.length === 0, pageErrors.join(' | '))
  } finally {
    await browser.close()
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
