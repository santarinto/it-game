import Phaser from 'phaser'
import { checkSpriteImage } from '../../scripts/lib/sprite-check-core.mjs'
import type { SpriteCheckResult } from '../../scripts/lib/sprite-check-core.mjs'
import { PALETTES, SPRITES } from '../assets/manifest'

// itd.sprite (ITGAME-119): подмена текстуры по ключу манифеста во вкладке — примерка
// спрайта на сцене без коммита и пересборки (docs/design/sprite-pipeline.md). Подмена
// живёт в памяти вкладки: в репо, dist, сейв и хранилища ничего не пишется,
// перезагрузка её снимает. Контракт считает тот же код, что npm run check:sprites.
// pull/watch (ITGAME-157) берут ревизию из API заданий minipc через Go-ручки
// /api/debug/sprite/* (ITGAME_DEBUG=1): токен остаётся на сервере, sha256 сверяет он же.

// Фильтр сэмплирования пробы. pixelArt: true даёт всей игре NEAREST (рендерер так
// решает по antialias: false); linear — билинейный только этой текстуре: детальный
// исходник крупнее слота сжимается гладко (честно — до 2×, mipmaps нет).
export type SpriteFilter = 'nearest' | 'linear'

export interface SpriteTryOptions {
  filter?: SpriteFilter // по умолчанию — как ключ рисуется в игре: linear у render: smooth, иначе nearest
}

// Откуда подмена: try — data URL из рук, pull — замороженная ревизия minipc, watch — latest
// ключа задания, подхваченный опросом.
export type SpriteSource = 'try' | 'pull' | 'watch'

// Отказы ручек /api/debug/sprite/* (server/internal/spriteproxy) и самой вкладки:
// debug_off — у сервера нет ITGAME_DEBUG=1, server_unreachable — Go-сервер не ответил.
export type SpritePullCode =
  | 'bad_task' | 'bad_key' | 'bad_rev' | 'not_found' | 'sha_mismatch' | 'too_large'
  | 'minipc_not_configured' | 'minipc_unreachable' | 'minipc_auth' | 'minipc_error'
  | 'debug_off' | 'server_unreachable'

export interface SpriteReceipt {
  ok: boolean
  key?: string
  w?: number
  h?: number
  filter?: SpriteFilter
  sha256?: string | null // null — страница не в secure context, crypto.subtle нет (у pull/watch — всегда sha minipc, сверенный сервером)
  objects?: number // живых объектов сцен перевешено на новую текстуру
  problems?: string[] // нарушения контракта; текстура при этом СТОИТ
  warnings?: string[]
  stats?: SpriteCheckResult['stats']
  source?: SpriteSource
  taskId?: string // задание minipc — у pull/watch
  rev?: number // ревизия ключа — у pull/watch
  code?: 'unknown_key' | 'bad_src' | 'bad_size' | 'bad_filter' | SpritePullCode
  error?: string
}

export interface SpriteTried {
  key: string
  w: number
  h: number
  filter: SpriteFilter
  sha256: string | null
  problems: string[]
  source: SpriteSource
  taskId?: string
  rev?: number
}

export interface SpriteWatchResult {
  ok: boolean
  taskId?: string
  keys?: string[] // ключи задания из манифеста — их latest опрашивается раз в секунду
  skipped?: { key: string; code: 'unknown_key' }[] // ключи задания, которых нет в sprites.json
  receipts?: SpriteReceipt[] // первый круг: квитанция по каждому ключу (not_found — ревизий ещё нет)
  replaced?: string // taskId прежнего watch, который этот вызов остановил
  code?: SpritePullCode
  error?: string
}

export interface SpriteUnwatchResult {
  ok: boolean
  taskId?: string
  polls?: number // кругов опроса
  updates?: SpriteReceipt[] // квитанции новых ревизий после первого круга, по порядку
  errors?: number // кругов с отказом ручки (сеть, minipc) — опрос при этом шёл дальше
  lastError?: string | null
  code?: 'not_watching'
  error?: string
}

