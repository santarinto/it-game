// qa-itgame46 — журнал живой партии из браузера сходится в реплее (ITGAME-46):
//   J1  партия из меню (normal), sid вкладки
//   J2  настоящие клики HUD (btn.pc, btn.hire), темп 3, команды через itd.cmd — в том
//       числе отказ (fire несуществующего слота)
//   J3  debug: itd.set({money}) и itd.step({ticks}) — тоже входы журнала
//   J3b (ITGAME-138) вирус: itd.restore с заражённым местом и волной через 2 тика, живая
//       волна на 3x (ролл цели — вход реплея), 6 virus_click чистят два места, 7-й —
//       not_infected; J6b — эти команды в журнале с id и отказом
//   J4  перезагрузка страницы на скорости 3 → «Продолжить»: первый снапшот resumed,
//       в журнале запись resume (офлайн-догон посчитан сервером от wall-clock)
//   J5  ещё ход и пауза; GET /api/debug/journal?sid= отдаёт JSONL (application/x-ndjson)
//   J6  в журнале start, cmd (с id из ITGAME-45 и err у отказа), debug, day или нет,
//       resume, end; seq подряд
//   J7  go run ./cmd/replay -json: ok, без расхождений и предупреждений
//   J8  сейв реплея совпадает с сейвом живой партии (GET /api/debug/state) после
//       JSON-круга, темп тоже
//   J9  itd.journal({tail, sid}) — тот же журнал из вкладки: хвост строками и объектами,
//       kinds/total как у эндпоинта, cmd с id, сейвы вырезаны (hasSave), tail вне 1..500 — отказ
//   J10 (ITGAME-91) команда моста агента /ws/agent со своим id1 и F5 посередине: у cmd
//       conn/src, start c1 tab, resume c2+ tab, мост — свой conn и src bridge; id
//       повторяется между соединениями, пара (conn, id) — нет; реплей печатает conns
//   J11 строки itd.journal(): «end disconnect» (F5), « bridge id1», cmd с cN
//   Z   на странице нет pageerror
//
// Self-serve: без QA_BASE поднимает Go-сервер на QA_PORT (по умолчанию :4186) с временным
// каталогом сейвов: resume без стора не бывает. Внешнему серверу (QA_BASE) нужны сейвы и
// ITGAME_DEBUG=1 (журнал пишется только под ним).
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'
import { chromePath } from './lib/chrome.mjs'
import { selfServe } from './lib/selfserve.mjs'

const SELF_PORT = Number(process.env.QA_PORT) || 4186
const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'server')

let stopServer = null
if (!process.env.QA_BASE) {
  try {
    ;({ stop: stopServer } = await selfServe({
      port: SELF_PORT,
      saves: 'tmp',
      label: 'QA-ITGAME46',
    }))
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  }
}
const BASE = process.env.QA_BASE || `http://127.0.0.1:${SELF_PORT}`

