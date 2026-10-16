// QA сценарий ITGAME-118: «Ранний сигнал обречённой партии» — плашка
// «До банкротства N дней» с кнопкой «Сдаться» на Hard/Hardcore.
//
// Запуск из корня проекта:
//   node client/scripts/qa-itgame118.mjs     (npm run qa:doom в client/)
//
// Self-serve: без QA_BASE поднимает Go-сервер на QA_PORT (по умолчанию :4188,
// ITGAME_DEBUG=1 — itd.scenario/itd.set/itd.advanceDays ходят в /api/debug/*).
//   D1  Hard + itd.scenario('doomed_debt'): state.bankruptInDays > 0, плашка hud.doom
//       с «До банкротства N …», кнопки hud.doom.surrender и hud.doom.close, строка в журнале
//   D2  настоящий клик по hud.doom.close: плашка снята; через тики того же дня не возвращается
//   D3  следующий день (advanceDays(1), утро): плашка снова, N на 1 меньше
//   D4  настоящий клик по «Сдаться»: окно «Удалить партию навсегда?», партия на паузе;
//       «Отмена» — окна нет, скорость вернулась, партия жива
//   D5  плашка не пересекается с текстами (itd.overlaps пуст), не за экраном, ошибок нет
//   D6  itd.scenario('fresh'): плашки нет, bankruptInDays 0
//   D7  Normal + doomed_debt: bankruptInDays 0, плашки нет
import puppeteer from 'puppeteer-core'
import { chromePath } from './lib/chrome.mjs'
import { selfServe } from './lib/selfserve.mjs'

const SELF_PORT = Number(process.env.QA_PORT) || 4188

let stopServer = null
if (!process.env.QA_BASE) {
  try {
    ;({ stop: stopServer } = await selfServe({ port: SELF_PORT, saves: 'off', label: 'QA-ITGAME118' }))
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  }
}
const BASE = process.env.QA_BASE || `http://127.0.0.1:${SELF_PORT}`

const report = []
const note = (name, pass, fact) => report.push({ name, pass, fact })

// Настоящий клик мышью в точку объекта из itd.screen(): строка «safe|текст|x|y|флаги»,
// safe — id с «:» вместо «.» (как в qa:buttons R4).
async function realClick(page, id) {
  const row = await page.evaluate((safe) => window.itd.screen().items.find((i) => i.startsWith(safe + '|')) ?? null, id.replaceAll('.', ':'))
  const cols = row ? row.split('|') : []
  const x = Number(cols[2])
  const y = Number(cols[3])
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, row }
  await page.mouse.click(x, y)
  return { ok: true, row }
}

const doomIds = () => window.itd.ids().map((x) => x.id).filter((id) => id && id.startsWith('hud.doom'))

