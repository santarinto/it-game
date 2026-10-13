# itd.sprite.try — подмена текстуры на лету. План реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `window.itd.sprite` с `try` / `reset` / `list`: подставить PNG по ключу манифеста во вкладке игры без коммита и пересборки и получить квитанцию контракта спрайта.

**Architecture:** Чистая проверка контракта выносится из Node-скрипта в модуль без зависимостей от `node:*`, чтобы один и тот же код считал контракт и в сборке, и во вкладке. Новый модуль `client/src/debug/spriteTry.ts` декодирует PNG из data URL, меняет текстуру ключа в Phaser `TextureManager` и переставляет её живым объектам сцен; исходный источник текстуры хранится в памяти вкладки для `reset`.

**Tech Stack:** TypeScript, Phaser 3.90, Vite, Node 26 (`node --test`), puppeteer-core (QA-скрипты), Go-сервер игры как self-serve.

**Spec:** `docs/design/sprite-pipeline.md` (раздел «2. Сторона игры» → `itd.sprite`, строка `try`), стиль и контракт спрайта — `docs/design/graphics.md`. Задача трекера — ITGAME-119.

**Область плана.** Только шаг 1 спеки в части ITGAME-119: `try`, `reset`, `list`. В план НЕ входят: `pull` / `watch` и Go-ручки (ждут путей API от minipc, письмо 4043), `qa:sprite`, `sprite:take`, поле манифеста `seenIn`, обвязка «иконка рядом с Text» (ITGAME-83 — ей нужен отдельный короткий дизайн: иконки стоят внутри строк тостов, а не отдельными объектами).

## Global Constraints

- `itd.sprite` существует только под `?debug=1` — как весь `window.itd`.
- Подмена живёт во вкладке: в репо, `dist`, сейв и хранилища браузера ничего не пишется; перезагрузка страницы её снимает.
- `try` принимает только ключ, который есть в `client/src/assets/sprites.json` (`code: 'unknown_key'` иначе).
- PNG не размера `size·frames × size` ключа не ставится (`code: 'bad_size'`).
- PNG с нарушением контракта (палитра, альфа, шум, белая заливка) ставится; нарушения возвращаются в `problems` квитанции.
- Контракт считает одна функция `checkSpriteImage` — та же, что в `npm run check:sprites`. Числа и формулировки сообщений не меняются.
- Каждая ручка `itd` несёт JSDoc с `@example` в `interface ItdApi`, строку в `help()` и попадает в `client/src/debug/contract.gen.ts` (`npm run gen:contract`).
- Комментарии и сообщения в коде клиента — по-русски, как в соседнем коде; `docs/development.md` — по-английски.
- Перед коммитом зелёные: `npm run typecheck`, `npm run build`, `npm run qa:contract`, `npm run qa:slots`, `npm run visreg` (эталоны и ожидания не меняются).
- Сообщение коммита — в стиле репо: `feat(itd): … — ITGAME-119: …`, в конце `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Повторный `try` того же ключа, затем `reset` — должна вернуться ИСХОДНАЯ текстура, а не первая подмена. Тест: Task 2, проверка S6.
2. Data URL с верным префиксом и битым телом (`data:image/png;base64,AAAA`) — отказ `bad_src`, без необработанного rejection и без `pageerror`. Тест: Task 2, S8.
3. Страница не в secure context (dev по `http://192.168.x.x`): `crypto.subtle` нет — `sha256: null`, `try` работает. Тест: Task 2, S9.
4. Ключ сцены, которая сейчас не показана (`rack_server` при открытом офисе): `try` не падает, текстура заменена, кадры идут без ошибок. Переход в серверную после подмены этим планом не проверяется — проверить руками на ревью. Тест: Task 2, S5.
5. Ключ с `fallback` (`desk_pc_off` → `desk_pc`): `try('desk_pc')` не трогает объекты, нарисованные ключом `desk_pc_off`, и наоборот. Тест: Task 2, S7.

---

### Task 1: Контракт спрайта — модуль без `node:*`

