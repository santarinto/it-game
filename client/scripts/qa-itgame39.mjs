// qa-itgame39 — машинный контракт itd.contract() (ITGAME-39):
//   A1  schema === 1
//   A2  version.hash — 12 hex-символов; version.sha/builtAt === itd.version
//   A3  Object.keys(contract().methods) (сортированные) === Object.keys(window.itd)
//       (сортированные) — контракт описывает РОВНО факасад, без дублей/пропусков
//   A4  у каждого метода в contract().methods — непустой doc
//   A5  types содержит AgentNode, CmdReceipt, AgentServer, ServerErrorCode
//   A6  types.ServerErrorCode — enum, значения включают equipment_already
//   A7  contract() — новый объект при каждом вызове (structuredClone):
//       мутация результата не протекает во второй вызов
//   A8  hash стабилен между двумя вызовами contract() в одной сессии
//   + на странице нет pageerror
//
// Self-serve: без QA_BASE поднимает Go-сервер на QA_PORT (по умолчанию
// :4178 — свой порт задачи; 4179 у qa:tabs, 4173–4177 у соседних скриптов).
import { existsSync } from 'node:fs'
import { selfServe } from './lib/selfserve.mjs'
import puppeteer from 'puppeteer-core'

const SELF_PORT = Number(process.env.QA_PORT) || 4178

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

async function run() {
  let stopServer = null
  if (!process.env.QA_BASE) {
    try {
      ;({ stop: stopServer } = await selfServe({ port: SELF_PORT, saves: 'off', label: 'QA-ITGAME39' }))
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

    const sid = 'qa39-' + Date.now().toString(36)
    await page.evaluateOnNewDocument((sid) => {
      try {
        sessionStorage.setItem('itd.sid', sid)
      } catch {
        // приватная вкладка/заблокированное хранилище — не критично для QA
      }
    }, sid)

    await page.goto(`${BASE}/?scenario=fresh&seed=1&debug=1`, { waitUntil: 'domcontentloaded' })
    await waitMenuReady(page)

    const data = await page.evaluate(() => {
      const c1 = window.itd.contract()
      const c2 = window.itd.contract()
      // Мутация первого результата не должна протечь во второй вызов
      // (contract() — structuredClone, не общая ссылка на кэш модуля).
      c1.methods.state.doc = 'МУТИРОВАНО'
      const c3 = window.itd.contract()
      return {
        c1: JSON.parse(JSON.stringify(c1)),
        c2Hash: c2.version.hash,
        c3StateDoc: c3.methods.state.doc,
        itdKeys: Object.keys(window.itd),
        itdVersion: window.itd.version,
      }
    })
    const { c1: contract, c2Hash, c3StateDoc, itdKeys, itdVersion } = data

    // ── A1: schema
    check('A1: schema === 1', contract.schema === 1, `schema=${contract.schema}`)

    // ── A2: version.hash формат + sha/builtAt совпадают с itd.version
    check(
      'A2: version.hash — 12 hex-символов',
      typeof contract.version.hash === 'string' && /^[0-9a-f]{12}$/.test(contract.version.hash),
      `hash=${contract.version.hash}`,
    )
    check(
      'A2: version.sha/builtAt === itd.version',
      contract.version.sha === itdVersion.sha && contract.version.builtAt === itdVersion.builtAt,
      JSON.stringify({ contract: { sha: contract.version.sha, builtAt: contract.version.builtAt }, itd: itdVersion }),
    )

    // ── A3: методы контракта === реальные ключи window.itd (без дублей/пропусков)
    const methodKeys = Object.keys(contract.methods).sort()
    const realKeys = itdKeys.sort()
    check(
      'A3: Object.keys(contract().methods) === Object.keys(window.itd)',
      JSON.stringify(methodKeys) === JSON.stringify(realKeys),
      `methods=${methodKeys.length} itd=${realKeys.length}` +
        (JSON.stringify(methodKeys) === JSON.stringify(realKeys)
          ? ''
          : ` diff=${JSON.stringify({ onlyContract: methodKeys.filter((k) => !realKeys.includes(k)), onlyItd: realKeys.filter((k) => !methodKeys.includes(k)) })}`),
    )

    // ── A4: у каждого метода — непустой doc
    const emptyDocs = Object.entries(contract.methods)
      .filter(([, spec]) => !spec.doc || spec.doc.trim().length === 0)
      .map(([name]) => name)
    check('A4: у каждого метода contract().methods — непустой doc', emptyDocs.length === 0, JSON.stringify(emptyDocs))

    // ── A5: обязательные типы присутствуют
    const requiredTypes = ['AgentNode', 'CmdReceipt', 'AgentServer', 'ServerErrorCode']
    const missingTypes = requiredTypes.filter((t) => !(t in contract.types))
    check('A5: types содержит AgentNode/CmdReceipt/AgentServer/ServerErrorCode', missingTypes.length === 0, JSON.stringify(missingTypes))

    // ── A6: ServerErrorCode — enum с equipment_already
    const sec = contract.types.ServerErrorCode
    check(
      'A6: types.ServerErrorCode — enum, значения включают equipment_already',
      sec?.kind === 'enum' && Array.isArray(sec.values) && sec.values.includes('equipment_already'),
      JSON.stringify(sec),
    )

    // ── A7: мутация результата contract() не протекает в следующий вызов
    check(
      'A7: contract() — новый объект при каждом вызове (мутация не протекает)',
      c3StateDoc !== 'МУТИРОВАНО' && typeof c3StateDoc === 'string' && c3StateDoc.length > 0,
      `c3StateDoc=${JSON.stringify(c3StateDoc)}`,
    )

    // ── A8: hash стабилен между вызовами в одной сессии
    check('A8: hash стабилен между вызовами contract()', contract.version.hash === c2Hash, `${contract.version.hash} vs ${c2Hash}`)

    // ── нет ошибок на странице за весь прогон
    check('на странице нет pageerror', pageErrors.length === 0, pageErrors.join(' | '))
  } finally {
    await browser.close()
    if (stopServer) await stopServer()
  }
}

await run()

const failed = results.filter((r) => !r.pass)
console.log(`\nИтог QA-ITGAME39: ${results.length - failed.length}/${results.length} проверок прошло`)
if (failed.length > 0) {
  console.error(`Провалено: ${failed.map((f) => f.name).join(', ')}`)
  process.exit(1)
} else {
  console.log('Все проверки пройдены успешно!')
}
