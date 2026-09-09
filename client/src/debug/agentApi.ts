import Phaser from 'phaser'
import { client, sessionId } from '../net'
import type { StateMessage } from '../protocol'
import { AI_SPRITES } from '../scenes/BootScene'
import { findLowContrast, findOffscreen, findOverlaps, findTiny } from './lint'
import type { ContrastEntry, OffscreenEntry, OverlapEntry, TinyEntry } from './lint'
import { startTelemetry } from './telemetry'
import type { ErrorEntry, LogEntry } from './telemetry'

// Агентский фасад window.itd (ITGAME-23, шаг ITGAME-24): консольный API,
// которым агент видит игру и действует в ней без input-слоя и скриншотов.
// Гейт: dev-сборка всегда, прод — ?debug=1 или localStorage['itd.debug']='1'.
// Контракт WS-моста /ws/agent (ITGAME-29) строится поверх этого же API.

// Стабильный id интерактива: клики/наведения ищут объект по этому id.
// Сцены вешают его единожды при создании объекта — перерисовка не меняет id.
export function tag<T extends Phaser.GameObjects.GameObject>(obj: T, id: string): T {
  obj.setData('id', id)
  return obj
}

// ── /api/debug/* (ITGAME-26) ───────────────────────────────────────────────

// Ответ GET /api/debug/state и POST-мутаций: свежий снапшот + сейв.
export interface DebugState {
  sid: string
  state: StateMessage
  save: Record<string, unknown>
  events?: string[]
}

// Ответ POST /api/debug/advance: итог офлайн-промотки + снапшот после неё.
export interface DebugAdvanceResult {
  sid: string
  advance: {
    ticks: number
    days: number
    income: number
    payroll: number
    balance: number
    gameOver: boolean
    victory: boolean
    reason?: string
  }
  state: StateMessage
}

// ── Штамп версии и ассеты (ITGAME-28) ──────────────────────────────────────

// Версия сборки: sha коммита и время билда (vite define; dev — HEAD на
// момент старта vite). Плюс <meta name="build"> в index.html.
export const BUILD = { sha: __BUILD_SHA__, builtAt: __BUILD_AT__ }

// Sweetie-16 (GrafxKid) — палитра арт-пайплайна (scripts/sprites/remap.sh);
// вне её цветов в спрайтах быть не должно.
const SWEETIE16 = new Set([
  '#1a1c2c', '#333c57', '#29366f', '#5d275d', '#257179', '#b13e53', '#ef7d57',
  '#38b764', '#a7f070', '#ffcd75', '#566c86', '#3b5dc9', '#41a6f6', '#73eff7',
  '#94b0c2', '#f4f4f4',
])

// Служебные текстуры Phaser — не ассеты: встроенные (__*) и растеризации
// Text-объектов (Phaser 3.60+ даёт каждой UUID-ключ). Палитра на
// антиалиас шрифтов не распространяется.
const INTERNAL_TEXTURES = new Set(['__DEFAULT', '__MISSING', '__WHITE'])
const UUID_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export interface AssetReport {
  key: string
  source: 'png' | 'pixelart' // чем заполнен ключ: подменённый PNG или кодоген
  w: number
  h: number
  transparentPct: number // доля прозрачных пикселей (alpha < 26)
  f4Pct: number // доля #f4f4f4: детектор запечённого чекерборда/фона
  offPalette: string[] // цвета вне Sweetie-16 (у кодогена пусто всегда)
}

export interface AssetSetEntry {
  key: string
  pngLoaded: boolean // ai:<key> приехал с сервера
  active: 'png' | 'pixelart' // чем реально рисуют сцены
}