**Files:**
- Create: `client/scripts/lib/sprite-check-core.mjs`
- Create: `client/scripts/lib/sprite-check-core.d.mts`
- Create: `client/scripts/lib/sprite-check-core.test.mjs`
- Modify: `client/scripts/lib/sprite-check.mjs` (целиком: остаются только реэкспорт и `loadManifest`)

**Interfaces:**
- Consumes: ничего.
- Produces: `checkSpriteImage(png, spec, palette, paletteName?)` и константы `MIN_TRANSPARENT_PCT`, `DEFAULT_MAX_WHITE_PCT`, `DEFAULT_MAX_SPECKS`, `INTERIOR_SPECKLE_WARN_PCT`, `WHITE_HEX` из `client/scripts/lib/sprite-check-core.mjs`; типы `SpritePng`, `SpriteCheckSpec`, `SpriteCheckResult` из `sprite-check-core.d.mts`. `sprite-check.mjs` экспортирует то же, что раньше.

- [ ] **Step 1: Написать падающий тест**

Создать `client/scripts/lib/sprite-check-core.test.mjs`:

```js
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { checkSpriteImage } from './sprite-check-core.mjs'

const PALETTE = ['1a1c2c', 'b13e53', 'f4f4f4']

// 8×8: рамка 6×6 цвета hex по центру, остальное прозрачно
function png(hex, { size = 8, alpha = 255 } = {}) {
  const data = new Uint8Array(size * size * 4)
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16))
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      data.set([r, g, b, alpha], (y * size + x) * 4)
    }
  }
  return { width: size, height: size, data }
}

test('чистый спрайт — без нарушений', () => {
  const r = checkSpriteImage(png('b13e53'), { size: 8 }, PALETTE, 'test')
  assert.deepEqual(r.problems, [])
  assert.equal(r.stats.transparentPct, 43.8)
})

test('цвет вне палитры назван в problems', () => {
  const r = checkSpriteImage(png('ff00ff'), { size: 8 }, PALETTE, 'test')
  assert.equal(r.problems.length, 1)
  assert.match(r.problems[0], /вне палитры test: ff00ff/)
})

test('полупрозрачные пиксели — нарушение', () => {
  const r = checkSpriteImage(png('b13e53', { alpha: 128 }), { size: 8 }, PALETTE)
  assert.ok(r.problems.some((p) => p.startsWith('полупрозрачных пикселей 36')))
})

test('чужой размер — нарушение, шум не считается', () => {
  const r = checkSpriteImage(png('b13e53', { size: 4 }), { size: 8 }, PALETTE)
  assert.ok(r.problems.some((p) => p.startsWith('размер 4×4, контракт 8×8')))
  assert.equal(r.stats.noiseSummary, '')
})

test('модуль не тянет node:* — годится для сборки клиента', () => {
  const src = readFileSync(new URL('./sprite-check-core.mjs', import.meta.url), 'utf8')
  assert.equal(/from 'node:/.test(src), false)
})
```

- [ ] **Step 2: Убедиться, что тест падает**

Run (из `client/`): `node --test scripts/lib/sprite-check-core.test.mjs`
Expected: FAIL, `Cannot find module … sprite-check-core.mjs`.

- [ ] **Step 3: Вынести чистую функцию**

Создать `client/scripts/lib/sprite-check-core.mjs`: перенести из `sprite-check.mjs` без единой правки тела пять констант (`MIN_TRANSPARENT_PCT` … `WHITE_HEX`) и функцию `checkSpriteImage` вместе с её JSDoc. Шапка файла:

```js
// sprite-check-core — чистая проверка одного декодированного RGBA-буфера против
// записи манифеста client/src/assets/sprites.json. Без node:* и без side-effects:
// модуль читают и Node-скрипты (check-sprites.mjs, sprite-remap.mjs — через
// sprite-check.mjs), и сборка клиента (client/src/debug/spriteTry.ts, ITGAME-119) —
// контракт во вкладке и в `npm run build` считает один код.
```

