// qa-itgame152 — itd.ask (ITGAME-152): опрос добивки человеком в странице
//   1  itd.ask(items): явный dock bottom → where bottom; dock auto на 1920×1080 → overlay (под холстом 27px < 220px)
//   2  выбор вариантов (check / value), ввод комментария → state().answers обновляется
//   3  сворачивание / разворачивание формы через кнопку #itd-ask-toggle
//   4  dock auto: геометрия окна меняет where (bottom при высоте 1400, right при ширине 2400, overlay при 800×600)
//   5  F5 (перезагрузка): форма и введённые ответы восстанавливаются из sessionStorage
//   6  интеграция с itd.claim: клики внутри #itd-ask не вызывают foreign и вспышку claim
//   7  кнопка «Отправить агенту» → itd.ask.result() со всеми метаданными (sha, iw, dpr, answers с target и hit)
//   8  await itd.ask.wait() резолвится результатом опроса
//   9  itd.ask.close() убирает форму и очищает sessionStorage
//   10 отказы bad_args на невалидных аргументах
//   + на странице нет pageerror
import puppeteer from 'puppeteer-core'
import { chromePath } from './lib/chrome.mjs'
import { selfServe } from './lib/selfserve.mjs'
import { waitMenuReady } from './lib/menu.mjs'

const SELF_PORT = Number(process.env.QA_PORT) || 4199
const BASE = process.env.QA_BASE || `http://127.0.0.1:${SELF_PORT}`

const results = []
function check(name, pass, fact) {
  results.push({ name, pass, fact })
  console.log(`${pass ? 'PASS' : 'FAIL'}: ${name}${fact ? ` — ${fact}` : ''}`)
}

