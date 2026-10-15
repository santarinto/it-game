// qa-itgame38 — фасад window.itd (ITGAME-38):
//   A1  menu.zoom.* — ровно один active===true; menu.diff.* — фокус (ITGAME-19): без сейва
//       active только у НОРМА, ↓ переносит его на СЛОЖНО; menu.stats — active===null
//   A2  клик menu.zoom.1 → только он active; зум возвращается на место
//   A3  itd.speed(2) → btn.speed.2 active (остальные — нет); itd.pause() → btn.speed.0 active;
//       ⏸ на паузе — янтарная плашка с тёмной подписью, speed(1) возвращает вид (ITGAME-62)
//   A4  click('nav.serverRoom') → он active, nav.office0 — нет; комната возвращается на место
//   A5  btn.pc.active === null (обычная кнопка покупки — не переключатель)
//   B1  set({money:100}), клик по отключённому btn.pc → sound {key:'sfx:error', scene:'hud', ok:true}
//   B2  itd.skipReports=1, set({tickInDay:53}), speed(3) → смена дня без модалки:
//       sound key bong/drop по знаку прибыли (out of log's day_report), toast {where:'top', bg по прибыли}
//   C1  itd.overlaps(): kind — только text|occlusion|interactive; interactive-записей в обычной игре нет
//   S1  itd.screen() на отчёте дня (ITGAME-72): meta.title — заголовок отчёта, blocker hud@50,
//       hudClock/hudBal — нарисованное; blocker() отдаёт safe и title
//   S2  btn:next_day — без X, точка = центр в CSS px; btn:menu под затемнением — X; free и frame
//   S3  $100 — у btn:pc флаг D в screen() и disabled true в nodes() (ITGAME-72)
//   S4  (ITGAME-113) подпись в screen() — тексты целиком в рамке кнопки: карточка события под окном
//       «Выйти в меню?» — ✕ окна центром на верхней кромке btn.event.1 (по старому правилу приклеивался:
//       «Отказаться (−$27) ✕»), подпись btn:event:1 — только её собственный текст, флаг X; modal:close — «✕»
//   H3  (ITGAME-113) stack() и объект, добавленный в этом кадре: сразу после add.rectangle().setInteractive()
//       он в _pendingInsertion, stack() его не видит (wins null) — и настоящий mousedown в канвас в тот же
//       момент Phaser ему не отдаёт (trace: wins null, got []); после одного requestAnimationFrame stack().wins —
//       он, настоящий клик мышью — тоже он (trace: wins и got qa:h3)
//   V1  itd.stale() на свежей вкладке: stale false, dist = client = version.sha, штамп sha в #topbar (ITGAME-78)
//   V2  index.html стенда с другим sha (подмена ответа fetch('/')) → stale true, метка «устарело, обнови»
//       видна, высота #topbar та же; ответ снова свой → метка скрыта
//   C2  без skipReports: та же промотка дня → модалка отчёта без interactive-находок;
//       btn.skip_reports active меняется false→true по клику, localStorage синхронизирован
//   H1  itd.stack() под открытым отчётом (ITGAME-74): stack('btn:menu').wins — затемнение hud,
//       btn:menu ниже в stack, совпадает с hit().top; stack('btn.next_day').wins — сама кнопка;
//       stack('nope.nope') → ok:false; stack(-5,-5) — пустой stack, wins null
//   H2  hit()/screen() X — настоящий хит-тест (владелец 10.10): hitArea btn.next_day 1×1 →
//       hit() ok:false, top — затемнение (= stack().wins), screen() ставит X; вернули — ok
//   C3  сдвиг btn.next_day на строку отчёта → находка {kind:'interactive'} с ним
//   C4  сдвиг menu.zoom.1 на соседа → находка {kind:'interactive'} с ним;
//       C4a ratio/threshold в каждой записи (ratio ≈ 0.58, threshold 0),
//       C4b minAreaRatio 0.6 отсекает пару, C4c 0.5 пропускает, C4d 2 → RangeError
//   C7  minAreaRatio 0: текст, на 40% закрытый плашкой, — occlusion (по умолчанию нет)
//   C8  сдвиг спрайта room.rack.0.0 на room.core (serverRoom) → interactive с обоими id
//   C5  сдвиг btn.skip_reports на строку отчёта → находка с ним (канон ITGAME-18)
//   Z1  uiScale '2' из старой версии → в меню ровно menu.zoom.1/1.4/fit, active — fit, ключ переписан в 'fit' (ITGAME-61)
//   Z2  окно 1237×700, «по окну» — у #app нет горизонтального скролла
//   Z3  окно 1237×700: на 1.4× itd.offscreen() даёт одну запись {scene:'page', type:'canvas'}, out.right > 0, out.left 0; на «по окну» её нет (ITGAME-61)
//   Z4  btn.zoom в HUD: три клика обходят 1 → 1.4 → fit по кругу и возвращают исходный
//   Z5  хранилище закрыто для itd.uiScale (getItem/setItem бросают): меню грузится, active 1.4,
//       клик menu.zoom.1 переключает active и CSS-зум канваса в этой вкладке (ITGAME-67)
//   L1  хранилище закрыто целиком (ITGAME-80): геттеры window.localStorage/sessionStorage и Storage.prototype
//       бросают SecurityError, ?debug=1. L1a — блок настоящий (проба ловит SecurityError), клиент в него упирался;
//       L1b — меню грузится без «Продолжить»
//   L2  menu.diff.normal → партия, hudBal нарисован, квитанция hire ok; «Первые кадры» — ровно один тост за 3+ тика
//   L3  пауза отчёта в памяти вкладки: на отчёте speedBeforeReport 3, btn.next_day → день 2 на 3×
//   L4–L5 («Сохранить и выйти» → «Продолжить», перезагрузка) здесь невозможны — сервер без сейвов; они в qa-itgame35, T1–T2
//   L6  без ?debug=1 (window.itd нет): меню без сейва, клавиша 2 стартует партию, HUD рисует деньги и день;
//       на обеих вкладках нет pageerror
//   A6  btn.debug active: true → false → true по кликам
//   A7  рестарт партии без перезагрузки: speed/nav active живые, нет pageerror (D2)
//   D1  mid_day10 на паузе, itd.step до 12:00/14:00/17:00 → hud.dayProfit одинаков (±$50), > 0
//       и равен day_report.profit дня 10 (последний тик — живой, ради настоящего отчёта)
//   D3  mid_day10 (день 10, тик 12) на паузе, itd.step({ticks: 60}) — 60 тиков за ОДИН вызов:
//       .advance.ticks 60, .advance.days 1, день 11 тик 18 (ITGAME-56; ms-форма — D1)
//   X1  itd.sandbox('qa38') при «владельце» в общем ключе: sid a-qa38-… во вкладке, owner {sid, diff}; bad_label (ITGAME-77)
//   X2  партия песочницы под её sid, общий ключ цел; в партии sandbox()/restore() — in_party; fakeOwner()
//   X3  «Сдаться» — fake в общем ключе цел (гард clearSession), вкладка на новом sid песочницы, «Продолжить» нет
//   X4  вторая партия после «Сдаться» — новый sid песочницы, общий ключ не перезаписан
//   X5  restore(): sidSame/diffSame, ключи владельца (и itd.onboard, ITGAME-21) возвращены, служебные убраны; повтор — no_sandbox
//   X6  владелец сам сменил общий ключ — restore() его не перетирает (kept)
//   P1  itd.play (ITGAME-73) на fresh, сид 7, тик 0: set_speed 0 → hire → hire → days1 → buy_pc → hire → days1 —
//       вердикты ok/ok/FAIL no_free_pc/ok/ok/FAIL not_enough_money/ok, цепочка балансов 600>300>614>39>353,
//       «до» шага = «после» прошлого, без «нет rev», строка «cmd | ok/FAIL code | dN tN | бал>бал | staff a>b | pay N | phase»
//   P2  itd.ledger(1)/(2)/(): сведены (balanced), покупки hire $300 / buy_pc $575, profit = delta + покупки,
//       старт дня = конец прошлого; текущий день открыт, payroll 0; ledger(99) — «нет книги дня 99: есть [1 2 3]»
//   P3  itd.set({money}) — правка видна в adjust, книга сведена
//   K1  (ITGAME-87) broken_pc: наведение на office.slot.1 (до зон мест — office.worker.1) — текст тултипа visible true; pointerout
//       прячет контейнер — тот же текст в itd.text() visible false (раньше true); hit/stack — «узел невидим»
//   N1  (ITGAME-117) overlaps() видит тексты и плашку внутри контейнера (text-text с соседом и с текстом верхнего уровня, occlusion); скрытый контейнер — 0
//   K2  (ITGAME-87) soft_lock → конец дня → «ТУПИК» (game_over): overlaps() без записей от затемнения;
//       снятая метка dim вернула бы их (контроль: > 0), метка возвращена — снова 0; у отчёта дня (C2) — тоже 0
//   K3  (ITGAME-88) nodes().fill: маркер меню (Triangle) и плашки — '#rrggbb' = fillColor объекта, у Text — null
//   K4  (ITGAME-88) menuReady после itd.sandbox.restore(): сразу false (перезапуск меню в очереди),
//       после wait — плашка menu.diff.normal не сдвигается 1,5 с
//   V1/V2 + (ITGAME-88) stale().shown: false на свежей вкладке, true на подмене, снова false
//   + на странице нет pageerror
//
// Отклонения от буквального сценария в трекере (см. отчёт агента):
//  - B1→B2 деньги поднимаются обратно set({money:5000}): $100 при 0 сотрудниках
//    меньше MinCostToEarn (наём $300) — конец дня уходит в deadlock/game_over,
//    а не в day_report, который проверяют B2/C2.
//  - C3 сдвигает btn.next_day не на "+5px от верха текста", а на нижнюю кромку
//    (body.y + body.height - 10): при случайном событии дня журнал «Журнал событий: …»
//    расширяет bounding box текста настолько, что кнопка (200px) оказывается
//    ЦЕЛИКОМ внутри него — находка тогда законно не считается (вложенность).
//    Сдвиг на кромку снизу гарантированно даёт частичное пересечение
//    независимо от случайного события.
//
// Self-serve: без QA_BASE поднимает Go-сервер на QA_PORT (по умолчанию :4175,
// как visreg.mjs/qa-itgame16.mjs — порт 4173/4174 заняты соседними прогонами).
// Общий self-serve — client/scripts/lib/selfserve.mjs.
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'
import { chromePath } from './lib/chrome.mjs'
import { selfServe } from './lib/selfserve.mjs'

const CLIENT_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const SELF_PORT = Number(process.env.QA_PORT) || 4175
const HINT_IDS = ['master', 'router', 'core', 'server', 'cooler', 'fridge', 'motivate', 'softlock']
const VALID_OVERLAP_KINDS = new Set(['text', 'occlusion', 'interactive'])

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

// ── Утилиты чтения сцены ────────────────────────────────────────────────
const ids = (page) => page.evaluate(() => window.itd.ids())
const byPrefix = (list, prefix) => list.filter((n) => n.id.startsWith(prefix))
const oneOf = (list) => list.find((n) => n.active === true)
// ITGAME-62: вид кнопок скорости — заливка, рамка, цвет подписи (приватное поле HUD)
async function speedLook(page) {
  return page.evaluate(() =>
    window.__itd.scene.getScene('hud').speedBtns.map((b) => ({
      speed: b.speed, fill: b.bg.fillColor, stroke: b.bg.strokeColor,
      label: b.label.text, color: b.label.style.color,
    })),
  )
}

const D1_TOL = 50 // $: один живой тик 53 может поймать поломку ПК; офлайн-промотка детерминирована
// «+$3,266/день» / «-$526/день» → 3266 / -526 (формат fmtMoney)
const parseMoney = (text) => (typeof text === 'string' && /\d/.test(text) ? Number(text.replace(/[^\d-]/g, '')) : NaN)
const dayProfitNow = (page) =>
  page.evaluate(() => window.itd.nodes().find((n) => n.id === 'hud.dayProfit')?.text ?? null)