`client/scripts/lib/sprite-check.mjs` заменить целиком:

```js
// sprite-check — контракт спрайта для Node-скриптов: чистая проверка живёт в
// sprite-check-core.mjs (её же импортирует клиент, ITGAME-119), здесь — чтение
// манифеста с диска. Поведение 1:1 с прежним: числа и формулировки не менялись.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export {
  DEFAULT_MAX_SPECKS,
  DEFAULT_MAX_WHITE_PCT,
  INTERIOR_SPECKLE_WARN_PCT,
  MIN_TRANSPARENT_PCT,
  WHITE_HEX,
  checkSpriteImage,
} from './sprite-check-core.mjs'

/**
 * Читает client/src/assets/sprites.json. clientDir — корень client/ (dirname дважды от scripts/lib).
 */
export function loadManifest(clientDir) {
  const path = join(clientDir, 'src', 'assets', 'sprites.json')
  return JSON.parse(readFileSync(path, 'utf8'))
}
```

Создать `client/scripts/lib/sprite-check-core.d.mts`:

```ts
export interface SpritePng {
  width: number
  height: number
  data: Uint8Array | Uint8ClampedArray
}

export interface SpriteCheckSpec {
  size: number
  frames?: number
  maxWhitePct?: number
  maxSpecks?: number
}

export interface SpriteCheckResult {
  problems: string[]
  warnings: string[]
  stats: {
    transparentPct: number
    whitePct: number
    noiseSummary: string
    totalSpecks: number
    maxSpecks: number
  }
}

export const MIN_TRANSPARENT_PCT: number
export const DEFAULT_MAX_WHITE_PCT: number
export const DEFAULT_MAX_SPECKS: number
export const INTERIOR_SPECKLE_WARN_PCT: number
export const WHITE_HEX: string

export function checkSpriteImage(
  png: SpritePng,
  spec: SpriteCheckSpec,
  palette: string[],
  paletteName?: string,
): SpriteCheckResult
```

- [ ] **Step 4: Убедиться, что тест и гейт зелёные**

Run (из `client/`): `node --test scripts/lib/sprite-check-core.test.mjs && npm run check:sprites`
Expected: 5 тестов pass; `check:sprites` печатает тот же итог, что до правки, exit 0.

- [ ] **Step 5: Commit**

```bash
git add client/scripts/lib/sprite-check-core.mjs client/scripts/lib/sprite-check-core.d.mts client/scripts/lib/sprite-check-core.test.mjs client/scripts/lib/sprite-check.mjs
git commit -m "refactor(sprites): the sprite contract check moves to a node-free module — ITGAME-119: checkSpriteImage and its thresholds live in scripts/lib/sprite-check-core.mjs (no node:* imports, typed by a .d.mts) so the client bundle can run the very same contract in a tab; sprite-check.mjs re-exports it and keeps loadManifest, check-sprites.mjs and sprite-remap.mjs are untouched; node --test covers clean/off-palette/semi-alpha/wrong-size and that the core imports nothing from node:

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `itd.sprite` — try / reset / list

**Files:**
- Create: `client/src/debug/spriteTry.ts`
- Create: `client/scripts/qa-itgame119.mjs`
- Modify: `client/src/debug/agentApi.ts` (импорт рядом со строкой 12; `interface ItdApi` — после `sandbox`, строка ~925; объект API — после `sandbox: makeSandbox(game),` строка ~2109)
- Modify: `client/package.json` (скрипт `qa:sprite-try`)

**Interfaces:**
- Consumes: `checkSpriteImage`, `SpriteCheckResult` из `client/scripts/lib/sprite-check-core.mjs` (Task 1); `SPRITES`, `PALETTES` из `client/src/assets/manifest.ts`.
- Produces (из `client/src/debug/spriteTry.ts`):
  - `makeSpriteApi(game: Phaser.Game): SpriteApi`
  - `interface SpriteApi { try(key: string, src: string): Promise<SpriteReceipt>; reset(key?: string): SpriteResetResult; list(): SpriteTried[] }`
  - `interface SpriteReceipt { ok: boolean; key?: string; w?: number; h?: number; sha256?: string | null; objects?: number; problems?: string[]; warnings?: string[]; stats?: SpriteCheckResult['stats']; code?: 'unknown_key' | 'bad_src' | 'bad_size'; error?: string }`
  - `interface SpriteTried { key: string; w: number; h: number; sha256: string | null; problems: string[] }`
  - `interface SpriteResetResult { ok: boolean; reset: string[]; code?: 'not_tried'; error?: string }`
  - `triedKeys(): ReadonlySet<string>` — для Task 3.

- [ ] **Step 1: Написать падающий QA-скрипт**

Создать `client/scripts/qa-itgame119.mjs`:

```js
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
```

В `client/package.json` рядом с `"qa:slots"` добавить:

```json
    "qa:sprite-try": "node scripts/qa-itgame119.mjs",
