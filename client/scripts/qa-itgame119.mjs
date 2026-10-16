// qa-itgame119 — itd.sprite.try/reset/list (ITGAME-119): подмена текстуры по ключу
// манифеста во вкладке, квитанция контракта, возврат исходной текстуры.
// Self-serve: без QA_BASE поднимает Go-сервер на QA_PORT (default 4187) поверх
// client/dist + bin/itdirector (npm run build — заранее), как qa-office-slots.mjs.
import { setTimeout as delay } from 'node:timers/promises'
import puppeteer from 'puppeteer-core'
import { chromePath } from './lib/chrome.mjs'
import { selfServe } from './lib/selfserve.mjs'
import { waitMenuReady } from './lib/menu.mjs'

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
  await waitMenuReady(page)
  // T1: место icon_trophy в меню (ITGAME-83) — иконка 16px у «Достижений»; проба 64px
  // перевешивает её и сохраняет экранный размер, reset возвращает заглушку.
  const t1 = await page.evaluate(async () => {
    const game = window.__itd
    const icons = game.scene.getScene('menu').children.list.filter((o) => o.texture?.key === 'icon_trophy')
    const size = () => icons.map((o) => [Math.round(o.displayWidth), Math.round(o.displayHeight)])
    const before = size()
    const c = document.createElement('canvas')
    c.width = 64
    c.height = 64
    const ctx = c.getContext('2d')
    ctx.fillStyle = '#41a6f6'
    ctx.fillRect(16, 16, 32, 32)
    const r = await window.itd.sprite.try('icon_trophy', c.toDataURL('image/png'), { filter: 'linear' })
    const after = size()
    const reset = window.itd.sprite.reset('icon_trophy')
    return { n: icons.length, before, after, ok: r.ok, objects: r.objects, problems: r.problems, reset: reset.ok }
  })
  check('T1: в меню одна иконка icon_trophy 16×16', t1.n === 1 && t1.before[0]?.[0] === 16 && t1.before[0]?.[1] === 16, t1)
  check('T1: try(icon_trophy, 64px, linear) перевешивает её и держит 16×16, reset ok', t1.ok && t1.objects === 1 && t1.after[0]?.[0] === 16 && t1.after[0]?.[1] === 16 && t1.reset, t1)

  // T2–T3: icon_trophy — render: smooth (ITGAME-83): BootScene ставит LINEAR, try без
  // опций берёт фильтр ключа, явный nearest его перекрывает, reset — снова LINEAR.
  const t2 = await page.evaluate(async () => {
    const game = window.__itd
    const gl = () => { const t = game.textures.get('icon_trophy').source[0].glTexture; return t ? t.minFilter : null }
    const boot = gl()
    const c = document.createElement('canvas')
    c.width = 64
    c.height = 64
    c.getContext('2d').fillRect(16, 16, 32, 32)
    const src = c.toDataURL('image/png')
    const dflt = await window.itd.sprite.try('icon_trophy', src)
    const dfltGl = gl()
    const near = await window.itd.sprite.try('icon_trophy', src, { filter: 'nearest' })
    const nearGl = gl()
    window.itd.sprite.reset('icon_trophy')
    return { boot, dflt: dflt.filter, dfltGl, near: near.filter, nearGl, back: gl() }
  })
  check('T2: icon_trophy (render: smooth) грузится с LINEAR', t2.boot === 9729, t2)
  check('T3: try без опций на smooth-ключе → linear; явный nearest перекрывает; reset → LINEAR', t2.dflt === 'linear' && t2.dfltGl === 9729 && t2.near === 'nearest' && t2.nearGl === 9728 && t2.back === 9729, t2)
  const t4 = await page.evaluate(() => window.itd.assets().textures.find((t) => t.key === 'icon_trophy'))
  check('T4: assets() — icon_trophy render: smooth, offPalette пуст (палитра у smooth не контракт)', t4?.render === 'smooth' && t4.offPalette.length === 0, { render: t4?.render, off: t4?.offPalette.length })

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

  // A1–A3: подмена видна в аудите — visreg/QA не примут пробу за эталон
  const a = await page.evaluate(async (k) => {
    await window.itd.sprite.try(k, window.qa119.variant(k, 'ff00ff'))
    const row = (key) => window.itd.assets().textures.find((t) => t.key === key)
    const set = (key) => window.itd.assetSet().find((t) => t.key === key)
    const tried = { row: row(k), set: set(k) }
    window.itd.sprite.reset(k)
    return { tried, back: { row: row(k), set: set(k) }, help: window.itd.help().includes('itd.sprite.try(') }
  }, KEY)
  check('A1: assets() помечает подменённый ключ source: tried и видит ff00ff вне палитры', a.tried.row.source === 'tried' && a.tried.row.offPalette.includes('#ff00ff'), a.tried.row)
  check('A2: assetSet() — active: tried; после reset снова png', a.tried.set.active === 'tried' && a.back.set.active === 'png' && a.back.row.source === 'png', { tried: a.tried.set, back: a.back.set })
  check('A3: help() описывает itd.sprite.try', a.help === true, a.help)

  // C1: оригинал — кодоген-canvas из CanvasPool (ключ без PNG). remove() отдаёт canvas
  // пулу, следующий add.text его забирает — reset обязан вернуть СВОЙ оригинал, а
  // объект на кодогене (16px, растянут до 32) — сохранить экранный размер.
  const c1 = await page.evaluate(async () => {
    const game = window.__itd
    const k = 'icon_money'
    const scene = game.scene.getScenes(true)[0]
    game.textures.remove(k)
    const ct = game.textures.createCanvas(k, 16, 16)
    ct.context.fillStyle = '#b13e53'
    ct.context.fillRect(4, 4, 8, 8)
    ct.refresh()
    const img = scene.add.image(-500, -500, k).setDisplaySize(32, 32)
    const orig = window.qa119.sig(k)
    const r = await window.itd.sprite.try(k, window.qa119.blank(64, 64, '38b764'))
    const afterTry = { w: Math.round(img.displayWidth), h: Math.round(img.displayHeight) }
    const txt = scene.add.text(-500, -500, 'HELLO', { fontSize: '40px' })
    const reset = window.itd.sprite.reset(k)
    const back = window.qa119.sig(k)
    const tex = game.textures.get(k).getSourceImage()
    const out = {
      ok: r.ok, reset: reset.ok, same: back === orig, size: [tex.width, tex.height], afterTry,
      afterReset: { w: Math.round(img.displayWidth), h: Math.round(img.displayHeight) },
      bound: img.texture === game.textures.get(k),
    }
    txt.destroy()
    img.destroy()
    return out
  })
  check('C1: кодоген-оригинал — reset возвращает свой canvas 16×16 байт в байт, а не canvas из пула', c1.ok && c1.reset && c1.same && c1.size[0] === 16 && c1.size[1] === 16, c1)
  check('C1: экранный размер объекта сохраняется при try и reset (32×32)', c1.afterTry.w === 32 && c1.afterTry.h === 32 && c1.afterReset.w === 32 && c1.afterReset.h === 32 && c1.bound, c1)

  // S10: reset() без ключа снимает всё
  const s10 = await page.evaluate(async (k) => {
    // блок A уже вернул desk_pc — подменяем снова, чтобы reset() снимал два ключа
    await window.itd.sprite.try(k, window.qa119.variant(k, 'b13e53'))
    const r = window.itd.sprite.reset()
    return { r, list: window.itd.sprite.list(), same: window.qa119.sig(k) }
  }, KEY)
  check('S10: reset() без ключа возвращает все подменённые', s10.r.ok && s10.r.reset.includes(KEY) && s10.r.reset.includes('rack_server') && s10.list.length === 0 && s10.same === before.sig, s10.r)

  // F1–F4: фильтр сэмплирования пробы. pixelArt: true не пишет NEAREST в текстуру
  // (source.scaleMode остаётся 0 = LINEAR) — NEAREST выбирает рендерер по antialias:
  // false, поэтому судим по GL-обёртке: minFilter/magFilter (9729 LINEAR, 9728 NEAREST).
  const f = await page.evaluate(async (k) => {
    const game = window.__itd
    const gl = (key) => {
      const t = game.textures.get(key).source[0].glTexture
      return t ? [t.minFilter, t.magFilter] : null
    }
    const orig = gl(k)
    const lin = await window.itd.sprite.try(k, window.qa119.variant(k, 'b13e53'), { filter: 'linear' })
    const linGl = gl(k)
    const linList = window.itd.sprite.list().find((t) => t.key === k)
    const near = await window.itd.sprite.try(k, window.qa119.variant(k, 'b13e53'))
    const nearGl = gl(k)
    const sig = window.qa119.sig(k)
    const bad = await window.itd.sprite.try(k, window.qa119.variant(k, '38b764'), { filter: 'bicubic' })
    const badSame = window.qa119.sig(k) === sig && gl(k)?.[0] === nearGl?.[0]
    await window.itd.sprite.try(k, window.qa119.variant(k, 'b13e53'), { filter: 'linear' })
    window.itd.sprite.reset(k)
    return { webgl: game.renderer.type === 2, orig, lin, linGl, linList, near, nearGl, bad, badSame, back: gl(k) }
  }, KEY)
  check('F0: стенд рисует WebGL (иначе фильтр не проверить)', f.webgl === true, f.webgl)
  check('F1: try(…, {filter: linear}) → ok, filter: linear, GL-текстура LINEAR, list() называет фильтр', f.lin.ok && f.lin.filter === 'linear' && f.linGl?.[0] === 9729 && f.linGl?.[1] === 9729 && f.linList?.filter === 'linear', { r: f.lin.filter, gl: f.linGl, list: f.linList })
  check('F2: try без опций → filter: nearest, GL-текстура NEAREST (как у всей сцены)', f.near.ok && f.near.filter === 'nearest' && f.nearGl?.[0] === 9728 && f.nearGl?.[1] === 9728, { r: f.near.filter, gl: f.nearGl })
  check('F3: неизвестный фильтр → bad_filter, текстура не тронута', f.bad.ok === false && f.bad.code === 'bad_filter' && f.badSame, f.bad)
  check('F4: reset после linear-пробы — оригинал снова NEAREST, как до try', f.back?.[0] === f.orig?.[0] && f.back?.[0] === 9728, { orig: f.orig, back: f.back })

  await delay(300)
  check('Ошибок на странице нет', pageErrors.length === 0, pageErrors)
} finally {
  await browser.close()
  await stopServer()
}

const failed = results.filter((r) => !r.pass)
console.log(`\nИтог QA ITGAME-119: ${results.length - failed.length}/${results.length} проверок прошло`)
process.exit(failed.length ? 1 : 0)
