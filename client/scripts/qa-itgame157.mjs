// qa-itgame157 — itd.sprite.pull/watch/unwatch (ITGAME-157, docs/design/sprite-pipeline.md,
// шаг 4): вкладка берёт ревизии из заглушки minipc (lib/minipc-stub.mjs) через Go-ручки
// /api/debug/sprite/*. Текстура байт в байт та же, что ревизия; квитанция несёт taskId,
// rev и sha256; брак ставится и называется; bad_size, unknown_key, not_found, bad_rev
// отказывают; watch подхватывает новую ревизию, unwatch останавливает опрос; reset
// возвращает исходную текстуру.
// Self-serve: заглушка на свободном порту, Go-сервер на QA_PORT (default 4194) поверх
// client/dist (npm run build — заранее). QA_BASE не поддерживается: серверу нужен адрес
// заглушки в окружении.
import { setTimeout as delay } from 'node:timers/promises'
import puppeteer from 'puppeteer-core'
import { chromePath } from './lib/chrome.mjs'
import { waitMenuReady } from './lib/menu.mjs'
import { jobBody, startMinipcStub } from './lib/minipc-stub.mjs'
import { selfServe } from './lib/selfserve.mjs'
import { makePng, rgbaSha, sha256 } from './lib/sprite-fixtures.mjs'

const SELF_PORT = Number(process.env.QA_PORT || 4194)

const results = []
function check(name, pass, fact) {
  results.push({ name, pass, fact })
  console.log(`${pass ? 'PASS' : 'FAIL'}: ${name}${fact !== undefined ? ` — ${JSON.stringify(fact)}` : ''}`)
}

const stub = await startMinipcStub()
const green1 = makePng({ size: 128 }) // cooler: 128px hd32, чистая
const green2 = makePng({ size: 128, fill: 'ef7d57' })
const green3 = makePng({ size: 128, fill: '38b764' })
const offPalette = makePng({ size: 64, fill: 'ff00ff' }) // icon_money: пиксельный sweetie16 — вне палитры
const small = makePng({ size: 32 }) // icon_trophy 64px — bad_size
const job = stub.createJob(jobBody(['cooler', 'icon_money', 'icon_trophy', 'not_in_manifest']))
const T = job.taskId
stub.addRevision(T, 'cooler', green1)
stub.addRevision(T, 'icon_money', offPalette)
stub.addRevision(T, 'icon_trophy', small)

process.env.ITGAME_MINIPC_URL = stub.url
process.env.ITGAME_MINIPC_TOKEN = stub.tokens.go
let stopServer = async () => {}
let base
try {
  ;({ base, stop: stopServer } = await selfServe({ port: SELF_PORT, saves: 'off', label: 'QA-ITGAME157' }))
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e))
  await stub.stop()
  process.exit(1)
}

const browser = await puppeteer.launch({
  executablePath: chromePath(),
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})

// sha256 RGBA текущей текстуры ключа во вкладке — та же мера, что rgbaSha() в Node.
const texSha = (page, key) =>
  page.evaluate(async (k) => {
    const img = window.__itd.textures.get(k).getSourceImage()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const ctx = c.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(img, 0, 0)
    const data = ctx.getImageData(0, 0, c.width, c.height).data
    const h = await crypto.subtle.digest('SHA-256', data)
    return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('')
  }, key)

const waitFor = async (fn, ms = 4000) => {
  const until = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v || Date.now() > until) return v
    await delay(100)
  }
}