```

- [ ] **Step 2: Убедиться, что QA падает**

Run (из `client/`): `npm run build && npm run qa:sprite-try`
Expected: FAIL — `window.itd.sprite` не определён (`TypeError: Cannot read properties of undefined (reading 'try')`), exit 1.

- [ ] **Step 3: Написать модуль**

Создать `client/src/debug/spriteTry.ts`:

```ts
import type Phaser from 'phaser'
import { checkSpriteImage } from '../../scripts/lib/sprite-check-core.mjs'
import type { SpriteCheckResult } from '../../scripts/lib/sprite-check-core.mjs'
import { PALETTES, SPRITES } from '../assets/manifest'

// itd.sprite (ITGAME-119): подмена текстуры по ключу манифеста во вкладке — примерка
// спрайта на сцене без коммита и пересборки (docs/design/sprite-pipeline.md). Подмена
// живёт в памяти вкладки: в репо, dist, сейв и хранилища ничего не пишется,
// перезагрузка её снимает. Контракт считает тот же код, что npm run check:sprites.

type Source = HTMLImageElement | HTMLCanvasElement

export interface SpriteReceipt {
  ok: boolean
  key?: string
  w?: number
  h?: number
  sha256?: string | null // null — страница не в secure context, crypto.subtle нет
  objects?: number // живых объектов сцен перевешено на новую текстуру
  problems?: string[] // нарушения контракта; текстура при этом СТОИТ
  warnings?: string[]
  stats?: SpriteCheckResult['stats']
  code?: 'unknown_key' | 'bad_src' | 'bad_size'
  error?: string
}

export interface SpriteTried {
  key: string
  w: number
  h: number
  sha256: string | null
  problems: string[]
}

export interface SpriteResetResult {
  ok: boolean
  reset: string[]
  code?: 'not_tried'
  error?: string
}

export interface SpriteApi {
  try(key: string, src: string): Promise<SpriteReceipt>
  reset(key?: string): SpriteResetResult
  list(): SpriteTried[]
}

const PNG_DATA_URL = /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/

// Исходные источники подменённых ключей — то, что вернёт reset(); и то, что стоит сейчас.
const originals = new Map<string, Source>()
const tried = new Map<string, SpriteTried>()

// Ключи, подменённые через itd.sprite.try, — для пометки в itd.assets().
export function triedKeys(): ReadonlySet<string> {
  return new Set(tried.keys())
}

function decode(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = src
  })
}

async function sha256Of(dataUrl: string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return null
  const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1))
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  const hash = await subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

interface Textured {
  texture: { key: string }
  frame: { name: string | number }
  setTexture(key: string, frame?: string | number): unknown
}

function isTextured(o: unknown): o is Textured {
  const t = o as Partial<Textured> | null
  return !!t && typeof t.setTexture === 'function' && typeof t.texture?.key === 'string'
}