// Пиксельный анализ текстуры: любой источник (img/canvas) через drawImage.
// sig — подпись пикселей (RGBA подряд) для поиска дублей ключей.
function analyzeTexture(
  game: Phaser.Game,
  key: string,
  source: AssetReport['source'],
): { report: AssetReport; sig: string } | null {
  if (!game.textures.exists(key)) return null
  const src = game.textures.get(key).getSourceImage()
  const w = src.width
  const h = src.height
  if (!w || !h) return null
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(src as CanvasImageSource, 0, 0)
  const data = ctx.getImageData(0, 0, w, h).data
  let transparent = 0
  let f4 = 0
  const off = new Map<string, number>()
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]
    if (a < 26) {
      transparent++
      continue
    }
    const hex =
      '#' + [data[i], data[i + 1], data[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('')
    if (hex === '#f4f4f4') f4++
    if (!SWEETIE16.has(hex)) off.set(hex, (off.get(hex) ?? 0) + 1)
  }
  const total = w * h
  // Подпись контента (без ключа — для поиска дублей): бинарная строка
  // кусками, spread на весь массив валит стек.
  let bin = ''
  const CHUNK = 8192
  for (let i = 0; i < data.length; i += CHUNK) {
    bin += String.fromCharCode(...data.subarray(i, Math.min(i + CHUNK, data.length)))
  }
  return {
    report: {
      key,
      source,
      w,
      h,
      transparentPct: Math.round((transparent / total) * 1000) / 10,
      f4Pct: Math.round((f4 / total) * 1000) / 10,
      offPalette: [...off.entries()].sort((a, b) => b[1] - a[1]).map(([hex]) => hex),
    },
    sig: `${w}x${h}:${bin}`,
  }
}

// Один и тот же источник у двух ключей? (подмена PNG в BootScene)
function sameSource(game: Phaser.Game, a: string, b: string): boolean {
  if (!game.textures.exists(a) || !game.textures.exists(b)) return false
  return game.textures.get(a).getSourceImage() === game.textures.get(b).getSourceImage()
}

async function debugFetch<T>(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<T> {
  let url = `/api/debug${path}`
  if (method === 'GET') {
    // sid — query-параметр: GET без тела
    url += `${path.includes('?') ? '&' : '?'}sid=${encodeURIComponent(sessionId())}`
  }
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify({ sid: sessionId(), ...body }) : undefined,
  })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    throw new Error((data.error as string) ?? `HTTP ${res.status}`)
  }
  return data as T
}

// ── Представления ─────────────────────────────────────────────────────────

// state(): плоское клиентское представление — null до первого снапшота,
// чтобы wait()-условия не падали на «ещё не подключено».
export interface AgentState {
  connected: boolean
  balance: number | null
  day: number | null
  clock: string | null
  lunch: boolean | null
  phase: StateMessage['phase'] | null
  speed: number | null
  difficulty: StateMessage['difficulty'] | null
  incomePerTick: number | null
  payrollPerDay: number | null
  forecastEndOfDay: number | null
  staff: number | null
  staffConnected: number | null
  staffLimit: number | null
  officesUnlocked: number | null
  officesTotal: number | null
  servers: number | null
  coreLevel: number | null
  coreConnected: number | null
  coreCapacity: number | null
  gateway: boolean | null
  debt: number | null // -balance, когда баланс ушёл в минус
  creditLimit: number | null
  creditRatePct: number | null
  winTarget: number | null
  winStaff: number | null
  winCore: number | null
  winDayLimit: number | null
  activeEvent: string | null
  // ITGAME-26: детерминизм и сценарии
  seed: string | null
  scenario: string | null
  tickInDay: number | null
  dayIncome: number | null
}

// server(): последний снапшот целиком + телеметрия сокета.
export interface AgentServer {
  socket: 'open' | 'reconnecting' | 'closed'
  lastEventId: number // счётчик принятых сообщений (своих id у протокола нет)
  rtt: number | null // мс от последней команды до ближайшего ответа
  reconnects: number
  lastMessageAt: number | null // epoch ms
  snapshot: StateMessage | null
}