try {
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  await page.goto(`${base}/?scenario=fresh&seed=1&debug=1`, { waitUntil: 'domcontentloaded' })
  await waitMenuReady(page)
  const coolerOrig = await texSha(page, 'cooler')

  // P1–P2: pull чистой ревизии — текстура байт в байт, квитанция и list() с происхождением.
  const p1 = await page.evaluate((t) => window.itd.sprite.pull(t, 'cooler', 1), T)
  const p1tex = await texSha(page, 'cooler')
  check('P1: pull(cooler, 1) ставит ревизию, квитанция чистая и с происхождением',
    p1.ok && p1.source === 'pull' && p1.taskId === T && p1.rev === 1 && p1.sha256 === sha256(green1) && p1.problems.length === 0,
    { ok: p1.ok, source: p1.source, taskId: p1.taskId, rev: p1.rev, sha: p1.sha256 === sha256(green1), problems: p1.problems, code: p1.code, error: p1.error })
  check('P1: текстура cooler — пиксели ревизии 1', p1tex === rgbaSha(green1), { tex: p1tex.slice(0, 12), want: rgbaSha(green1).slice(0, 12) })
  const p2 = await page.evaluate(() => ({
    list: window.itd.sprite.list().find((x) => x.key === 'cooler'),
    asset: window.itd.assets().textures.find((a) => a.key === 'cooler'),
  }))
  check('P2: list() — cooler из pull с taskId/rev, itd.assets() — source tried',
    p2.list?.source === 'pull' && p2.list?.taskId === T && p2.list?.rev === 1 && p2.list?.sha256 === sha256(green1) && p2.asset?.source === 'tried',
    { list: p2.list, asset: p2.asset?.source })

  // P3: брак ставится и называется.
  const p3 = await page.evaluate((t) => window.itd.sprite.pull(t, 'icon_money', 1), T)
  check('P3: pull ревизии вне палитры — ставится, problems называет цвета', p3.ok && p3.problems.some((p) => /палитр/i.test(p)), { ok: p3.ok, problems: p3.problems })

  // P4–P5: отказы.
  const p4 = await page.evaluate((t) => window.itd.sprite.pull(t, 'icon_trophy', 1), T)
  check('P4: ревизия не того размера — bad_size, не ставится', !p4.ok && p4.code === 'bad_size', { code: p4.code, error: p4.error })
  const p5 = await page.evaluate(async (t) => ({
    unknown: await window.itd.sprite.pull(t, 'not_in_manifest', 1),
    missing: await window.itd.sprite.pull(t, 'cooler', 9),
    rev0: await window.itd.sprite.pull(t, 'cooler', 0),
    task: await window.itd.sprite.pull('abc', 'cooler', 1),
  }), T)
  check('P5: отказы unknown_key, not_found, bad_rev, bad_task',
    p5.unknown.code === 'unknown_key' && p5.missing.code === 'not_found' && p5.rev0.code === 'bad_rev' && p5.task.code === 'bad_task',
    { unknown: p5.unknown.code, missing: p5.missing.code, rev0: p5.rev0.code, task: p5.task.code })

  // P6: reset возвращает исходную текстуру байт в байт.
  const p6 = await page.evaluate(() => window.itd.sprite.reset())
  const p6tex = await texSha(page, 'cooler')
  check('P6: reset() — cooler снова исходный', p6.ok && p6tex === coolerOrig, { reset: p6.reset })

  // W1: watch ставит latest всех ключей задания из манифеста, чужие ключи — в skipped.
  const w1 = await page.evaluate((t) => window.itd.sprite.watch(t), T)
  const w1rc = Object.fromEntries((w1.receipts ?? []).map((r) => [r.key, r]))
  check('W1: watch — ключи манифеста, not_in_manifest в skipped, первая квитанция по каждому',
    w1.ok && w1.taskId === T && w1.keys.join() === 'cooler,icon_money,icon_trophy' &&
      w1.skipped.some((s) => s.key === 'not_in_manifest' && s.code === 'unknown_key') &&
      w1rc.cooler?.ok && w1rc.cooler.rev === 1 && w1rc.cooler.source === 'watch' && w1rc.icon_trophy?.code === 'bad_size',
    { ok: w1.ok, keys: w1.keys, skipped: w1.skipped, receipts: (w1.receipts ?? []).map((r) => [r.key, r.ok, r.rev, r.code]) })

  // W2: новая ревизия в minipc приезжает во вкладку без вызова.
  stub.addRevision(T, 'cooler', green2)
  const w2 = await waitFor(() => page.evaluate(() => window.itd.sprite.list().find((x) => x.key === 'cooler' && x.rev === 2) ?? null))
  const w2tex = await texSha(page, 'cooler')
  check('W2: ревизия 2 подхвачена опросом за ≤ 4 с, текстура — её пиксели', w2?.source === 'watch' && w2tex === rgbaSha(green2), { list: w2 })

  // W3: unwatch останавливает опрос и отдаёт обновления.
  const w3 = await page.evaluate(() => window.itd.sprite.unwatch())
  stub.addRevision(T, 'cooler', green3)
  await delay(2500)
  const w3after = await page.evaluate(() => window.itd.sprite.list().find((x) => x.key === 'cooler'))
  check('W3: unwatch — updates с ревизией 2, после него ревизия 3 не приезжает',
    w3.ok && w3.taskId === T && w3.updates.some((u) => u.key === 'cooler' && u.rev === 2) && w3after?.rev === 2,
    { ok: w3.ok, updates: (w3.updates ?? []).map((u) => [u.key, u.rev]), after: w3after?.rev })
  const w4 = await page.evaluate(() => window.itd.sprite.unwatch())
  check('W4: повторный unwatch — not_watching', !w4.ok && w4.code === 'not_watching', w4)

  await page.evaluate(() => window.itd.sprite.reset())
  check('ошибок страницы нет', pageErrors.length === 0, pageErrors)
} finally {
  await browser.close()
  await stopServer()
  await stub.stop()
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} PASS`)
process.exit(failed.length ? 1 : 0)
