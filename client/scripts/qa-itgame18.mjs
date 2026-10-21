// qa-itgame18 — пауза отчёта дня (ITGAME-18), `npm run qa:report-pause`:
//   отчёт дня ставит партию на паузу (speed 0), время и баланс стоят; Enter / Space /
//   btn.next_day / itd.cmd('next_day') закрывают его и возвращают скорость до отчёта;
//   F5 при открытом отчёте: sessionStorage itd.speedBeforeReport переживает перезагрузку,
//   «Продолжить» поднимает отчёт на паузе, закрытие возвращает 3×; внешняя пауза
//   (itd.speed(0) поверх отчёта) не снимается; itd.set({tickInDay}) в day_report отклонён;
//   skipReports — день меняется без модалки и без залипания скорости в 0; нет pageerror;
//   R1–R2 длинный журнал (ITGAME-141): перенос с висячим отступом, обрезка сверху строкой
//   «… раньше: ещё k», текст в рамке, панель в поле, itd.overlaps()/offscreen() пусты;
//   Z0 «Зарплата:  $0» без минуса при пустом штате (ITGAME-147); R3 лента hud.log после отчёта —
//   строки журнала сервера со своим временем, итог дня последним, R4 пересланный после
//   переподключения отчёт ленту не дублирует (ITGAME-150).
//
// Self-serve (ITGAME-70, по образцу qa-itgame47): без QA_BASE поднимает Go-сервер на QA_PORT
// (по умолчанию :4182) с временным каталогом сейвов — F5 → «Продолжить» восстанавливает партию
// из сейва, без стора (-saves off) нечего восстанавливать. Внешнему серверу (QA_BASE) тоже
// нужны сейвы и ITGAME_DEBUG=1. Раньше порт :8089 был зашит, а сервер не поднимался — набор
// не входил ни в один qa:*-скрипт.
//
// sid задаётся явно (sessionStorage, только вкладке): реконнект после F5 под тем же sid
// поднимает сейв, а ?scenario=fresh действует только на первую партию.
//
// Скорость, которую проверяет пункт, читается только после itd.wait на ожидаемое значение
// (ITGAME-82): ответ на set_speed приходит позже снапшота, который его вызвал (пауза отчёта,
// возврат темпа из refresh() после itd.cmd('next_day')). Такой wait — с .catch: регресс виден
// фактом speed=…, а не исключением, обрывающим набор. Чей возврат — по itd.net(): out set_speed
// после out next_day (itd.cmd — есть 2; внешняя пауза — нет ни одного). Enter/Space/btn.next_day
// читаются сразу: proceedNextDay шлёт set_speed ДО next_day, снапшот дня уже несёт скорость.
import puppeteer from 'puppeteer-core'
import { chromePath } from './lib/chrome.mjs'
import { selfServe } from './lib/selfserve.mjs'

const SELF_PORT = Number(process.env.QA_PORT) || 4182

let stopServer = null
if (!process.env.QA_BASE) {
  try {
    ;({ stop: stopServer } = await selfServe({ port: SELF_PORT, saves: 'tmp', label: 'QA-ITGAME18' }))
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  }
}
const BASE = process.env.QA_BASE || `http://127.0.0.1:${SELF_PORT}`

const results = []
const check = (name, pass, fact) => {
  results.push({ name, pass, fact })
  console.log(`${pass ? 'PASS' : 'FAIL'}: ${name} — ${fact}`)
}