// nodes()/text(): объект сцены. x/y — позиция объекта (для вложенных в
// контейнер — локальные), w/h — габариты по bounds (с учётом масштаба).
export interface AgentNode {
  scene: string
  type: string
  id: string | null
  text: string | null
  x: number
  y: number
  w: number
  h: number
  visible: boolean
  alpha: number
  interactive: boolean
  depth: number
}

export interface AgentResult {
  ok: boolean
  error?: string
}

export interface ItdApi {
  // Штамп сборки (ITGAME-28): {sha, builtAt} + <meta name="build">.
  readonly version: { sha: string; builtAt: string }
  state(): AgentState
  server(): AgentServer
  nodes(): AgentNode[]
  text(): AgentNode[]
  ids(): { id: string; scene: string; type: string; text: string | null }[]
  click(id: string): AgentResult & { id?: string; scene?: string }
  hover(id: string): AgentResult & { id?: string; scene?: string }
  key(k: string): AgentResult & { key?: string; scenes?: string[] }
  wait(cond: (s: AgentState, srv: AgentServer) => boolean, timeoutMs?: number): Promise<AgentState>
  overlaps(): OverlapEntry[]
  offscreen(): OffscreenEntry[]
  contrast(): ContrastEntry[]
  tiny(): TinyEntry[]
  assets(): {
    textures: AssetReport[]
    duplicates: { keys: string[]; expected: boolean }[]
    textTextures: number // растеризации Text-объектов (UUID-ключи), вне аудита
  }
  assetSet(): AssetSetEntry[]
  reset(): AgentResult & { removed: string[] }
  log(n?: number): LogEntry[]
  errors(): ErrorEntry[]
  net(n?: number): {
    socket: AgentServer['socket']
    reconnects: number
    rtt: number | null
    last: { dir: 'in' | 'out'; at: number; type: string; info: Record<string, unknown> }[]
  }
  // ITGAME-26: управление временем и состоянием через /api/debug/*.
  pause(): AgentResult
  resume(): AgentResult
  speed(n: number): AgentResult
  step(ms: number): Promise<DebugAdvanceResult>
  advanceDays(n: number): Promise<DebugAdvanceResult>
  set(patch: { money?: number; day?: number; tickInDay?: number }): Promise<DebugState>
  scenario(name: string): Promise<DebugState>
  snapshot(): Promise<DebugState>
  restore(save: Record<string, unknown>): Promise<DebugState>
  quiet(): AgentResult
  help(): string
}

declare global {
  interface Window {
    itd?: ItdApi
  }
}

// ── Реализация ────────────────────────────────────────────────────────────

function buildState(): AgentState {
  const s = client.latest
  if (!s) {
    return {
      connected: false, balance: null, day: null, clock: null, lunch: null,
      phase: null, speed: null, difficulty: null, incomePerTick: null,
      payrollPerDay: null, forecastEndOfDay: null, staff: null,
      staffConnected: null, staffLimit: null, officesUnlocked: null,
      officesTotal: null, servers: null, coreLevel: null, coreConnected: null,
      coreCapacity: null, gateway: null, debt: null, creditLimit: null,
      creditRatePct: null,       winTarget: null, winStaff: null, winCore: null,
      winDayLimit: null, activeEvent: null,
      seed: null, scenario: null, tickInDay: null, dayIncome: null,
    }
  }
  const staff = s.offices.reduce((n, o) => n + o.employees.length, 0)
  return {
    connected: true,
    balance: s.money,
    day: s.day,
    clock: s.clock,
    lunch: s.isLunch,
    phase: s.phase,
    speed: s.speed,
    difficulty: s.difficulty,
    incomePerTick: s.incomePerTick,
    payrollPerDay: s.payrollPerDay,
    forecastEndOfDay: s.forecastEndOfDay,
    staff,
    staffConnected: s.core.connected,
    staffLimit: s.staffLimit,
    officesUnlocked: s.offices.filter((o) => o.unlocked).length,
    officesTotal: s.offices.length,
    servers: s.offices.reduce((n, o) => n + o.servers.length, 0),
    coreLevel: s.core.level,
    coreConnected: s.core.connected,
    coreCapacity: s.core.capacity,
    gateway: s.gateway,
    debt: s.money < 0 ? -s.money : 0,
    creditLimit: s.creditLimit,
    creditRatePct: s.creditRatePct,
    winTarget: s.winTarget,
    winStaff: s.winStaff,
    winCore: s.winCore,
    winDayLimit: s.winDayLimit,
    activeEvent: s.activeEvent?.id ?? null,
    seed: s.seed,
    scenario: s.scenario || null,
    tickInDay: s.tickInDay,
    dayIncome: s.dayIncome,
  }
}