export interface SpriteResetResult {
  ok: boolean
  reset: string[]
  code?: 'not_tried'
  error?: string
}

export interface SpriteApi {
  try(key: string, src: string, opts?: SpriteTryOptions): Promise<SpriteReceipt>
  pull(taskId: string | number, key: string, rev: number, opts?: SpriteTryOptions): Promise<SpriteReceipt>
  watch(taskId: string | number): Promise<SpriteWatchResult>
  unwatch(): SpriteUnwatchResult
  reset(key?: string): SpriteResetResult
  list(): SpriteTried[]
}

const PNG_DATA_URL = /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/

// Исходная текстура подменённого ключа не уничтожается, а прячется под служебным
// ключом (renameTexture): remove() кодоген-текстуры отдал бы её canvas в CanvasPool,
// и первый же add.text забрал бы его себе — reset вернул бы чужие пиксели (ревью
// ITGAME-119). Texture-объект оригинала, его кадры и GL-текстура живут до reset.
const ORIG_PREFIX = '__itd_orig:'
const tried = new Map<string, SpriteTried>()

// Служебный ключ спрятанного оригинала — itd.assets() его не аудирует.
export function isHiddenOriginal(key: string): boolean {
  return key.startsWith(ORIG_PREFIX)
}

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
  displayWidth: number
  displayHeight: number
  setTexture(key: string, frame?: string | number): unknown
  setDisplaySize?(w: number, h: number): unknown
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

// Поставить под key новую текстуру из source (или, без source, вернуть спрятанный
// оригинал). Занятый ключ add* не перезаписывает (инцидент ITGAME-11): текущую
// текстуру ключа сначала прячем (первый try) или снимаем (проба поверх пробы, reset).
// Объекты перевешиваем в том же тике, до кадра рендера, и сохраняем им экранный
// размер: кодоген-плейсхолдер 16px растянут до слота, PNG того же слота — 128px.
function swap(game: Phaser.Game, key: string, source: HTMLImageElement | null): number {
  const spec = SPRITES[key]
  const users = usersOf(game, key).map((u) => ({ ...u, w: u.obj.displayWidth, h: u.obj.displayHeight }))
  const hidden = ORIG_PREFIX + key
  if (source === null) {
    game.textures.remove(key)
    game.textures.renameTexture(hidden, key)
  } else {
    if (game.textures.exists(hidden)) game.textures.remove(key)
    else game.textures.renameTexture(key, hidden)
    if (spec.frames > 1) {
      game.textures.addSpriteSheet(key, source, { frameWidth: spec.size, frameHeight: spec.size })
    } else {
      game.textures.addImage(key, source)
    }
  }
  for (const { obj, frame, w, h } of users) {
    obj.setTexture(key, frame)
    obj.setDisplaySize?.(w, h)
  }
  return users.length
}

// Происхождение подмены — в квитанцию и list().
interface Origin {
  source: SpriteSource
  taskId?: string
  rev?: number
  sha256?: string // pull/watch: sha minipc, уже сверенный Go-сервером
}