// Честная промотка офлайн-движком (itd.step → /api/debug/advance), ≤ 10 тиков за вызов.
async function advanceTo(page, target) {
  for (let i = 0; i < 20; i++) {
    const t = await page.evaluate(() => window.itd.state().tickInDay)
    if (t >= target) return t
    const n = Math.min(10, target - t)
    await page.evaluate((ms) => window.itd.step(ms), n * 1000)
    await page.waitForFunction((tt) => window.itd.state().tickInDay >= tt, { timeout: 5000 }, t + n)
  }
  return page.evaluate(() => window.itd.state().tickInDay)
}

async function run() {
  let stopServer = null
  if (!process.env.QA_BASE) {
    try {
      ;({ stop: stopServer } = await selfServe({ port: SELF_PORT, saves: 'off', label: 'QA-ITGAME38' }))
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

    // sid уникален (агрессивный прогон — не резюмировать чужую партию) и все
    // онбординг-хинты помечены показанными: тосты хинтов не должны мешать
    // проверкам тостов/звука в B2/C2. Оба — до первого документа страницы.
    const sid = 'qa38-' + Date.now().toString(36)
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

    // ── V1/V2 (ITGAME-78): штамп сборки и «устарело, обнови» в #topbar (страница с debug=1)
    const v1 = await page.evaluate(async () => {
      const st = await window.itd.stale()
      return {
        st, sha: window.itd.version.sha, stamp: document.getElementById('build')?.textContent ?? null,
        warnHidden: document.getElementById('stale')?.hidden ?? null, data: document.getElementById('topbar')?.dataset.stale ?? null,
        h: document.getElementById('topbar')?.offsetHeight ?? 0, meta: window.itd.screen().meta.stale,
      }
    })
    check(
      'V1: свежая вкладка — stale false, dist = client = itd.version.sha, штамп sha в #topbar, метка скрыта, meta.stale false',
      v1.st.stale === false && v1.st.shown === false && v1.st.client === v1.sha && v1.st.dist === v1.sha && v1.stamp === v1.sha &&
        (v1.st.server === null || typeof v1.st.server === 'string') && v1.warnHidden === true && v1.data === 'false' && v1.meta === false,
      JSON.stringify(v1),
    )
    // Стенд «пересобран»: index.html отдаёт другой sha — подменяем ответ на fetch('/').
    await page.setRequestInterception(true)
    const fakeIndex = (req) => {
      const u = new URL(req.url())
      if (req.resourceType() === 'fetch' && u.pathname === '/') {
        req.respond({ status: 200, contentType: 'text/html', body: '<html><head><meta name="build" content="0000000 2026-10-10T00:00:00Z" /></head></html>' })
      } else req.continue()
    }
    page.on('request', fakeIndex)
    const v2 = await page.evaluate(async () => {
      const st = await window.itd.stale()
      const w = document.getElementById('stale')
      return {
        st, warnHidden: w?.hidden ?? null, text: w?.textContent ?? null, visible: !!w && w.offsetWidth > 0,
        data: document.getElementById('topbar')?.dataset.stale ?? null, h: document.getElementById('topbar')?.offsetHeight ?? 0,
      }
    })
    page.off('request', fakeIndex)
    await page.setRequestInterception(false)
    const v2b = await page.evaluate(async () => ({ st: await window.itd.stale(), warnHidden: document.getElementById('stale')?.hidden ?? null }))
    check(
      'V2: стенд отдаёт другой sha — stale true, красная метка «устарело, обнови» видна, высота #topbar та же; стенд снова свой — метка скрыта',
      v2.st.stale === true && v2.st.shown === true && v2.st.dist === '0000000' && v2.warnHidden === false && v2.visible && v2.text === 'устарело, обнови' &&
        v2.data === 'true' && v2.h === v1.h && v2b.st.stale === false && v2b.st.shown === false && v2b.warnHidden === true,
      JSON.stringify({ v2, v2b, h1: v1.h }),
    )

    // ── A1: ровно один активный зум; сложности и статистика — не переключатели
    const idsA1 = await ids(page)
    const zoomA1 = byPrefix(idsA1, 'menu.zoom.')
    check(
      'A1: ровно один menu.zoom.* active===true',
      zoomA1.filter((n) => n.active === true).length === 1,
      JSON.stringify(zoomA1),
    )
    const diffA1 = byPrefix(idsA1, 'menu.diff.')
    // Пункты меню — фокус клавиатуры (ITGAME-19): active ровно у одного,
    // без сейва это НОРМА; ↓ переносит фокус на следующий уровень.
    check(
      'A1: menu.diff.* — фокус только на menu.diff.normal',
      diffA1.length === 4 && diffA1.filter((n) => n.active === true).map((n) => n.id).join() === 'menu.diff.normal' &&
        diffA1.every((n) => typeof n.active === 'boolean'),
      JSON.stringify(diffA1),
    )
    await page.evaluate(() => window.itd.key('down'))
    const diffDown = byPrefix(await ids(page), 'menu.diff.')
    check(
      'A1: ↓ переносит фокус на menu.diff.hard',
      diffDown.filter((n) => n.active === true).map((n) => n.id).join() === 'menu.diff.hard',
      JSON.stringify(diffDown),
    )
    await page.evaluate(() => window.itd.key('up'))
    const statsA1 = idsA1.find((n) => n.id === 'menu.stats')
    check('A1: menu.stats active===null', statsA1?.active === null, JSON.stringify(statsA1))

    // ── A2: клик по зуму переключает active
    const originalZoomId = oneOf(zoomA1)?.id
    const clickZoom1 = await page.evaluate(() => window.itd.click('menu.zoom.1'))
    await delay(150)
    const idsA2 = byPrefix(await ids(page), 'menu.zoom.')
    check(
      'A2: клик menu.zoom.1 → только он active',
      clickZoom1.ok && idsA2.find((n) => n.id === 'menu.zoom.1')?.active === true &&
        idsA2.filter((n) => n.active === true).length === 1,
      JSON.stringify(idsA2),
    )
    // возвращаем исходный зум
    if (originalZoomId) {
      await page.evaluate((id) => window.itd.click(id), originalZoomId)
      await delay(150)
    }

    // ── C4: сдвиг menu.zoom.1 на соседа — overlaps() ловит интерактив
    const moveC4 = await page.evaluate(() => {
      const scene = window.__itd.scene.getScene('menu')
      const find = (id) => scene.children.list.find((o) => o.getData && o.getData('id') === id)
      const a = find('menu.zoom.1')
      const b = find('menu.zoom.1.4')
      if (!a || !b) return null
      const origX = a.x
      a.x = b.x - 30 // частичное перекрытие (не «один внутри другого»)
      return { origX }
    })
    const ovC4 = moveC4 ? await page.evaluate(() => window.itd.overlaps()) : []
    const hitC4 = ovC4.find((e) => e.kind === 'interactive' && (e.a === 'menu.zoom.1' || e.b === 'menu.zoom.1'))
    check('C4: сдвиг menu.zoom.1 на соседа → overlaps kind interactive', !!moveC4 && !!hitC4, JSON.stringify(hitC4 ?? ovC4.slice(0, 5)))
    if (moveC4) {
      const pairC4 = ovC4.find((e) => e.kind === 'interactive' && [e.a, e.b].includes('menu.zoom.1') && [e.a, e.b].includes('menu.zoom.1.4'))
      check(
        'C4a: ratio ≈ 0.58, threshold 0; у всех записей 0 < ratio ≤ 1 и ratio ≥ threshold',
        !!pairC4 && pairC4.threshold === 0 && pairC4.ratio >= 0.55 && pairC4.ratio <= 0.62 &&
          ovC4.every((e) => typeof e.ratio === 'number' && typeof e.threshold === 'number' && e.ratio > 0 && e.ratio <= 1 && e.ratio >= e.threshold),
        JSON.stringify(pairC4 ?? ovC4.slice(0, 5)),
      )
      const ovC4b = await page.evaluate(() => window.itd.overlaps({ minAreaRatio: 0.6 }))
      check(
        'C4b: minAreaRatio 0.6 отсекает пару, threshold у всех 0.6',
        !ovC4b.some((e) => [e.a, e.b].includes('menu.zoom.1') && [e.a, e.b].includes('menu.zoom.1.4')) &&
          ovC4b.every((e) => e.threshold === 0.6),
        JSON.stringify(ovC4b.slice(0, 5)),
      )
      const ovC4c = await page.evaluate(() => window.itd.overlaps({ minAreaRatio: 0.5 }))
      const pairC4c = ovC4c.find((e) => [e.a, e.b].includes('menu.zoom.1') && [e.a, e.b].includes('menu.zoom.1.4'))
      check('C4c: minAreaRatio 0.5 пропускает пару, threshold 0.5', !!pairC4c && pairC4c.threshold === 0.5, JSON.stringify(pairC4c ?? ovC4c.slice(0, 5)))
      const errC4d = await page.evaluate(() => {
        try {
          window.itd.overlaps({ minAreaRatio: 2 })
          return null
        } catch (e) {
          return e.message
        }
      })
      check('C4d: minAreaRatio 2 → RangeError с minAreaRatio в сообщении', typeof errC4d === 'string' && errC4d.includes('minAreaRatio'), String(errC4d))
    }
    if (moveC4) {
      await page.evaluate((x) => {
        const scene = window.__itd.scene.getScene('menu')
        const a = scene.children.list.find((o) => o.getData && o.getData('id') === 'menu.zoom.1')
        a.x = x
      }, moveC4.origX)
    }

    // ── C7: строгий режим для occlusion (в меню; всё внутри одного evaluate)
    const c7 = await page.evaluate(() => {
      const scene = window.__itd.scene.getScene('menu')
      const t = scene.children.list.find((o) => o.text === 'IT DIRECTOR')
      if (!t) return null
      const tb = t.getBounds()
      const r = scene.add.rectangle(tb.x, tb.y, tb.width, tb.height * 0.4, 0x000000).setOrigin(0).setDepth(10)
      const def = window.itd.overlaps()
      const strict = window.itd.overlaps({ minAreaRatio: 0 })
      r.destroy()
      return { def, strict }
    })
    const occDef = c7?.def.find((e) => e.kind === 'occlusion' && e.a === 'IT DIRECTOR')
    const occStrict = c7?.strict.find((e) => e.kind === 'occlusion' && e.a === 'IT DIRECTOR')
    check(
      'C7: occlusion 40% — по умолчанию нет, при minAreaRatio 0 есть (threshold 0, ratio ≈ 0.4)',
      !!c7 && !occDef && !!occStrict && occStrict.threshold === 0 && occStrict.ratio >= 0.35 && occStrict.ratio <= 0.45,
      JSON.stringify({ occDef, occStrict }),
    )

    // ── Старт партии (норма, fresh) — дальше HUD/офис
    const clickedNormal = await page.evaluate(() => window.itd.click('menu.diff.normal'))
    if (!clickedNormal.ok) throw new Error(`клик menu.diff.normal не прошёл — ${JSON.stringify(clickedNormal)}`)
    await page.waitForFunction(() => window.itd.state().connected === true, { timeout: 20000 })
    await delay(300)

    // ── A3: рамка активной скорости
    await page.evaluate(() => window.itd.speed(2))
    await page.waitForFunction(() => window.itd.state().speed === 2, { timeout: 5000 })
    await delay(150)
    const speedIdsA3 = byPrefix(await ids(page), 'btn.speed.')
    check(
      'A3: speed(2) → btn.speed.2 active, остальные нет',
      speedIdsA3.find((n) => n.id === 'btn.speed.2')?.active === true &&
        speedIdsA3.filter((n) => n.active === true).length === 1,
      JSON.stringify(speedIdsA3),
    )
    const lookRun = await speedLook(page)
    check(
      'A3: speed(2) → ⏸ в обычном виде (ITGAME-62)',
      lookRun[0].fill === 0x232640 && lookRun[0].stroke === 0x3a3f5c && lookRun[0].color === '#f4f4f4' &&
        lookRun[0].label === '⏸' && lookRun.find((b) => b.speed === 2)?.stroke === 0x41a6f6,
      JSON.stringify(lookRun),
    )
    await page.evaluate(() => window.itd.pause())
    await page.waitForFunction(() => window.itd.state().speed === 0, { timeout: 5000 })
    await delay(150)
    const speedIdsPause = byPrefix(await ids(page), 'btn.speed.')
    check(
      'A3: pause() → btn.speed.0 active',
      speedIdsPause.find((n) => n.id === 'btn.speed.0')?.active === true,
      JSON.stringify(speedIdsPause),
    )
    const lookPause = await speedLook(page)
    const hudContrast = await page.evaluate(() =>
      window.itd.contrast().filter((e) => e.scene === 'hud' && e.text === '⏸'),
    )
    check(
      'A3: pause() → ⏸ янтарная плашка, тёмная подпись, контраст ≥ 3:1 (ITGAME-62)',
      lookPause[0].fill === 0xffcd75 && lookPause[0].stroke === 0xffcd75 && lookPause[0].color === '#1a1c2c' &&
        lookPause[0].label === '⏸' &&
        lookPause.slice(1).every((b) => b.fill === 0x232640 && b.stroke === 0x3a3f5c && b.color === '#f4f4f4') &&
        hudContrast.length === 0,
      JSON.stringify({ lookPause, hudContrast }),
    )
    await page.evaluate(() => window.itd.speed(1))
    await page.waitForFunction(() => window.itd.state().speed === 1, { timeout: 5000 })
    await delay(150)
    const lookBack = await speedLook(page)
    check(
      'A3: speed(1) после паузы → ⏸ снова в обычном виде (ITGAME-62)',
      lookBack[0].fill === 0x232640 && lookBack[0].stroke === 0x3a3f5c && lookBack[0].color === '#f4f4f4' &&
        lookBack.find((b) => b.speed === 1)?.stroke === 0x41a6f6,
      JSON.stringify(lookBack),
    )
    // вернуть состояние, в котором идут A4+
    await page.evaluate(() => window.itd.pause())
    await page.waitForFunction(() => window.itd.state().speed === 0, { timeout: 5000 })
    await delay(150)

    // ── A4: панель навигации
    await page.evaluate(() => window.itd.click('nav.serverRoom'))
    await delay(300)
    const navIdsA4 = byPrefix(await ids(page), 'nav.')
    check(
      'A4: click(nav.serverRoom) → он active, nav.office0 — нет',
      navIdsA4.find((n) => n.id === 'nav.serverRoom')?.active === true &&
        navIdsA4.find((n) => n.id === 'nav.office0')?.active === false,
      JSON.stringify(navIdsA4),
    )
    // ── C8: спрайт × контейнер/прямоугольник в serverRoom → interactive с обоими id
    const c8 = await page.evaluate(() => {
      const scene = window.__itd.scene.getScene('serverRoom')
      const find = (id) => scene.children.list.find((o) => o.getData && o.getData('id') === id)
      const rack = find('room.rack.0.0')
      const core = find('room.core')
      if (!rack || !core) return null
      const { x, y } = rack
      rack.x = core.x + core.width / 2 // половинное перекрытие
      rack.y = core.y
      const ov = window.itd.overlaps()
      rack.x = x
      rack.y = y
      return ov
    })
    const hitC8 = c8?.find((e) => e.kind === 'interactive' && [e.a, e.b].includes('room.rack.0.0') && [e.a, e.b].includes('room.core'))
    check('C8: сдвиг спрайта room.rack.0.0 на room.core → interactive', !!hitC8, JSON.stringify(hitC8 ?? c8?.slice(0, 5) ?? null))
    // Назад в офис: кнопки покупки с ITGAME-94 живут в его сцене. Дребезг switchRoom
    // (250 мс игрового времени, в headless кадры редкие) отвечает code debounced — повторяем.
    for (let i = 0; i < 20; i++) {
      const r = await page.evaluate(() => window.itd.click('nav.office0'))
      if (r.code !== 'debounced') break
      await delay(150)
    }
    await delay(300)

    // ── A5: обычная кнопка покупки — не переключатель
    const pcIds = await page.evaluate(() => window.itd.ids().filter((n) => n.id === 'btn.pc'))
    check('A5: btn.pc.active===null', pcIds[0]?.active === null, JSON.stringify(pcIds))

    // ── Z4 (ITGAME-61): btn.zoom обходит три масштаба по кругу (2× убран)
    const zoomKey = () => page.evaluate(() => localStorage.getItem('itd.uiScale'))
    const zoomStart = (await zoomKey()) ?? '1.4' // null — значение по умолчанию
    const zoomSeq = []
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.itd.click('btn.zoom'))
      await delay(150)
      zoomSeq.push(await zoomKey())
    }
    check(
      'Z4: btn.zoom обходит 1/1.4/fit по кругу',
      [...zoomSeq].sort().join() === ['1', '1.4', 'fit'].sort().join() && zoomSeq[2] === zoomStart &&
        !zoomSeq.includes('2'),
      `start=${zoomStart} seq=${zoomSeq.join('→')}`,
    )

    // ── A6: тумблер debug — переключатель (страница открыта с debug=1)
    const dbgA6 = []
    dbgA6.push((await page.evaluate(() => window.itd.ids().find((n) => n.id === 'btn.debug')))?.active)
    await page.evaluate(() => window.itd.click('btn.debug'))
    await delay(150)
    dbgA6.push((await page.evaluate(() => window.itd.ids().find((n) => n.id === 'btn.debug')))?.active)
    await page.evaluate(() => window.itd.click('btn.debug'))
    await delay(150)
    dbgA6.push((await page.evaluate(() => window.itd.ids().find((n) => n.id === 'btn.debug')))?.active)
    check('A6: btn.debug active true → false → true', JSON.stringify(dbgA6) === '[true,false,true]', JSON.stringify(dbgA6))

    // ── C1: до всяких читов — overlaps() валиден и без interactive-находок
    const ovC1 = await page.evaluate(() => window.itd.overlaps())
    const badKindC1 = ovC1.filter((e) => !VALID_OVERLAP_KINDS.has(e.kind))
    check('C1: overlaps kind — допустимые значения', badKindC1.length === 0, `n=${ovC1.length} bad=${JSON.stringify(badKindC1)}`)
    const interactiveC1 = ovC1.filter((e) => e.kind === 'interactive')
    check('C1: interactive-записей нет (обычная игра)', interactiveC1.length === 0, JSON.stringify(interactiveC1))

    // ── B1: недостаточно денег → клик по отключённой кнопке → sound sfx:error
    await page.evaluate(() => window.itd.set({ money: 100 }))
    await page.waitForFunction(() => window.itd.state().balance === 100, { timeout: 5000 })
    await page.evaluate(() => window.itd.click('btn.pc'))
    await delay(250)
    const soundLogB1 = await page.evaluate(() => window.itd.log(200).filter((e) => e.type === 'sound'))
    const lastSoundB1 = soundLogB1[soundLogB1.length - 1]
    check(
      'B1: последняя sound-запись — sfx:error/office/ok (кнопка в комнате, ITGAME-94)',
      lastSoundB1?.key === 'sfx:error' && lastSoundB1?.scene === 'office' && lastSoundB1?.ok === true &&
        lastSoundB1?.name === 'error' && typeof lastSoundB1?.volume === 'number' &&
        lastSoundB1.volume > 0 && lastSoundB1.volume <= 1,
      JSON.stringify(lastSoundB1),
    )

    // ── S3 (ITGAME-72): нет денег — у btn.pc флаг D в screen() и disabled в nodes()
    const s3 = await page.evaluate(() => ({
      item: window.itd.screen({ scene: 'office' }).items.find((i) => i.startsWith('btn:pc|')),
      node: window.itd.nodes().find((n) => n.id === 'btn.pc')?.disabled,
      menu: window.itd.nodes().find((n) => n.id === 'btn.menu')?.disabled,
    }))
    check(
      'S3: $100 — btn:pc с флагом D, nodes().disabled true; у btn.menu disabled null',
      typeof s3.item === 'string' && s3.item.split('|')[4].includes('D') && s3.node === true && s3.menu === null,
      JSON.stringify(s3),
    )

    // Деньги обратно: $100 при 0 сотрудниках < MinCostToEarn ($300 найм) —
    // конец дня ушёл бы в deadlock/game_over, а не в day_report (см. шапку).
    await page.evaluate(() => window.itd.set({ money: 5000 }))

    // ── S4 (ITGAME-113): подпись в screen() — тексты ЦЕЛИКОМ в рамке кнопки, не всё, чей центр в ней.
    // Карточка события (btn.event.1, глубина 41) под окном «Выйти в меню?» (70): ✕ окна стоит центром на
    // верхней кромке btn.event.1 — старое правило клеило его в подпись «Отказаться (−$27) ✕». Событие ставит
    // itd.restore, как qa:slots EV1; сейв до него возвращается после — дедлайн не остаётся в плане дня.
    const saveS4 = await page.evaluate(async () => (await window.itd.snapshot()).save)
    await page.evaluate(async (tick) => { await window.itd.restore({ activeEvent: { ID: 'deadline', Tick: tick } }) }, saveS4.tickInDay)
    const evS4 = await page.evaluate(() =>
      window.itd.wait(() => window.itd.ids().some((n) => n.id === 'btn.event.1'), 5000).then(() => true, () => false))
    await page.evaluate(() => window.itd.click('btn.menu'))
    await delay(200)
    const s4 = await page.evaluate(() => {
      const sc = window.itd.screen()
      const nodes = window.itd.nodes()
      const geo = (n) => n && { cx: n.cx, cy: n.cy, w: Math.round(n.w * 10) / 10, h: Math.round(n.h * 10) / 10 }
      const btn = nodes.find((n) => n.id === 'btn.event.1' && n.visible)
      const x = nodes.find((n) => n.id === 'modal.close' && n.visible)
      // собственная подпись кнопки — Text в центре её рамки (showEvent: x + w/2, 212)
      const own = btn && nodes.find((n) => n.type === 'Text' && n.visible && n.text && Math.abs(n.cx - btn.cx) <= 1 && Math.abs(n.cy - btn.cy) <= 2)
      const row = (safe) => sc.items.find((i) => i.startsWith(safe + '|'))?.split('|')
      return {
        title: sc.meta.title, ev1: row('btn:event:1'), ev0: row('btn:event:0'), close: row('modal:close'),
        own: own ? own.text.replace(/\s+/g, ' ').trim().replace(/\|/g, '/').slice(0, 22) : null, btn: geo(btn), x: geo(x),
      }
    })
    // Предусловие кейса: центр ✕ в рамке btn.event.1 (±2 — старое правило его брало), а рамка ✕ — нет.
    const s4Pre = !!s4.btn && !!s4.x &&
      Math.abs(s4.x.cx - s4.btn.cx) <= s4.btn.w / 2 + 2 && Math.abs(s4.x.cy - s4.btn.cy) <= s4.btn.h / 2 + 2 &&
      Math.abs(s4.x.cy - s4.btn.cy) + s4.x.h / 2 > s4.btn.h / 2 + 2
    check(
      'S4: окно выхода над карточкой события — подпись btn:event:1 без ✕ окна (центр ✕ на её кромке), только свой текст, флаг X; modal:close — «✕»',
      evS4 && s4Pre && s4.title === 'Выйти в меню?' && !!s4.ev1 && s4.own !== null && s4.ev1[1] === s4.own && !s4.ev1[1].includes('✕') &&
        s4.ev1[4].includes('X') && !!s4.ev0 && !s4.ev0[1].includes('✕') && s4.close?.[1] === '✕',
      JSON.stringify({ evS4, pre: s4Pre, ...s4 }),
    )
    await page.evaluate(() => window.itd.click('modal.close'))
    await delay(150)
    await page.evaluate(async (save) => { await window.itd.restore(save) }, saveS4)
    await page.evaluate(() =>
      window.itd.wait(() => !window.itd.ids().some((n) => n.id.startsWith('btn.event.')), 5000).then(() => true, () => false))

    // ── H3 (ITGAME-113): stack() и объект, добавленный в этом кадре. setInteractive() ставит его в
    // _pendingInsertion, в _list (список хит-теста) его переносит preUpdate сцены на следующем шаге лупа.
    // stack() — настоящий хит-тест: сразу объекта не видит, и настоящий mousedown, разобранный Phaser в тот
    // же момент (его DOM-обработчик синхронный), тоже до него не доходит. Через кадр — видят оба.
    const h3 = await page.evaluate(async () => {
      const game = window.__itd
      const sc = game.scene.getScene('hud')
      const pt = [[24, 700], [640, 700], [1256, 700], [24, 400], [640, 400]].find(([px, py]) => window.itd.stack(px, py).stack.length === 0)
      if (!pt) return null
      const [x, y] = pt
      const tr = window.itd.trace.start({ maxMs: 20000 })
      const rect = sc.add.rectangle(x, y, 40, 30, 0xff00ff).setDepth(999).setInteractive()
      rect.setData('id', 'qa.h3')
      window.__qaH3 = rect
      const queued = sc.input._pendingInsertion.includes(rect) && !sc.input._list.includes(rect)
      const now = window.itd.stack(x, y)
      const c = game.canvas.getBoundingClientRect()
      const k = c.width / 1280
      const css = { x: c.left + x * k, y: c.top + y * k }
      const ev = (type) => new MouseEvent(type, { clientX: css.x, clientY: css.y, bubbles: true, cancelable: true, button: 0 })
      game.canvas.dispatchEvent(ev('mousedown'))
      game.canvas.dispatchEvent(ev('mouseup'))
      await new Promise((r) => requestAnimationFrame(r)) // рецепт из JSDoc stack(): дождаться кадра
      const listed = sc.input._list.includes(rect)
      const next = window.itd.stack(x, y)
      return { x, y, css, id: tr.id, queued, listed, now: { wins: now.wins?.id ?? null, n: now.stack.length }, next: { wins: next.wins?.id ?? null, stack: next.stack } }
    })
    if (h3) {
      await page.mouse.click(h3.css.x, h3.css.y) // настоящий клик мышью — уже после кадра
      await delay(150)
    }
    const h3tr = h3 && await page.evaluate((id) => {
      const tr = window.itd.trace.stop(id)
      window.__qaH3?.destroy()
      delete window.__qaH3
      return tr.pointer.map((p) => ({ type: p.type, wins: p.wins?.id ?? null, got: p.got }))
    }, h3.id)
    check(
      'H3: объект, добавленный в этом кадре, — в _pendingInsertion: stack().wins null, mousedown в тот же момент Phaser ему не отдал (trace: wins null, got [])',
      !!h3 && h3.queued && h3.now.wins === null && h3.now.n === 0 && h3tr?.length === 4 &&
        h3tr.slice(0, 2).every((p) => p.wins === null && p.got.length === 0),
      JSON.stringify({ h3, pointer: h3tr }),
    )
    check(
      'H3: через один requestAnimationFrame — в _list, stack().wins он; настоящий клик мышью Phaser отдал ему (trace: wins и got qa:h3)',
      !!h3 && h3.listed && h3.next.wins === 'qa.h3' && !!h3.next.stack[0]?.startsWith('qa:h3 hud ') &&
        !!h3tr && h3tr.slice(2).every((p) => p.wins === 'qa.h3' && p.got.length === 1 && p.got[0] === 'qa:h3'),
      JSON.stringify({ next: h3?.next, pointer: h3tr?.slice(2) }),
    )

    // ── B2: skipReports=1 — смена дня без модалки, sound/toast по прибыли
    await page.evaluate(() => localStorage.setItem('itd.skipReports', '1'))
    await page.evaluate(() => window.itd.set({ tickInDay: 53 })) // 53 — макс. для running (dayTicks=54, строго меньше)
    await page.evaluate(() => window.itd.speed(3))
    const dayBeforeB2 = await page.evaluate(() => window.itd.state().day)
    await page.waitForFunction((d) => window.itd.state().day > d, { timeout: 30000 }, dayBeforeB2)
    await delay(400)

    const logB2 = await page.evaluate(() => window.itd.log(200))
    const dayReportB2 = [...logB2].reverse().find((e) => e.type === 'day_report')
    const expectedSoundKey = (dayReportB2?.profit ?? 0) >= 0 ? 'sfx:bong' : 'sfx:drop'
    // Не просто «последняя sound-запись»: следом может сыграть звук ачивки
    // (например, первый день — «confirmation»). Ищем последний звук конца дня.
    const daySoundEntriesB2 = logB2.filter((e) => e.type === 'sound' && (e.key === 'sfx:bong' || e.key === 'sfx:drop'))
    const lastSoundB2 = daySoundEntriesB2[daySoundEntriesB2.length - 1]
    check(
      'B2: sound key по знаку прибыли (из day_report в логе)',
      !!dayReportB2 && lastSoundB2?.key === expectedSoundKey,
      `profit=${dayReportB2?.profit} lastSound=${JSON.stringify(lastSoundB2)}`,
    )
    const toastEntriesB2 = logB2.filter((e) => e.type === 'toast' && e.where === 'top')
    const lastToastB2 = toastEntriesB2[toastEntriesB2.length - 1]
    const expectedPrefix = dayReportB2 ? `День ${dayReportB2.day}: прибыль` : null
    check(
      'B2: toast where=top, текст «День N: прибыль…»',
      !!lastToastB2 && !!expectedPrefix && lastToastB2.text.startsWith(expectedPrefix),
      JSON.stringify(lastToastB2),
    )
    const profitB2 = dayReportB2?.profit ?? 0
    const expectedBg = profitB2 > 0 ? '#257179' : profitB2 === 0 ? '#333c57' : '#b13e53'
    check('B2: toast bg по знаку прибыли', lastToastB2?.bg === expectedBg, `expected=${expectedBg} got=${lastToastB2?.bg}`)

    // ── C2: без skipReports — модалка отчёта, без interactive-находок; чекбокс переключается
    await page.evaluate(() => localStorage.removeItem('itd.skipReports'))
    await page.waitForFunction(() => window.itd.state().phase === 'running', { timeout: 10000 })
    await page.evaluate(() => window.itd.set({ tickInDay: 53 }))
    await page.evaluate(() => window.itd.speed(3))
    await page.waitForFunction(() => window.itd.state().phase === 'day_report', { timeout: 30000 })
    await delay(400)

    const ovC2 = await page.evaluate(() => window.itd.overlaps())
    const interactiveC2 = ovC2.filter((e) => e.kind === 'interactive')
    check('C2: модалка отчёта — interactive-находок нет', interactiveC2.length === 0, JSON.stringify(interactiveC2))
    const dimC2 = ovC2.filter((e) => e.b === 'Rectangle(1280x720)' || e.a === 'Rectangle(1280x720)')
    check('C2/K2: отчёт дня — записей overlaps() от затемнения нет (ITGAME-87)', dimC2.length === 0, JSON.stringify(dimC2.slice(0, 3)))
    // ── S1/S2 (ITGAME-72): карта экрана на отчёте дня
    const s1 = await page.evaluate(() => {
      const sc = window.itd.screen()
      return {
        sc, len: JSON.stringify(sc).length, day: window.itd.state().day, blocker: window.itd.blocker(),
        free: window.itd.screen({ free: true }), half: window.itd.screen({ frame: innerWidth / 2 }),
        next: window.itd.nodes().find((n) => n.id === 'btn.next_day'),
        pcHit: window.itd.hit('btn.pc').ok,
        rect: (() => { const r = document.querySelector('canvas').getBoundingClientRect(); return { left: r.left, top: r.top, k: r.width / 1280 } })(),
      }
    })
    console.log('      screen():', JSON.stringify(s1.sc))
    const row = (sc, safe) => sc.items.find((i) => i.startsWith(safe + '|'))?.split('|')
    const nextRow = row(s1.sc, 'btn:next_day')
    const menuRow = row(s1.sc, 'btn:menu')
    const keys = ['sha', 'tab', 'day', 'clock', 't', 'bal', 'speed', 'phase', 'staff', 'pay', 'hudClock', 'hudBal', 'blocker', 'title']
    check(
      'S1: отчёт дня — meta.title «День N завершён», blocker hud@50, phase day_report, hudBal/hudClock нарисованы; blocker() отдаёт safe и title',
      keys.every((k) => k in s1.sc.meta) && s1.sc.meta.title === `День ${s1.day} завершён` && s1.sc.meta.blocker === 'hud@50' &&
        s1.sc.meta.phase === 'day_report' && /^\$/.test(s1.sc.meta.hudBal ?? '') && /^День \d+ ·/.test(s1.sc.meta.hudClock ?? '') &&
        s1.blocker?.title === s1.sc.meta.title && 'safe' in s1.blocker && s1.sc.n === s1.sc.items.length,
      JSON.stringify({ meta: s1.sc.meta, blocker: s1.blocker }),
    )
    const expX = Math.round(s1.rect.left + s1.next.cx * s1.rect.k)
    const expY = Math.round(s1.rect.top + s1.next.cy * s1.rect.k)
    const halfNext = row(s1.half, 'btn:next_day')
    check(
      'S2: btn:next_day без X с подписью и точкой = центр в CSS px; btn:menu под затемнением — X; free без X; frame пересчитывает x/y',
      !!nextRow && !nextRow[4].includes('X') && nextRow[1] !== '-' && Number(nextRow[2]) === expX && Number(nextRow[3]) === expY &&
        !!menuRow && menuRow[4].includes('X') &&
        s1.free.items.length > 0 && s1.free.items.every((i) => !i.split('|')[4].includes('X')) && !row(s1.free, 'btn:menu') &&
        !!halfNext && Math.abs(Number(halfNext[2]) - expX / 2) <= 1 && Math.abs(Number(halfNext[3]) - expY / 2) <= 1,
      JSON.stringify({ nextRow, menuRow, halfNext, expX, expY, free: s1.free.n, len: s1.len, n: s1.sc.n }),
    )
    const pcRow = row(s1.sc, 'btn:pc')
    check(
      'S2b: кнопка комнаты btn:pc под затемнением отчёта — X, hit() не ok, в free её нет (ITGAME-94)',
      !!pcRow && pcRow[4].includes('X') && s1.pcHit === false && !row(s1.free, 'btn:pc'),
      JSON.stringify({ pcRow, pcHit: s1.pcHit }),
    )
    const skipIdsBefore = await page.evaluate(() => window.itd.ids().filter((n) => n.id === 'btn.skip_reports'))
    check('C2: btn.skip_reports active===false (до клика)', skipIdsBefore[0]?.active === false, JSON.stringify(skipIdsBefore))
    await page.evaluate(() => window.itd.click('btn.skip_reports'))
    await delay(150)
    const skipIdsAfter = await page.evaluate(() => window.itd.ids().filter((n) => n.id === 'btn.skip_reports'))
    const skipLs = await page.evaluate(() => localStorage.getItem('itd.skipReports'))
    check(
      'C2: после клика active===true и localStorage===1',
      skipIdsAfter[0]?.active === true && skipLs === '1',
      JSON.stringify({ skipIdsAfter, skipLs }),
    )

    // ── H1 (ITGAME-74): itd.stack() — настоящий хит-тест Phaser под открытым отчётом дня
    const h1 = await page.evaluate(() => ({
      menu: window.itd.stack('btn:menu'),
      hit: window.itd.hit('btn.menu'),
      next: window.itd.stack('btn.next_day'),
      bad: window.itd.stack('nope.nope'),
      pt: window.itd.stack(-5, -5),
    }))
    check(
      'H1: stack(btn:menu) под отчётом — wins затемнение hud (не btn.menu), btn:menu ниже в stack, совпадает с hit().top',
      h1.menu.ok && h1.menu.wins && h1.menu.wins.id !== 'btn.menu' && h1.menu.wins.scene === 'hud'
        && h1.menu.stack.some((l) => l.startsWith('btn:menu '))
        && h1.hit.top?.scene === h1.menu.wins.scene && h1.hit.top?.depth === h1.menu.wins.depth
        && h1.hit.top?.type === h1.menu.wins.type,
      JSON.stringify({ menu: h1.menu, top: h1.hit.top }),
    )
    check('H1: stack(btn.next_day) — wins сама кнопка', h1.next.wins?.id === 'btn.next_day', JSON.stringify(h1.next))
    check('H1: stack(нет узла) → ok:false, why; stack(-5,-5) вне холста → stack пуст, wins null',
      h1.bad.ok === false && h1.bad.why === 'нет узла' && h1.pt.ok === true && h1.pt.stack.length === 0 && h1.pt.wins === null,
      JSON.stringify({ bad: h1.bad, pt: h1.pt }))

    // ── H2 (владелец 10.10): hit() и флаг X в screen() — настоящий хит-тест, не bounds.
    // hitArea btn.next_day сжимаем до 1×1 в левом верхнем углу: bounds те же, но центр
    // кнопки клик уже не берёт — его забирает затемнение отчёта под ней.
    const h2 = await page.evaluate(() => {
      const scene = window.__itd.scene.getScene('hud')
      const btn = scene.children.list.find((o) => o.getData && o.getData('id') === 'btn.next_day')
      if (!btn?.input?.hitArea) return null
      const ha = btn.input.hitArea
      const orig = { w: ha.width, h: ha.height }
      ha.width = 1
      ha.height = 1
      const hit = window.itd.hit('btn.next_day')
      const stack = window.itd.stack('btn.next_day')
      const row = window.itd.screen().items.find((i) => i.startsWith('btn:next_day|'))
      ha.width = orig.w
      ha.height = orig.h
      const back = window.itd.hit('btn.next_day')
      return { hit, wins: stack.wins, row, back: back.ok }
    })
    check(
      'H2: hitArea кнопки 1×1 — hit() ok:false, top = wins stack() (затемнение hud), screen() ставит X; hitArea вернули — ok',
      !!h2 && h2.hit.ok === false && h2.hit.top?.scene === 'hud' && h2.hit.top?.id !== 'btn.next_day'
        && h2.hit.top?.depth === h2.wins?.depth && h2.hit.top?.type === h2.wins?.type
        && !!h2.row && h2.row.split('|')[4].includes('X') && h2.back === true,
      JSON.stringify(h2),
    )

    // ── C3: сдвиг btn.next_day на кромку текста отчёта → находка interactive
    const moveC3 = await page.evaluate(() => {
      const scene = window.__itd.scene.getScene('hud')
      const btn = scene.children.list.find((o) => o.getData && o.getData('id') === 'btn.next_day')
      const body = scene.reportUI?.[3] // [overlay, panel, title, bodyText, checkbox, btnBg, btnText]
      if (!btn || !body) return null
      const tb = body.getBounds()
      const origY = btn.y
      // Нижняя кромка текста, а не «+5px от верха»: у длинного тела (со
      // строкой события) кнопка иначе целиком попадает внутрь bounding box
      // многострочного текста и линтер законно не считает это находкой
      // (вложенность). Кромка снизу даёт частичное пересечение всегда.
      btn.y = tb.y + tb.height - 10
      return { origY }
    })
    const ovC3 = moveC3 ? await page.evaluate(() => window.itd.overlaps()) : []
    const hitC3 = ovC3.find((e) => e.kind === 'interactive' && (e.a === 'btn.next_day' || e.b === 'btn.next_day'))
    check('C3: сдвиг btn.next_day в текст отчёта → overlaps kind interactive', !!moveC3 && !!hitC3, JSON.stringify(hitC3 ?? ovC3.slice(0, 5)))
    if (moveC3) {
      await page.evaluate((y) => {
        const scene = window.__itd.scene.getScene('hud')
        const btn = scene.children.list.find((o) => o.getData && o.getData('id') === 'btn.next_day')
        btn.y = y
      }, moveC3.origY)
    }

    // ── C5: канон ITGAME-18 — чекбокс «пропускать отчёты» на строку отчёта
    const c5 = await page.evaluate(() => {
      const scene = window.__itd.scene.getScene('hud')
      const cb = scene.children.list.find((o) => o.getData && o.getData('id') === 'btn.skip_reports')
      const body = scene.reportUI?.[3]
      if (!cb || !body) return null
      const tb = body.getBounds()
      const y = cb.y
      cb.y = tb.y + tb.height / 2 - cb.height / 2 // origin (0.5, 0)
      const ov = window.itd.overlaps()
      cb.y = y
      return ov
    })
    const hitC5 = c5?.find((e) => [e.a, e.b].includes('btn.skip_reports') && (e.kind === 'text' || e.kind === 'interactive'))
    check('C5: чекбокс на строке отчёта → находка с btn.skip_reports', !!hitC5, JSON.stringify(hitC5 ?? c5?.slice(0, 5) ?? null))

    // ── A7: повторная партия в той же вкладке (сцена hud переживает рестарт) —
    // active скоростей/навигации живой, refresh() не падает (D2)
    if ((await page.evaluate(() => window.itd.state().phase)) === 'day_report') {
      await page.evaluate(() => window.itd.key('enter'))
      await page.waitForFunction(() => window.itd.state().phase === 'running', { timeout: 10000 })
    }
    const menuClickA7 = await page.evaluate(() => window.itd.click('btn.menu'))
    await delay(300)
    const saveClickA7 = await page.evaluate(() => window.itd.click('modal.btn.0'))
    await page.waitForFunction(() => window.itd.state().menuReady === true, { timeout: 20000 })
    // Сейвы выключены (-saves off): сводка сейва (ITGAME-19) честно говорит
    // «сейва нет», и «Продолжить» исчезает — повторная партия идёт через уровень.
    await page.waitForFunction(() => !window.itd.ids().some((n) => n.id === 'menu.continue'), { timeout: 10000 })
    const contClickA7 = await page.evaluate(() => window.itd.click('menu.diff.normal'))
    await page.waitForFunction(() => window.itd.state().connected === true, { timeout: 20000 })
    await delay(300)
    await page.evaluate(() => window.itd.speed(2))
    await page.waitForFunction(() => window.itd.state().speed === 2, { timeout: 5000 })
    await delay(150)
    const idsA7 = await ids(page)
    const speedA7 = byPrefix(idsA7, 'btn.speed.')
    const navA7 = byPrefix(idsA7, 'nav.')
    check(
      'A7: после рестарта партии — 4 btn.speed.*, active только у btn.speed.2',
      menuClickA7.ok && saveClickA7.ok && contClickA7.ok && speedA7.length === 4 &&
        speedA7.find((n) => n.id === 'btn.speed.2')?.active === true &&
        speedA7.filter((n) => n.active === true).length === 1,
      JSON.stringify({ speedA7, clicks: [menuClickA7, saveClickA7, contClickA7] }),
    )
    check(
      'A7: после рестарта партии — 4 nav.*, nav.office0 active',
      navA7.length === 4 && navA7.find((n) => n.id === 'nav.office0')?.active === true,
      JSON.stringify(navA7),
    )

    // ── D1 (ITGAME-49): «+X/день» — прибыль дня, а не остаток дня.
    // Сначала пауза (A7 оставил speed 2): живые тики дали бы кофе/поломки.
    await page.evaluate(() => window.itd.pause())
    await page.waitForFunction(() => window.itd.state().speed === 0, { timeout: 5000 })
    await page.evaluate(() => window.itd.scenario('mid_day10'))
    await page.waitForFunction(
      () => window.itd.state().scenario === 'mid_day10' && window.itd.state().tickInDay === 12,
      { timeout: 10000 },
    )
    await delay(200)
    const d1 = []
    for (const tick of [12, 24, 42]) {
      const at = await advanceTo(page, tick)
      await delay(200)
      const st = await page.evaluate(() => window.itd.state())
      const text = await dayProfitNow(page)
      d1.push({ tick: at, clock: st.clock, text, value: parseMoney(text) })
    }
    const vals = d1.map((p) => p.value)
    check(
      `D1: hud.dayProfit на mid_day10 в 12:00/14:00/17:00 одинаков (±$${D1_TOL})`,
      d1.every((p, i) => p.tick === [12, 24, 42][i]) && vals.every(Number.isFinite) &&
        Math.max(...vals) - Math.min(...vals) <= D1_TOL,
      JSON.stringify(d1),
    )
    check('D1: hud.dayProfit положителен во всех трёх точках', vals.every((v) => v > 0), JSON.stringify(vals))
    // Промотка через конец дня отчёта не даёт — последний тик живой.
    await advanceTo(page, 53)
    await page.evaluate(() => window.itd.speed(1))
    await page.waitForFunction(
      () => window.itd.log(200).some((e) => e.type === 'day_report' && e.day === 10),
      { timeout: 15000 },
    )
    const reportD1 = (await page.evaluate(() => window.itd.log(200)))
      .filter((e) => e.type === 'day_report' && e.day === 10).pop()
    await page.evaluate(() => window.itd.pause())
    check(
      `D1: hud.dayProfit в 12:00 = day_report.profit дня 10 (±$${D1_TOL})`,
      !!reportD1 && Number.isFinite(vals[0]) && Math.abs(reportD1.profit - vals[0]) <= D1_TOL,
      `hud12=${vals[0]} report=${JSON.stringify(reportD1)}`,
    )

    // ── D3 (ITGAME-56): ticks-форма itd.step — больше 10 тиков за вызов.
    // mid_day10: день 10, тик 12, dayTicks 54. +60 тиков офлайн-движком: хвост
    // дня (42) закрывает день 10, остаток 18 — в день 11. Скорость уже 0 (D1).
    await page.evaluate(() => window.itd.scenario('mid_day10'))
    await page.waitForFunction(
      () => { const s = window.itd.state(); return s.phase === 'running' && s.day === 10 && s.tickInDay === 12 },
      { timeout: 10000 },
    )
    const stepD3 = await page.evaluate(() =>
      window.itd.step({ ticks: 60 }).then(
        (r) => ({ ok: true, advance: r.advance, day: r.state.day, tickInDay: r.state.tickInDay }),
        (e) => ({ ok: false, error: String(e?.message ?? e) }),
      ),
    )
    await page
      .waitForFunction(() => window.itd.state().day === 11 && window.itd.state().tickInDay === 18, { timeout: 5000 })
      .catch(() => {})
    const stD3 = await page.evaluate(() => ({ day: window.itd.state().day, tickInDay: window.itd.state().tickInDay }))
    check(
      'D3: itd.step({ticks: 60}) — 60 тиков за вызов: день 10 тик 12 → день 11 тик 18',
      stepD3.ok && stepD3.advance?.ticks === 60 && stepD3.advance?.days === 1 &&
        stepD3.day === 11 && stepD3.tickInDay === 18 && stD3.day === 11 && stD3.tickInDay === 18,
      JSON.stringify({ stepD3, stD3 }),
    )

    // ── X1–X6 (ITGAME-77): песочница агента — своя вкладка, «владелец» в общем ключе
    const ps = await browser.newPage()
    ps.on('pageerror', (e) => pageErrors.push(String(e)))
    await ps.setViewport({ width: 1920, height: 1080 })
    await ps.goto(`${BASE}/?debug=1&seed=1`, { waitUntil: 'domcontentloaded' })
    await waitMenuReady(ps)
    // QA-скрипт пишет в localStorage сам: это «владелец» (агенту в браузере так нельзя — для этого fakeOwner)
    await ps.evaluate(() => {
      localStorage.setItem('itd.sid', 'owner-qa38'); localStorage.setItem('itd.diff', 'normal')
      // владелец ещё не прошёл онбординг HUD: браузер общий с прежними кейсами, они могли записать done (ITGAME-21)
      localStorage.removeItem('itd.onboard')
    })
    await ps.reload({ waitUntil: 'domcontentloaded' })
    await waitMenuReady(ps)
    const x1 = await ps.evaluate(() => ({
      bad: window.itd.sandbox('a.b'), sb: window.itd.sandbox('qa38'), tab: sessionStorage.getItem('itd.sid'),
      sid: window.itd.server().sid,
    }))
    check(
      'X1: sandbox(qa38) → sid a-qa38-…, owner {sid:true, diff:normal}, sid во вкладке; метка с точкой — bad_label',
      x1.sb.ok && /^a-qa38-\d+$/.test(x1.sb.sid) && x1.sb.owner?.sid === true && x1.sb.owner?.diff === 'normal' &&
        x1.tab === x1.sb.sid && x1.sid === x1.sb.sid && x1.bad.ok === false && x1.bad.code === 'bad_label',
      JSON.stringify(x1),
    )
    await ps.waitForFunction(() => window.itd.state().menuReady === true, { timeout: 20000 })
    await ps.evaluate(() => window.itd.click('menu.diff.normal'))
    await ps.waitForFunction(() => window.itd.state().connected === true, { timeout: 20000 })
    const x2 = await ps.evaluate(() => ({
      sid: window.itd.server().sid, ls: localStorage.getItem('itd.sid'), diff: localStorage.getItem('itd.diff'),
      again: window.itd.sandbox('qa38'), restore: window.itd.sandbox.restore(), fake: window.itd.sandbox.fakeOwner(),
    }))
    x2.lsAfterFake = await ps.evaluate(() => [localStorage.getItem('itd.sid'), localStorage.getItem('itd.diff')])
    check(
      'X2: партия песочницы под её sid, общий ключ владельца не тронут; в партии sandbox()/restore() — in_party; fakeOwner ставит чужой ключ',
      x2.sid === x1.sb.sid && x2.ls === 'owner-qa38' && x2.diff === 'normal' && x2.again.code === 'in_party' &&
        x2.restore.code === 'in_party' && x2.fake.ok && /^fake-owner-/.test(x2.fake.sid) && x2.fake.diff === 'hard' &&
        x2.lsAfterFake[0] === x2.fake.sid && x2.lsAfterFake[1] === 'hard',
      JSON.stringify(x2),
    )
    // «Сдаться» — путём кнопки; гард clearSession (45487c7) не должен стереть «чужой» общий ключ
    await ps.evaluate(() => window.itd.cmd('abandon'))
    await ps.waitForFunction(() => window.itd.state().menuReady === true, { timeout: 20000 })
    const x3 = await ps.evaluate(() => ({
      ls: [localStorage.getItem('itd.sid'), localStorage.getItem('itd.diff')], tab: sessionStorage.getItem('itd.sid'),
      sid: window.itd.server().sid, cont: window.itd.ids().some((n) => n.id === 'menu.continue'),
    }))
    check(
      'X3: после «Сдаться» общий ключ — всё ещё fake (гард держит), вкладка на новом sid песочницы, «Продолжить» нет',
      x3.ls[0] === x2.fake.sid && x3.ls[1] === 'hard' && x3.tab === null && /^a-qa38-/.test(x3.sid) && x3.sid !== x1.sb.sid && !x3.cont,
      JSON.stringify(x3),
    )
    // Новая партия после «Сдаться» (раньше «НОРМА» тут перезаписывала общий ключ) и выход в меню
    await ps.evaluate(() => window.itd.click('menu.diff.normal'))
    await ps.waitForFunction(() => window.itd.state().connected === true, { timeout: 20000 })
    const x4sid = await ps.evaluate(() => window.itd.server().sid)
    await ps.evaluate(() => window.itd.click('btn.menu'))
    await delay(300)
    await ps.evaluate(() => window.itd.click('modal.btn.0'))
    await ps.waitForFunction(() => window.itd.state().menuReady === true, { timeout: 20000 })
    const x4 = await ps.evaluate(() => [localStorage.getItem('itd.sid'), localStorage.getItem('itd.diff')])
    check(
      'X4: вторая партия песочницы — новый sid a-qa38-…, общий ключ не перезаписан',
      /^a-qa38-/.test(x4sid) && x4sid !== x1.sb.sid && x4[0] === x2.fake.sid && x4[1] === 'hard',
      JSON.stringify({ x4sid, x4 }),
    )
    // Партия песочницы прошла цепочку онбординга (HUD пишет done) — у владельца значения не было
    await ps.evaluate(() => localStorage.setItem('itd.onboard', 'done'))
    const x5 = await ps.evaluate(() => {
      const r = window.itd.sandbox.restore()
      return {
        r, again: window.itd.sandbox.restore(), ls: [localStorage.getItem('itd.sid'), localStorage.getItem('itd.diff')],
        tab: sessionStorage.getItem('itd.sid'), rec: sessionStorage.getItem('itd.sandbox'), sid: window.itd.server().sid,
        onboard: localStorage.getItem('itd.onboard'),
      }
    })
    const x5c = {
      ok: x5.r.ok, sidSame: x5.r.sidSame === true, diffSame: x5.r.diffSame === true, fake: x5.r.fake === true,
      restoredKeys: x5.r.restored.includes('localStorage.itd.sid') && x5.r.restored.includes('localStorage.itd.diff'),
      noKept: x5.r.kept.length === 0, sandboxRemoved: x5.r.removed.includes('sessionStorage.itd.sandbox'),
      ls: x5.ls[0] === 'owner-qa38' && x5.ls[1] === 'normal', tabClean: x5.tab === null && x5.rec === null,
      sid: x5.sid === 'owner-qa38', again: x5.again.code === 'no_sandbox',
      onboardGone: x5.onboard === null, onboardListed: x5.r.restored.includes('localStorage.itd.onboard'),
    }
    check(
      'X5: restore() — sidSame/diffSame (fake цел), ключи владельца (и itd.onboard, ITGAME-21) возвращены, служебные убраны, вкладка снова на sid владельца; повтор — no_sandbox',
      Object.values(x5c).every(Boolean),
      JSON.stringify({ conditions: x5c, x5 }),
    )
    // Владелец сам сменил общий ключ в другой вкладке — restore() его не перетирает
    await ps.waitForFunction(() => window.itd.state().menuReady === true, { timeout: 20000 })
    const x6 = await ps.evaluate(() => {
      window.itd.sandbox('qa38b')
      localStorage.setItem('itd.sid', 'owner-new')
      const r = window.itd.sandbox.restore()
      return { r, ls: localStorage.getItem('itd.sid') }
    })
    check(
      'X6: чужое значение общего ключа — sidSame false, kept, не перетёрто',
      x6.r.ok && x6.r.sidSame === false && x6.r.diffSame === true && x6.r.kept.includes('localStorage.itd.sid') && x6.ls === 'owner-new',
      JSON.stringify(x6),
    )
    await ps.evaluate(() => { localStorage.removeItem('itd.sid'); localStorage.removeItem('itd.diff') })
    await ps.close()

    // ── P1–P3 (ITGAME-73): партия и бухгалтерия из консоли. Своя вкладка с сидом 7
    // (найм роллит выработку $13/тик: день 1 даёт ровно $614 — числа замера из задачи)
    // и своя песочница — не выбивает партию основной вкладки.
    const pp = await browser.newPage()
    pp.on('pageerror', (e) => pageErrors.push(String(e)))
    await pp.setViewport({ width: 1920, height: 1080 })
    await pp.goto(`${BASE}/?scenario=fresh&seed=7&debug=1`, { waitUntil: 'domcontentloaded' })
    await waitMenuReady(pp)
    await pp.evaluate(() => window.itd.sandbox('qa73'))
    await pp.waitForFunction(() => window.itd.state().menuReady === true, { timeout: 20000 })
    await pp.evaluate(() => window.itd.click('menu.diff.normal'))
    await pp.waitForFunction(() => window.itd.state().scenario === 'fresh' && window.itd.state().phase === 'running', { timeout: 20000 })
    // живые тики до паузы съели бы выработку дня: тик 0 — как в замере (на пустом штате денег не двигает)
    await pp.evaluate(() => window.itd.pause())
    await pp.waitForFunction(() => window.itd.state().speed === 0, { timeout: 5000 })
    await pp.evaluate(() => window.itd.set({ tickInDay: 0 }))
    await pp.waitForFunction(() => window.itd.state().tickInDay === 0, { timeout: 5000 })
    const p1 = await pp.evaluate(async () => {
      const t0 = performance.now()
      const rows = await window.itd.play([
        { cmd: 'set_speed', extra: { speed: 0 } }, { cmd: 'hire' }, { cmd: 'hire' }, { days: 1 },
        { cmd: 'buy_pc' }, { cmd: 'hire' }, { days: 1 },
      ])
      return { rows, ms: Math.round(performance.now() - t0), bad: await window.itd.play([{ nope: 1 }]) }
    })
    const cells = p1.rows.map((r) => r.split(' | '))
    const bals = cells.map((c) => (c[3] ?? '').split('>').map(Number))
    check(
      'P1: itd.play — 7 строк, вердикты ok/ok/FAIL no_free_pc/ok/ok/FAIL not_enough_money/ok, балансы 600>300>614>39>353, «до» = «после» прошлого',
      p1.rows.length === 7 && cells.every((c) => c.length === 7) &&
        cells.map((c) => c[1]).join() === 'ok,ok,FAIL no_free_pc,ok,ok,FAIL not_enough_money,ok' &&
        cells.map((c) => c[0]).join() === 'set_speed 0,hire,hire,days1,buy_pc,hire,days1' &&
        bals.map((b) => b[1]).join() === '600,300,300,614,39,39,353' &&
        bals.every((b, i) => i === 0 || b[0] === bals[i - 1][1]) &&
        cells[3][2] === 'd2 t0' && cells[6][2] === 'd3 t0' && cells[1][4] === 'staff 0>1' && cells[2][4] === 'staff 1>1' &&
        cells.every((c) => c[6] === 'running') && /^FAIL bad_step/.test(p1.bad[0]?.split(' | ')[1] ?? ''),
      JSON.stringify(p1),
    )
    const p2 = await pp.evaluate(async () => ({
      l1: await window.itd.ledger(1), l2: await window.itd.ledger(2), cur: await window.itd.ledger(),
      bal: window.itd.state().balance,
      miss: await window.itd.ledger(99).then(() => 'resolved', (e) => String(e.message)),
      zero: await window.itd.ledger(0).then(() => 'resolved', (e) => String(e.message)),
    }))
    const sumOf = (l) => l.balanceStart + l.income + l.eventMoney - l.purchasesTotal - l.payroll - l.gatewayOpex - l.interest + l.adjust
    const { l1, l2, cur } = p2
    check(
      'P2: itd.ledger — дни 1, 2 закрыты и сведены (hire $300 / buy_pc $575), profit = delta + покупки, старт = вчерашний конец; текущий день 3 открыт; ledger(99) — список дней',
      [l1, l2, cur].every((l) => l.balanced === true && sumOf(l) === l.balanceEnd && l.delta === l.balanceEnd - l.balanceStart && l.adjust === 0) &&
        l1.day === 1 && l1.closed && l1.offline && l1.balanceStart === 600 && l1.balanceEnd === 614 &&
        l1.purchases.length === 1 && l1.purchases[0].type === 'hire' && l1.purchases[0].price === 300 &&
        l1.profit === l1.delta + l1.purchasesTotal && l1.payroll > 0 &&
        l2.day === 2 && l2.closed && l2.balanceStart === 614 && l2.balanceEnd === 353 &&
        l2.purchases.length === 1 && l2.purchases[0].type === 'buy_pc' && l2.purchases[0].price === 575 &&
        cur.day === 3 && !cur.closed && cur.payroll === 0 && cur.balanceStart === 353 && cur.balanceEnd === p2.bal &&
        cur.history.join() === '1,2,3' && p2.miss.includes('нет книги дня 99: есть [1 2 3]') && p2.zero.startsWith('ledger: day'),
      JSON.stringify(p2),
    )
    const p3 = await pp.evaluate(async () => {
      await window.itd.set({ money: 1000 })
      return window.itd.ledger()
    })
    check('P3: itd.set({money: 1000}) — adjust 647, книга сведена', p3.adjust === 1000 - 353 && p3.balanced && p3.balanceEnd === 1000, JSON.stringify(p3))
    await pp.close()

    // ── K1–K4 (ITGAME-87/88): своя вкладка и песочница
    const pk = await browser.newPage()
    pk.on('pageerror', (e) => pageErrors.push(String(e)))
    await pk.setViewport({ width: 1920, height: 1080 })
    await pk.goto(`${BASE}/?scenario=broken_pc&seed=1&debug=1`, { waitUntil: 'domcontentloaded' })
    await waitMenuReady(pk)
    // K3 — заливки в меню (маркер фокуса — треугольник, плашки — прямоугольники)
    const k3 = await pk.evaluate(() => {
      const nodes = window.itd.nodes()
      const tri = nodes.find((n) => n.scene === 'menu' && n.type === 'Triangle')
      const plate = nodes.find((n) => n.id === 'menu.diff.normal')
      const text = nodes.find((n) => n.scene === 'menu' && n.type === 'Text')
      const menu = window.__itd.scene.getScene('menu')
      const hex = (c) => '#' + c.toString(16).padStart(6, '0')
      return { tri: tri?.fill, triReal: hex(menu.focusMarker.fillColor), plate: plate?.fill, text: text ? text.fill : 'нет текста', shapes: nodes.filter((n) => n.fill !== null).length }
    })
    check(
      'K3: nodes().fill — маркер меню и плашка «#rrggbb» (= fillColor), у Text null',
      /^#[0-9a-f]{6}$/.test(k3.tri ?? '') && k3.tri === k3.triReal && k3.plate === '#232640' && k3.text === null && k3.shapes > 3,
      JSON.stringify(k3),
    )
    // K4 — menuReady не раньше перестройки меню: песочница и выход из неё перезапускают меню
    await pk.evaluate(() => localStorage.setItem('itd.sid', 'qa88-ghost-' + Date.now()))
    await pk.evaluate(() => window.itd.sandbox('qa88'))
    await pk.waitForFunction(() => window.itd.state().menuReady === true, { timeout: 20000 })
    const k4 = await pk.evaluate(async () => {
      const r = window.itd.sandbox.restore()
      const right = window.itd.state().menuReady
      await window.itd.wait((s) => s.menuReady, 8000)
      const cy = () => window.itd.nodes().find((n) => n.id === 'menu.diff.normal')?.cy
      const a = cy()
      await new Promise((res) => setTimeout(res, 1500))
      return { restored: r.restored, right, a, b: cy() }
    })
    check(
      'K4: сразу после sandbox.restore() menuReady false (перезапуск меню в очереди); после wait плашка не сдвигается 1,5 с',
      k4.right === false && typeof k4.a === 'number' && k4.a === k4.b,
      JSON.stringify(k4),
    )
    await pk.evaluate(() => localStorage.removeItem('itd.sid'))
    await pk.evaluate(() => window.itd.sandbox('qa87'))
    await pk.waitForFunction(() => window.itd.state().menuReady === true, { timeout: 20000 })
    await pk.evaluate(() => window.itd.click('menu.diff.normal'))
    await pk.waitForFunction(() => window.itd.state().scenario === 'broken_pc' && window.itd.state().phase === 'running', { timeout: 20000 })
    await pk.evaluate(() => window.itd.pause())
    await pk.waitForFunction(() => window.itd.ids().some((n) => n.id === 'office.worker.1' || n.id === 'office.slot.1'), { timeout: 10000 })
    // K1 — текст тултипа офиса в скрытом контейнере
    const k1 = await pk.evaluate(() => {
      const itd = window.itd
      const office = window.__itd.scene.getScene('office')
      // с ITGAME-90 тултип и уход курсора — у зоны места office.slot.N, до неё — у спрайта сотрудника
      const zone = itd.ids().some((n) => n.id === 'office.slot.1') ? 'office.slot.1' : 'office.worker.1'
      itd.hover(zone)
      const label = office.tooltipText.text
      const find = () => itd.text().find((n) => n.scene === 'office' && n.text === label)
      const shown = find()
      // настоящий уход курсора — обработчик pointerout сотрудника
      const walk = (list) => { for (const o of list) { if (o.getData?.('id') === zone) return o; if (o.list) { const f = walk(o.list); if (f) return f } } return null }
      walk(office.children.list).emit('pointerout')
      const hidden = find()
      return {
        label: label.split('\n')[0], shown: shown?.visible, hidden: hidden?.visible, kept: !!hidden,
        container: office.tooltip.visible, child: office.tooltipText.visible,
      }
    })
    check(
      'K1: тултип показан — visible true; контейнер скрыт (pointerout) — тот же текст visible false, хотя у самого Text visible true',
      k1.shown === true && k1.hidden === false && k1.kept && k1.container === false && k1.child === true,
      JSON.stringify(k1),
    )
    // N1 (ITGAME-117) — тексты и плашка внутри контейнера видны text-text/occlusion в overlaps()
    const n117 = await pk.evaluate(() => {
      const office = window.__itd.scene.getScene('office')
      const mk = (o, id) => { o.setData('id', id); return o }
      const st = { fontSize: '16px', color: '#ffffff' }
      const top = mk(office.add.text(40, 640, 'ZZZZZZZZZZ', st).setDepth(5), 'qa117.top')
      const in1 = mk(office.add.text(0, 0, 'AAAAAAAAAA', st), 'qa117.in1')
      const in2 = mk(office.add.text(2, 2, 'BBBBBBBBBB', st), 'qa117.in2')
      const cover = mk(office.add.rectangle(0, 0, 200, 60, 0x123456, 1).setOrigin(0, 0), 'qa117.cover')
      const box = office.add.container(40, 640, [in1, in2, cover]).setDepth(5)
      const mine = () => window.itd.overlaps().filter((e) => `${e.a}${e.b}`.includes('qa117.'))
      const pair = (list, kind, x, y) => list.some((e) => e.kind === kind && [e.a, e.b].sort().join() === [x, y].sort().join())
      const shown = mine()
      box.setVisible(false)
      const hidden = mine()
      const nested = office.children.list.includes(in1)
      for (const o of [top, box]) o.destroy()
      return {
        nested, hiddenCount: hidden.length,
        textInIn: pair(shown, 'text', 'qa117.in1', 'qa117.in2'),
        textInTop: pair(shown, 'text', 'qa117.in1', 'qa117.top'),
        occl: pair(shown, 'occlusion', 'qa117.in1', 'qa117.cover'),
        left: mine().length,
        shown: shown.map((e) => `${e.kind}:${e.a}|${e.b}`),
      }
    })
    check(
      'N1: текст в контейнере: text-text с соседом по контейнеру и с текстом верхнего уровня, occlusion плашкой контейнера; скрытый контейнер — 0 записей',
      n117.nested === false && n117.textInIn && n117.textInTop && n117.occl && n117.hiddenCount === 0 && n117.left === 0,
      JSON.stringify(n117),
    )
    // K2 — «ТУПИК»: затемнение финала не находка overlaps()
    await pk.evaluate(async () => {
      await window.itd.scenario('soft_lock')
      await window.itd.set({ tickInDay: 53 })
      window.itd.speed(3)
    })
    await pk.waitForFunction(() => window.itd.state().phase === 'game_over', { timeout: 30000 })
    await delay(500)
    const k2 = await pk.evaluate(() => {
      const dimOf = (e) => e.b === 'Rectangle(1280x720)' || e.a === 'Rectangle(1280x720)'
      const now = window.itd.overlaps()
      const hud = window.__itd.scene.getScene('hud')
      const dims = hud.children.list.filter((o) => o.getData?.('dim') === true)
      dims.forEach((o) => o.setData('dim', false))
      const unmarked = window.itd.overlaps()
      dims.forEach((o) => o.setData('dim', true))
      const back = window.itd.overlaps()
      return {
        title: window.itd.screen().meta.title, dims: dims.length,
        dim: now.filter(dimOf).length, all: now.length, unmarked: unmarked.filter(dimOf).length, back: back.filter(dimOf).length,
      }
    })
    check(
      'K2: «ТУПИК» — overlaps() без записей от затемнения (метка dim); без метки их было бы > 0, вернули — 0',
      k2.title === 'ТУПИК' && k2.dims === 1 && k2.dim === 0 && k2.unmarked > 0 && k2.back === 0,
      JSON.stringify(k2),
    )
    await pk.evaluate(() => window.itd.sandbox.restore?.())
    await pk.close()

    // ── Z1/Z2 (ITGAME-61): сохранённый 2× из старой версии — отдельная вкладка, окно как у владельца
    const pz = await browser.newPage()
    pz.on('pageerror', (e) => pageErrors.push(String(e)))
    await pz.setViewport({ width: 1237, height: 700 })
    await pz.goto(`${BASE}/?debug=1`, { waitUntil: 'domcontentloaded' })
    await waitMenuReady(pz)
    await pz.evaluate(() => localStorage.setItem('itd.uiScale', '2'))
    await pz.reload({ waitUntil: 'domcontentloaded' })
    await waitMenuReady(pz)
    const zoomZ1 = byPrefix(await ids(pz), 'menu.zoom.')
    const keyZ1 = await pz.evaluate(() => localStorage.getItem('itd.uiScale'))
    check(
      'Z1: сохранённый 2× → menu.zoom.1/1.4/fit, active fit, ключ переписан в fit',
      zoomZ1.map((n) => n.id).join() === 'menu.zoom.1,menu.zoom.1.4,menu.zoom.fit' &&
        zoomZ1.filter((n) => n.active === true).map((n) => n.id).join() === 'menu.zoom.fit' && keyZ1 === 'fit',
      `${JSON.stringify(zoomZ1)} key=${keyZ1}`,
    )
    const scrollZ2 = await pz.evaluate(() => {
      const a = document.getElementById('app')
      return { sw: a.scrollWidth, cw: a.clientWidth }
    })
    check('Z2: окно 1237×700, «по окну» — у #app нет горизонтального скролла', scrollZ2.sw <= scrollZ2.cw, JSON.stringify(scrollZ2))
    // Z3: канвас шире окна → одна запись scene 'page' и настоящий скролл #app; «по окну» — записи нет
    await pz.evaluate(() => window.itd.click('menu.zoom.1.4'))
    await delay(150)
    const pageZ3 = (await pz.evaluate(() => window.itd.offscreen())).filter((e) => e.scene === 'page')
    const scrollZ3 = await pz.evaluate(() => {
      const a = document.getElementById('app')
      return { sw: a.scrollWidth, cw: a.clientWidth }
    })
    check(
      'Z3: 1237×700, 1.4× → одна запись page/canvas, out.right>0, out.left 0, #app скроллится',
      pageZ3.length === 1 && pageZ3[0].type === 'canvas' && pageZ3[0].out.right > 0 && pageZ3[0].out.left === 0 &&
        scrollZ3.sw > scrollZ3.cw,
      `${JSON.stringify(pageZ3)} scroll=${JSON.stringify(scrollZ3)}`,
    )
    await pz.evaluate(() => window.itd.click('menu.zoom.fit'))
    await delay(150)
    const pageZ3fit = (await pz.evaluate(() => window.itd.offscreen())).filter((e) => e.scene === 'page')
    check('Z3: «по окну» — записи page нет', pageZ3fit.length === 0, JSON.stringify(pageZ3fit))
    await pz.close()

    // ── Z5 (ITGAME-67): хранилище бросает на ключе масштаба — загрузка не падает, выбор живёт во вкладке.
    // Бросаем только на itd.uiScale; полный запрет хранилища — L1–L6 ниже (ITGAME-80).
    const pb = await browser.newPage()
    pb.on('pageerror', (e) => pageErrors.push(`Z5: ${e}`))
    await pb.evaluateOnNewDocument(() => {
      const get = Storage.prototype.getItem, set = Storage.prototype.setItem
      Storage.prototype.getItem = function (k) {
        if (k === 'itd.uiScale') throw new DOMException('blocked', 'SecurityError')
        return get.call(this, k)
      }
      Storage.prototype.setItem = function (k, v) {
        if (k === 'itd.uiScale') throw new DOMException('blocked', 'QuotaExceededError')
        return set.call(this, k, v)
      }
    })
    await pb.goto(`${BASE}/?debug=1`, { waitUntil: 'domcontentloaded' })
    const readyZ5 = await waitMenuReady(pb).then(() => true, () => false)
    const zoomZ5 = readyZ5 ? oneOf(byPrefix(await ids(pb), 'menu.zoom.'))?.id : null
    if (readyZ5) await pb.evaluate(() => window.itd.click('menu.zoom.1'))
    await delay(150)
    const afterZ5 = readyZ5
      ? await pb.evaluate(() => ({
          active: window.itd.ids().find((n) => n.id.startsWith('menu.zoom.') && n.active === true)?.id,
          cssW: Math.round(document.querySelector('#app canvas').getBoundingClientRect().width),
        }))
      : null
    check(
      'Z5: itd.uiScale бросает → меню грузится, active 1.4; menu.zoom.1 → active 1, канвас 1280 CSS px',
      readyZ5 && zoomZ5 === 'menu.zoom.1.4' && afterZ5?.active === 'menu.zoom.1' && afterZ5?.cssW === 1280,
      JSON.stringify({ readyZ5, zoomZ5, afterZ5 }),
    )
    await pb.close()

    // ── L1–L6 (ITGAME-80): хранилище закрыто целиком, как Chrome с запретом данных сайта — геттеры
    // window.localStorage/sessionStorage и методы Storage.prototype бросают SecurityError (evaluateOnNewDocument
    // переживает reload). Скрипт в этих вкладках к хранилищу не ходит — только проба L1a, которая ждёт исключения.
    const blockStorage = () => {
      let denied = 0
      const deny = (what) => function () {
        denied++
        throw new DOMException(`${what}: storage blocked (qa ITGAME-80)`, 'SecurityError')
      }
      Object.defineProperty(window, '__qaDenied', { get: () => denied })
      for (const name of ['localStorage', 'sessionStorage']) {
        Object.defineProperty(window, name, { configurable: true, get: deny(name) })
      }
      for (const m of ['getItem', 'setItem', 'removeItem', 'key', 'clear']) Storage.prototype[m] = deny(`Storage.${m}`)
    }
    const errsL = []
    const pl = await browser.newPage()
    pl.on('pageerror', (e) => { errsL.push(`L: ${e}`); pageErrors.push(`L: ${e}`) })
    await pl.setViewport({ width: 1920, height: 1080 })
    await pl.evaluateOnNewDocument(blockStorage)
    await pl.goto(`${BASE}/?scenario=fresh&seed=1&debug=1`, { waitUntil: 'domcontentloaded' })
    const readyL = await waitMenuReady(pl).then(() => true, () => false)
    const l1a = await pl.evaluate(() => {
      const denied = window.__qaDenied
      const probe = {}
      for (const n of ['localStorage', 'sessionStorage']) {
        try { void window[n]; probe[n] = 'open' } catch (e) { probe[n] = e.name }
      }
      // методы тоже закрыты: вызов с чужим this — запрет бросает раньше, чем смотрит на хранилище
      const methods = {}
      for (const m of ['getItem', 'setItem', 'removeItem', 'key', 'clear']) {
        try { Storage.prototype[m].call({}, 'x', 'y'); methods[m] = 'open' } catch (e) { methods[m] = e.name }
      }
      return { denied, probe, methods }
    })
    check(
      'L1a: хранилище закрыто — оба геттера и методы Storage.prototype бросают SecurityError, клиент в запрет упирался (denied > 0)',
      l1a.probe.localStorage === 'SecurityError' && l1a.probe.sessionStorage === 'SecurityError' &&
        Object.values(l1a.methods).every((v) => v === 'SecurityError') && l1a.denied > 0,
      JSON.stringify(l1a),
    )
    const l1b = readyL
      ? await pl.evaluate(async () => {
          await window.itd.wait((s) => s.menuReady, 10000).catch(() => null)
          return { menuReady: window.itd.state().menuReady, cont: window.itd.ids().some((n) => n.id === 'menu.continue') }
        })
      : null
    check('L1b: закрытое хранилище — меню грузится, «Продолжить» нет', readyL && l1b?.menuReady === true && l1b.cont === false, JSON.stringify({ readyL, l1b }))

    const lb2 = l1b?.menuReady
      ? await pl.evaluate(async () => {
          window.itd.click('menu.diff.normal')
          const up = await window.itd.wait((s) => s.connected === true && s.day === 1, 15000).then(() => true, () => false)
          if (!up) return { up }
          const sid = window.itd.server().sid
          const hudBal = window.itd.screen().meta.hudBal
          const receipt = await window.itd.cmd('hire')
          const staff = await window.itd.wait((s) => s.staff === 1, 5000).then((s) => s.staff, () => null)
          const t0 = window.itd.state().tickInDay
          await window.itd.wait((s) => s.tickInDay >= t0 + 3, 10000).catch(() => null)
          // ITGAME-83: тост достижения помечен спрайтом icon_trophy (поле icon), а не эмодзи 🏆 в тексте
          const trophies = window.itd.log(200).filter((e) => e.type === 'toast' && e.icon === 'icon_trophy').map((e) => e.text)
          const hud = window.__itd.scene.getScene('hud')
          const toastIcons = hud.children.list.filter((o) => o.texture?.key === 'icon_trophy').map((o) => Math.round(o.displayWidth))
          return { up, sid, hudBal, receipt, staff, ticks: window.itd.state().tickInDay - t0, trophies, toastIcons }
        })
      : null
    check(
      'L2: партия стартует, hudBal нарисован, hire ok; «Первые кадры» — один тост за 3+ тика, тосты достижений не повторяются',
      lb2?.up === true && typeof lb2?.sid === 'string' && /^\$[\d,]+$/.test(lb2.hudBal ?? '') && lb2.receipt?.ok === true &&
        lb2.staff === 1 && lb2.ticks >= 3 && lb2.trophies.filter((t) => t.includes('Первые кадры')).length === 1 &&
        new Set(lb2.trophies).size === lb2.trophies.length && lb2.toastIcons.includes(24),
      JSON.stringify(lb2),
    )

    // L2b (ITGAME-83): строка достижения в итогах (победа, поражение, «Пока вас не было») —
    // отдельный Text под блоком с кубком 16px слева; пара центрирована по прежнему y.
    const l2b = lb2?.up
      ? await pl.evaluate(async () => {
          const hud = window.__itd.scene.getScene('hud')
          const style = { fontFamily: 'monospace', fontSize: '15px', color: '#f4f4f4', lineSpacing: 6, align: 'center' }
          const [body, ach] = hud.bodyWithTrophy(290, ['Строка 1', 'Строка 2'], 'Новое достижение: X', style, 61)
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))) // иконка встаёт на prerender
          const icon = hud.children.list.find((o) => o.texture?.key === 'icon_trophy' && Math.round(o.displayWidth) === 16)
          const ab = ach.getBounds()
          const out = {
            n: [body, ach].length,
            stacked: Math.abs(ach.y - (body.y + body.height + 6)) <= 1,
            centred: Math.abs((body.y + ach.y + ach.height) / 2 - 290) <= 1,
            iconLeft: !!icon && icon.x > ab.x && icon.x < ab.x + 16 + 1 && Math.abs(icon.y - ab.centerY) <= 2,
          }
          body.destroy()
          ach.destroy()
          out.iconGone = !hud.children.list.includes(icon)
          return out
        })
      : null
    check('L2b: итоги — строка достижения своим Text под блоком, кубок 16px слева по центру строки, уходит вместе с ней',
      l2b?.n === 2 && l2b.stacked && l2b.centred && l2b.iconLeft && l2b.iconGone, JSON.stringify(l2b))

    // Пауза отчёта (ITGAME-18) — sessionStorage-ключ itd.speedBeforeReport: при закрытом хранилище он живёт в памяти
    // вкладки. Пауза до tickInDay 53 — чтобы день не кончился на старой скорости раньше speed(3).
    const l3 = lb2?.staff === 1
      ? await pl.evaluate(async () => {
          const hud = window.__itd.scene.getScene('hud')
          window.itd.pause()
          await window.itd.wait((s) => s.speed === 0, 5000).catch(() => null)
          await window.itd.set({ money: 5000 })
          await window.itd.set({ tickInDay: 53 })
          window.itd.speed(3)
          const report = await window.itd.wait((s) => s.phase === 'day_report' && s.speed === 0, 15000).then(() => true, () => false)
          const onReport = { sbr: hud.speedBeforeReport, next: window.itd.ids().some((n) => n.id === 'btn.next_day') }
          const click = report ? window.itd.click('btn.next_day') : null
          const back = report
            ? await window.itd.wait((s) => s.day === 2 && s.phase === 'running' && s.speed === 3, 10000).then(() => true, () => false)
            : false
          return { report, onReport, click: click?.ok ?? null, back, after: hud.speedBeforeReport, day: window.itd.state().day, speed: window.itd.state().speed }
        })
      : null
    check(
      'L3: пауза отчёта в памяти вкладки — на отчёте speedBeforeReport 3, btn.next_day → день 2 на 3×, ключ снят',
      l3?.report === true && l3.onReport.sbr === 3 && l3.onReport.next === true && l3.click === true && l3.back === true && l3.after === null,
      JSON.stringify(l3),
    )

    await pl.close()

    // L6: прод без ?debug=1 — window.itd нет (installAgentApi читал itd.debug из хранилища и падал на старте),
    // наблюдение через window.__itd, партия — настоящей клавишей 2 (MenuScene: 1-4 = сложность).
    const pn = await browser.newPage()
    pn.on('pageerror', (e) => { errsL.push(`L6: ${e}`); pageErrors.push(`L6: ${e}`) })
    await pn.setViewport({ width: 1920, height: 1080 })
    await pn.evaluateOnNewDocument(blockStorage)
    await pn.goto(`${BASE}/?scenario=fresh&seed=1`, { waitUntil: 'domcontentloaded' })
    const menuN = await pn.waitForFunction(() => window.__itd?.scene.isActive('menu') === true, { timeout: 20000 }).then(() => true, () => false)
    const n0 = menuN
      ? await pn.evaluate(() => ({ itd: typeof window.itd, hadSave: window.__itd.scene.getScene('menu').hadSave }))
      : null
    if (menuN) {
      await pn.bringToFront()
      await pn.keyboard.press('2')
    }
    const upN = menuN
      ? await pn
          .waitForFunction(
            () => window.__itd.scene.isActive('office') && window.__itd.scene.isActive('hud') &&
              /^-?\$[\d,]+$/.test(window.__itd.scene.getScene('hud').moneyText?.text ?? ''),
            { timeout: 20000 },
          )
          .then(() => true, () => false)
      : false
    await delay(1500)
    const n1 = upN
      ? await pn.evaluate(() => { const hud = window.__itd.scene.getScene('hud'); return { money: hud.moneyText.text, day: hud.dayText.text } })
      : null
    check(
      'L6: без ?debug=1 — window.itd нет, меню без сейва, клавиша 2 → office+hud, HUD рисует деньги и «День 1 · ЧЧ:ММ»',
      menuN && n0?.itd === 'undefined' && n0.hadSave === false && upN && /^День 1 · \d\d:\d\d/.test(n1?.day ?? ''),
      JSON.stringify({ menuN, n0, upN, n1 }),
    )
    await pn.close()
    check('L: закрытое хранилище — нет pageerror (обе вкладки)', errsL.length === 0, errsL.join(' | '))

    // ── нет ошибок на странице за весь прогон
    check('на странице нет pageerror', pageErrors.length === 0, pageErrors.join(' | '))
  } finally {
    if (browser) await browser.close()
    if (stopServer) await stopServer()
  }
}

await run()

const failed = results.filter((r) => !r.pass)
console.log(`\nИтог QA-ITGAME38: ${results.length - failed.length}/${results.length} проверок прошло`)
if (failed.length > 0) {
  console.error(`Провалено: ${failed.map((f) => f.name).join(', ')}`)
  process.exit(1)
} else {
  console.log('Все проверки пройдены успешно!')
}