function buildServer(): AgentServer {
  return {
    socket: client.socketStatus(),
    lastEventId: client.stats.messages,
    rtt: client.stats.rtt,
    reconnects: client.stats.reconnects,
    lastMessageAt: client.stats.lastMessageAt || null,
    snapshot: client.latest,
  }
}

// Обход объектов сцены с рекурсией по контейнерам. Свойства достаём
// защитно: не каждый GameObject имеет x/alpha/bounds.
function walkObjects(sceneKey: string, objects: Phaser.GameObjects.GameObject[], out: AgentNode[]): void {
  for (const obj of objects) {
    const o = obj as unknown as {
      type?: string
      x?: number
      y?: number
      visible?: boolean
      alpha?: number
      depth?: number
      input?: { enabled?: boolean } | null
      getData?(k: string): unknown
      text?: string
      getBounds?(): Phaser.Geom.Rectangle
      width?: number
      height?: number
      list?: Phaser.GameObjects.GameObject[]
    }
    let w = 0
    let h = 0
    try {
      const b = o.getBounds?.()
      if (b) {
        w = b.width
        h = b.height
      }
    } catch {
      w = typeof o.width === 'number' ? o.width : 0
      h = typeof o.height === 'number' ? o.height : 0
    }
    out.push({
      scene: sceneKey,
      type: o.type ?? 'unknown',
      id: typeof o.getData?.('id') === 'string' ? (o.getData('id') as string) : null,
      text: typeof o.text === 'string' ? o.text : null,
      x: typeof o.x === 'number' ? o.x : 0,
      y: typeof o.y === 'number' ? o.y : 0,
      w,
      h,
      visible: o.visible !== false,
      alpha: typeof o.alpha === 'number' ? o.alpha : 1,
      interactive: o.input?.enabled === true,
      depth: typeof o.depth === 'number' ? o.depth : 0,
    })
    if (o.list) walkObjects(sceneKey, o.list, out)
  }
}

function activeNodes(game: Phaser.Game): AgentNode[] {
  const out: AgentNode[] = []
  for (const scene of game.scene.getScenes(true)) {
    walkObjects(scene.scene.key, scene.children.list, out)
  }
  return out
}

function findById(game: Phaser.Game, id: string): { obj: Phaser.GameObjects.GameObject; scene: string } | null {
  for (const scene of game.scene.getScenes(true)) {
    const found = findInList(scene.children.list, id)
    if (found) return { obj: found, scene: scene.scene.key }
  }
  return null
}

function findInList(objects: Phaser.GameObjects.GameObject[], id: string): Phaser.GameObjects.GameObject | null {
  for (const obj of objects) {
    const o = obj as unknown as {
      getData?(k: string): unknown
      list?: Phaser.GameObjects.GameObject[]
    }
    if (o.getData?.('id') === id) return obj
    if (o.list) {
      const nested = findInList(o.list, id)
      if (nested) return nested
    }
  }
  return null
}

// Клик мимо input-слоя: дергаем pointerdown-обработчик напрямую. Стаб —
// левая кнопка: OfficeScene различает правый клик (увольнение).
const leftPointer = {
  x: 0, y: 0, worldX: 0, worldY: 0,
  leftButtonDown: () => true,
  rightButtonDown: () => false,
  rightButtonClick: () => false,
} as unknown as Phaser.Input.Pointer

