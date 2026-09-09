import Phaser from 'phaser'
import { client } from '../net'
import type { StateMessage } from '../protocol'
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
  log(n?: number): LogEntry[]
  errors(): ErrorEntry[]
  net(n?: number): {
    socket: AgentServer['socket']
    reconnects: number
    rtt: number | null
    last: { dir: 'in' | 'out'; at: number; type: string; info: Record<string, unknown> }[]
  }
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
      creditRatePct: null, winTarget: null, winStaff: null, winCore: null,
      winDayLimit: null, activeEvent: null,
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

const HELP = `itd — агентский API игры (ITGAME-24/25)
  itd.state()                       — баланс, день, часы, доход, ФОТ, штат, сеть, долг, цель (null до первого снапшота)
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
Пример: itd.click('menu.diff.normal'); await itd.wait(s => s.connected); itd.click('btn.hire')`

function makeApi(game: Phaser.Game): ItdApi {
  const telemetry = startTelemetry(game)
  return {
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
