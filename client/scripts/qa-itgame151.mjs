// qa-itgame151 — itd.claim (ITGAME-151): полоса «АГЕНТ работает в этой вкладке», счёт нажатий
// own/allowed/foreign, «нажми сам» по got, переживает F5 и itd.reset():
//   1  claim('qa151') → #itd-claim: position fixed, pointer-events none, высота 40, data-mode claim, в тексте
//      метка и sha; заголовок «▶ АГЕНТ — смотри, не кликай»; рамка холста та же, что до claim
//   2  настоящий клик по пустому месту холста без mine → foreign 1, downs 1 (pointerdown + mousedown — одно
//      нажатие), onCanvas 1, presses[0] {n:1, kind:'foreign', wins:null}; сразу после клика data-mode foreign,
//      через 800 мс — claim
//   3  mine() → {ok, pending:1, ms:20000}; клик → own 1, foreign 1, вспышки нет, бюджет израсходован
//   4  mine(1, 200), пауза 400 мс, клик → foreign 2, own 1
//   5  синтетика: dispatchEvent mousedown+mouseup на холст → synthetic 1, downs тот же
//   6a allow('нажми «НОРМА»', {target:'menu.diff.normal'}) → data-mode allow, allow.target 'menu:diff:normal',
//      hit false; настоящий клик по menu:diff:normal → deny(): hit true, одно нажатие allowed с got menu:diff:normal
//   6b второе окно с тем же target; elementFromPoint в точке #build — сам #build (клик проходит сквозь полосу);
//      клик по #build под полосой → deny().hit false, onCanvas false; deny() без окна → no_allow; полоса снова claim
//   7  отказы: claim('') → bad_label, mine(0) → bad_args, allow('') → bad_args
//   7b claim('qa151b') → метка qa151b, счётчики те же; claim('qa151') возвращает метку
//   8a F5 → полоса на месте, счёт тот же, reloads 1, заголовок занят
//   8b itd.reset() снёс itd.claim, F5 → полоса на месте (pagehide записал её снова), reloads 2
//   9  stop() → итог active:false, полосы нет, заголовок «вкладка свободна», sessionStorage itd.claim нет,
//      state() {active:false}; второй stop() → no_claim; mine()/allow('x')/deny() после stop → no_claim
//   10 resizes (ITGAME-232): claim → без ресайза n 0; setViewport → resizes.n ≥ 1, last.iw новый;
//      stop() несёт resizes
//   + на странице нет pageerror
//
// Self-serve: без QA_BASE поднимает Go-сервер на QA_PORT (по умолчанию :4198 — свой порт задачи;
// 4173–4197 заняты соседними скриптами). Общий self-serve — client/scripts/lib/selfserve.mjs.
import { setTimeout as delay } from 'node:timers/promises'
import puppeteer from 'puppeteer-core'
import { chromePath } from './lib/chrome.mjs'
import { selfServe } from './lib/selfserve.mjs'
import { waitMenuReady } from './lib/menu.mjs'

const SELF_PORT = Number(process.env.QA_PORT) || 4198
const BASE = process.env.QA_BASE || `http://127.0.0.1:${SELF_PORT}`
const HINT_IDS = ['master', 'router', 'core', 'server', 'cooler', 'fridge', 'motivate', 'softlock']
const BUSY = '▶ АГЕНТ — смотри, не кликай'

const results = []
function check(name, pass, fact) {
  results.push({ name, pass, fact })
  console.log(`${pass ? 'PASS' : 'FAIL'}: ${name}${fact ? ` — ${fact}` : ''}`)
}

// Первая точка холста (мировые 1280×720), где хит-тест Phaser никого не находит.
async function findEmpty(page) {
  return page.evaluate(() => {
    const r = document.querySelector('canvas').getBoundingClientRect()
    for (const [gx, gy] of [[40, 700], [1240, 700], [640, 700], [40, 120], [1240, 120]]) {
      if (window.itd.stack(gx, gy).wins === null) {
        return { gx, gy, x: r.left + (gx / 1280) * r.width, y: r.top + (gy / 720) * r.height, wins: null }
      }
    }
    return null
  })
}