// Поставить PNG из data URL под ключ манифеста: общий путь try, pull и watch. alive —
// у watch: опрос, начатый до unwatch()/reset(), спрашивается ещё раз после decode, перед
// подменой, и если его уже сняли — не ставит ничего (null), иначе reset откатился бы.
async function apply(game: Phaser.Game, key: string, src: string, opts: SpriteTryOptions | undefined, origin: Origin): Promise<SpriteReceipt>
async function apply(game: Phaser.Game, key: string, src: string, opts: SpriteTryOptions | undefined, origin: Origin, alive: () => boolean): Promise<SpriteReceipt | null>
async function apply(game: Phaser.Game, key: string, src: string, opts: SpriteTryOptions | undefined, origin: Origin, alive?: () => boolean): Promise<SpriteReceipt | null> {
  const tag = { source: origin.source, taskId: origin.taskId, rev: origin.rev }
  const spec = SPRITES[key]
  if (!spec) {
    return { ok: false, ...tag, key, code: 'unknown_key', error: `ключа '${key}' нет в манифесте sprites.json` }
  }
  // По умолчанию — фильтр, с которым ключ рисуется в игре (render в манифесте).
  const filter = opts?.filter ?? (spec.render === 'smooth' ? 'linear' : 'nearest')
  if (filter !== 'nearest' && filter !== 'linear') {
    return { ok: false, ...tag, code: 'bad_filter', error: `filter — 'nearest' или 'linear', получено ${JSON.stringify(filter)}` }
  }
  if (typeof src !== 'string' || !PNG_DATA_URL.test(src)) {
    return { ok: false, ...tag, code: 'bad_src', error: 'src — data URL вида data:image/png;base64,…' }
  }
  const img = await decode(src)
  if (!img) return { ok: false, ...tag, code: 'bad_src', error: 'PNG не декодируется' }

  const w = img.width
  const h = img.height
  const wantW = spec.size * spec.frames
  if (w !== wantW || h !== spec.size) {
    return {
      ok: false, ...tag, code: 'bad_size', key, w, h,
      error: `размер ${w}×${h}, контракт ключа — ${wantW}×${spec.size}`,
    }
  }

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return { ok: false, ...tag, code: 'bad_src', error: 'нет 2d-контекста для разбора PNG' }
  ctx.drawImage(img, 0, 0)
  const data = ctx.getImageData(0, 0, w, h).data
  const res = checkSpriteImage({ width: w, height: h, data }, spec, PALETTES[spec.palette], spec.palette)
  const sha256 = origin.sha256 ?? (await sha256Of(src))

  if (alive && !alive()) return null
  if (!game.textures.exists(key)) {
    return { ok: false, ...tag, code: 'unknown_key', error: `текстуры '${key}' нет в игре — boot не закончен?` }
  }
  // Оригинал прячется один раз: второй try того же ключа снимает только пробу.
  const objects = swap(game, key, img)
  // Новая текстура рождается NEAREST (её рендерер не сглаживает при antialias: false);
  // setFilter пишет фильтр прямо в GL. Оригинал под ORIG_PREFIX свой фильтр хранит.
  if (filter === 'linear') game.textures.get(key).setFilter(Phaser.Textures.FilterMode.LINEAR)
  const warnings = [...res.warnings]
  if (filter === 'linear' && game.renderer.type !== Phaser.WEBGL) {
    warnings.push('filter: linear действует только в WebGL — canvas-рендер рисует как раньше')
  }
  tried.set(key, { key, w, h, filter, sha256, problems: res.problems, ...tag })
  return { ok: true, key, w, h, filter, sha256, objects, problems: res.problems, warnings, stats: res.stats, ...tag }
}

const TASK_RE = /^[0-9]+$/

type Fetched =
  | { ok: true; status: 200; src: string; rev: number | undefined; sha256: string; etag: string | null }
  | { ok: true; status: 304 }
  | { ok: false; code: SpritePullCode; error: string }

// Отказ ручки: JSON {code, error} от spriteproxy; не-JSON 404 — маршрута нет (без ITGAME_DEBUG).
async function refusal(resp: Response): Promise<{ ok: false; code: SpritePullCode; error: string }> {
  try {
    const body = (await resp.json()) as { code?: SpritePullCode; error?: string }
    if (body.code) return { ok: false, code: body.code, error: body.error ?? `HTTP ${resp.status}` }
  } catch {
    // не JSON — ниже
  }
  if (resp.status === 404) return { ok: false, code: 'debug_off', error: 'нет /api/debug/sprite — сервер запущен без ITGAME_DEBUG=1' }
  return { ok: false, code: 'minipc_error', error: `HTTP ${resp.status}` }
}

function pngDataUrl(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return 'data:image/png;base64,' + btoa(bin)
}