const report = []
const note = (name, pass, fact) => report.push({ name, pass, fact })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let browser = null
const binDir = mkdtempSync(join(tmpdir(), 'qa-replay-'))
try {
  browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  await page.evaluateOnNewDocument(() => {
    if (!sessionStorage.getItem('qa46.cleared')) {
      localStorage.clear()
      sessionStorage.setItem('qa46.cleared', '1')
    }
  })
  await page.goto(`${BASE}/?debug=1`, { waitUntil: 'domcontentloaded' })

  // J1
  const j1 = await page.evaluate(async () => {
    await window.itd.wait((s) => s.menuReady === true, 8000)
    window.itd.click('menu.diff.normal')
    await window.itd.wait((s) => s.connected === true, 10000)
    return { sid: window.itd.server().sid, day: window.itd.state().day }
  })
  const sid = j1.sid
  note('J1 партия запущена из меню', !!sid && j1.day === 1, JSON.stringify(j1))

  // J2 — HUD-клики и команды; у fire слота 9 — отказ bad_slot
  const j2 = await page.evaluate(async () => {
    const itd = window.itd
    const out = {}
    out.money = await itd.set({ money: 4000 }).then((r) => r.state.money)
    out.pc = itd.click('btn.pc').ok
    await new Promise((r) => setTimeout(r, 300)) // ПК куплен — место для найма
    out.hire = itd.click('btn.hire').ok
    out.speed = itd.speed(3).ok
    out.motivate = (await itd.cmd('motivate', 0, { slot: 0 })).ok
    out.fire = await itd.cmd('fire', 0, { slot: 9 })
    return out
  })
  await sleep(1500)
  note(
    'J2 клики HUD и команды прошли, отказ дошёл',
    j2.pc && j2.hire && j2.speed && j2.fire.ok === false,
    JSON.stringify(j2),
  )

  // J3 — debug-входы
  const j3 = await page.evaluate(async () => {
    const itd = window.itd
    const set = await itd.set({ money: 9000 })
    const step = await itd.step({ ticks: 20 })
    const sp = itd.speed(3)
    return {
      money: set.state.money,
      ticks: step.advance && step.advance.ticks,
      speed: sp.ok,
    }
  })
  await sleep(1200)
  note('J3 itd.set и itd.step прошли', j3.money === 9000 && j3.ticks === 20 && j3.speed, JSON.stringify(j3))

  // J3b (ITGAME-138) — вирус: itd.restore заражает место 1 при двух сотрудниках и
  // волне через 2 тика, живые тики на 3x катят волну (ролл цели из PCG — вход
  // реплея), virus_click чистит оба места, лишний клик — отказ not_infected.
  const j3b = await page.evaluate(async () => {
    const itd = window.itd
    const snap = await itd.snapshot()
    const o = snap.save.offices[0]
    o.PCs = Math.max(o.PCs, 2)
    o.Employees = [{ ...o.Employees[0], Infected: true, VirusClicks: 0, PCBroken: false }, { ...o.Employees[0], Name: 'Вирус Тестов', Infected: false, PCBroken: false }]
    snap.save.virusWaveIn = 2
    await itd.restore(snap.save)
    itd.speed(3)
    await itd.wait((s) => s.virusPCs === 2, 8000).catch(() => null)
    itd.pause()
    const waved = itd.state().virusPCs
    const clicks = []
    for (const slot of [0, 0, 0, 1, 1, 1]) clicks.push((await itd.cmd('virus_click', 0, { slot })).ok)
    const extra = await itd.cmd('virus_click', 0, { slot: 0 })
    itd.speed(3)
    return { waved, clicks, extra: extra.code, left: itd.state().virusPCs }
  })
  await sleep(600)
  note(
    'J3b вирус: живая волна заразила второе место, 6 кликов вычистили оба, лишний — not_infected',
    j3b.waved === 2 && j3b.clicks.every(Boolean) && j3b.extra === 'not_infected' && j3b.left === 0,
    JSON.stringify(j3b),
  )

  // J4 — перезагрузка на скорости 3 и «Продолжить»
  await page.reload({ waitUntil: 'domcontentloaded' })
  const hasContinue = await page.evaluate(async () => {
    await window.itd.wait((s) => s.menuReady === true, 8000)
    await window.itd.wait(() => window.itd.ids().some((x) => x.id === 'menu.continue'), 5000).catch(() => null)
    return window.itd.ids().some((x) => x.id === 'menu.continue')
  })
  await sleep(1500) // сейв стоит на 3x: офлайн-догон набегает
  const j4 = await page.evaluate(async () => {
    window.itd.click('menu.continue')
    await window.itd.wait((s) => s.connected === true, 10000)
    return { sid: window.itd.server().sid, day: window.itd.state().day }
  })
  note('J4 «Продолжить» поднял ту же партию', hasContinue && j4.sid === sid, JSON.stringify({ hasContinue, ...j4 }))

  // J5 — ещё ход и пауза, журнал
  await page.evaluate(async () => {
    const itd = window.itd
    await itd.cmd('buy_pc', 0)
    await itd.cmd('hire', 0)
  })
  // J10 — мост агента наблюдателем шлёт свою команду с id 1 (ITGAME-91)
  const bridge = await page.evaluate(async (sid) => {
    const ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ws/agent?sid=${encodeURIComponent(sid)}`)
    const reply = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ timeout: true }), 5000)
      ws.onopen = () => ws.send(JSON.stringify({ type: 'buy_pc', office: 0, id: 1 }))
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data)
        if (m.re === 1) {
          clearTimeout(timer)
          resolve({ type: m.type, code: m.code })
        }
      }
    })
    ws.close()
    return reply
  }, sid)
  await page.evaluate(async () => {
    await window.itd.cmd('set_speed', 0, { speed: 0 })
  })
  const resp = await fetch(`${BASE}/api/debug/journal?sid=${encodeURIComponent(sid)}`)
  const journal = await resp.text()
  const ctype = resp.headers.get('content-type') || ''
  note(
    'J5 /api/debug/journal отдал JSONL',
    resp.status === 200 && ctype.startsWith('application/x-ndjson'),
    `${resp.status} ${ctype} ${journal.length} байт`,
  )

  // J6 — виды записей
  const lines = journal
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
  const recs = lines.slice(1)
  const kinds = {}
  for (const r of recs) kinds[r.k] = (kinds[r.k] || 0) + 1
  const seqOk = recs.every((r, i) => i === 0 || r.seq === recs[i - 1].seq + 1)
  const withId = recs.filter((r) => r.k === 'cmd' && r.id > 0).length
  const rejected = recs.filter((r) => r.k === 'cmd' && r.err).map((r) => `${r.type}:${r.err}`)
  const resume = recs.find((r) => r.k === 'resume')
  const virusClicks = recs.filter((r) => r.k === 'cmd' && r.type === 'virus_click')
  note(
    'J6b журнал: virus_click с id, отказ not_infected (ITGAME-138)',
    virusClicks.length === 7 && virusClicks.every((r) => r.id > 0) && virusClicks.filter((r) => r.err === 'not_infected').length === 1,
    JSON.stringify(virusClicks.map((r) => `${r.slot ?? 0}:${r.err ?? 'ok'}`)),
  )
  note(
    'J6 журнал: header, start, cmd с id, отказ, debug, end, resume; seq подряд',
    lines[0].k === 'header' &&
      lines[0].sid === sid &&
      kinds.start === 1 &&
      withId >= 5 &&
      rejected.length >= 1 &&
      kinds.debug >= 3 &&
      kinds.end >= 1 &&
      !!resume &&
      seqOk,
    JSON.stringify({
      kinds,
      withId,
      rejected,
      offline: resume && resume.offline,
      seqOk,
    }),
  )

  // J7 — реплей
  const bin = join(binDir, 'replay')
  execFileSync('go', ['build', '-o', bin, './cmd/replay'], {
    cwd: SERVER_DIR,
    stdio: 'inherit',
  })
  let out
  let code = 0
  try {
    out = execFileSync(bin, ['-json', '-'], { input: journal }).toString()
  } catch (e) {
    code = e.status
    out = e.stdout ? e.stdout.toString() : String(e)
  }
  let res = {}
  try {
    res = JSON.parse(out)
  } catch {
    res = { raw: out }
  }
  note(
    'J7 реплей сошёлся без предупреждений',
    code === 0 && res.ok === true && res.warnings && res.warnings.length === 0,
    JSON.stringify({
      code,
      ok: res.ok,
      records: res.records,
      ticks: res.ticks,
      warnings: res.warnings,
      divergence: res.divergence,
    }),
  )

  // J8 — сейв реплея = сейв живой партии
  const live = await (await fetch(`${BASE}/api/debug/state?sid=${encodeURIComponent(sid)}`)).json()
  const same = JSON.stringify(live.save) === JSON.stringify(res.save)
  note(
    'J8 сейв и темп реплея совпадают с живой партией',
    same && live.state.speed === res.speed,
    JSON.stringify({
      same,
      liveSpeed: live.state.speed,
      replaySpeed: res.speed,
      day: live.state.day,
      money: live.state.money,
    }),
  )

  // J9 — itd.journal(): тот же журнал из вкладки, хвостом, без сейвов
  const j9 = await page.evaluate(async (sid) => {
    const mine = await window.itd.journal({ tail: 5 })
    const other = await window.itd.journal({ sid, tail: 500 })
    let bad = null
    try {
      await window.itd.journal({ tail: 0 })
    } catch (e) {
      bad = String(e.message || e)
    }
    return {
      total: mine.total,
      n: mine.records.length,
      lines: mine.lines,
      kinds: mine.kinds,
      last: mine.records[mine.records.length - 1],
      heavy: other.records.some((r) => 'save' in r || 'state' in r),
      hasSave: other.records.filter((r) => r.hasSave).map((r) => r.k),
      ids: other.records.filter((r) => r.k === 'cmd').map((r) => r.id),
      bad,
      url: mine.url,
      allLines: other.lines,
    }
  }, sid)
  note(
    'J9 itd.journal(): хвост 5 строками, total как у эндпоинта, cmd с id, сейвы вырезаны, tail 0 отказ',
    j9.total === recs.length &&
      j9.n === 5 &&
      j9.lines.length === 5 &&
      /^#\d+ cmd set_speed =0 c\d+ id\d+ ok \| d\d+ t\d+ \$\d+ running 0x rev\d+/.test(j9.lines[4]) &&
      j9.last.k === 'cmd' &&
      j9.last.type === 'set_speed' &&
      JSON.stringify(j9.kinds) === JSON.stringify(kinds) &&
      !j9.heavy &&
      j9.hasSave.includes('resume') &&
      j9.ids.length === withId &&
      /tail/.test(j9.bad || '') &&
      j9.url.includes(encodeURIComponent(sid)),
    JSON.stringify({ total: j9.total, lines: j9.lines, hasSave: j9.hasSave, bad: j9.bad }),
  )

  // J10 — conn/src у команд, пара (conn, id) уникальна, хотя id повторяется
  const cmds = recs.filter((r) => r.k === 'cmd')
  const pairs = cmds.map((r) => `${r.conn}:${r.id}`)
  const idRepeats = new Set(cmds.map((r) => r.id)).size < cmds.length
  const start = recs.find((r) => r.k === 'start')
  const bridgeCmd = cmds.find((r) => r.src === 'bridge')
  const tabConns = new Set(cmds.filter((r) => r.src === 'tab').map((r) => r.conn))
  note(
    'J10 команды с conn/src: start c1 tab, resume c2+ tab, мост — свой conn; id повторяется, (conn, id) — нет; реплей печатает conns',
    !bridge.timeout &&
      cmds.every((r) => r.conn > 0 && (r.src === 'tab' || r.src === 'bridge')) &&
      new Set(pairs).size === pairs.length &&
      idRepeats &&
      start && start.conn === 1 && start.src === 'tab' &&
      resume && resume.conn > 1 && resume.src === 'tab' &&
      bridgeCmd && bridgeCmd.id === 1 && !tabConns.has(bridgeCmd.conn) &&
      res.conns && res.conns[String(bridgeCmd.conn)] === 'bridge' && res.conns['1'] === 'tab',
    JSON.stringify({ bridge, pairs, start: start && [start.conn, start.src], resume: resume && [resume.conn, resume.src], conns: res.conns }),
  )

  // J11 — строки itd.journal(): end F5 расшифрован, мост и соединения видны
  note(
    'J11 строки журнала: «end disconnect», « bridge id1», cmd с cN',
    j9.allLines.some((l) => /^#\d+ end disconnect \|/.test(l)) &&
      j9.allLines.some((l) => / c\d+ bridge id1 /.test(l)) &&
      j9.allLines.some((l) => /^#\d+ resume c\d+ offline \d+t/.test(l)) &&
      j9.allLines.some((l) => /^#\d+ start c1 \|/.test(l)),
    JSON.stringify(j9.allLines.filter((l) => / (start|resume|end) | bridge /.test(l))),
  )

  note('Z нет pageerror', pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 3)))
} finally {
  if (browser) await browser.close()
  if (stopServer) await stopServer()
  rmSync(binDir, { recursive: true, force: true })
}

let failed = 0
for (const r of report) {
  if (!r.pass) failed++
  console.log(`${r.pass ? 'PASS' : 'FAIL'}: ${r.name} — ${r.fact}`)
}
console.log(failed === 0 ? '\nQA ITGAME-46: ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : `\nQA ITGAME-46: ПРОВАЛОВ — ${failed}`)
process.exit(failed === 0 ? 0 : 1)
