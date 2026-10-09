// qa-itgame38 — фасад window.itd (ITGAME-38):
//   A1  menu.zoom.* — ровно один active===true; menu.diff.* — фокус (ITGAME-19): без сейва
//       active только у НОРМА, ↓ переносит его на СЛОЖНО; menu.stats — active===null
//   A2  клик menu.zoom.1 → только он active; зум возвращается на место
//   A3  itd.speed(2) → btn.speed.2 active (остальные — нет); itd.pause() → btn.speed.0 active
//   A4  click('nav.serverRoom') → он active, nav.office0 — нет; комната возвращается на место
//   A5  btn.pc.active === null (обычная кнопка покупки — не переключатель)
//   B1  set({money:100}), клик по отключённому btn.pc → sound {key:'sfx:error', scene:'hud', ok:true}
//   B2  itd.skipReports=1, set({tickInDay:53}), speed(3) → смена дня без модалки:
//       sound key bong/drop по знаку прибыли (out of log's day_report), toast {where:'top', bg по прибыли}
//   C1  itd.overlaps(): kind — только text|occlusion|interactive; interactive-записей в обычной игре нет
//   C2  без skipReports: та же промотка дня → модалка отчёта без interactive-находок;
//       btn.skip_reports active меняется false→true по клику, localStorage синхронизирован
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
//   A6  btn.debug active: true → false → true по кликам
//   A7  рестарт партии без перезагрузки: speed/nav active живые, нет pageerror (D2)
//   D1  mid_day10 на паузе, itd.step до 12:00/14:00/17:00 → hud.dayProfit одинаков (±$50), > 0
//       и равен day_report.profit дня 10 (последний тик — живой, ради настоящего отчёта)
//   D3  mid_day10 (день 10, тик 12) на паузе, itd.step({ticks: 60}) — 60 тиков за ОДИН вызов:
//       .advance.ticks 60, .advance.days 1, день 11 тик 18 (ITGAME-56; ms-форма — D1)
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
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'
import { selfServe } from './lib/selfserve.mjs'

const CLIENT_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const SELF_PORT = Number(process.env.QA_PORT) || 4175
const HINT_IDS = ['master', 'router', 'core', 'server', 'cooler', 'fridge', 'motivate', 'softlock']
const VALID_OVERLAP_KINDS = new Set(['text', 'occlusion', 'interactive'])

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

// ── Утилиты чтения сцены ────────────────────────────────────────────────
const ids = (page) => page.evaluate(() => window.itd.ids())
const byPrefix = (list, prefix) => list.filter((n) => n.id.startsWith(prefix))
const oneOf = (list) => list.find((n) => n.active === true)

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
    await page.evaluate(() => window.itd.pause())
    await page.waitForFunction(() => window.itd.state().speed === 0, { timeout: 5000 })
    await delay(150)
    const speedIdsPause = byPrefix(await ids(page), 'btn.speed.')
    check(
      'A3: pause() → btn.speed.0 active',
      speedIdsPause.find((n) => n.id === 'btn.speed.0')?.active === true,
      JSON.stringify(speedIdsPause),
    )

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
    await page.evaluate(() => window.itd.click('nav.office0'))
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
      'B1: последняя sound-запись — sfx:error/hud/ok',
      lastSoundB1?.key === 'sfx:error' && lastSoundB1?.scene === 'hud' && lastSoundB1?.ok === true &&
        lastSoundB1?.name === 'error' && typeof lastSoundB1?.volume === 'number' &&
        lastSoundB1.volume > 0 && lastSoundB1.volume <= 1,
      JSON.stringify(lastSoundB1),
    )

    // Деньги обратно: $100 при 0 сотрудниках < MinCostToEarn ($300 найм) —
    // конец дня ушёл бы в deadlock/game_over, а не в day_report (см. шапку).
    await page.evaluate(() => window.itd.set({ money: 5000 }))

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