// Живые объекты всех сцен (спящих тоже), нарисованные ключом; контейнеры — вглубь.
function usersOf(game: Phaser.Game, key: string): { obj: Textured; frame: string | number }[] {
  const out: { obj: Textured; frame: string | number }[] = []
  const walk = (list: unknown[]) => {
    for (const o of list) {
      if (isTextured(o) && o.texture.key === key) out.push({ obj: o, frame: o.frame.name })
      const nested = (o as { list?: unknown }).list
      if (Array.isArray(nested)) walk(nested)
    }
  }
  for (const scene of game.scene.getScenes(false)) walk(scene.children.list)
  return out
}

// Заменить источник ключа. Занятый ключ add* не перезаписывает (инцидент ITGAME-11),
// поэтому remove → add; объекты держат кадр снятой текстуры, их перевешиваем в том
// же тике, до следующего кадра рендера.
function swap(game: Phaser.Game, key: string, source: Source): number {
  const spec = SPRITES[key]
  const users = usersOf(game, key)
  game.textures.remove(key)
  if (spec.frames > 1) {
    game.textures.addSpriteSheet(key, source as HTMLImageElement, {
      frameWidth: spec.size, frameHeight: spec.size,
    })
  } else if (source instanceof HTMLCanvasElement) {
    game.textures.addCanvas(key, source)
  } else {
    game.textures.addImage(key, source)
  }
  for (const { obj, frame } of users) obj.setTexture(key, frame)
  return users.length
}

export function makeSpriteApi(game: Phaser.Game): SpriteApi {
  return {
    async try(key, src) {
      const spec = SPRITES[key]
      if (!spec) {
        return { ok: false, code: 'unknown_key', error: `ключа '${key}' нет в манифесте sprites.json` }
      }
      if (typeof src !== 'string' || !PNG_DATA_URL.test(src)) {
        return { ok: false, code: 'bad_src', error: 'src — data URL вида data:image/png;base64,…' }
      }
      const img = await decode(src)
      if (!img) return { ok: false, code: 'bad_src', error: 'PNG не декодируется' }

      const w = img.width
      const h = img.height
      const wantW = spec.size * spec.frames
      if (w !== wantW || h !== spec.size) {
        return {
          ok: false, code: 'bad_size', key, w, h,
          error: `размер ${w}×${h}, контракт ключа — ${wantW}×${spec.size}`,
        }
      }

      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) return { ok: false, code: 'bad_src', error: 'нет 2d-контекста для разбора PNG' }
      ctx.drawImage(img, 0, 0)
      const data = ctx.getImageData(0, 0, w, h).data
      const res = checkSpriteImage({ width: w, height: h, data }, spec, PALETTES[spec.palette], spec.palette)
      const sha256 = await sha256Of(src)

      if (!game.textures.exists(key)) {
        return { ok: false, code: 'unknown_key', error: `текстуры '${key}' нет в игре — boot не закончен?` }
      }
      // Исходник запоминаем один раз: второй try того же ключа его не перетирает.
      if (!originals.has(key)) originals.set(key, game.textures.get(key).getSourceImage() as Source)
      const objects = swap(game, key, img)
      tried.set(key, { key, w, h, sha256, problems: res.problems })
      return { ok: true, key, w, h, sha256, objects, problems: res.problems, warnings: res.warnings, stats: res.stats }
    },

    reset(key) {
      if (key !== undefined && !originals.has(key)) {
        return { ok: false, reset: [], code: 'not_tried', error: `ключ '${key}' не подменён — см. itd.sprite.list()` }
      }
      const keys = key !== undefined ? [key] : [...originals.keys()]
      for (const k of keys) {
        swap(game, k, originals.get(k) as Source)
        originals.delete(k)
        tried.delete(k)
      }
      return { ok: true, reset: keys }
    },

    list: () => [...tried.values()].sort((a, b) => a.key.localeCompare(b.key)),
  }
}
```

- [ ] **Step 4: Подключить к `window.itd`**

В `client/src/debug/agentApi.ts`:

Импорт после строки `import type { FakeOwnerResult, … } from './sandbox'`:

```ts
import { makeSpriteApi } from './spriteTry'
import type { SpriteApi } from './spriteTry'
```

В `interface ItdApi` сразу после `readonly sandbox: SandboxApi`:

```ts
  /**
   * Примерка спрайта (ITGAME-119): itd.sprite.try(key, dataUrl) ставит PNG вместо
   * текстуры ключа манифеста во вкладке и перевешивает живые объекты сцен →
   * {ok, key, w, h, sha256, objects, problems, warnings, stats} — problems считает
   * тот же контракт, что npm run check:sprites (палитра, альфа, шум), текстура при
   * нарушениях всё равно стоит. Отказы: unknown_key (ключа нет в sprites.json),
   * bad_src (не data:image/png;base64 или PNG битый), bad_size (не size·frames ×
   * size ключа). itd.sprite.list() → [{key, w, h, sha256, problems}];
   * itd.sprite.reset(key?) → {ok, reset[]} — вернуть исходную текстуру (без ключа —
   * все), not_tried — ключ не подменён. В репо, dist и сейв ничего не пишется,
   * перезагрузка страницы снимает подмену.
   * @example await itd.sprite.try('desk_pc', dataUrl)
   * @example itd.sprite.list()
   * @example itd.sprite.reset()
   */
  readonly sprite: SpriteApi