// Раскладка клавиш для key(): короткие имена → коды Phaser.
// Enter/Space/Esc — отчёт дня, 1-4 — сложность в меню (ITGAME-24).
const KEYMAP: Record<string, { code: string; keyCode: number; key: string }> = {
  enter: { code: 'ENTER', keyCode: 13, key: 'Enter' },
  space: { code: 'SPACE', keyCode: 32, key: 'Space' },
  esc: { code: 'ESC', keyCode: 27, key: 'Escape' },
  escape: { code: 'ESC', keyCode: 27, key: 'Escape' },
  1: { code: 'ONE', keyCode: 49, key: '1' },
  2: { code: 'TWO', keyCode: 50, key: '2' },
  3: { code: 'THREE', keyCode: 51, key: '3' },
  4: { code: 'FOUR', keyCode: 52, key: '4' },
}

const HELP = `itd — агентский API игры (ITGAME-24/25/26)
  itd.state()                       — баланс, день, часы, доход, ФОТ, штат, сеть, долг, цель, сид/сценарий (null до первого снапшота)
  itd.server()                      — снапшот целиком + сокет: open|reconnecting|closed, lastEventId, rtt, reconnects
  itd.nodes()                       — все объекты живых сцен: {scene, type, id, text, x, y, w, h, visible, alpha, interactive, depth}
  itd.text()                        — nodes() с непустым текстом
  itd.ids()                         — стабильные id интерактивов (btn.*, nav.*, office.*, room.*, menu.*, modal.*)
  itd.click('btn.hire')             — клик по id: дергает pointerdown-обработчик напрямую, мимо input-слоя
  itd.hover('office.worker.0')      — наведение по id (тултипы)
  itd.key('1'|'enter'|'space'|'esc')— клавиша: 1-4 сложность в меню, enter/space/esc — отчёт дня
  itd.wait(s => s.day === 2)        — промис: поллинг state()/server() до условия (таймаут 5с, второй аргумент — свой)
  itd.overlaps()                    — линтер вёрстки: пересечения видимых текстов одного depth
  itd.offscreen()                   — линтер: вылезание за канвас 1280×720
  itd.contrast()                    — линтер: контраст текста к фону ниже 3:1
  itd.tiny()                        — линтер: шрифт мельче 12px
  itd.log(50)                       — журнал переходов (кольцевой на 200, переживает чистку консоли)
  itd.errors()                      — ошибки страницы (window.onerror + unhandledrejection)
  itd.net(20)                       — последние сообщения WS в обе стороны + сокет/rtt/реконнекты
  itd.version                       — {sha, builtAt} сборки (+ <meta name="build"> в html)
  itd.assets()                      — аудит текстур: размер, прозрачность %, доля #f4f4f4, цвета вне Sweetie-16, дубли ключей
  itd.assetSet()                    — чем рисуют сцены: png (подменён из assets/) или pixelart (кодоген-фолбэк)
  itd.reset()                       — снести все ключи localStorage itd.* (sid, сложность, хинты, зум, отчёты)
  itd.pause() / resume() / speed(n) — темп сессии: set_speed 0/1/0..3 (серверный, живёт в сейве)
  itd.step(2000)                    — пауза + промотка 2с игровых тиков (2000мс = 2 тика) через /api/debug/advance
  itd.advanceDays(3)                — промотка дней офлайн-движком: день N → N+3, отчёты дней в itd.events()
  itd.set({money: 50000})           — читы живой сессии: {money, day, tickInDay}
  itd.scenario('soft_lock')         — пересоздать партию фикстурой: fresh|broke_day3|mid_day10|full_office|soft_lock|pre_victory
  itd.snapshot()                    — полный стейт с сервера: {state, save, events}; сид нового старта — ?seed=1234 в URL страницы
  itd.restore(save)                 — вернуть состояние из snapshot().save (дельта над текущим)
  itd.quiet()                       — стоп твитов/миганий для стабильных скриншотов
Пример: await itd.scenario('soft_lock'); itd.state().day
Пример: itd.set({money: 50000}); await itd.wait(s => s.balance === 50000)`