// rev — номер, если X-Sprite-Rev не пришёл (у pull — запрошенный, у latest — неизвестен).
async function fetchRevision(path: string, ifNoneMatch?: string | null, rev?: number): Promise<Fetched> {
  let resp: Response
  try {
    resp = await fetch(path, { cache: 'no-store', headers: ifNoneMatch ? { 'If-None-Match': ifNoneMatch } : {} })
  } catch (e) {
    return { ok: false, code: 'server_unreachable', error: `Go-сервер не ответил: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (resp.status === 304) return { ok: true, status: 304 }
  if (resp.status !== 200) return refusal(resp)
  let body: ArrayBuffer
  try {
    body = await resp.arrayBuffer()
  } catch (e) {
    return { ok: false, code: 'server_unreachable', error: `ответ оборвался: ${e instanceof Error ? e.message : String(e)}` }
  }
  const header = Number(resp.headers.get('X-Sprite-Rev'))
  return {
    ok: true,
    status: 200,
    src: pngDataUrl(body),
    rev: Number.isInteger(header) && header > 0 ? header : rev,
    sha256: resp.headers.get('X-Sprite-Sha256') ?? '',
    etag: resp.headers.get('ETag'),
  }
}

// Ключи задания minipc: items[] (как в заглушке) или keys[]; элемент — {key} или строка.
// Форму GET /jobs/{taskId} письмо 4123 не приводит — сверить на шаге 5 (ITGAME-182).
function jobKeys(job: unknown): string[] {
  const j = job as { items?: unknown[]; keys?: unknown[] } | null
  const list = Array.isArray(j?.items) ? j.items : Array.isArray(j?.keys) ? j.keys : []
  return list
    .map((x) => (typeof x === 'string' ? x : (x as { key?: unknown } | null)?.key))
    .filter((k): k is string => typeof k === 'string')
}

const WATCH_EVERY_MS = 1000
const WATCH_UPDATES_MAX = 100

interface Watch {
  taskId: string
  keys: string[]
  etags: Map<string, string | null>
  polls: number
  updates: SpriteReceipt[]
  errors: number
  lastError: string | null
  timer: ReturnType<typeof setTimeout> | null
  stopped: boolean
}

export function makeSpriteApi(game: Phaser.Game): SpriteApi {
  let watch: Watch | null = null
  // Эпоха подмен: reset() её сдвигает — ревизия опроса, начатого раньше, не встаёт.
  let epoch = 0

  // Один круг опроса: latest каждого ключа с If-None-Match; 304 — ничего не изменилось.
  // record — круг после первого: квитанция идёт в updates сразу, а не по концу круга,
  // иначе unwatch() посреди круга терял бы уже поставленную ревизию.
  async function poll(wt: Watch, record: boolean): Promise<SpriteReceipt[]> {
    const out: SpriteReceipt[] = []
    const push = (r: SpriteReceipt) => {
      out.push(r)
      // not_found — у ключа всё ещё нет ревизий; в updates только то, что приехало или отказало.
      if (!record || r.code === 'not_found') return
      wt.updates.push(r)
      if (wt.updates.length > WATCH_UPDATES_MAX) wt.updates.splice(0, wt.updates.length - WATCH_UPDATES_MAX)
    }
    let failed = false
    const e0 = epoch
    const alive = () => !wt.stopped && epoch === e0
    for (const key of wt.keys) {
      if (wt.stopped) break
      const got = await fetchRevision(`/api/debug/sprite/${wt.taskId}/${key}/latest`, wt.etags.get(key))
      if (wt.stopped) break
      if (!got.ok) {
        push({ ok: false, key, source: 'watch', taskId: wt.taskId, code: got.code, error: got.error })
        if (got.code !== 'not_found') {
          failed = true
          wt.lastError = `${key}: ${got.error}`
        }
        continue
      }
      if (got.status === 304) continue
      // ETag запоминается и у брака: квитанция bad_size не повторяется каждую секунду.
      wt.etags.set(key, got.etag ?? `"${got.sha256}"`)
      const r = await apply(game, key, got.src, undefined, { source: 'watch', taskId: wt.taskId, rev: got.rev, sha256: got.sha256 }, alive)
      if (r) push(r)
    }
    wt.polls++
    if (failed) wt.errors++
    return out
  }

  function schedule(wt: Watch) {
    if (wt.stopped) return
    wt.timer = setTimeout(async () => {
      // Исключение в круге не должно молча гасить опрос: watch при этом выглядел бы живым.
      try {
        await poll(wt, true)
      } catch (e) {
        wt.errors++
        wt.lastError = e instanceof Error ? e.message : String(e)
      }
      schedule(wt)
    }, WATCH_EVERY_MS)
  }

  function stop(): Watch | null {
    const wt = watch
    if (!wt) return null
    wt.stopped = true
    if (wt.timer) clearTimeout(wt.timer)
    watch = null
    return wt
  }

  return {
    try: (key, src, opts) => apply(game, key, src, opts, { source: 'try' }),

    async pull(taskId, key, rev, opts) {
      const t = String(taskId)
      const tag = { source: 'pull' as const, key, taskId: t, rev }
      if (!SPRITES[key]) return { ok: false, ...tag, code: 'unknown_key', error: `ключа '${key}' нет в манифесте sprites.json` }
      if (!TASK_RE.test(t)) return { ok: false, ...tag, code: 'bad_task', error: `taskId — число, получено ${JSON.stringify(taskId)}` }
      if (!Number.isInteger(rev) || rev < 1) return { ok: false, ...tag, code: 'bad_rev', error: `rev — номер ревизии ≥ 1, получено ${JSON.stringify(rev)}` }
      const got = await fetchRevision(`/api/debug/sprite/${t}/${key}?rev=${rev}`, null, rev)
      if (!got.ok) return { ok: false, ...tag, code: got.code, error: got.error }
      if (got.status !== 200) return { ok: false, ...tag, code: 'minipc_error', error: 'неожиданный 304 без If-None-Match' }
      return apply(game, key, got.src, opts, { source: 'pull', taskId: t, rev: got.rev, sha256: got.sha256 })
    },

    async watch(taskId) {
      const t = String(taskId)
      if (!TASK_RE.test(t)) return { ok: false, taskId: t, code: 'bad_task', error: `taskId — число, получено ${JSON.stringify(taskId)}` }
      let resp: Response
      try {
        resp = await fetch(`/api/debug/sprite/${t}`, { cache: 'no-store' })
      } catch (e) {
        return { ok: false, taskId: t, code: 'server_unreachable', error: `Go-сервер не ответил: ${e instanceof Error ? e.message : String(e)}` }
      }
      if (resp.status !== 200) {
        const r = await refusal(resp)
        return { ok: false, taskId: t, code: r.code, error: r.error }
      }
      const all = jobKeys(await resp.json())
      // Ключ без записи в манифесте не регистрируется: место в сцене появляется раньше задания.
      const keys = all.filter((k) => SPRITES[k])
      const skipped = all.filter((k) => !SPRITES[k]).map((key) => ({ key, code: 'unknown_key' as const }))
      const prev = stop()
      const wt: Watch = { taskId: t, keys, etags: new Map(), polls: 0, updates: [], errors: 0, lastError: null, timer: null, stopped: false }
      watch = wt
      const receipts = await poll(wt, false)
      schedule(wt)
      return { ok: true, taskId: t, keys, skipped, receipts, ...(prev ? { replaced: prev.taskId } : {}) }
    },

    unwatch() {
      const wt = stop()
      if (!wt) return { ok: false, code: 'not_watching', error: 'опроса нет — см. itd.sprite.watch(taskId)' }
      return { ok: true, taskId: wt.taskId, polls: wt.polls, updates: wt.updates, errors: wt.errors, lastError: wt.lastError }
    },

    reset(key) {
      if (key !== undefined && !tried.has(key)) {
        return { ok: false, reset: [], code: 'not_tried', error: `ключ '${key}' не подменён — см. itd.sprite.list()` }
      }
      const keys = key !== undefined ? [key] : [...tried.keys()]
      epoch++
      for (const k of keys) {
        swap(game, k, null)
        tried.delete(k)
      }
      return { ok: true, reset: keys }
    },

    list: () => [...tried.values()].sort((a, b) => a.key.localeCompare(b.key)),
  }
}
