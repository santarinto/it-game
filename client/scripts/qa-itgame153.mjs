// qa-itgame153 — itd.tap (ITGAME-153): клик по id синтетическим MouseEvent через настоящий хит-тест Phaser.
//   1  меню, окно 2173 dpr 1.15: tap('menu.zoom.1') / ('menu.zoom.fit') / ('menu.zoom.1.4') при разных масштабах холста
//      и после смены окна — мировая точка нажатия down в трассе (pointer x/y) = cx/cy цели ±1 (up после смены масштаба приходит в ту же клиентскую точку, но уже другого мира), wins/got.down = цель,
//      client = rect.left + cx/1280·rect.width (по живой рамке); оба события в трассе с synthetic: true, в
//      itd.trace.summary — слово «synthetic»; 1c: got.down/got.up/gone ответа = pointer[].got/gone трассы, в т.ч. после
//      смены масштаба, когда up приходит уже в другой мир (got.up по точке события, не по cx/cy до down)
//   2  tap('menu.diff.normal') стартует партию: ok, synthetic, got.down [menu:diff:normal], up пуст, gone [цель]
//   3  tap('btn.hire') в партии: got down/up btn:hire, sent [{type:'hire', src:'itd'}], штат растёт
//   4  отказы без событий: no_node, hidden (невидимый hud.virus.*), no_hit (hud.money — нет hitArea), covered (под окном
//      «Выйти в меню?»: wins — подложка, got пуст, sent пуст, в трассе pointer 0),
//      bad_args (button 1, holdMs -1 / 5000 / строка) — события не слались; ok:false всегда с synthetic: true
//   5  button 2 → pointer button 2, окно «Уволить сотрудника?»; левый tap по тому же объекту окна не открывает
//   6  holdMs 300 → up не раньше 290 мс после down и заметно позже, чем по умолчанию (≥ 35; потолка нет: таймер ждёт кадра)
//   7  холст сдвинут style.top без resize (Phaser канвасные границы ещё не перечитал) → tap сразу после сдвига:
//      down в трассе = cx/cy цели ±1, got.down — цель (client считается обратным преобразованием Phaser, не по живой рамке)
//   8  itd.claim: два tap → synthetic 2, downs/own/foreign/allowed 0, полоса не краснела; allow(target) + tap по цели →
//      deny().hit false и ни одного разрешённого нажатия (синтетика — не «ход человека»)
//   9  настоящий клик мыши (puppeteer) в те же client-координаты даёт тот же wins и got.down, что tap (хит-тест один)
//   10 контракт: methods.tap, types TapOptions/TapResult/TapCode, TracePointer.synthetic; help() называет itd.tap
//   + на странице нет pageerror
//
// Self-serve: без QA_BASE поднимает Go-сервер на QA_PORT (по умолчанию :4194 — свой порт задачи).
// Общий self-serve — client/scripts/lib/selfserve.mjs.
import { setTimeout as delay } from 'node:timers/promises'
import puppeteer from 'puppeteer-core'
import { chromePath } from './lib/chrome.mjs'
import { selfServe } from './lib/selfserve.mjs'
import { waitMenuReady } from './lib/menu.mjs'

const SELF_PORT = Number(process.env.QA_PORT) || 4194
const BASE = process.env.QA_BASE || `http://127.0.0.1:${SELF_PORT}`

const results = []
function check(name, pass, fact) {
  results.push({ name, pass, fact })
  console.log(`${pass ? 'PASS' : 'FAIL'}: ${name}${fact ? ` — ${fact}` : ''}`)
}
const near = (a, b, d) => typeof a === 'number' && Math.abs(a - b) <= d