function makeApi(game: Phaser.Game): ItdApi {
  const telemetry = startTelemetry(game)
  return {
    version: BUILD,
    state: buildState,
    server: buildServer,
    nodes: () => activeNodes(game),
    text: () => activeNodes(game).filter((n) => n.text !== null && n.text !== ''),
    ids: () =>
      activeNodes(game)
        .filter((n) => n.id !== null)
        .map((n) => ({ id: n.id as string, scene: n.scene, type: n.type, text: n.text })),
    click(id) {
      const hit = findById(game, id)
      if (!hit) return { ok: false, error: `id '${id}' не найден — см. itd.ids()` }
      hit.obj.emit('pointerdown', leftPointer, 0, 0, {})
      return { ok: true, id, scene: hit.scene }
    },
    hover(id) {
      const hit = findById(game, id)
      if (!hit) return { ok: false, error: `id '${id}' не найден — см. itd.ids()` }
      hit.obj.emit('pointerover', leftPointer, 0, 0, {})
      return { ok: true, id, scene: hit.scene }
    },
    key(k) {
      const def = KEYMAP[k.toLowerCase()]
      if (!def) return { ok: false, error: `неизвестная клавиша '${k}' — есть: ${Object.keys(KEYMAP).join(', ')}` }
      const event = {
        keyCode: def.keyCode,
        key: def.key,
        code: def.code,
        altKey: false, ctrlKey: false, shiftKey: false, metaKey: false,
        repeat: false, location: 0, timeStamp: performance.now(),
      }
      const scenes: string[] = []
      for (const scene of game.scene.getScenes(true)) {
        const kb = scene.input.keyboard
        if (!kb) continue
        scenes.push(scene.scene.key)
        kb.emit(`keydown-${def.code}`, event)
        kb.emit('keydown', event)
      }
      return { ok: true, key: def.code, scenes }
    },
    wait(cond, timeoutMs = 5000) {
      return new Promise<AgentState>((resolve, reject) => {
        const startedAt = Date.now()
        const tick = () => {
          const s = buildState()
          let ok: boolean
          try {
            ok = cond(s, buildServer())
          } catch (e) {
            clearInterval(timer)
            reject(e instanceof Error ? e : new Error(String(e)))
            return
          }
          if (ok) {
            clearInterval(timer)
            resolve(s)
            return
          }
          if (Date.now() - startedAt >= timeoutMs) {
            clearInterval(timer)
            reject(new Error(`itd.wait: таймаут ${timeoutMs}мс`))
          }
        }
        const timer = setInterval(tick, 100)
        tick()
      })
    },
    overlaps: () => findOverlaps(game),
    offscreen: () => findOffscreen(game),
    contrast: () => findLowContrast(game),
    tiny: () => findTiny(game),
    assets() {
      const textures: AssetReport[] = []
      const bySig = new Map<string, string[]>()
      let textTextures = 0
      for (const key of game.textures.getTextureKeys()) {
        if (INTERNAL_TEXTURES.has(key) || UUID_KEY.test(key)) {
          if (UUID_KEY.test(key)) textTextures++
          continue
        }
        // Источник: ai:<key> — сам PNG; <key> — PNG, если подменён
        // источником ai:<key> в BootScene, иначе кодоген.
        let source: AssetReport['source'] = 'pixelart'
        if (key.startsWith('ai:')) source = 'png'
        else if (sameSource(game, key, 'ai:' + key)) source = 'png'
        const res = analyzeTexture(game, key, source)
        if (!res) continue
        textures.push(res.report)
        bySig.set(res.sig, [...(bySig.get(res.sig) ?? []), key])
      }
      textures.sort((a, b) => a.key.localeCompare(b.key))
      const duplicates = [...bySig.values()]
        .filter((keys) => keys.length > 1)
        .map((keys) => ({
          keys: keys.sort(),
          // «desk_empty + ai:desk_empty» — так устроена подмена PNG в
          // BootScene; дубли без пары ai:* — находка.
          expected: keys.every((k) => keys.includes(k.replace(/^ai:/, ''))),
        }))
      return { textures, duplicates, textTextures }
    },
    assetSet() {
      return AI_SPRITES.map((key) => {
        const pngLoaded = game.textures.exists('ai:' + key)
        return {
          key,
          pngLoaded,
          active: pngLoaded && sameSource(game, key, 'ai:' + key) ? 'png' : 'pixelart',
        }
      })
    },
    reset() {
      // Единый namespace itd.* (ITGAME-28): снести всё разом — sid,
      // сложность, хинты, зум, тумблеры. Страницу перезагружает агент.
      const removed: string[] = []
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i)
        if (k?.startsWith('itd.')) {
          localStorage.removeItem(k)
          removed.push(k)
        }
      }
      return { ok: true, removed }
    },
    log: (n = 50) => telemetry.log(n),
    errors: () => telemetry.errors(),
    net(n = 20) {
      return {
        socket: client.socketStatus(),
        reconnects: client.stats.reconnects,
        rtt: client.stats.rtt,
        last: client.wire.slice(-n),
      }
    },
    pause() {
      client.send('set_speed', 0, { speed: 0 })
      return { ok: true }
    },
    resume() {
      client.send('set_speed', 0, { speed: 1 })
      return { ok: true }
    },
    speed(n) {
      if (!Number.isInteger(n) || n < 0 || n > 3) {
        return { ok: false, error: 'скорость — целое 0..3 (0 — пауза)' }
      }
      client.send('set_speed', 0, { speed: n })
      return { ok: true }
    },
    async step(ms) {
      if (ms <= 0 || ms > 10000) throw new Error('step: мс — 1..10000')
      client.send('set_speed', 0, { speed: 0 }) // степпинг только на паузе
      return debugFetch<DebugAdvanceResult>('POST', '/advance', { ticks: Math.round(ms / 1000) })
    },
    advanceDays(n) {
      if (!Number.isInteger(n) || n < 1 || n > 90) {
        return Promise.reject(new Error('advanceDays: целое 1..90'))
      }
      return debugFetch<DebugAdvanceResult>('POST', '/advance', { days: n })
    },
    set(patch) {
      if (!patch.money && !patch.day && !patch.tickInDay) {
        return Promise.reject(new Error('set: нужен хотя бы один из money/day/tickInDay'))
      }
      return debugFetch<DebugState>('POST', '/state', { ...patch })
    },
    scenario(name) {
      return debugFetch<DebugState>('POST', '/state', { scenario: name })
    },
    snapshot() {
      return debugFetch<DebugState>('GET', '/state')
    },
    restore(save) {
      return debugFetch<DebugState>('POST', '/state', { state: save })
    },
    quiet() {
      // Заморозка визуального шума: мигание поломок, всплывающие циферки.
      // TweenManager живёт на сценах, не на игре. Игровое время не трогаем —
      // пауза отдельно через itd.pause().
      for (const scene of game.scene.getScenes(true)) scene.tweens.pauseAll()
      return { ok: true }
    },
    help() {
      console.log(HELP)
      return HELP
    },
  }
}

// Ставится в main.ts после готовности сцен: до этого сцен ещё нет,
// nodes()/click() смотрели бы в пустоту.
export function installAgentApi(game: Phaser.Game): void {
  const enabled =
    import.meta.env.DEV ||
    new URLSearchParams(location.search).get('debug') === '1' ||
    localStorage.getItem('itd.debug') === '1'
  if (!enabled) return
  game.events.once(Phaser.Core.Events.READY, () => {
    window.itd = makeApi(game)
    console.log(`[itd] agent api ready {build:${import.meta.env.MODE}}`)
  })
}