// launch внутри try: упавший Chromium не должен оставлять bin/itdirector на порту
let browser = null
try {
  browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const page = await browser.newPage()
  // 1920×1080, как qa:hud: в окне 800×600 канвас 1.4× вылезает, и itd.offscreen() в R1–R2
  // ловил бы окно, а не отчёт (ITGAME-141)
  await page.setViewport({ width: 1920, height: 1080 })
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('PAGE error:', msg.text())
  })

  // ITGAME-82: скорости из out set_speed после последнего out next_day в itd.net() — кто вернул
  // темп после закрытия отчёта. Снапшот раздаётся слушателям (HUD refresh) синхронно, до того
  // как его увидит itd.wait, поэтому к концу wait ответный set_speed уже в журнале провода.
  // null — next_day нет среди последних 100 сообщений.
  const speedsSentAfterNextDay = () =>
    page.evaluate(() => {
      const last = window.itd.net(100).last
      const i = last.findLastIndex((m) => m.dir === 'out' && m.type === 'next_day')
      return i < 0
        ? null
        : last.slice(i + 1).filter((m) => m.dir === 'out' && m.type === 'set_speed').map((m) => m.info.speed)
    })

  await page.evaluateOnNewDocument(() => {
    if (!sessionStorage.getItem('itd.sid')) {
      sessionStorage.setItem('itd.sid', 'qa18-test-' + Date.now())
    }
    localStorage.removeItem('itd.skipReports')
  })

  await page.goto(`${BASE}/?debug=1&scenario=fresh&seed=42`, { waitUntil: 'domcontentloaded' })
  await new Promise((r) => setTimeout(r, 200))

  // 1. Старт игры
  await page.evaluate(async () => {
    await window.itd.wait((s) => s.menuReady === true, 8000)
    window.itd.click('menu.diff.normal')
    await window.itd.wait((s) => s.connected === true, 8000)
    await window.itd.set({ money: 50000 })
  })

  // 2. Установим скорость 2x перед окончанием дня
  const set2x = await page.evaluate(async () => {
    window.itd.speed(2)
    await window.itd.wait((s, srv) => srv.snapshot?.speed === 2, 5000)
    return window.itd.server().snapshot?.speed
  })
  check('Скорость установлена на 2x', set2x === 2, `speed=${set2x}`)

  // 3. Перемотаем к концу дня (тик 53 из 54)
  await page.evaluate(async () => {
    await window.itd.set({ tickInDay: 53 })
  })

  // 4. Ждем открытия модала отчета дня
  const reportOpened = await page.evaluate(async () => {
    await window.itd.wait(() => window.itd.ids().some((x) => x.id === 'btn.next_day'), 8000)
    await window.itd.wait((s, srv) => srv.snapshot?.speed === 0, 5000)
    const st = window.itd.server().snapshot
    return {
      hasBtn: window.itd.ids().some((x) => x.id === 'btn.next_day'),
      speed: st?.speed,
      day: st?.day,
      phase: st?.phase,
      balance: st?.money,
    }
  })
  check('Модал дня открылся', reportOpened.hasBtn === true, `hasBtn=${reportOpened.hasBtn}`)
  check('Скорость на паузе (0) во время модала', reportOpened.speed === 0, `speed=${reportOpened.speed}`)
  // Z0 (ITGAME-147): у fresh штата нет — «Зарплата:  $0» без минуса, «-$0» читался как ошибка.
  const salary0 = await page.evaluate(() =>
    (window.itd.text().find((n) => n.scene === 'hud' && (n.text ?? '').startsWith('Доход:'))?.text ?? '')
      .split('\n').find((l) => l.startsWith('Зарплата:')) ?? null)
  check('Z0 без штата строка «Зарплата:  $0» без минуса', salary0 === 'Зарплата:  $0', JSON.stringify(salary0))

  // 5. Ждем 2 секунды и проверяем, что время стоит и баланс не изменился
  await new Promise((r) => setTimeout(r, 2000))
  const pausedState = await page.evaluate(() => {
    const st = window.itd.server().snapshot
    return {
      day: st?.day,
      balance: st?.money,
      speed: st?.speed,
    }
  })
  check('Время стоит во время модала (день тот же)', pausedState.day === reportOpened.day, `day=${pausedState.day}`)
  check('Баланс не изменился (нет тиков/событий)', pausedState.balance === reportOpened.balance, `balance=${pausedState.balance}`)
  check('Скорость остается 0', pausedState.speed === 0, `speed=${pausedState.speed}`)

  // 6. Нажимаем Enter через реальное клавиатурное событие страницы
  await page.keyboard.press('Enter')

  // 7. Проверяем, что модал закрылся, наступил День 2, и восстановилась скорость 2x!
  const day2State = await page.evaluate(async () => {
    await window.itd.wait(() => !window.itd.ids().some((x) => x.id === 'btn.next_day'), 5000)
    await window.itd.wait((s) => s.day === 2 && s.phase === 'running', 5000)
    const st = window.itd.server().snapshot
    return {
      day: st?.day,
      phase: st?.phase,
      speed: st?.speed,
      noModal: !window.itd.ids().some((x) => x.id === 'btn.next_day'),
    }
  })
  check('Модал закрыт по Enter', day2State.noModal === true, `noModal=${day2State.noModal}`)
  check('День 2 наступил', day2State.day === 2 && day2State.phase === 'running', `day=${day2State.day}, phase=${day2State.phase}`)
  check('Скорость восстановлена на 2x', day2State.speed === 2, `speed=${day2State.speed}`)

  // 8. Проверяем Space на следующем дне через реальное клавиатурное событие
  await page.evaluate(async () => {
    window.itd.speed(3) // сменим на 3x
    await window.itd.wait((s, srv) => srv.snapshot?.speed === 3, 5000)
    await window.itd.set({ tickInDay: 53 })
    await window.itd.wait(() => window.itd.ids().some((x) => x.id === 'btn.next_day'), 8000)
  })
  const day2ReportSpeed = await page.evaluate(async () => {
    // ITGAME-82: set_speed 0 отчёта (onDayReport) уходит в момент появления btn.next_day —
    // ждём его ответ; таймаут не бросает, регресс виден фактом speed=…
    await window.itd.wait((s) => s.speed === 0, 5000).catch(() => null)
    return window.itd.server().snapshot?.speed
  })
  check('День 2: скорость на паузе (0)', day2ReportSpeed === 0, `speed=${day2ReportSpeed}`)

  // Нажимаем Space
  await page.keyboard.press('Space')
  const day3State = await page.evaluate(async () => {
    await window.itd.wait(() => !window.itd.ids().some((x) => x.id === 'btn.next_day'), 5000)
    await window.itd.wait((s) => s.day === 3 && s.phase === 'running', 5000)
    const st = window.itd.server().snapshot
    return {
      day: st?.day,
      speed: st?.speed,
    }
  })
  check('Space перевел на день 3', day3State.day === 3, `day=${day3State.day}`)
  check('Скорость 3x восстановлена после Space', day3State.speed === 3, `speed=${day3State.speed}`)

  // 9. Перезагрузка F5 при открытом отчёте дня (ITGAME-18 Opus review)
  await page.evaluate(async () => {
    window.itd.speed(3)
    await window.itd.wait((s, srv) => srv.snapshot?.speed === 3, 5000)
    await window.itd.set({ tickInDay: 53 })
    await window.itd.wait(() => window.itd.ids().some((x) => x.id === 'btn.next_day'), 8000)
    // ITGAME-82: перезагрузка — только когда пауза отчёта дошла до сервера (и его сейва):
    // иначе «скорость 0 после F5» зависела бы от того, успел ли set_speed 0 до F5
    await window.itd.wait((s) => s.speed === 0, 5000).catch(() => null)
  })
  const beforeReloadStorage = await page.evaluate(() => sessionStorage.getItem('itd.speedBeforeReport'))
  check('sessionStorage хранит 3x до перезагрузки', beforeReloadStorage === '3', `val=${beforeReloadStorage}`)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await new Promise((r) => setTimeout(r, 200))

  const afterReloadReady = await page.evaluate(async () => {
    await window.itd.wait((s) => s.menuReady === true, 8000)
    const storageBeforeClick = sessionStorage.getItem('itd.speedBeforeReport')
    window.itd.click('menu.continue')
    await window.itd.wait((s) => s.connected === true, 8000)
    await window.itd.wait(() => window.itd.ids().some((x) => x.id === 'btn.next_day'), 8000)
    return {
      storageVal: storageBeforeClick,
      storageAfterConnect: sessionStorage.getItem('itd.speedBeforeReport'),
      speed: window.itd.server().snapshot?.speed,
    }
  })
  check('sessionStorage сохранил 3x после F5', afterReloadReady.storageVal === '3', `val=${afterReloadReady.storageVal}`)
  check('Скорость на сервере 0 после F5', afterReloadReady.speed === 0, `speed=${afterReloadReady.speed}`)

  // Закрываем модал кликом по кнопке btn.next_day
  await page.evaluate(() => {
    window.itd.click('btn.next_day')
  })
  const day4State = await page.evaluate(async () => {
    await window.itd.wait(() => !window.itd.ids().some((x) => x.id === 'btn.next_day'), 5000)
    await window.itd.wait((s) => s.day === 4 && s.phase === 'running', 5000)
    return {
      day: window.itd.server().snapshot?.day,
      speed: window.itd.server().snapshot?.speed,
      storageCleared: sessionStorage.getItem('itd.speedBeforeReport') === null,
    }
  })
  check('День 4 наступил после F5', day4State.day === 4, `day=${day4State.day}`)
  check('Скорость 3x восстановлена после F5 (не сбросилась в 1)', day4State.speed === 3, `speed=${day4State.speed}`)
  check('sessionStorage очищен после закрытия модала', day4State.storageCleared === true, `cleared=${day4State.storageCleared}`)

  // 10. Прямой вызов itd.cmd('next_day') во время открытого отчёта
  await page.evaluate(async () => {
    window.itd.speed(2)
    await window.itd.wait((s, srv) => srv.snapshot?.speed === 2, 5000)
    await window.itd.set({ tickInDay: 53 })
    await window.itd.wait(() => window.itd.ids().some((x) => x.id === 'btn.next_day'), 8000)
    // Шлём команду напрямую на сервер в обход proceedNextDay UI
    window.itd.cmd('next_day')
  })
  const day5State = await page.evaluate(async () => {
    await window.itd.wait(() => !window.itd.ids().some((x) => x.id === 'btn.next_day'), 5000)
    await window.itd.wait((s) => s.day === 5 && s.phase === 'running', 5000)
    // ITGAME-82: ответ на next_day приходит со speed 0, set_speed 2 HUD шлёт из refresh() по этому
    // снапшоту — ждём ответ на него, а не читаем сразу; таймаут не бросает, регресс виден фактом
    await window.itd.wait((s) => s.speed === 2, 5000).catch(() => null)
    return {
      day: window.itd.server().snapshot?.day,
      speed: window.itd.server().snapshot?.speed,
    }
  })
  const day5Sent = await speedsSentAfterNextDay()
  check('itd.cmd(next_day): день 5 наступил', day5State.day === 5, `day=${day5State.day}`)
  check(
    'itd.cmd(next_day): скорость 2x восстановлена через refresh()',
    day5State.speed === 2 && day5Sent?.includes(2) === true,
    `speed=${day5State.speed}, set_speed после next_day: ${JSON.stringify(day5Sent)}`,
  )

  // 11. Сохранение внешней паузы при закрытии через ENTER (путь игрока)
  await page.evaluate(async () => {
    window.itd.speed(3)
    await window.itd.wait((s, srv) => srv.snapshot?.speed === 3, 5000)
    await window.itd.set({ tickInDay: 53 })
    await window.itd.wait(() => window.itd.ids().some((x) => x.id === 'btn.next_day'), 8000)
    // Проверяем гарду itd.set({ tickInDay }) в фазе day_report
    let setRejected = false
    try {
      await window.itd.set({ tickInDay: 10 })
    } catch {
      setRejected = true
    }
    window.__setRejectedInReport = setRejected

    // Внешняя пауза, например агент или пользователь вызвал itd.speed(0)
    window.itd.speed(0)
  })
  const setCheck = await page.evaluate(() => window.__setRejectedInReport)
  check('itd.set(tickInDay) отклонён во время day_report', setCheck === true, `rejected=${setCheck}`)

  // Закрываем модал нажатием клавиши Enter (реальное DOM-событие игрока!)
  await page.keyboard.press('Enter')

  const day6State = await page.evaluate(async () => {
    await window.itd.wait(() => !window.itd.ids().some((x) => x.id === 'btn.next_day'), 5000)
    await window.itd.wait((s) => s.day === 6 && s.phase === 'running', 5000)
    return {
      day: window.itd.server().snapshot?.day,
      speed: window.itd.server().snapshot?.speed,
    }
  })
  const day6Sent = await speedsSentAfterNextDay()
  check('День 6 наступил', day6State.day === 6, `day=${day6State.day}`)
  // ITGAME-82: мгновенное чтение speed не видит ошибочный set_speed из refresh(), который ещё в пути;
  // журнал провода видит — refresh шлёт синхронно на снапшот next_day, до того как wait увидел день 6
  check(
    'Внешняя пауза не снята (скорость осталась 0)',
    day6State.speed === 0 && day6Sent !== null && day6Sent.length === 0,
    `speed=${day6State.speed}, set_speed после next_day: ${JSON.stringify(day6Sent)}`,
  )

  // 12. Проверяем режим skipReports
  await page.evaluate(async () => {
    // Включаем skipReports через localStorage и выставляем скорость 2x
    localStorage.setItem('itd.skipReports', '1')
    window.itd.speed(2)
    await window.itd.wait((s, srv) => srv.snapshot?.speed === 2, 5000)
    // Промотаем день 6 к концу
    await window.itd.set({ tickInDay: 53 })
  })

  // С включенным skipReports игра должна автоматически перейти на следующий день (день 7) без паузы
  const skipResult = await page.evaluate(async () => {
    await window.itd.wait((s) => s.day === 7 && s.phase === 'running', 8000)
    const st = window.itd.server().snapshot
    const hasModal = window.itd.ids().some((x) => x.id === 'btn.next_day')
    return {
      day: st?.day,
      speed: st?.speed,
      hasModal,
    }
  })
  check('skipReports: день перешел на 7 без модала', skipResult.day === 7 && !skipResult.hasModal, `day=${skipResult.day}, modal=${skipResult.hasModal}`)
  check('skipReports: скорость не залипла на 0 (осталась 2)', skipResult.speed === 2, `speed=${skipResult.speed}`)

  // 13. Длинные строки журнала в отчёте (ITGAME-141): itd.restore подкладывает eventLog, день
  // доходит до отчёта живым тиком. R1 — строки шире панели переносятся с висячим отступом «  » и
  // склеиваются обратно без потерь; R2 — журнал выше поля режется сверху строкой «… раньше: ещё k»,
  // вечерняя строка остаётся. В обоих: текст внутри рамки панели, панель внутри поля, линтер пуст.
  const LONG = [
    '12:00 вирус в офисе 2 отбит подпиской Enterprise — подписка покрыла всех сотрудников офиса',
    '14:30 Константин Константинопольский: повышение (+$5/день, +2% выработки) — просьба удовлетворена',
    '17:50 вирус: к вечеру заражено 12 ПК — само не пройдёт, кликайте по местам или берите подписку',
  ]
  const MANY = Array.from({ length: 30 }, (_, i) =>
    `${String(10 + Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')} вирус: офис ${i % 3 + 1} вычищен вручную к ${String(10 + Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15 + 5).padStart(2, '0')} — строка ${i + 1}`)
  const reportWith = async (eventLog) => {
    await page.evaluate(async (log) => {
      localStorage.removeItem('itd.skipReports')
      window.itd.speed(0)
      await window.itd.wait((s, srv) => srv.snapshot?.speed === 0, 5000).catch(() => null)
      const sn = await window.itd.snapshot()
      sn.save.eventLog = log
      await window.itd.restore(sn.save)
      await window.itd.set({ tickInDay: 53 })
      window.itd.speed(1)
      await window.itd.wait(() => window.itd.ids().some((x) => x.id === 'btn.next_day'), 8000)
    }, eventLog)
    return page.evaluate(() => {
      const box = (n) => n && { left: n.cx - n.w / 2, right: n.cx + n.w / 2, top: n.cy - n.h / 2, bottom: n.cy + n.h / 2 }
      const body = window.itd.text().find((n) => n.scene === 'hud' && (n.text ?? '').startsWith('Доход:'))
      const panel = window.itd.nodes().find((n) => n.scene === 'hud' && n.type === 'Rectangle' && n.depth === 51 && n.fill === '#14162b')
      const btn = window.itd.nodes().find((n) => n.id === 'btn.next_day')
      return {
        lines: (body?.text ?? '').split('\n'),
        body: box(body), panel: box(panel), btn: box(btn),
        overlaps: window.itd.overlaps(), offscreen: window.itd.offscreen(),
      }
    })
  }
  // Строки журнала из тела отчёта: продолжение «  …» приклеивается к своей строке «· …».
  const logOf = (lines) => {
    const i = lines.indexOf('Журнал событий:')
    const out = []
    for (const l of i < 0 ? [] : lines.slice(i + 1)) {
      if (l.startsWith('  ') && out.length) out[out.length - 1] += ' ' + l.trimStart()
      else out.push(l)
    }
    return out
  }
  const inside = (b, p) => !!b && !!p && b.left >= p.left + 16 && b.right <= p.right - 16 && b.top >= p.top && b.bottom <= p.bottom
  const closeReport = async (day) => {
    await page.keyboard.press('Enter')
    await page.evaluate(async (d) => {
      await window.itd.wait((s) => s.day === d && s.phase === 'running', 5000).catch(() => null)
    }, day)
  }

  const r1 = await reportWith(LONG)
  const log1 = logOf(r1.lines)
  const wrapped = r1.lines.filter((l) => l.startsWith('  '))
  check('R1 длинные строки: перенос с висячим отступом «  »', wrapped.length >= LONG.length,
    `продолжений ${wrapped.length}: ${JSON.stringify(r1.lines.slice(-8))}`)
  check('R1 строки журнала склеиваются в исходные без потерь',
    LONG.every((e) => log1.includes(`· ${e}`)), JSON.stringify(log1))
  check('R1 текст отчёта внутри рамки панели (поля ≥ 16 px)', inside(r1.body, r1.panel),
    JSON.stringify({ body: r1.body, panel: r1.panel }))
  check('R1 itd.overlaps() и itd.offscreen() пусты', r1.overlaps.length === 0 && r1.offscreen.length === 0,
    JSON.stringify({ overlaps: r1.overlaps, offscreen: r1.offscreen }).slice(0, 300))
  await closeReport(8)

  const r2 = await reportWith(MANY)
  const log2 = logOf(r2.lines)
  const more = /^· … раньше: ещё (\d+)$/.exec(log2[0] ?? '')
  const shown = log2.slice(1)
  check('R2 журнал выше поля: сверху «· … раньше: ещё k», вечерняя строка на месте',
    !!more && Number(more[1]) > 0 && shown.includes(`· ${MANY[MANY.length - 1]}`)
      && Number(more[1]) + shown.length >= MANY.length,
    JSON.stringify({ first: log2[0], shown: shown.length, last: shown[shown.length - 1] }))
  check('R2 панель внутри поля 16..704, текст и кнопка внутри рамки',
    !!r2.panel && r2.panel.top >= 16 - 0.5 && r2.panel.bottom <= 720 - 16 + 0.5 && inside(r2.body, r2.panel)
      && !!r2.btn && r2.btn.bottom <= r2.panel.bottom,
    JSON.stringify({ panel: r2.panel, body: r2.body, btn: r2.btn }))
  check('R2 itd.overlaps() и itd.offscreen() пусты', r2.overlaps.length === 0 && r2.offscreen.length === 0,
    JSON.stringify({ overlaps: r2.overlaps, offscreen: r2.offscreen }).slice(0, 300))
  await closeReport(9)

  // 14. Лента HUD после отчёта (ITGAME-150). R3 — строки журнала сервера идут в hud.log со своим
  // «HH:MM», без часов прихода отчёта перед ним (было «19:00 · 10:50 …»), итог дня последним.
  // R4 — отчёт, пересланный сервером после переподключения в фазе day_report (itd.away net
  // короче таймаута — ранний возврат), приходит второй раз, а лента остаётся прежней.
  const FEED = ['10:50 вирус в офисе 1: 2 ПК', '19:00 вирус: к вечеру заражено 3 ПК — само не пройдёт']
  const feedText = () => page.evaluate(() => window.itd.text().find((n) => n.id === 'hud.log')?.text ?? '')
  const reportsIn = () => page.evaluate(() => window.itd.net(200).last.filter((m) => m.dir === 'in' && m.type === 'day_report').length)
  await reportWith(FEED)
  const feed3 = await feedText()
  const lines3 = feed3.split('\n')
  const feedAt = lines3.indexOf(FEED[0])
  check('R3 лента: строки журнала со своим временем, одно время на строку, итог дня последним',
    // подложенные строки ищем, а не пинаем по индексу: перед ними может остаться только утренняя строка
    // клиента («10:00 Утро, день 9»), за ними — вечерние итоги активных событий самого сервера
    feedAt >= 0 && feedAt <= 1 && lines3[feedAt + 1] === FEED[1]
      && (feedAt === 0 || /^\d\d:\d\d Утро, день 9$/.test(lines3[0])) && lines3.every((l) => /^\d\d:\d\d (?!· )(?!\d\d:\d\d)\S/.test(l))
      && /^\d\d:\d\d День 9: прибыль /.test(lines3.at(-1) ?? ''),
    JSON.stringify(lines3))
  const before4 = await reportsIn()
  // Лента держит LOG_LINES (5) последних строк: отчёт в 5 строк, выложенный второй раз, даёт тот
  // же хвост, и по тексту повтор не виден — считаем сами вызовы logLine у сцены на время пересылки.
  await page.evaluate(() => {
    const hud = window.__itd.scene.getScene('hud')
    const orig = hud.logLine
    window.__qaLogLines = []
    hud.logLine = function (...a) { window.__qaLogLines.push(a[0]); return orig.apply(this, a) }
  })
  const away4 = await page.evaluate(() => window.itd.away(1, { mode: 'net', timeout: 5000 }))
  await page.evaluate(async (n) => {
    await window.itd.wait(() => window.itd.net(200).last.filter((m) => m.dir === 'in' && m.type === 'day_report').length > n, 5000).catch(() => null)
  }, before4)
  const after4 = await reportsIn()
  const feed4 = await feedText()
  const open4 = await page.evaluate(() => window.itd.ids().some((x) => x.id === 'btn.next_day'))
  const logged4 = await page.evaluate(() => {
    const hud = window.__itd.scene.getScene('hud')
    delete hud.logLine // снова метод прототипа
    return window.__qaLogLines
  })
  check('R4 пересланный после переподключения отчёт строк в ленту второй раз не кладёт',
    away4.ok === true && after4 > before4 && open4 && feed4 === feed3
      && !logged4.some((l) => FEED.some((e) => e.endsWith(l)) || /^День \d+: прибыль /.test(l)),
    JSON.stringify({ ok: away4.ok, reports: [before4, after4], open4, logged4, feed4: feed4.split('\n') }))
  await closeReport(10)

  check('Ошибок на странице нет', pageErrors.length === 0, `errors=${pageErrors.length} ${pageErrors.join(' | ')}`)
  await page.close()
} catch (e) {
  check('сценарий выполнен без исключений', false, e instanceof Error ? e.message : String(e))
} finally {
  if (browser) await browser.close()
  if (stopServer) await stopServer()
}

const failed = results.filter((r) => !r.pass)
console.log(`\nИтог QA-ITGAME18: ${results.length - failed.length}/${results.length} проверок прошло`)
if (failed.length > 0) {
  console.error(`Провалено: ${failed.map((f) => f.name).join(', ')}`)
  process.exit(1)
}