async function run() {
  let stopServer = null
  if (!process.env.QA_BASE) {
    try {
      ;({ stop: stopServer } = await selfServe({ port: SELF_PORT, saves: 'off', label: 'QA-ITGAME152' }))
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e))
      process.exit(1)
    }
  }

  const pageErrors = []
  let browser = null

  try {
    browser = await puppeteer.launch({
      executablePath: chromePath(),
      headless: true,
      args: ['--no-sandbox', '--disable-gpu', '--window-size=1920,1080'],
    })

    const page = await browser.newPage()
    page.on('pageerror', (err) => pageErrors.push(String(err)))

    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 })
    await page.goto(`${BASE}/?debug=1`, { waitUntil: 'domcontentloaded' })
    await waitMenuReady(page)

    // 1: itd.ask(items) создаёт форму; проверка явного dock bottom и auto
    const res1 = await page.evaluate(() => {
      const askBottom = window.itd.ask([
        { n: 1, text: 'Шрифт меню читается?', kind: 'check' },
        { n: 2, text: 'Выбери сложность', kind: 'value', choices: ['норма', 'хардкор'] },
      ], { dock: 'bottom' })

      const el = document.getElementById('itd-ask')
      const st = window.itd.ask.state()
      const res = window.itd.ask.result()
      return {
        askBottom,
        hasEl: !!el,
        where: el?.dataset.where,
        active: st.active,
        res,
      }
    })
    check(
      '1: itd.ask(items, {dock:"bottom"}) → #itd-ask: position fixed, dock bottom, result null, active true',
      res1.askBottom.ok === true && res1.askBottom.where === 'bottom' && res1.hasEl && res1.active && res1.res === null,
      JSON.stringify(res1),
    )

    // 2: выбор вариантов и комментарий
    const res2 = await page.evaluate(() => {
      // Кликаем по кнопке «корректно» пункта 1
      const q1 = document.querySelector('#itd-ask [data-n="1"]')
      const btnOk = Array.from(q1.querySelectorAll('button')).find((b) => b.textContent === 'корректно')
      btnOk?.click()

      // Вводим комментарий в пункт 1
      const input1 = q1.querySelector('input')
      if (input1) {
        input1.value = 'Шрифт четкий'
        input1.dispatchEvent(new Event('input'))
      }

      // Кликаем «хардкор» в пункте 2
      const q2 = document.querySelector('#itd-ask [data-n="2"]')
      const btnHard = Array.from(q2.querySelectorAll('button')).find((b) => b.textContent === 'хардкор')
      btnHard?.click()

      return window.itd.ask.state().answers
    })
    check(
      '2: выбор вариантов (check/value), ввод комментария → state().answers обновляется',
      res2[1]?.status === 'корректно' && res2[1]?.comment === 'Шрифт четкий' && res2[2]?.status === 'хардкор',
      JSON.stringify(res2),
    )

    // 3: сворачивание / разворачивание
    const res3 = await page.evaluate(() => {
      const toggle = document.getElementById('itd-ask-toggle')
      toggle?.click()
      const stCollapsed = window.itd.ask.state().collapsed
      const hCollapsed = document.getElementById('itd-ask')?.getBoundingClientRect().height
      toggle?.click()
      const stExpanded = window.itd.ask.state().collapsed
      const hExpanded = document.getElementById('itd-ask')?.getBoundingClientRect().height
      return { stCollapsed, hCollapsed, stExpanded, hExpanded }
    })
    check(
      '3: сворачивание / разворачивание формы через #itd-ask-toggle',
      res3.stCollapsed === true && res3.stExpanded === false && res3.hCollapsed < res3.hExpanded,
      JSON.stringify(res3),
    )

    // 4: dock auto: смена размеров окна
    await page.evaluate(() => window.itd.ask([
      { n: 1, text: 'Шрифт меню читается?', kind: 'check' },
    ], { dock: 'auto' }))

    // Высота 1400: под холстом > 220px -> bottom
    await page.setViewport({ width: 1920, height: 1400 })
    const res4Bottom = await page.evaluate(() => document.getElementById('itd-ask')?.dataset.where)

    // Ширина 2600 при высоте 1080: центрированный холст 1920 оставляет по бокам (2600-1920)/2 = 340px >= 320px -> right
    await page.setViewport({ width: 2600, height: 1080 })
    const res4Right = await page.evaluate(() => document.getElementById('itd-ask')?.dataset.where)

    // Окно 800x600 -> overlay
    await page.setViewport({ width: 800, height: 600 })
    const res4Overlay = await page.evaluate(() => document.getElementById('itd-ask')?.dataset.where)

    // Возвращаем 1920x1080
    await page.setViewport({ width: 1920, height: 1080 })
    check(
      '4: dock auto: смена геометрии окна меняет dataset.where (bottom при h=1400, right при w=2400, overlay при 800x600)',
      res4Bottom === 'bottom' && res4Right === 'right' && res4Overlay === 'overlay',
      `bottom=${res4Bottom}, right=${res4Right}, overlay=${res4Overlay}`,
    )

    // 5: F5 (перезагрузка страницы) сохраняет форму и ответы
    // Заполняем ответ перед релоадом
    await page.evaluate(() => {
      window.itd.ask([{ n: 1, text: 'Проверка сохранения', kind: 'check' }], { dock: 'bottom' })
      const q1 = document.querySelector('#itd-ask [data-n="1"]')
      const btn = Array.from(q1.querySelectorAll('button')).find((b) => b.textContent === 'корректно')
      btn?.click()
      const inp = q1.querySelector('input')
      if (inp) {
        inp.value = 'сохранено'
        inp.dispatchEvent(new Event('input'))
      }
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitMenuReady(page)
    const res5 = await page.evaluate(() => {
      const el = document.getElementById('itd-ask')
      const st = window.itd.ask.state()
      return {
        hasEl: !!el,
        where: el?.dataset.where,
        active: st.active,
        answers: st.answers,
      }
    })
    check(
      '5: F5: форма и ответы восстанавливаются из sessionStorage',
      res5.hasEl && res5.active && res5.answers[1]?.status === 'корректно' && res5.answers[1]?.comment === 'сохранено',
      JSON.stringify(res5),
    )

    // 6: интеграция с itd.claim: клик по форме не триггерит foreign в claim;
    // клик «корректно» до нажатия цели блокируется и не устанавливает статус
    const res6 = await page.evaluate(() => {
      window.itd.claim('qa152')
      window.itd.ask([{ n: 1, text: 'Нажми «НОРМА» в игре', target: 'menu:diff:normal' }], { dock: 'bottom' })
      const q1 = document.querySelector('#itd-ask [data-n="1"]')
      const btn = Array.from(q1.querySelectorAll('button')).find((b) => b.textContent === 'корректно')
      // Попытка выбрать «корректно» до клика в игре
      btn?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      btn?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      btn?.click()
      const blockedStatus = window.itd.ask.state().answers[1]?.status
      return {
        foreign: window.itd.claim.state().foreign,
        blockedStatus,
      }
    })
    check(
      '6: интеграция с claim: клики по #itd-ask не вызывают foreign в claim; выбор «корректно» блокируется до клика',
      res6.foreign === 0 && res6.blockedStatus === null,
      JSON.stringify(res6),
    )

    // Клик по кнопке меню menu:diff:normal на канвасе
    const btnPos = await page.evaluate(() => {
      const n = window.itd.nodes().find((m) => m.id === 'menu.diff.normal')
      const r = document.querySelector('canvas').getBoundingClientRect()
      return { x: r.left + (n.cx / 1280) * r.width, y: r.top + (n.cy / 720) * r.height }
    })
    await page.mouse.click(btnPos.x, btnPos.y)

    // После клика в игре выбираем «корректно» и отправляем ответ
    const res7 = await page.evaluate(() => {
      const q1 = document.querySelector('#itd-ask [data-n="1"]')
      const btn = Array.from(q1.querySelectorAll('button')).find((b) => b.textContent === 'корректно')
      btn?.click()
      const sendBtn = document.getElementById('itd-ask-send')
      sendBtn?.click()
      return {
        result: window.itd.ask.result(),
        state: window.itd.ask.state(),
      }
    })
    check(
      '7: кнопка «Отправить агенту» → результат с метаданными (sha, iw, dpr, answers с target и hit)',
      res7.result !== null &&
        typeof res7.result.at === 'number' &&
        res7.result.answers[0]?.target === 'menu:diff:normal' &&
        res7.result.answers[0]?.hit === true &&
        res7.state.submitted === true,
      JSON.stringify(res7.result),
    )

    // 8: await itd.ask.wait()
    const res8 = await page.evaluate(async () => {
      const w = await window.itd.ask.wait(100)
      return !!w && w.at > 0
    })
    check('8: await itd.ask.wait() резолвится объектом результата', res8 === true, `res8=${res8}`)

    // 9: itd.ask.close()
    const res9 = await page.evaluate(() => {
      window.itd.claim.stop()
      const closeRes = window.itd.ask.close()
      const el = document.getElementById('itd-ask')
      const st = window.itd.ask.state()
      const saved = sessionStorage.getItem('itd.ask')
      return { closeRes, hasEl: !!el, active: st.active, saved }
    })
    check(
      '9: itd.ask.close() убирает элемент из DOM и очищает sessionStorage',
      res9.closeRes.ok === true && !res9.hasEl && !res9.active && res9.saved === null,
      JSON.stringify(res9),
    )

    // 10: отказы на невалидных аргументах
    const res10 = await page.evaluate(() => {
      const b1 = window.itd.ask([])
      const b2 = window.itd.ask([{ n: 0, text: '' }])
      const b3 = window.itd.ask([{ n: 1, text: 'ok' }], { dock: 'wrong' })
      return { b1, b2, b3 }
    })
    check(
      '10: отказы bad_args на невалидных items и opts',
      res10.b1.ok === false &&
        res10.b1.code === 'bad_args' &&
        res10.b2.ok === false &&
        res10.b3.ok === false &&
        res10.b3.code === 'bad_args',
      JSON.stringify(res10),
    )

    // Проверка JS ошибок страницы
    check('на странице нет pageerror', pageErrors.length === 0, pageErrors.join('; '))
  } finally {
    if (browser) await browser.close()
    if (stopServer) await stopServer()
  }

  const passed = results.filter((r) => r.pass).length
  const total = results.length
  console.log(`\nИтог QA-ITGAME152: ${passed}/${total} проверок прошло`)
  if (passed !== total) {
    process.exit(1)
  }
  console.log('Все проверки пройдены успешно!')
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