```

В объекте API сразу после `sandbox: makeSandbox(game),`:

```ts
    sprite: makeSpriteApi(game),
```

- [ ] **Step 5: Убедиться, что QA зелёный**

Run (из `client/`): `npm run gen:contract && npm run typecheck && npm run build && npm run qa:sprite-try`
Expected: `Итог QA ITGAME-119: 21/21 проверок прошло`, exit 0.

Если S1 «объекты перевешены» или S3 «кадры без pageerror» красные — `setTexture` после `textures.remove` не восстановил кадр объекта. Тогда в `swap()` перед `obj.setTexture(key, frame)` ничего не менять, а порядок сделать таким: сначала `game.textures.remove(key)` и добавление, затем для каждого объекта `obj.setTexture(key, frame)` — это уже так; проверить в консоли вкладки `obj.frame.texture === game.textures.get(key)` и, если ложь, заменить вызов на `obj.setTexture(key).setFrame?.(frame)`. Повторить шаг.

- [ ] **Step 6: Commit**

```bash
git add client/src/debug/spriteTry.ts client/src/debug/agentApi.ts client/src/debug/contract.gen.ts client/scripts/qa-itgame119.mjs client/package.json
git commit -m "feat(itd): itd.sprite.try/reset/list swap a manifest texture in the tab — ITGAME-119: try(key, pngDataUrl) decodes the PNG, runs the same contract as check:sprites (scripts/lib/sprite-check-core.mjs), replaces the key in the TextureManager (remove → add, a busy key is never overwritten — ITGAME-11) and re-points every live object of every scene, sleeping ones too; the receipt carries w/h, sha256 (null outside a secure context), objects and problems — a contract violation is applied and named, only unknown_key, bad_src and bad_size refuse; the original source is kept once per key so reset() after two tries restores the original; nothing is written to the repo, dist, saves or storage; qa:sprite-try 21/21 (:4187): clean swap, off-palette, a sleeping scene's key, fallback keys independent, the four refusals, no crypto.subtle, reset all

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Пометка в `itd.assets()`, `help()`, документация

**Files:**
- Modify: `client/src/debug/agentApi.ts` (`AssetReport.source`, `AssetSetEntry.active`, тела `assets()` и `assetSet()`, текст `help()` у строк ~1854–1855, JSDoc `assets()` ~1009)
- Modify: `client/scripts/qa-itgame119.mjs` (проверки A1–A3 перед S10)
- Modify: `docs/development.md` (таблица QA-команд рядом с `qa:slots`; раздел `## Assets`)
- Modify: `docs/design/sprite-pipeline.md` (статус строки `try`)

