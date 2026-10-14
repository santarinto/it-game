// qa-itgame119 — itd.sprite.try/reset/list (ITGAME-119): подмена текстуры по ключу
// манифеста во вкладке, квитанция контракта, возврат исходной текстуры.
// Self-serve: без QA_BASE поднимает Go-сервер на QA_PORT (default 4187) поверх
// client/dist + bin/itdirector (npm run build — заранее), как qa-office-slots.mjs.
import { setTimeout as delay } from 'node:timers/promises'
import puppeteer from 'puppeteer-core'
import { chromePath } from './lib/chrome.mjs'
import { selfServe } from './lib/selfserve.mjs'

const SELF_PORT = Number(process.env.QA_PORT || 4187)
const BASE = process.env.QA_BASE || `http://127.0.0.1:${SELF_PORT}`

const results = []
function check(name, pass, fact) {
  results.push({ name, pass, fact })
  console.log(`${pass ? 'PASS' : 'FAIL'}: ${name}${fact !== undefined ? ` — ${JSON.stringify(fact)}` : ''}`)
}

let stopServer = async () => {}
if (!process.env.QA_BASE) {
  try {
    ;({ stop: stopServer } = await selfServe({ port: SELF_PORT, saves: 'off', label: 'QA-ITGAME119' }))
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

try {
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  await page.goto(`${BASE}/?scenario=mid_day10&seed=1&debug=1`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => window.itd != null && window.itd.ids().some((n) => n.id === 'menu.diff.normal'),
    { timeout: 20000 },
  )
  await page.evaluate(() => localStorage.setItem('itd.sid', 'qa119-' + Date.now().toString(36)))
  await page.evaluate(() => window.itd.click('menu.diff.normal'))
  await page.waitForFunction(() => window.itd.state().connected === true, { timeout: 20000 })
  await page.evaluate(() => window.itd.pause())
  await delay(300)

  // Помощники во вкладке: PNG из текущей текстуры ключа с закрашенным блоком;
  // подпись пикселей текстуры; живые объекты, нарисованные ключом.
  await page.evaluate(() => {
    const game = window.__itd // игра Phaser под ?debug=1, как в qa-office-slots.mjs
    const canvasOf = (key) => {
      const src = game.textures.get(key).getSourceImage()
      const c = document.createElement('canvas')
      c.width = src.width
      c.height = src.height
      c.getContext('2d').drawImage(src, 0, 0)
      return c
    }
    window.qa119 = {
      sig: (key) => canvasOf(key).toDataURL('image/png'),
      // блок 16×16 в (x0, y0) цветом hex поверх текущей текстуры
      variant(key, hex, x0 = 56, y0 = 56) {
        const c = canvasOf(key)
        const ctx = c.getContext('2d')
        ctx.fillStyle = '#' + hex
        ctx.fillRect(x0, y0, 16, 16)
        return c.toDataURL('image/png')
      },
      blank(w, h, hex) {
        const c = document.createElement('canvas')
        c.width = w
        c.height = h
        const ctx = c.getContext('2d')
        ctx.fillStyle = '#' + hex
        ctx.fillRect(w / 4, h / 4, w / 2, h / 2)
        return c.toDataURL('image/png')
      },
      pixel(key, x, y) {
        const d = canvasOf(key).getContext('2d').getImageData(x, y, 1, 1).data
        return [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('')
      },
      users(key) {
        let n = 0
        const walk = (list) => {
          for (const o of list) {
            if (o.texture && o.texture.key === key) n++
            if (Array.isArray(o.list)) walk(o.list)
          }
        }
        for (const s of game.scene.getScenes(false)) walk(s.children.list)
        return n
      },
    }
  })

  const KEY = 'desk_pc'
  const before = await page.evaluate((k) => ({ sig: window.qa119.sig(k), users: window.qa119.users(k) }), KEY)
  check('S0: на mid_day10 есть живые объекты с ключом desk_pc', before.users > 0, before.users)

  // S1: чистая подмена — цвет палитры hd32
  const s1 = await page.evaluate(async (k) => {
    const r = await window.itd.sprite.try(k, window.qa119.variant(k, 'b13e53'))
    return { r, px: window.qa119.pixel(k, 60, 60), users: window.qa119.users(k) }
  }, KEY)
  check('S1: try → ok, без нарушений, размер 128×128', s1.r.ok && s1.r.problems.length === 0 && s1.r.w === 128 && s1.r.h === 128, s1.r)
  check('S1: текстура ключа несёт новый пиксель b13e53', s1.px === 'b13e53', s1.px)
  check('S1: живые объекты перевешены на новую текстуру (objects = их число)', s1.r.objects === before.users && s1.users === before.users, { objects: s1.r.objects, users: s1.users })
  check('S1: sha256 — 64 hex (localhost — secure context)', /^[0-9a-f]{64}$/.test(s1.r.sha256 ?? ''), s1.r.sha256)

  // S2: list
  const s2 = await page.evaluate(() => window.itd.sprite.list())
  check('S2: list() называет подменённый ключ', s2.length === 1 && s2[0].key === KEY && s2[0].w === 128, s2)

  // S3: кадр после подмены рисуется без ошибок
  await delay(300)
  check('S3: после подмены кадры идут без pageerror', pageErrors.length === 0, pageErrors)

  // S4: нарушение контракта ставится, но названо
  const s4 = await page.evaluate(async (k) => {
    const r = await window.itd.sprite.try(k, window.qa119.variant(k, 'ff00ff'))
    return { r, px: window.qa119.pixel(k, 60, 60) }
  }, KEY)
  check('S4: цвет вне палитры — ok:true, problems называет ff00ff, текстура стоит', s4.r.ok && s4.r.problems.some((p) => p.includes('вне палитры hd32: ff00ff')) && s4.px === 'ff00ff', s4)

  // S5: ключ сцены, которая сейчас не показана
  const s5 = await page.evaluate(async () => {
    const k = 'rack_server'
    const r = await window.itd.sprite.try(k, window.qa119.variant(k, 'b13e53'))
    return { r, px: window.qa119.pixel(k, 60, 60) }
  })
  check('S5: try ключа серверной при открытом офисе — ok', s5.r.ok && s5.px === 'b13e53', s5.r)

  // S6: повторный try, затем reset → ИСХОДНАЯ текстура
  const s6 = await page.evaluate((k) => {
    const r = window.itd.sprite.reset(k)
    return { r, sig: window.qa119.sig(k), users: window.qa119.users(k), list: window.itd.sprite.list().map((t) => t.key) }
  }, KEY)
  check('S6: reset(key) после двух try возвращает исходные пиксели байт в байт', s6.r.ok && s6.sig === before.sig, { ok: s6.r.ok, same: s6.sig === before.sig })
  check('S6: объекты на месте, в list() ключа нет', s6.users === before.users && !s6.list.includes(KEY), { users: s6.users, list: s6.list })

  // S7: fallback-ключи независимы
  const s7 = await page.evaluate(async () => {
    const off = window.qa119.sig('desk_pc_off')
    const r = await window.itd.sprite.try('desk_pc', window.qa119.variant('desk_pc', 'b13e53'))
    const same = window.qa119.sig('desk_pc_off') === off
    window.itd.sprite.reset('desk_pc')
    return { ok: r.ok, same }
  })
  check('S7: try(desk_pc) не меняет текстуру desk_pc_off', s7.ok && s7.same, s7)

  // S8: отказы
  const s8 = await page.evaluate(async (k) => {
    const sig = window.qa119.sig(k)
    const out = {
      unknown: await window.itd.sprite.try('no_such_key', window.qa119.variant(k, 'b13e53')),
      notPng: await window.itd.sprite.try(k, 'hello'),
      broken: await window.itd.sprite.try(k, 'data:image/png;base64,AAAA'),
      size: await window.itd.sprite.try(k, window.qa119.blank(64, 64, 'b13e53')),
      resetUntouched: window.itd.sprite.reset('router'),
    }
    return { out, same: window.qa119.sig(k) === sig }
  }, KEY)
  check('S8: ключ вне манифеста → unknown_key', s8.out.unknown.ok === false && s8.out.unknown.code === 'unknown_key', s8.out.unknown)
  check('S8: не data URL PNG → bad_src', s8.out.notPng.ok === false && s8.out.notPng.code === 'bad_src', s8.out.notPng)
  check('S8: битое тело PNG → bad_src', s8.out.broken.ok === false && s8.out.broken.code === 'bad_src', s8.out.broken)
  check('S8: 64×64 при контракте 128×128 → bad_size', s8.out.size.ok === false && s8.out.size.code === 'bad_size', s8.out.size)
  check('S8: reset неподменённого ключа → not_tried', s8.out.resetUntouched.ok === false && s8.out.resetUntouched.code === 'not_tried', s8.out.resetUntouched)
  check('S8: после отказов текстура ключа не тронута', s8.same, s8.same)

  // S9: без crypto.subtle (не secure context) try работает, sha256 = null
  const s9 = await page.evaluate(async (k) => {
    const subtle = Object.getOwnPropertyDescriptor(Crypto.prototype, 'subtle')
    Object.defineProperty(Crypto.prototype, 'subtle', { get: () => undefined, configurable: true })
    try {
      return await window.itd.sprite.try(k, window.qa119.variant(k, 'b13e53'))
    } finally {
      Object.defineProperty(Crypto.prototype, 'subtle', subtle)
    }
  }, KEY)
  check('S9: без crypto.subtle — ok:true, sha256 null', s9.ok === true && s9.sha256 === null, s9)

  // S10: reset() без ключа снимает всё
  const s10 = await page.evaluate((k) => {
    const r = window.itd.sprite.reset()
    return { r, list: window.itd.sprite.list(), same: window.qa119.sig(k) }
  }, KEY)
  check('S10: reset() без ключа возвращает все подменённые', s10.r.ok && s10.r.reset.includes(KEY) && s10.r.reset.includes('rack_server') && s10.list.length === 0 && s10.same === before.sig, s10.r)

  await delay(300)
  check('Ошибок на странице нет', pageErrors.length === 0, pageErrors)
} finally {
  await browser.close()
  await stopServer()
}

const failed = results.filter((r) => !r.pass)
console.log(`\nИтог QA ITGAME-119: ${results.length - failed.length}/${results.length} проверок прошло`)
process.exit(failed.length ? 1 : 0)
