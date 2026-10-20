// scene-step — открыть шаг «где виден ключ» в своей вкладке self-serve сервера: шаг seenIn
// манифеста ({fixture, scene, open?}) у qa:sprite (ITGAME-157) и место кропа контекста у
// sprite:job (ITGAME-182) — один и тот же путь, чтобы кроп задания и кадр приёмки снимались
// с одного и того же экрана.
//
// Вкладка с зумом scale ('1', '1.4'), ?scenario=<fixture>&seed=1&debug=1; для сцены не
// menu — партия «Обычная» под своим sid (серверные сейвы живут сутки и резюмятся по общему
// ключу) и пауза: кадр не уезжает тиками. open — id для itd.click после загрузки (окно,
// вкладка, кнопка карточки события). frames: false — снять красные рамки интерактива
// ?debug=1 (drawDebugFrames) кнопкой btn.debug HUD: window.itd остаётся, сцены
// перерисовываются по последнему снапшоту — так кроп показывает экран, каким его видит
// игрок. qa:sprite рамки не снимает (его линтеры сверяются до/после в одной вкладке).
import { setTimeout as delay } from 'node:timers/promises'
import { waitMenuReady } from './menu.mjs'

/**
 * @param {import('puppeteer-core').Browser} browser
 * @param {string} base — http://127.0.0.1:<port>
 * @param {{ fixture: string, scene: string, open?: string }} step
 * @param {string} scale — itd.uiScale
 * @param {string} sid — sid партии (уникальный на шаг)
 * @param {{ frames?: boolean }} [opts]
 * @returns {Promise<{ page: import('puppeteer-core').Page, errors: string[] }>}
 */
export async function openStep(browser, base, step, scale, sid, { frames = true } = {}) {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.evaluateOnNewDocument((v) => localStorage.setItem('itd.uiScale', v), scale)
  await page.goto(`${base}/?scenario=${step.fixture}&seed=1&debug=1`, { waitUntil: 'domcontentloaded' })
  await waitMenuReady(page)
  if (step.scene !== 'menu') {
    await page.evaluate((t) => localStorage.setItem('itd.sid', t), sid)
    const clicked = await page.evaluate(() => window.itd.click('menu.diff.normal'))
    if (!clicked.ok) throw new Error(`старт партии: ${JSON.stringify(clicked)}`)
    await page.waitForFunction(() => window.itd.state().connected === true, { timeout: 20000 })
    await page.evaluate(() => window.itd.pause())
  }
  if (step.open) {
    const opened = await page.evaluate((id) => window.itd.click(id), step.open)
    if (!opened.ok) throw new Error(`open '${step.open}': ${JSON.stringify(opened)}`)
  }
  if (!frames && (await page.evaluate(() => window.itd.ids().some((n) => n.id === 'btn.debug')))) {
    const off = await page.evaluate(() => window.itd.click('btn.debug'))
    if (!off.ok) throw new Error(`btn.debug: ${JSON.stringify(off)}`)
  }
  await delay(400)
  return { page, errors }
}

/**
 * Рамка места на сцене (выполняется в странице): объединение мировых рамок узлов ids
 * (itd.nodes(), по центру и размеру) и картинок сцены, чей ключ текстуры подходит под
 * textures и которые с этим объединением пересекаются, плюс pad мировых px. css —
 * прямоугольник для page.screenshot({clip}) по рамке канваса (мир 1280 px в ширину).
 * missing — ids, которых на сцене нет.
 * @param {[string, string[], string | null, number]} args — [scene, ids, textures (RegExp-строка) | null, pad]
 */
export const PLACE_OF_IDS = ([sceneKey, ids, textures, pad]) => {
  const game = window.__itd
  const nodes = window.itd.nodes()
  const boxes = []
  const missing = []
  for (const id of ids) {
    const n = nodes.find((x) => x.id === id && x.scene === sceneKey && x.visible !== false)
    if (!n) missing.push(id)
    else boxes.push({ x0: n.cx - n.w / 2, y0: n.cy - n.h / 2, x1: n.cx + n.w / 2, y1: n.cy + n.h / 2 })
  }
  if (missing.length || !boxes.length) return { missing }
  const u = () => ({
    x0: Math.min(...boxes.map((b) => b.x0)), y0: Math.min(...boxes.map((b) => b.y0)),
    x1: Math.max(...boxes.map((b) => b.x1)), y1: Math.max(...boxes.map((b) => b.y1)),
  })
  const textured = []
  if (textures) {
    const re = new RegExp(textures)
    const around = u()
    const walk = (list) => {
      for (const o of list) {
        if (o.type === 'Image' && o.visible !== false && re.test(String(o.texture?.key ?? ''))) {
          const b = o.getBounds()
          if (b.x <= around.x1 && b.right >= around.x0 && b.y <= around.y1 && b.bottom >= around.y0) {
            boxes.push({ x0: b.x, y0: b.y, x1: b.right, y1: b.bottom })
            textured.push(o.texture.key)
          }
        }
        if (Array.isArray(o.list)) walk(o.list)
      }
    }
    walk(game.scene.getScene(sceneKey).children.list)
  }
  const w = u()
  const r = game.canvas.getBoundingClientRect()
  const k = r.width / 1280
  const x = Math.max(r.left, r.left + (w.x0 - pad) * k)
  const y = Math.max(r.top, r.top + (w.y0 - pad) * k)
  return {
    missing: [],
    world: w,
    textured,
    css: { x, y, width: Math.min(r.right, r.left + (w.x1 + pad) * k) - x, height: Math.min(r.bottom, r.top + (w.y1 + pad) * k) - y },
  }
}