**Interfaces:**
- Consumes: `triedKeys(): ReadonlySet<string>` из `client/src/debug/spriteTry.ts` (Task 2).
- Produces: `AssetReport['source']` и `AssetSetEntry['active']` получают третье значение `'tried'`.

- [ ] **Step 1: Дописать падающие проверки**

В `client/scripts/qa-itgame119.mjs` перед блоком `// S10` вставить:

```js
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
```

- [ ] **Step 2: Убедиться, что проверки падают**

Run (из `client/`): `npm run build && npm run qa:sprite-try`
Expected: FAIL на A1 (`source` = `pixelart`: после подмены источник ключа не совпадает с `ai:desk_pc`), A2 и A3; остальные 21 — PASS.

- [ ] **Step 3: Реализовать пометку**

В `client/src/debug/agentApi.ts`:

Импорт Task 2 расширить:

```ts
import { makeSpriteApi, triedKeys } from './spriteTry'
```

Типы:

```ts
export interface AssetReport {
  key: string
  source: 'png' | 'pixelart' | 'tried' // подменённый PNG, кодоген или проба itd.sprite.try (ITGAME-119)
```

```ts
export interface AssetSetEntry {
  key: string
  pngLoaded: boolean // ai:<key> приехал с сервера
  active: 'png' | 'pixelart' | 'tried' // чем реально рисуют сцены; tried — проба itd.sprite.try
}
```

В теле `assets()` заменить три строки определения `source`:

```ts
        // Источник: ai:<key> — сам PNG; <key> — проба itd.sprite.try (ITGAME-119),
        // PNG, если подменён источником ai:<key> в BootScene, иначе кодоген.
        const tried = triedKeys()
        let source: AssetReport['source'] = 'pixelart'
        if (key.startsWith('ai:')) source = 'png'
        else if (tried.has(key)) source = 'tried'
        else if (sameSource(game, key, 'ai:' + key)) source = 'png'
```

(`const tried = triedKeys()` вынести перед циклом `for (const key of game.textures.getTextureKeys())`, чтобы не строить Set на каждый ключ.)

В теле `assetSet()`:

```ts
    assetSet() {
      const tried = triedKeys()
      return AI_SPRITES.map((key) => {
        const pngLoaded = game.textures.exists('ai:' + key)
        return {
          key,
          pngLoaded,
          active: tried.has(key)
            ? 'tried'
            : pngLoaded && sameSource(game, key, 'ai:' + key) ? 'png' : 'pixelart',
        }
      })
    },
```

JSDoc `assets()` в `interface ItdApi` — дописать перед `@example`:

```ts
   * source: tried — ключ подменён пробой itd.sprite.try (ITGAME-119), это не эталон.
```

JSDoc `assetSet()` — заменить первую строку на:

```ts
   * Чем рисуют сцены: png (подменён из assets/), pixelart (кодоген-фолбэк) или
   * tried (проба itd.sprite.try).
```

В тексте `help()` после строки `itd.assetSet()` добавить, выровняв описание по соседним строкам:

```
  await itd.sprite.try(key, dataUrl) — примерка спрайта: PNG (data:image/png;base64,…) вместо текстуры ключа манифеста во вкладке → {ok, key, w, h, sha256, objects, problems, warnings, stats}; problems — контракт check:sprites, текстура стоит и с нарушениями; отказы unknown_key | bad_src | bad_size; в репо и сейв ничего не пишется
  itd.sprite.list() / reset(key?)   — что подменено [{key, w, h, sha256, problems}] / вернуть исходную текстуру (без ключа — все), not_tried — ключ не подменён
```

и в строках `itd.assets()` / `itd.assetSet()` дописать в конец: `; source/active: tried — проба itd.sprite.try`.

- [ ] **Step 4: Документация**

В `docs/development.md`, в таблице QA-команд после строки `npm run qa:slots`:

```markdown
| `npm run qa:sprite-try` | `itd.sprite.try/reset/list` (ITGAME-119): a clean swap re-points live objects and reports `sha256`; an off-palette PNG is applied and named in `problems`; a sleeping scene's key; fallback keys stay independent; `unknown_key`/`bad_src`/`bad_size`/`not_tried`; no `crypto.subtle` → `sha256: null`; `reset()` restores the original pixels after two tries; `assets()`/`assetSet()` mark the key `tried` | :4187, self-serve |
```