let browser = null
try {
  browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1600,1000'],
    defaultViewport: { width: 1600, height: 1000 },
  })
  const page = await browser.newPage()
  await page.evaluateOnNewDocument(() => localStorage.clear())
  await page.goto(`${BASE}/?debug=1`, { waitUntil: 'domcontentloaded' })

  // D1 — Hard, обречённая партия
  const d1 = await page.evaluate(async (doomIdsSrc) => {
    const doomIds = new Function(`return (${doomIdsSrc})()`)
    await window.itd.wait((s) => s.menuReady === true, 8000)
    window.itd.click('menu.diff.hard')
    await window.itd.wait((s) => s.connected === true && s.phase === 'running', 10000)
    await window.itd.pause()
    await window.itd.scenario('doomed_debt')
    await window.itd.wait((s) => s.scenario === 'doomed_debt', 10000)
    await window.itd.wait(() => window.itd.ids().some((x) => x.id === 'hud.doom'), 5000).catch(() => null)
    const node = window.itd.nodes().find((n) => n.id === 'hud.doom.text')
    return {
      diff: window.itd.state().difficulty,
      days: window.itd.state().bankruptInDays,
      ids: doomIds(),
      text: node ? node.text : null,
      log: window.itd.log().filter((e) => e.type === 'log' || e.type === 'toast').map((e) => e.text).filter((t) => /банкрот/i.test(t || '')),
    }
  }, doomIds.toString())
  note(
    'D1: Hard + doomed_debt — bankruptInDays > 0, плашка с текстом и двумя кнопками',
    d1.diff === 'hard' && d1.days > 0 &&
      ['hud.doom', 'hud.doom.text', 'hud.doom.surrender', 'hud.doom.close'].every((id) => d1.ids.includes(id)) &&
      typeof d1.text === 'string' && d1.text.startsWith(`До банкротства ${d1.days} `),
    JSON.stringify(d1),
  )

  // D5 — раскладка с плашкой на экране
  const d5 = await page.evaluate(() => ({
    overlaps: window.itd.overlaps(),
    offscreen: window.itd.offscreen().filter((x) => String(x.id || '').startsWith('hud.doom')),
    errors: window.itd.errors(),
  }))
  note('D5: плашка не наезжает на тексты, не за экраном, ошибок нет',
    d5.overlaps.length === 0 && d5.offscreen.length === 0 && d5.errors.length === 0, JSON.stringify(d5))

  // D2 — «×» настоящим кликом, тики того же дня плашку не возвращают
  const c2 = await realClick(page, 'hud.doom.close')
  const d2 = await page.evaluate(async (doomIdsSrc) => {
    const doomIds = new Function(`return (${doomIdsSrc})()`)
    await new Promise((r) => setTimeout(r, 200))
    const after = doomIds()
    await window.itd.step({ ticks: 6 })
    await new Promise((r) => setTimeout(r, 200))
    return { after, later: doomIds(), day: window.itd.state().day, days: window.itd.state().bankruptInDays }
  }, doomIds.toString())
  note('D2: «×» снимает плашку, в тот же день она не возвращается',
    c2.ok && d2.after.length === 0 && d2.later.length === 0 && d2.days === d1.days, JSON.stringify({ c2, d2 }))

  // D3 — следующий день: плашка снова, N − 1
  const d3 = await page.evaluate(async (doomIdsSrc) => {
    const doomIds = new Function(`return (${doomIdsSrc})()`)
    const day0 = window.itd.state().day
    await window.itd.advanceDays(1)
    await window.itd.pause()
    await window.itd.wait((s) => s.day === day0 + 1 && s.phase === 'running', 10000)
    await window.itd.wait(() => window.itd.ids().some((x) => x.id === 'hud.doom'), 5000).catch(() => null)
    const node = window.itd.nodes().find((n) => n.id === 'hud.doom.text')
    return { day0, day: window.itd.state().day, days: window.itd.state().bankruptInDays, ids: doomIds(), text: node ? node.text : null }
  }, doomIds.toString())
  note('D3: утро следующего дня — плашка снова, N на 1 меньше',
    d3.day === d3.day0 + 1 && d3.days === d1.days - 1 && d3.ids.includes('hud.doom') &&
      typeof d3.text === 'string' && d3.text.startsWith(`До банкротства ${d3.days} `),
    JSON.stringify(d3))

  // D4 — «Сдаться» настоящим кликом: подтверждение, пауза; «Отмена» возвращает игру
  await page.evaluate(async () => {
    await window.itd.speed(1)
    await window.itd.wait((s) => s.speed === 1, 5000)
  })
  const c4 = await realClick(page, 'hud.doom.surrender')
  const d4 = await page.evaluate(async () => {
    await window.itd.wait((s) => s.speed === 0, 5000).catch(() => null)
    const modal = window.itd.ids().map((x) => x.id).filter((id) => id && id.startsWith('modal.'))
    const title = window.itd.nodes().some((n) => n.text === 'Удалить партию навсегда?')
    const speedIn = window.itd.state().speed
    return { modal, title, speedIn }
  })
  const cancel = d4.modal.includes('modal.btn.1') ? await realClick(page, 'modal.btn.1') : { ok: false }
  const d4b = await page.evaluate(async () => {
    await window.itd.wait((s) => s.speed === 1, 5000).catch(() => null)
    return {
      modal: window.itd.ids().map((x) => x.id).filter((id) => id && id.startsWith('modal.')),
      speed: window.itd.state().speed,
      phase: window.itd.state().phase,
      connected: window.itd.state().connected,
    }
  })
  note('D4: «Сдаться» — «Удалить партию навсегда?» на паузе; «Отмена» — назад в игру со скоростью',
    c4.ok && d4.title && d4.speedIn === 0 && cancel.ok && d4b.modal.length === 0 && d4b.speed === 1 &&
      d4b.phase === 'running' && d4b.connected,
    JSON.stringify({ c4, d4, cancel, d4b }))

  // D6 — сброс партии сценарием снимает плашку
  const d6 = await page.evaluate(async (doomIdsSrc) => {
    const doomIds = new Function(`return (${doomIdsSrc})()`)
    await window.itd.pause()
    await window.itd.scenario('fresh')
    await window.itd.wait((s) => s.scenario === 'fresh', 10000)
    await new Promise((r) => setTimeout(r, 200))
    return { ids: doomIds(), days: window.itd.state().bankruptInDays }
  }, doomIds.toString())
  note('D6: itd.scenario(fresh) — плашки нет, bankruptInDays 0', d6.ids.length === 0 && d6.days === 0, JSON.stringify(d6))

  // D7 — Normal: кредита нет, сигнала нет
  const p7 = await browser.newPage()
  await p7.evaluateOnNewDocument(() => localStorage.clear())
  await p7.goto(`${BASE}/?debug=1`, { waitUntil: 'domcontentloaded' })
  const d7 = await p7.evaluate(async (doomIdsSrc) => {
    const doomIds = new Function(`return (${doomIdsSrc})()`)
    await window.itd.wait((s) => s.menuReady === true, 8000)
    window.itd.click('menu.diff.normal')
    await window.itd.wait((s) => s.connected === true && s.phase === 'running', 10000)
    await window.itd.pause()
    await window.itd.scenario('doomed_debt')
    await window.itd.wait((s) => s.scenario === 'doomed_debt', 10000)
    await new Promise((r) => setTimeout(r, 300))
    return { diff: window.itd.state().difficulty, days: window.itd.state().bankruptInDays, ids: doomIds(), errors: window.itd.errors() }
  }, doomIds.toString())
  note('D7: Normal + doomed_debt — bankruptInDays 0, плашки нет',
    d7.diff === 'normal' && d7.days === 0 && d7.ids.length === 0 && d7.errors.length === 0, JSON.stringify(d7))
  await p7.close()
} finally {
  if (browser) await browser.close()
  if (stopServer) await stopServer()
}

let failed = 0
for (const r of report) {
  if (!r.pass) failed++
  console.log(`${r.pass ? 'PASS' : 'FAIL'}: ${r.name} — ${r.fact}`)
}

console.log(failed === 0 ? '\nQA ITGAME-118: ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : `\nQA ITGAME-118: ПРОВАЛОВ — ${failed}`)
process.exit(failed === 0 ? 0 : 1)