async function run() {
  let stopServer = null
  if (!process.env.QA_BASE) {
    try {
      ;({ stop: stopServer } = await selfServe({ port: SELF_PORT, saves: 'off', label: 'QA-ITGAME153' }))
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
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    })
    const page = await browser.newPage()
    page.on('pageerror', (e) => pageErrors.push(String(e)))
    await page.setViewport({ width: 2173, height: 1000, deviceScaleFactor: 1.15 })
    const sid = 'qa153-' + Date.now().toString(36)
    await page.evaluateOnNewDocument((sid) => {
      try {
        sessionStorage.setItem('itd.sid', sid)
      } catch {
        // заблокированное хранилище — не критично для QA
      }
    }, sid)
    await page.goto(`${BASE}/?scenario=fresh&seed=1&debug=1`, { waitUntil: 'domcontentloaded' })
    await waitMenuReady(page)
    const ev = (f, ...a) => page.evaluate(f, ...a)

    // Окно трассы вокруг tap: pointer/sent/summary и то, что ответил сам tap
    const traced = (id, opts) =>
      ev(
        async (id, opts) => {
          // узел и рамка — ДО tap: нажатие может перекладывать холст (масштаб меню), up придёт уже в другую точку мира
          const n = window.itd.nodes().find((x) => x.id === id.replace(/:/g, '.'))
          const cv = document.querySelector('canvas').getBoundingClientRect()
          const { id: tid } = window.itd.trace.start()
          const res = await window.itd.tap(id, opts)
          const tr = window.itd.trace.stop(tid)
          return { res, pointer: tr.pointer, sent: tr.sent, lines: window.itd.trace.summary(tr).lines, node: n ? { cx: n.cx, cy: n.cy } : null, rect: { l: cv.left, t: cv.top, w: cv.width, h: cv.height } }
        },
        id,
        opts,
      )

    // ── 1: координаты по рамке холста при разных масштабах
    const zoomRuns = []
    for (const [zid, key] of [['menu.zoom.1', '1'], ['menu.zoom.fit', 'fit'], ['menu.zoom.1.4', '1.4']]) {
      const t = await traced(zid)
      await delay(400)
      await waitMenuReady(page)
      zoomRuns.push({ zid, key, t, scale: await ev(() => localStorage.getItem('itd.uiScale')), w: t.rect.w })
    }
    await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 })
    await delay(400)
    const small = await traced('menu.zoom.fit')
    await delay(400)
    await waitMenuReady(page)
    const coordOk = (t) =>
      t.res.ok === true && t.res.client && t.node &&
      near(t.res.client.x, t.rect.l + (t.node.cx / 1280) * t.rect.w, 0.2) &&
      near(t.res.client.y, t.rect.t + (t.node.cy / 720) * t.rect.h, 0.2) &&
      t.pointer.length === 2 && near(t.pointer[0].x, t.node.cx, 1) && near(t.pointer[0].y, t.node.cy, 1) && t.pointer.every((p) => p.onCanvas && p.synthetic === true)
    check(
      '1: tap по рамке холста — мировая точка в трассе = cx/cy цели ±1 при трёх масштабах (1, fit, 1.4) и после смены окна 1280×720; client по getBoundingClientRect; оба события synthetic: true',
      [...zoomRuns.map((z) => z.t), small].every(coordOk) &&
        new Set(zoomRuns.map((z) => z.w)).size >= 2 &&
        zoomRuns.every((z) => z.scale === z.key),
      JSON.stringify({ widths: zoomRuns.map((z) => z.w), scales: zoomRuns.map((z) => z.scale), small: small.res.client, rect: small.rect }),
    )
    const z0 = zoomRuns[0].t
    check(
      '1b: wins и got.down — цель, summary метит «synthetic», у ответа synthetic: true',
      z0.res.wins === 'menu:zoom:1' && z0.res.got.down.includes('menu:zoom:1') && z0.res.synthetic === true &&
        z0.lines.some((l) => / ptr down .* synthetic canvas /.test(l)) && z0.lines.some((l) => / ptr up .* synthetic canvas /.test(l)),
      JSON.stringify({ res: z0.res, lines: z0.lines }),
    )

    // 1c: got/gone ответа = то, что трасса (проба по самому событию) записала у down и up — и после смены масштаба,
    // когда up приходит уже в другой мир: got.up берётся по точке события, не по cx/cy до down
    const same = (t) => t.pointer.length === 2 && JSON.stringify(t.res.got.down) === JSON.stringify(t.pointer[0].got) &&
      JSON.stringify(t.res.got.up) === JSON.stringify(t.pointer[1].got) && JSON.stringify(t.res.gone) === JSON.stringify(t.pointer[1].gone)
    check(
      '1c: got.down/got.up/gone ответа совпадают с pointer[0].got/[1].got/[1].gone трассы после смены масштаба меню и окна',
      [...zoomRuns.map((z) => z.t), small].every(same),
      JSON.stringify([...zoomRuns.map((z) => z.t), small].map((t) => ({ got: t.res.got, tr: t.pointer.map((p) => p.got), up: [t.pointer[1]?.x, t.pointer[1]?.y, t.pointer[1]?.wins] }))),
    )

    // ── 2: старт партии из меню
    await page.setViewport({ width: 2173, height: 1000, deviceScaleFactor: 1.15 })
    await delay(300)
    const start = await traced('menu.diff.normal')
    await page.waitForFunction(() => window.itd.state().connected === true && window.itd.state().phase != null, { timeout: 15000 })
    await ev(() => window.itd.pause())
    check(
      '2: tap(menu.diff.normal) стартует партию — got.down [цель], up пуст (кнопка ушла), gone [цель], ответ ok',
      start.res.ok === true && start.res.wins === 'menu:diff:normal' && start.res.got.down.length === 1 && start.res.got.down[0] === 'menu:diff:normal' &&
        start.res.got.up.length === 0 && start.res.gone.length === 1 && start.res.gone[0] === 'menu:diff:normal' &&
        start.pointer.length === 2 && start.pointer[1].gone[0] === 'menu:diff:normal',
      JSON.stringify(start.res),
    )

    // ── 3: команда от tap
    const hire = await traced('btn.hire')
    await page.waitForFunction(() => window.itd.state().staff >= 1, { timeout: 8000 })
    check(
      '3: tap(btn.hire) — got down и up btn:hire, sent [{type:hire, src:itd}], в трассе тот же hire, штат вырос',
      hire.res.ok === true && hire.res.got.down.includes('btn:hire') && hire.res.got.up.includes('btn:hire') &&
        hire.res.sent.length === 1 && hire.res.sent[0].type === 'hire' && hire.res.sent[0].src === 'itd' &&
        hire.sent.filter((s) => s.type === 'hire').length === 1,
      JSON.stringify({ res: hire.res, traceSent: hire.sent }),
    )

    // ── 4: отказы
    const hiddenId = await ev(() => window.itd.nodes().find((n) => n.id && !n.visible && n.id.startsWith('hud.virus'))?.id ?? null)
    const refusals = {}
    for (const [k, id, opts] of [
      ['no_node', 'btn.nothing'], ['hidden', hiddenId ?? 'hud.virus.office0'], ['no_hit', 'hud.money'],
      ['badBtn', 'btn.hire', { button: 1 }], ['badNeg', 'btn.hire', { holdMs: -1 }], ['badBig', 'btn.hire', { holdMs: 5000 }], ['badStr', 'btn.hire', { holdMs: '40' }],
    ]) {
      refusals[k] = await traced(id, opts)
    }
    const rr = (k) => refusals[k].res
    const noEvents = Object.values(refusals).every((t) => t.pointer.length === 0 && t.sent.length === 0)
    check(
      '4a: no_node / hidden / no_hit / bad_args (button 1, holdMs −1, 5000, строка) — ok:false с code и error, synthetic: true, событий и команд нет',
      rr('no_node').code === 'no_node' && rr('no_node').id === null && rr('hidden').code === 'hidden' && rr('no_hit').code === 'no_hit' &&
        ['badBtn', 'badNeg', 'badBig', 'badStr'].every((k) => rr(k).code === 'bad_args') &&
        Object.values(refusals).every((t) => t.res.ok === false && t.res.synthetic === true && typeof t.res.error === 'string' && t.res.got.down.length === 0 && t.res.client === null) &&
        noEvents,
      JSON.stringify({ hiddenId, codes: Object.fromEntries(Object.entries(refusals).map(([k, t]) => [k, t.res.code])) }),
    )

    // covered: окно «Выйти в меню?» накрывает HUD
    const menuTap = await traced('btn.menu')
    const covered = await traced('btn.speed.2')
    await traced('modal.close')
    await delay(200)
    const blockerAfter = await ev(() => window.itd.blocker())
    check(
      '4b: covered — под окном «Выйти в меню?» tap(btn.speed.2) → ok:false, wins — подложка окна, got и sent пусты, в трассе pointer 0 и sent 0 (tapWire — ничего не ушло); tap(modal.close) закрывает окно',
      menuTap.res.ok === true && covered.res.ok === false && covered.res.code === 'covered' && covered.res.wins !== null && covered.res.wins !== 'btn:speed:2' &&
        covered.res.got.down.length === 0 && covered.res.sent.length === 0 && covered.pointer.length === 0 && covered.sent.length === 0 && blockerAfter === null,
      JSON.stringify({ covered: covered.res, traceSent: covered.sent, blockerAfter }),
    )

    // ── 5: правая кнопка
    const left = await traced('office.pc.0')
    const blockerLeft = await ev(() => window.itd.blocker()?.title ?? null)
    await traced('modal.close')
    await delay(200)
    const right = await traced('office.pc.0', { button: 2 })
    const blockerRight = await ev(() => window.itd.blocker()?.title ?? null)
    check(
      '5: левый tap по рабочему месту открывает его окно, button 2 — «Уволить сотрудника?»: pointer down/up button 2 (synthetic), got down у цели',
      left.res.ok === true && left.pointer.every((p) => p.button === 0) && blockerLeft !== null && blockerLeft !== 'Уволить сотрудника?' &&
        right.res.ok === true && right.pointer.length === 2 && right.pointer.every((p) => p.button === 2 && p.synthetic === true) &&
        right.res.got.down.includes('office:pc:0') && blockerRight === 'Уволить сотрудника?',
      JSON.stringify({ blockerLeft, blockerRight, right: right.res.got }),
    )
    await traced('modal.close')
    await delay(200)
    const blockerEnd = await ev(() => window.itd.blocker())

    // ── 6: holdMs
    const slow = await traced('btn.speed.1', { holdMs: 300 })
    const fast = await traced('btn.speed.1')
    const gap = (t) => t.pointer[1].t - t.pointer[0].t
    check(
      '6: holdMs 300 — между down и up в трассе ≥ 290 мс и заметно дольше, чем по умолчанию (≥ 35 мс; таймер ждёт кадра, в headless на softGL кадр ~250 мс, потолка нет)',
      blockerEnd === null && slow.res.ok === true && gap(slow) >= 290 && fast.res.ok === true && gap(fast) >= 35 && gap(slow) > gap(fast) + 100,
      JSON.stringify({ slow: gap(slow), fast: gap(fast) }),
    )

    // ── 7: холст сдвинули, Phaser границы ещё не перечитал (раз в ~0.5 с) — tap сразу после сдвига
    const shifted = await ev(async () => {
      const cv = document.querySelector('canvas')
      cv.style.position = 'relative'
      cv.style.top = '37px'
      const n = window.itd.nodes().find((x) => x.id === 'btn.speed.1')
      // синхронно со сдвигом: Phaser ещё не успел перечитать границы
      const staleAtStart = window.__itd.scale.canvasBounds.y !== cv.getBoundingClientRect().top
      const { id } = window.itd.trace.start()
      const res = await window.itd.tap('btn.speed.1')
      const tr = window.itd.trace.stop(id)
      return { res, cx: n.cx, cy: n.cy, pointer: tr.pointer, staleAtStart, rectTop: cv.getBoundingClientRect().top }
    })
    await ev(() => {
      document.querySelector('canvas').style.top = '0px'
    })
    await delay(900) // Phaser перечитал границы
    check(
      '7: холст сдвинут на 37 px без resize, tap сразу — Phaser ещё держит старые границы (canvasBounds.y ≠ rect.top в момент tap), но down в трассе = cx/cy цели ±1 и got.down — цель (client — обратное преобразование Phaser)',
      shifted.res.ok === true && shifted.staleAtStart === true && shifted.pointer.length === 2 &&
        near(shifted.pointer[0].x, shifted.cx, 1) && near(shifted.pointer[0].y, shifted.cy, 1) && shifted.res.got.down.includes('btn:speed:1'),
      JSON.stringify({ staleAtStart: shifted.staleAtStart, rectTop: shifted.rectTop, down: shifted.pointer[0], got: shifted.res.got, client: shifted.res.client }),
    )

    // ── 8: itd.claim
    await ev(() => window.itd.claim('qa153'))
    await ev(async () => {
      await window.itd.tap('btn.speed.1')
      await window.itd.tap('btn.speed.1')
    })
    const cl = await ev(() => ({ s: window.itd.claim.state(), mode: document.getElementById('itd-claim')?.dataset.mode }))
    await ev(() => window.itd.claim.allow('нажми скорость 1', { target: 'btn.speed.1' }))
    await ev(() => window.itd.tap('btn.speed.1'))
    const den = await ev(() => window.itd.claim.deny())
    const fin = await ev(() => window.itd.claim.stop())
    check(
      '8: itd.claim — два tap: synthetic 2, downs/own/foreign/allowed 0, полоса не краснела; tap по цели окна allow → deny().hit false, разрешённых нажатий нет (синтетика не считается чужой и не считается ходом человека)',
      cl.s.synthetic === 2 && cl.s.downs === 0 && cl.s.own === 0 && cl.s.foreign === 0 && cl.s.allowed === 0 && cl.mode === 'claim' &&
        den.ok === true && den.hit === false && den.presses.length === 0 && fin.synthetic === 3 && fin.foreign === 0,
      JSON.stringify({ cl: { ...cl.s, presses: undefined }, den, fin: { synthetic: fin.synthetic, foreign: fin.foreign } }),
    )

    // ── 9: настоящий клик мыши в те же client-координаты
    const tp = await traced('btn.speed.1')
    await ev(() => {
      window.__realTr = window.itd.trace.start()
    })
    await page.mouse.click(tp.res.client.x, tp.res.client.y)
    const real = await ev(() => window.itd.trace.stop(window.__realTr.id).pointer)
    check(
      '9: настоящий клик мыши в client-координаты tap даёт тот же wins и got.down, что tap; у настоящего нет synthetic',
      tp.res.ok === true && real.length === 2 && real[0].synthetic === undefined && real[0].wins === tp.res.wins &&
        JSON.stringify(real[0].got) === JSON.stringify(tp.res.got.down) && near(real[0].x, tp.node.cx, 1) && near(real[0].y, tp.node.cy, 1),
      JSON.stringify({ tap: tp.res.got, real: real.map((p) => ({ type: p.type, wins: p.wins, got: p.got, x: p.x, y: p.y })) }),
    )

    // ── 10: контракт и help
    const c = await ev(() => {
      const k = window.itd.contract()
      return {
        tap: k.methods.tap,
        types: ['TapOptions', 'TapResult', 'TapCode'].map((n) => k.types[n]?.kind ?? null),
        codes: k.types.TapCode?.values,
        pointerSynthetic: k.types.TracePointer?.fields?.synthetic ?? null,
        fn: typeof window.itd.tap,
        help: window.itd.help().includes('itd.tap('),
      }
    })
    check(
      '10: контракт — methods.tap (id, opts?) → Promise<TapResult> с doc и примерами, TapOptions/TapResult/TapCode, TracePointer.synthetic; help() называет itd.tap',
      c.fn === 'function' && c.tap?.params?.length === 2 && c.tap.params[1].optional === true && c.tap.returns === 'Promise<TapResult>' &&
        c.tap.doc.length > 100 && c.tap.examples.length >= 2 && c.types.every((k) => k !== null) &&
        JSON.stringify(c.codes) === JSON.stringify(['bad_args', 'covered', 'hidden', 'no_hit', 'no_node']) && c.pointerSynthetic?.optional === true && c.help === true,
      JSON.stringify({ params: c.tap?.params, returns: c.tap?.returns, types: c.types, codes: c.codes, pointerSynthetic: c.pointerSynthetic, help: c.help }),
    )

    check('на странице нет pageerror', pageErrors.length === 0, pageErrors.join(' | '))
  } finally {
    if (browser) await browser.close()
    if (stopServer) await stopServer()
  }
}

await run()

const failed = results.filter((r) => !r.pass)
console.log(`\nИтог QA-ITGAME153: ${results.length - failed.length}/${results.length} проверок прошло`)
if (failed.length > 0) {
  console.error(`Провалено: ${failed.map((f) => f.name).join(', ')}`)
  process.exit(1)
} else {
  console.log('Все проверки пройдены успешно!')
}