const barInfo = (page) =>
  page.evaluate(() => {
    const b = document.getElementById('itd-claim')
    if (!b) return null
    const cs = getComputedStyle(b)
    return { mode: b.dataset.mode, text: b.textContent, position: cs.position, pe: cs.pointerEvents, h: b.getBoundingClientRect().height }
  })

const COUNTS = ['downs', 'own', 'allowed', 'foreign', 'synthetic', 'onCanvas']
const sameCounts = (a, b) => COUNTS.every((k) => a?.[k] === b?.[k])

async function run() {
  let stopServer = null
  if (!process.env.QA_BASE) {
    try {
      ;({ stop: stopServer } = await selfServe({ port: SELF_PORT, saves: 'off', label: 'QA-ITGAME151' }))
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
    await page.setViewport({ width: 1920, height: 1080 })

    const sid = 'qa151-' + Date.now().toString(36)
    await page.evaluateOnNewDocument(
      (sid, hintIds) => {
        try {
          sessionStorage.setItem('itd.sid', sid)
          for (const id of hintIds) localStorage.setItem('itd.hint:' + id, '1')
        } catch {
          // заблокированное хранилище — не критично для QA
        }
      },
      sid,
      HINT_IDS,
    )
    await page.goto(`${BASE}/?scenario=fresh&seed=1&debug=1`, { waitUntil: 'domcontentloaded' })
    await waitMenuReady(page)
    const st = () => page.evaluate(() => window.itd.claim.state())
    const canvasRect = () => page.evaluate(() => JSON.stringify(document.querySelector('canvas').getBoundingClientRect()))

    // ── 1
    const rect0 = await canvasRect()
    const c1 = await page.evaluate(() => window.itd.claim('qa151'))
    const b1 = await barInfo(page)
    const t1 = await page.title()
    const rect1 = await canvasRect()
    const sha = await page.evaluate(() => window.itd.version.sha)
    check(
      '1: claim(qa151) → полоса fixed, pointer-events none, 40 px, data-mode claim, метка и sha в тексте; заголовок занят; холст на месте',
      c1.ok === true && c1.active === true && c1.label === 'qa151' && c1.downs === 0 &&
        c1.resizes?.n === 0 && c1.resizes?.last === null && c1.resizes?.first?.iw === 1920 &&
        b1?.position === 'fixed' && b1.pe === 'none' && b1.h === 40 && b1.mode === 'claim' &&
        b1.text.includes('qa151') && b1.text.includes(sha) && t1 === BUSY && rect1 === rect0,
      JSON.stringify({ c1, b1, t1, rect0, rect1 }),
    )

    // ── 2
    const empty = await findEmpty(page)
    if (empty) await page.mouse.click(empty.x, empty.y)
    const m2 = (await barInfo(page))?.mode
    const s2 = await st()
    await delay(800)
    const m2b = (await barInfo(page))?.mode
    check(
      '2: клик по пустому месту без mine → foreign 1, downs 1, onCanvas 1, presses[0] {n:1, foreign, wins:null}; вспышка foreign, потом claim',
      empty !== null && s2.foreign === 1 && s2.downs === 1 && s2.onCanvas === 1 && s2.presses.length === 1 &&
        s2.presses[0].n === 1 && s2.presses[0].kind === 'foreign' && s2.presses[0].wins === null &&
        m2 === 'foreign' && m2b === 'claim',
      JSON.stringify({ empty, s2, m2, m2b }),
    )

    // ── 3
    const mine3 = await page.evaluate(() => window.itd.claim.mine())
    if (empty) await page.mouse.click(empty.x, empty.y)
    const m3 = (await barInfo(page))?.mode
    const s3 = await st()
    check(
      '3: mine() → {ok, pending 1, ms 20000}; клик → own 1, foreign 1, без вспышки, бюджет израсходован',
      mine3.ok === true && mine3.pending === 1 && mine3.ms === 20000 && s3.own === 1 && s3.foreign === 1 &&
        s3.downs === 2 && s3.mine === null && s3.presses[1]?.kind === 'own' && m3 === 'claim',
      JSON.stringify({ mine3, s3, m3 }),
    )

    // ── 4
    await page.evaluate(() => window.itd.claim.mine(1, 200))
    await delay(400)
    if (empty) await page.mouse.click(empty.x, empty.y)
    const s4 = await st()
    check('4: mine(1, 200) истёк за 400 мс → клик — foreign', s4.foreign === 2 && s4.own === 1 && s4.mine === null, JSON.stringify(s4))
    await delay(700) // вспышка 600 мс прошла

    // ── 5
    const s5 = await page.evaluate((pt) => {
      const cv = document.querySelector('canvas')
      const o = { bubbles: true, cancelable: true, clientX: pt?.x ?? 0, clientY: pt?.y ?? 0, button: 0, view: window }
      cv.dispatchEvent(new MouseEvent('mousedown', { ...o, buttons: 1 }))
      cv.dispatchEvent(new MouseEvent('mouseup', { ...o, buttons: 0 }))
      return window.itd.claim.state()
    }, empty)
    check('5: dispatchEvent mousedown → synthetic 1, downs тот же (3)', s5.synthetic === 1 && s5.downs === 3, JSON.stringify(s5))

    // ── 6a
    const a6 = await page.evaluate(() => window.itd.claim.allow('нажми «НОРМА»', { target: 'menu.diff.normal' }))
    const m6 = (await barInfo(page))?.mode
    const btn = await page.evaluate(() => {
      const row = window.itd.screen().items.find((i) => i.startsWith('menu:diff:normal|'))?.split('|')
      return row ? { x: Number(row[2]), y: Number(row[3]) } : null
    })
    if (btn) await page.mouse.click(btn.x, btn.y)
    await delay(100)
    const d6 = await page.evaluate(() => window.itd.claim.deny())
    check(
      '6a: allow(…, {target: menu.diff.normal}) → полоса allow, target menu:diff:normal, hit false; клик по кнопке → deny().hit true, got с целью',
      a6.ok === true && a6.allow?.target === 'menu:diff:normal' && a6.allow.hit === false && m6 === 'allow' && btn !== null &&
        d6.ok === true && d6.hit === true && d6.presses.length === 1 && d6.presses[0].kind === 'allowed' &&
        d6.presses[0].got.includes('menu:diff:normal'),
      JSON.stringify({ a6, m6, btn, d6 }),
    )

    // ── 6b
    await page.evaluate(() => window.itd.claim.allow('нажми «НОРМА»', { target: 'menu.diff.normal' }))
    const bp = await page.evaluate(() => {
      const r = document.getElementById('build')?.getBoundingClientRect()
      return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
    })
    const under6 = bp ? await page.evaluate((p) => document.elementFromPoint(p.x, p.y)?.id ?? null, bp) : null
    if (bp) await page.mouse.click(bp.x, bp.y)
    await delay(100)
    const d6b = await page.evaluate(() => window.itd.claim.deny())
    const d6c = await page.evaluate(() => window.itd.claim.deny())
    const s6 = await st()
    const m6b = (await barInfo(page))?.mode
    check(
      '6b: под полосой в точке #build — #build; клик по нему → hit false, onCanvas false; deny() без окна → no_allow; allowed 2, полоса claim',
      bp !== null && under6 === 'build' && d6b.ok === true && d6b.hit === false && d6b.presses.length === 1 && d6b.presses[0].onCanvas === false &&
        d6c.ok === false && d6c.code === 'no_allow' && s6.allowed === 2 && s6.allow === null && m6b === 'claim',
      JSON.stringify({ bp, under6, d6b, d6c, s6, m6b }),
    )

    // ── 7
    const r7 = await page.evaluate(() => ({
      label: window.itd.claim(''),
      mine: window.itd.claim.mine(0),
      allow: window.itd.claim.allow(''),
    }))
    check(
      '7: отказы — claim("") bad_label, mine(0) bad_args, allow("") bad_args',
      r7.label.code === 'bad_label' && r7.mine.code === 'bad_args' && r7.allow.code === 'bad_args',
      JSON.stringify(r7),
    )

    // ── 7b
    const before7 = await st()
    const rl = await page.evaluate(() => window.itd.claim('qa151b'))
    const back = await page.evaluate(() => window.itd.claim('qa151'))
    check(
      "7b: claim('qa151b') → метка qa151b, счётчики не тронуты; claim('qa151') возвращает метку",
      rl.ok === true && rl.label === 'qa151b' && sameCounts(rl, before7) && back.ok === true && back.label === 'qa151' && sameCounts(back, before7),
      JSON.stringify({ before7, rl, back }),
    )

    // ── 8a
    const before8 = await st()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => !!document.getElementById('itd-claim') && !!window.itd, { timeout: 20000 })
    const s8 = await st()
    const t8 = await page.title()
    check(
      '8a: F5 → полоса на месте, счёт тот же, reloads 1, заголовок занят',
      s8.active === true && s8.label === 'qa151' && sameCounts(s8, before8) && s8.reloads === 1 && t8 === BUSY,
      JSON.stringify({ before8, s8, t8 }),
    )

    // ── 8b
    const reset8 = await page.evaluate(() => window.itd.reset())
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => !!document.getElementById('itd-claim') && !!window.itd, { timeout: 20000 })
    const s8b = await st()
    check(
      '8b: itd.reset() снёс itd.claim, F5 → полоса на месте (pagehide записал), счёт тот же, reloads 2',
      reset8.removed.includes('itd.claim') && s8b.active === true && sameCounts(s8b, before8) && s8b.reloads === 2,
      JSON.stringify({ reset8, s8b }),
    )

    // ── 9
    const f9 = await page.evaluate(() => window.itd.claim.stop())
    const after9 = await page.evaluate(() => ({
      bar: !!document.getElementById('itd-claim'),
      title: document.title,
      key: sessionStorage.getItem('itd.claim'),
      state: window.itd.claim.state(),
      again: window.itd.claim.stop(),
      mine: window.itd.claim.mine(),
      allow: window.itd.claim.allow('x'),
      deny: window.itd.claim.deny(),
    }))
    check(
      '9: stop() → итог active:false, полосы нет, заголовок «вкладка свободна», ключа нет, state {active:false}; второй stop — no_claim',
      f9.ok === true && f9.active === false && sameCounts(f9, before8) && !after9.bar && after9.title === 'вкладка свободна' &&
        after9.key === null && after9.state.ok === true && after9.state.active === false &&
        after9.again.ok === false && after9.again.code === 'no_claim' &&
        [after9.mine, after9.allow, after9.deny].every((r) => r.ok === false && r.code === 'no_claim'),
      JSON.stringify({ f9, after9 }),
    )

    // ── 10
    // ITGAME-232: resizes фиксирует смену размеров окна за заход
    const c10 = await page.evaluate(() => window.itd.claim('qa151-resize'))
    await page.setViewport({ width: 1400, height: 1080 })
    await page.waitForFunction(() => (window.itd.claim.state().resizes?.n ?? 0) >= 1, { timeout: 5000 })
    const s10 = await st()
    await page.setViewport({ width: 1920, height: 1080 })
    await page.waitForFunction(() => (window.itd.claim.state().resizes?.n ?? 0) >= 2, { timeout: 5000 })
    const stop10 = await page.evaluate(() => window.itd.claim.stop())
    check(
      '10: resizes — без ресайза n 0; setViewport → resizes.n ≥ 1, last.iw новый; stop() возвращает resizes',
      c10.ok === true && c10.resizes.n === 0 && c10.resizes.last === null && c10.resizes.first.iw === 1920 &&
        s10.active === true && s10.resizes.n >= 1 && s10.resizes.last?.iw === 1400 && s10.resizes.first.iw === 1920 &&
        stop10.ok === true && stop10.resizes.n >= 2 && stop10.resizes.last?.iw === 1920,
      JSON.stringify({ c10, s10, stop10 }),
    )

    check('на странице нет pageerror', pageErrors.length === 0, pageErrors.join(' | '))
  } finally {
    if (browser) await browser.close()
    if (stopServer) await stopServer()
  }
}

await run()

const failed = results.filter((r) => !r.pass)
console.log(`\nИтог QA-ITGAME151: ${results.length - failed.length}/${results.length} проверок прошло`)
if (failed.length > 0) {
  console.error(`Провалено: ${failed.map((f) => f.name).join(', ')}`)
  process.exit(1)
} else {
  console.log('Все проверки пройдены успешно!')
}
