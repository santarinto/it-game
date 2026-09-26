// qa-itgame38 — фасад window.itd (ITGAME-38):
//   A1  menu.zoom.* — ровно один active===true; menu.diff.*/menu.stats — active===null
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
//   C4  сдвиг menu.zoom.1 на соседа → находка {kind:'interactive'} с ним
//   + на странице нет pageerror
//
// Отклонения от буквального сценария в трекере (см. отчёт агента):
//  - B1→B2 деньги поднимаются обратно set({money:5000}): $100 при 0 сотрудниках
//    меньше MinCostToEarn (наём $300) — конец дня уходит в deadlock/game_over,
//    а не в day_report, который проверяют B2/C2.
//  - C3 сдвигает btn.next_day не на "+5px от верха текста", а на нижнюю кромку
//    (body.y + body.height - 10): при случайном событии дня строка «События: …»
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
    check(
      'A1: menu.diff.* active===null',
      diffA1.length > 0 && diffA1.every((n) => n.active === null),
      JSON.stringify(diffA1),
    )
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
      await page.evaluate((x) => {
        const scene = window.__itd.scene.getScene('menu')
        const a = scene.children.list.find((o) => o.getData && o.getData('id') === 'menu.zoom.1')
        a.x = x
      }, moveC4.origX)
    }

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
    await page.evaluate(() => window.itd.click('nav.office0'))
    await delay(300)

    // ── A5: обычная кнопка покупки — не переключатель
    const pcIds = await page.evaluate(() => window.itd.ids().filter((n) => n.id === 'btn.pc'))
    check('A5: btn.pc.active===null', pcIds[0]?.active === null, JSON.stringify(pcIds))

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
      lastSoundB1?.key === 'sfx:error' && lastSoundB1?.scene === 'hud' && lastSoundB1?.ok === true,
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

    // ── нет ошибок на странице за весь прогон
    check('на странице нет pageerror', pageErrors.length === 0, pageErrors.join(' | '))
  } finally {
    await browser.close()
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