В том же файле в строке, где перечислены self-serve скрипты (`qa:buttons`/`qa:hud`/`qa:facade`/`qa:slots`/…), добавить `qa:sprite-try` в оба перечисления (строки ~1033 и ~1044).

В раздел `## Assets`, после подраздела `### Sprite manifest`, добавить:

```markdown
### Trying a sprite in the tab

`itd.sprite.try(key, dataUrl)` (`?debug=1` only, ITGAME-119) replaces the
texture of a manifest key with a PNG given as a `data:image/png;base64,…` URL
and re-points every live object of every scene. Nothing is written to the
repo, `dist`, a save or browser storage; a reload drops the swap.

The receipt runs the same contract as `npm run check:sprites`
(`client/scripts/lib/sprite-check-core.mjs`): a violation (off-palette colour,
semi-transparent pixels, noise) is **applied and named** in `problems`, so a
broken edit is visible on the scene. Only three things refuse: a key missing
from `sprites.json` (`unknown_key`), a source that is not a decodable PNG data
URL (`bad_src`), and a PNG that is not `size·frames × size` (`bad_size`) — a
wrong size would move the layout and make every other finding false.

`itd.sprite.list()` names what is swapped, `itd.sprite.reset(key?)` restores
the original source. While a key is swapped, `itd.assets()` reports
`source: 'tried'` and `itd.assetSet()` `active: 'tried'`: do not record a
visreg baseline in that state. `sha256` is `null` when the page is not a
secure context (`crypto.subtle` is absent on `http://<lan-ip>`).

The pipeline this is the first step of: `docs/design/sprite-pipeline.md`.
```

В `docs/design/sprite-pipeline.md`, в таблице `itd.sprite`, строку `try` заменить на:

```markdown
| `try(key, png)` | локальная подмена из data URL, без minipc (ITGAME-119) — **сделано** |
```

- [ ] **Step 5: Убедиться, что всё зелёное**

Run (из `client/`):

```bash
npm run gen:contract && npm run typecheck && npm run build && npm run qa:sprite-try && npm run qa:contract && npm run qa:slots && npm run qa:facade && npm run visreg
```

Expected: `qa:sprite-try` 24/24; `qa:contract`, `qa:slots`, `qa:facade` — без красных проверок; `visreg` OK без изменения эталонов и `baseline.json`. Если `qa:contract` красный на хеше контракта — это ожидаемо после `gen:contract` только в том случае, если тест сравнивает с зашитым хешем; тогда обновить ожидание так, как это сделано в коммите `774199d` (ITGAME-116), и назвать новый хеш в сообщении коммита.

- [ ] **Step 6: Commit**

```bash
git add client/src/debug/agentApi.ts client/src/debug/contract.gen.ts client/scripts/qa-itgame119.mjs docs/development.md docs/design/sprite-pipeline.md
git commit -m "feat(itd): assets()/assetSet() mark a key swapped by itd.sprite.try as tried — ITGAME-119: a swapped key no longer shares its source with ai:<key>, so the audit called it pixelart; source/active get a third value 'tried' so visreg and QA cannot take a probe for a baseline; help() describes itd.sprite.try/list/reset, contract regenerated, docs/development.md gets the qa:sprite-try row and «Trying a sprite in the tab», sprite-pipeline.md marks try as done; qa:sprite-try 24/24, qa:contract, qa:slots, qa:facade green, visreg OK with no baseline changed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## После плана

- Задача ITGAME-119 в трекере: лог с номерами коммитов и итогом QA, статус `review`.
- Следующие планы (отдельные документы): обвязка иконок ITGAME-83 — после короткого дизайна «иконка внутри строки тоста»; `pull` / `watch` и Go-ручки — после ответа minipc на письмо 4043.
