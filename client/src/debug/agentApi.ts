import Phaser from 'phaser'
import { client, sessionId } from '../net'
import { partyChange, resetForNewGame } from '../party'
import { nav } from '../rooms'
import { GAME_H, GAME_W } from '../layout'
import type { OfflineCatchUp, SocketStatus, TransportErrorCode } from '../net'
import { COMMAND_TYPES } from '../protocol'
import type { CommandType, ServerErrorCode, StateMessage } from '../protocol'
import { CONTRACT } from './contract.gen'
import { AI_SPRITES } from '../scenes/BootScene'
import type { MenuScene } from '../scenes/MenuScene'
import { PALETTES, SPRITES } from '../assets/manifest'
import type { PaletteName } from '../assets/manifest'
import { findLowContrast, findOffscreen, findOverlaps, findTiny } from './lint'
import type { ContrastEntry, OffscreenEntry, OverlapEntry, OverlapOptions, TinyEntry } from './lint'
import { startTelemetry } from './telemetry'
import type { ErrorEntry, LogEntry } from './telemetry'
import { notifyItdKey, runTrace } from './trace'
import type { TraceResult } from './trace'
export type { TraceResult }
import {
  ACHIEVEMENTS,
  getAchievementsSummary,
  loadStats,
  resetMeta,
  unlockAchievement,
} from '../meta'
import type { AchievementDef, MetaStats } from '../meta'

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

// Состояние переключателя для itd.nodes()/itd.ids() (ITGAME-38): рамка
// активной скорости ⏸/1x/2x/3x, пункт навигации, чекбокс «пропускать
// отчёты», тумблер debug, зум в меню. НЕ GameObject.active («объект жив» в
// Phaser) — свой data-ключ 'active', читается в walkObjects().
export function markActive<T extends Phaser.GameObjects.GameObject>(obj: T, on: boolean): T {
  obj.setData('active', on)
  return obj
}

// ITGAME-58: pointerdown-обработчик, чей guard проглотил клик (дребезг
// switchRoom), зовёт rejectClick(code) — itd.click() тогда отвечает
// ok:false + code вместо ложного ok:true. Сбрасывается вокруг каждого emit.
let clickRejection: string | null = null
export function rejectClick(code: string): void {
  clickRejection = code
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

// Палитра «вне палитры» — по манифесту ключа (manifest.palettes[spec.palette]),
// а не жёстко Sweetie-16: HD-спрайты (desk_pc, worker, …) заявлены с
// palette: 'hd32' и проверяются по hd32, легаси 64px-спрайты — по sweetie16.
// Ключ вне манифеста (или 'ai:'-обёртка) падает на sweetie16 — как было
// раньше для всех ключей.
const paletteSetCache = new Map<PaletteName, ReadonlySet<string>>()
function paletteSetFor(key: string): ReadonlySet<string> {
  const bareKey = key.startsWith('ai:') ? key.slice(3) : key
  const paletteName: PaletteName = SPRITES[bareKey]?.palette ?? 'sweetie16'
  let set = paletteSetCache.get(paletteName)
  if (!set) {
    set = new Set((PALETTES[paletteName] ?? PALETTES.sweetie16).map((h) => `#${h}`))
    paletteSetCache.set(paletteName, set)
  }
  return set
}

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
  offPalette: string[] // цвета вне палитры манифеста этого ключа (у кодогена пусто всегда)
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
  const paletteSet = paletteSetFor(key)
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
    if (!paletteSet.has(hex)) off.set(hex, (off.get(hex) ?? 0) + 1)
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
  // Debug-вызовы идут в партию, которую показывает вкладка (ITGAME-64): после финала
  // net.ts стирает sid из хранилищ, и sessionId() выдал бы свежий — чужую партию.
  const sid = client.liveSid() ?? sessionId()
  let url = `/api/debug${path}`
  if (method === 'GET') {
    // sid — query-параметр: GET без тела
    url += `${path.includes('?') ? '&' : '?'}sid=${encodeURIComponent(sid)}`
  }
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify({ sid, ...body }) : undefined,
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
  // ITGAME-30: меню создано и активно — предикат готовности ДО старта
  // партии (state() там весь null). ITGAME-19: и сводка сейва устоялась. wait(s => s.menuReady) вместо слепого
  // setTimeout; в скрытой вкладке wait() сам прогревает кадр.
  menuReady: boolean
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
  dayProfit: number | null // = hud.dayProfit и «Прибыль» отчёта к концу дня (ITGAME-53)
}

// server(): последний снапшот целиком + телеметрия сокета.
export interface AgentServer {
  socket: SocketStatus
  lastEventId: number // счётчик принятых сообщений (своих id у протокола нет)
  rtt: number | null // мс от последней команды до ближайшего ответа
  reconnects: number
  lastMessageAt: number | null // epoch ms
  sid: string // ITGAME-30: sid текущего соединения (каким партиям уезжают команды)
  sidSwitches: number // ITGAME-30: сколько раз sid сменился между соединениями (гарда вкладок)
  snapshot: StateMessage | null
}

// nodes()/text(): объект сцены. x/y — позиция объекта по его origin (у плашек
// HUD — левый верхний угол, у кнопок модалок и текстов — центр; для вложенных в
// контейнер — локальные), w/h — габариты по bounds (с учётом масштаба),
// cx/cy — центр bounds в мировых 1280×720: точка для настоящего клика.
export interface AgentNode {
  scene: string
  type: string
  id: string | null
  text: string | null
  x: number
  y: number
  w: number
  h: number
  cx: number
  cy: number
  visible: boolean
  alpha: number
  interactive: boolean
  depth: number
  // ITGAME-38: состояние переключателя (markActive) — true/false для
  // контролов со сменным состоянием, null у всех прочих объектов.
  active: boolean | null
}

// hit()/blocker() (приёмка 10.10): кто примет настоящий клик в точке —
// эмуляция хит-теста Phaser (globalTopOnly): сцены сверху вниз, в сцене —
// видимый interactive с наибольшей глубиной, чьи bounds содержат точку.
export interface HitTarget {
  scene: string
  type: string
  id: string | null
  depth: number
}

export interface HitResult {
  ok: boolean // true — клик в центр цели попадёт в саму цель
  id: string
  at: { x: number; y: number } | null // центр цели, мировые 1280×720 (= nodes().cx/cy)
  top: HitTarget | null // кто примет клик в этой точке; null — никто
  why?: string // нет узла / узел невидим
}

export interface AgentResult {
  ok: boolean
  error?: string
  code?: string
}

// Квитанция команды (ITGAME-30): ok=true — сервер принял (state за ней),
// ok=false — код отказа: серверный (ServerErrorCode: no_free_pc,
// not_enough_money, …) или транспортный (TransportErrorCode: not_connected,
// receipt_timeout, disconnected).
export interface CmdReceipt {
  ok: boolean
  code?: ServerErrorCode | TransportErrorCode
  error?: string
}

// ── Контракт API (ITGAME-39): формат itd.contract() ─────────────────────────
// Единственный источник истины — типы ItdApi ниже; client/scripts/gen-contract.mjs
// строит из них contract.gen.ts через TS Compiler API. Меняется сигнатура —
// меняется JSON, а не рукописная строка HELP, за которой легко забыть уследить.

// Параметр метода фасада: имя, тип (как объявлен), опциональность.
export interface ParamSpec {
  name: string
  type: string
  optional: boolean
}

// Поле объектного типа (AgentNode, CmdReceipt, …): тип, опциональность,
// описание — из JSDoc поля, иначе из хвостового //-комментария той же строки.
export interface FieldSpec {
  type: string
  optional: boolean
  doc: string
}

// Один член ItdApi: метод (с параметрами и типом результата) либо
// readonly-свойство (itd.version).
export type MemberSpec =
  | { kind: 'method'; params: ParamSpec[]; returns: string; doc: string; examples: string[] }
  | { kind: 'prop'; type: string; readonly: boolean; doc: string }

// Именованный тип из замыкания членов ItdApi: объект с полями, enum строковых
// литералов (ServerErrorCode, CommandType, …) или произвольный алиас.
export type TypeSpec =
  | { kind: 'object'; fields: Record<string, FieldSpec>; index?: string[] }
  | { kind: 'enum'; values: string[] }
  | { kind: 'alias'; type: string }

// itd.contract(): машинный контракт фасада целиком — методы, типы (в т.ч.
// коды отказов и команды как enum), штамп версии с hash самого контракта.
// version.hash — то, что цитирует отчёт волны приёмки, а не пересказ help().
export interface ItdContract {
  schema: 1
  version: { sha: string; builtAt: string; hash: string }
  methods: Record<string, MemberSpec>
  types: Record<string, TypeSpec>
}

export interface ItdApi {
  /**
   * Штамп сборки: {sha, builtAt} + `<meta name="build">` в html.
   * @example itd.version
   */
  readonly version: { sha: string; builtAt: string }
  /**
   * Баланс, день, часы, доход, ФОТ, штат, сеть, долг, цель, сид/сценарий
   * (null до первого снапшота); menuReady — меню создано, активно и сводка сейва устоялась.
   * @example itd.state()
   */
  state(): AgentState
  /**
   * Снапшот целиком + сокет: open|reconnecting|closed, lastEventId, rtt,
   * reconnects, sid, sidSwitches.
   * @example itd.server()
   */
  server(): AgentServer
  /**
   * Все объекты живых сцен: {scene, type, id, text, x, y, w, h, cx, cy,
   * visible, alpha, interactive, depth, active}. x/y — позиция по origin,
   * cx/cy — центр bounds (точка для настоящего клика).
   * @example itd.nodes()
   */
  nodes(): AgentNode[]
  /**
   * nodes() с непустым текстом.
   * @example itd.text()
   */
  text(): AgentNode[]
  /**
   * Стабильные id интерактивов (btn.*, nav.*, office.*, room.*, menu.*,
   * modal.*) + active — состояние переключателя, null у прочих (НЕ
   * GameObject.active).
   * @example itd.ids()
   */
  ids(): { id: string; scene: string; type: string; text: string | null; active: boolean | null }[]
  /**
   * Клик по id: дёргает pointerdown-обработчик напрямую, мимо input-слоя.
   * ok:false + code 'debounced' — обработчик отбросил клик (дребезг switchRoom
   * 250 мс игрового времени): повторите после паузы.
   * @example itd.click('btn.hire')
   */
  click(id: string): AgentResult & { id?: string; scene?: string }
  /**
   * Наведение по id (тултипы).
   * @example itd.hover('office.worker.0')
   */
  hover(id: string): AgentResult & { id?: string; scene?: string }
  /**
   * Клавиша: 1-4 — сложность в меню, up/down — фокус меню, enter — пункт в фокусе меню / отчёт дня, space/esc — отчёт дня.
   * @example itd.key('enter')
   */
  key(k: string): AgentResult & { key?: string; scenes?: string[] }
  /**
   * Команда с квитанцией сервера (ITGAME-30): Promise<{ok, code?}> — первый
   * state|error после отправки, по порядку команд.
   * @example await itd.cmd('hire')
   */
  cmd(type: CommandType, office?: number, extra?: Record<string, number>): Promise<CmdReceipt>
  /**
   * Живая трассировка окна вокруг action (ITGAME-37): подписка ДО action,
   * окно windowMs (0..10000, по умолчанию 1000) ПОСЛЕ него — реальный путь
   * игрока (клавиши/команды/переходы/тосты/звуки), а не срез log()/net().
   * @example itd.trace(() => itd.click('btn.pc'), 1000)
   */
  trace(action: () => unknown, windowMs?: number): Promise<TraceResult>
  /**
   * Прогреть кадр вручную (сколько шагов лупа сделали); в скрытой вкладке
   * itd делает это сам.
   * @example itd.warm()
   */
  warm(): number
  /**
   * Промис: поллинг state()/server() до условия (таймаут 5с по умолчанию,
   * второй аргумент — свой).
   * @example itd.wait(s => s.day === 2)
   */
  wait(cond: (s: AgentState, srv: AgentServer) => boolean, timeoutMs?: number): Promise<AgentState>
  /**
   * Линтер вёрстки: kind text — тексты одного depth; occlusion — текст под
   * непрозрачной плашкой; interactive — интерактив частично перекрыт
   * интерактивом или текстом (вложенность целиком — не находка). Каждая
   * пара: ratio — площадь пересечения / площадь меньшего из пары (occlusion —
   * / площадь текста), threshold — порог, с которым сравнили. minAreaRatio
   * 0..1 заменяет пороги по умолчанию для всех kind (text и interactive — 0,
   * occlusion — 0.25 и >50% по каждой оси: заданный minAreaRatio снимает и
   * правило по осям, находок может стать больше, чем без него); 0 — строгий
   * режим, вне 0..1 — RangeError.
   * @example itd.overlaps()
   * @example itd.overlaps({ minAreaRatio: 0 })
   */
  overlaps(opts?: OverlapOptions): OverlapEntry[]
  /**
   * Линтер: вылезание за канвас 1280×720 (мировые px). Плюс одна запись
   * {scene:'page', type:'canvas', id:null} — сам канвас не влез в видимую область
   * окна (bounds/out — CSS px окна): масштаб UI крупнее окна, страница скроллится.
   * @example itd.offscreen()
   * @example itd.offscreen().filter(e => e.scene === 'page')
   */
  offscreen(): OffscreenEntry[]
  /**
   * Попадёт ли НАСТОЯЩИЙ клик в центр объекта в него самого: эмуляция
   * хит-теста Phaser (сцены сверху вниз, в сцене — interactive с наибольшей
   * глубиной). ok:false + top — кто перехватит клик (например, затемнение
   * отчёта дня поверх HUD). itd.click() этого не проверяет: он мимо хит-теста.
   * @example itd.hit('btn.menu')
   * @example itd.hit('btn.menu').top
   */
  hit(id: string): HitResult
  /**
   * Что сейчас перекрывает ввод во весь холст: верхний видимый interactive,
   * чьи bounds покрывают 1280×720 (затемнение отчёта дня, модалки, «Пока вас
   * не было»). null — сплошного перекрытия нет. Под ним нажимаются только
   * объекты той же сцены с большей глубиной.
   * @example itd.blocker()
   */
  blocker(): HitTarget | null
  /**
   * Последний офлайн-догон этой страницы: {ticks, days, shown, at} или null.
   * shown:false — догон внутри дня, окно «Пока вас не было» игроку не показано.
   * Догона нет и при ticks 0 (сейв на паузе или в отчёте дня) — тогда null.
   * @example itd.offline()
   */
  offline(): OfflineCatchUp | null
  /**
   * Линтер: контраст текста к фону ниже 3:1.
   * @example itd.contrast()
   */
  contrast(): ContrastEntry[]
  /**
   * Линтер: шрифт мельче 12px.
   * @example itd.tiny()
   */
  tiny(): TinyEntry[]
  /**
   * Аудит текстур: размер, прозрачность %, доля #f4f4f4, цвета вне
   * палитры манифеста этого ключа (manifest.palettes[spec.palette]), дубли
   * ключей.
   * @example itd.assets()
   */
  assets(): {
    textures: AssetReport[]
    duplicates: { keys: string[]; expected: boolean }[]
    textTextures: number // растеризации Text-объектов (UUID-ключи), вне аудита
  }
  /**
   * Чем рисуют сцены: png (подменён из assets/) или pixelart (кодоген-фолбэк).
   * @example itd.assetSet()
   */
  assetSet(): AssetSetEntry[]
  /**
   * Снести все ключи itd.* (sid в обоих хранилищах, сложность, хинты, зум,
   * отчёты).
   * @example itd.reset()
   */
  reset(): AgentResult & { removed: string[] }
  /**
   * Журнал переходов (кольцевой на 200, переживает чистку консоли); + звуки
   * и тосты ({type:'sound', ...} / {type:'toast', ...}).
   * @example itd.log(50)
   */
  log(n?: number): LogEntry[]
  /**
   * Ошибки страницы (window.onerror + unhandledrejection).
   * @example itd.errors()
   */
  errors(): ErrorEntry[]
  /**
   * Последние сообщения WS в обе стороны + сокет/rtt/реконнекты.
   * @example itd.net(20)
   */
  net(n?: number): {
    socket: AgentServer['socket']
    reconnects: number
    rtt: number | null
    last: { dir: 'in' | 'out'; at: number; type: string; info: Record<string, unknown> }[]
  }
  /**
   * Темп сессии — пауза (set_speed 0, серверный, живёт в сейве); до коннекта
   * — {ok:false, code:'not_connected'}.
   * @example itd.pause()
   */
  pause(): AgentResult & { code?: string }
  /**
   * Темп сессии — возобновить (set_speed 1).
   * @example itd.resume()
   */
  resume(): AgentResult & { code?: string }
  /**
   * Темп сессии: set_speed 0..3 (0 — пауза).
   * @example itd.speed(2)
   */
  speed(n: number): AgentResult & { code?: string }
  /**
   * Пауза (set_speed 0 — так и остаётся) + промотка тиков ОФЛАЙН-движком через
   * /api/debug/advance. Две формы: step(ms) — мс, 1 тик = 1000 мс, округление до
   * целых, 500..10000 мс (1..10 тиков); step({ticks}) — целое 1..10000 тиков за
   * вызов. Офлайн-движок — сводная формула: без кофе-роллов, событий, поломок и
   * XP; конец дня закрывается без day_report и без роллов next_day (ни
   * day_report, ни offline_report не приходят). Из фазы day_report сервер
   * сначала делает обычный next_day. Сводка {ticks, days, income, payroll,
   * balance, gameOver, victory, reason?} — в ответе .advance (+ .state) и строкой
   * «debug · advance» в itd.snapshot().events; в itd.log() — только переходы
   * снапшота (day/phase/speed — пауза step на идущей игре тоже даёт speed) и
   * game_over/victory при финале. Вне фазы running (например game_over) сервер
   * отвечает 200 с advance.ticks 0 — ничего не промотано. Настоящий отчёт дня —
   * промотать до последнего тика и дать ему пройти вживую.
   * @example itd.step(2000)
   * @example itd.step({ticks: 60})
   */
  step(msOrTicks: number | { ticks: number }): Promise<DebugAdvanceResult>
  /**
   * Промотка n целых дней (1..90) ОФЛАЙН-движком через /api/debug/advance:
   * день N → N+n, тик дня тот же; set_speed сама не шлёт. Из фазы day_report
   * сервер сначала делает обычный next_day (итог — день N+1+n, тик 0), а HUD,
   * увидев running, закрывает отчёт и возвращает скорость до отчёта, как кнопка
   * «Дальше» (никто другой set_speed не слал) — партия побежит живьём, тик 0 не
   * гарантирован. Нужна пауза — itd.pause() ДО вызова (его set_speed сдвигает
   * счётчик, и HUD скорость не вернёт) или itd.step(): он сам ставит паузу.
   * Офлайн-движок: без кофе-роллов, событий, поломок и XP; дни закрываются
   * без day_report и offline_report — отчётов дней в itd.log() НЕТ, там только
   * смена дня (type 'day') и game_over/victory при финале. Сводка {ticks,
   * days, income, payroll, balance, …} — в ответе .advance и строкой
   * «debug · advance» в itd.snapshot().events. Вне фазы running (например
   * game_over) сервер отвечает 200 с advance.ticks 0 — ничего не промотано.
   * @example itd.advanceDays(3)
   */
  advanceDays(n: number): Promise<DebugAdvanceResult>
  /**
   * Читы живой сессии: {money, day, tickInDay}.
   * @example itd.set({money: 50000})
   */
  set(patch: { money?: number; day?: number; tickInDay?: number }): Promise<DebugState>
  /**
   * Пересоздать партию фикстурой: fresh|broke_day3|mid_day10|full_office|
   * soft_lock|pre_victory|spare_pcs. Сбрасывает клиентское состояние партии: активный
   * офис → О1 (ITGAME-55), оверлеи HUD — отчёт дня, событие, «Пока вас не было», финал,
   * окно выхода — и учёт паузы отчёта (ITGAME-64). Скорость сессии не трогает: вызванный
   * из открытого отчёта или окна выхода, оставляет новую партию на паузе — itd.resume(). Работает и после
   * финала (сессия жива до «В меню»). Ошибка (неизвестная фикстура) партию не трогает.
   * @example itd.scenario('soft_lock')
   */
  scenario(name: string): Promise<DebugState>
  /**
   * Полный стейт с сервера: {sid, state, save, events}.
   * @example await itd.snapshot()
   */
  snapshot(): Promise<DebugState>
  /**
   * Вернуть состояние из snapshot().save (дельта над текущим). Партию не сбрасывает;
   * если активный офис в новом состоянии закрыт — вкладка переходит в О1 (ITGAME-63).
   * @example itd.restore(save)
   */
  restore(save: Record<string, unknown>): Promise<DebugState>
  /**
   * Стоп твитов/миганий для стабильных скриншотов.
   * @example itd.quiet()
   */
  quiet(): AgentResult
  /**
   * Статистика прогонов и состояние достижений (localStorage).
   * @example itd.meta()
   */
  meta(): {
    stats: MetaStats
    achievements: { unlockedCount: number; totalCount: number; list: (AchievementDef & { unlocked: boolean; unlockedAt?: number })[] }
  }
  /**
   * Сбросить мета-статистику и достижения.
   * @example itd.resetMeta()
   */
  resetMeta(): AgentResult
  /**
   * Принудительно открыть ачивку: {ok:true, achievement} | {ok:false, code}.
   * @example itd.unlockAchievement('id')
   */
  unlockAchievement(id: string): AgentResult & { achievement?: AchievementDef }
  /**
   * Человекочитаемая справка по всем методам (печатает в консоль и
   * возвращает ту же строку).
   * @example itd.help()
   */
  help(): string
  /**
   * Машинный контракт API (ITGAME-39): методы, типы, коды ошибок и команд;
   * version.hash — цитировать в отчётах приёмки вместо пересказа help().
   * @example itd.contract().version.hash
   */
  contract(): ItdContract
}

declare global {
  interface Window {
    itd?: ItdApi
  }
}

// ── Реализация ────────────────────────────────────────────────────────────

// Прогрев лупа (ITGAME-30): в скрытой вкладке RAF стоит — сцены не
// создаются, ids()/nodes() смотрели бы в пустоту без ошибки. tick() —
// публичный шаг TimeStep, ровно тот, что зовёт RAF: он двигает загрузчик,
// create() сцен и обновление. Прогрев не рендерит ничего лишнего — канвас
// скрытой вкладки и так не показывается.
function warmTicks(game: Phaser.Game, n: number): number {
  const loop = game.loop as Phaser.Core.TimeStep & { tick(): void }
  let done = 0
  for (; done < n; done++) loop.tick()
  return done
}

function buildState(game: Phaser.Game): AgentState {
  // Меню готово, когда его create() отработал (сцена RUNNING) и сводка
  // сейва устоялась (ITGAME-19): иначе клик уровня в первые миллисекунды
  // спросил бы подтверждение затирания сейва, которого на сервере нет.
  // До старта партии это единственный честный «я на экране» для агента.
  const menu = game.scene.getScene('menu') as MenuScene | null
  const menuReady = game.scene.isActive('menu') && (menu?.saveSettled ?? true)
  const s = client.latest
  if (!s) {
    return {
      connected: false, menuReady, balance: null, day: null, clock: null, lunch: null,
      phase: null, speed: null, difficulty: null, incomePerTick: null,
      payrollPerDay: null, forecastEndOfDay: null, staff: null,
      staffConnected: null, staffLimit: null, officesUnlocked: null,
      officesTotal: null, servers: null, coreLevel: null, coreConnected: null,
      coreCapacity: null, gateway: null, debt: null, creditLimit: null,
      creditRatePct: null,       winTarget: null, winStaff: null, winCore: null,
      winDayLimit: null, activeEvent: null,
      seed: null, scenario: null, tickInDay: null, dayIncome: null, dayProfit: null,
    }
  }
  const staff = s.offices.reduce((n, o) => n + o.employees.length, 0)
  return {
    connected: true,
    menuReady,
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
    dayProfit: s.dayProfit,
  }
}

function buildServer(): AgentServer {
  return {
    socket: client.socketStatus(),
    lastEventId: client.stats.messages,
    rtt: client.stats.rtt,
    reconnects: client.stats.reconnects,
    lastMessageAt: client.stats.lastMessageAt || null,
    sid: sessionId(),
    sidSwitches: client.stats.sidSwitches,
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
    let cx = typeof o.x === 'number' ? o.x : 0
    let cy = typeof o.y === 'number' ? o.y : 0
    try {
      const b = o.getBounds?.()
      if (b) {
        w = b.width
        h = b.height
        cx = b.centerX
        cy = b.centerY
      }
    } catch {
      w = typeof o.width === 'number' ? o.width : 0
      h = typeof o.height === 'number' ? o.height : 0
    }
    const act = o.getData?.('active')
    out.push({
      scene: sceneKey,
      type: o.type ?? 'unknown',
      id: typeof o.getData?.('id') === 'string' ? (o.getData('id') as string) : null,
      text: typeof o.text === 'string' ? o.text : null,
      x: typeof o.x === 'number' ? o.x : 0,
      y: typeof o.y === 'number' ? o.y : 0,
      w,
      h,
      cx: Math.round(cx * 10) / 10,
      cy: Math.round(cy * 10) / 10,
      visible: o.visible !== false,
      alpha: typeof o.alpha === 'number' ? o.alpha : 1,
      interactive: o.input?.enabled === true,
      depth: typeof o.depth === 'number' ? o.depth : 0,
      active: typeof act === 'boolean' ? act : null,
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

interface HitCandidate { t: HitTarget; b: Phaser.Geom.Rectangle; order: number }

// Видимые interactive объекты сцены с мировыми bounds; вложенные в контейнер
// наследуют глубину и видимость контейнера, порядок — порядок отрисовки.
function interactiveIn(sceneKey: string, objects: Phaser.GameObjects.GameObject[], depth: number | null,
  out: HitCandidate[]): void {
  for (const obj of objects) {
    const o = obj as unknown as {
      type?: string
      visible?: boolean
      alpha?: number
      depth?: number
      input?: { enabled?: boolean } | null
      getData?(k: string): unknown
      getBounds?(): Phaser.Geom.Rectangle
      list?: Phaser.GameObjects.GameObject[]
    }
    if (o.visible === false || o.alpha === 0) continue
    const d = depth ?? (typeof o.depth === 'number' ? o.depth : 0)
    if (o.input?.enabled === true) {
      try {
        const b = o.getBounds?.()
        const id = o.getData?.('id')
        if (b) out.push({ t: { scene: sceneKey, type: o.type ?? 'unknown', id: typeof id === 'string' ? id : null, depth: d }, b, order: out.length })
      } catch { /* без bounds — не цель */ }
    }
    if (o.list) interactiveIn(sceneKey, o.list, d, out)
  }
}

// Верхний в сцене: наибольшая глубина, при равной — позже отрисованный.
function topOf(cands: HitCandidate[]): HitCandidate | null {
  let best: HitCandidate | null = null
  for (const c of cands) {
    if (!best || c.t.depth > best.t.depth || (c.t.depth === best.t.depth && c.order > best.order)) best = c
  }
  return best
}

function hitAt(game: Phaser.Game, x: number, y: number): HitTarget | null {
  for (const scene of game.scene.getScenes(true, true)) {
    const cands: HitCandidate[] = []
    interactiveIn(scene.scene.key, scene.children.list, null, cands)
    const top = topOf(cands.filter((c) => c.b.contains(x, y)))
    if (top) return top.t
  }
  return null
}

function blockerOf(game: Phaser.Game): HitTarget | null {
  for (const scene of game.scene.getScenes(true, true)) {
    const cands: HitCandidate[] = []
    interactiveIn(scene.scene.key, scene.children.list, null, cands)
    const full = topOf(cands.filter((c) => c.b.x <= 0 && c.b.y <= 0 && c.b.right >= GAME_W && c.b.bottom >= GAME_H))
    if (full) return full.t
  }
  return null
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
// Enter/Space/Esc — отчёт дня, 1-4 — сложность в меню (ITGAME-24),
// up/down — фокус пунктов меню (ITGAME-19).
const KEYMAP: Record<string, { code: string; keyCode: number; key: string }> = {
  enter: { code: 'ENTER', keyCode: 13, key: 'Enter' },
  space: { code: 'SPACE', keyCode: 32, key: 'Space' },
  esc: { code: 'ESC', keyCode: 27, key: 'Escape' },
  escape: { code: 'ESC', keyCode: 27, key: 'Escape' },
  1: { code: 'ONE', keyCode: 49, key: '1' },
  2: { code: 'TWO', keyCode: 50, key: '2' },
  3: { code: 'THREE', keyCode: 51, key: '3' },
  4: { code: 'FOUR', keyCode: 52, key: '4' },
  // ↑↓ — фокус пунктов меню (ITGAME-19)
  up: { code: 'UP', keyCode: 38, key: 'ArrowUp' },
  down: { code: 'DOWN', keyCode: 40, key: 'ArrowDown' },
}

// Команды протокола для itd.cmd() (ITGAME-30): единственный список —
// COMMAND_TYPES в protocol.ts (ITGAME-39), zero дублей.
const COMMANDS = new Set<string>(COMMAND_TYPES)

const HELP = `itd — агентский API игры (ITGAME-24/25/26/30/37/38/39)
  itd.state()                       — баланс, день, часы, доход, ФОТ, штат, сеть, долг, цель, сид/сценарий (null до первого снапшота); menuReady — меню создано, активно и сводка сейва устоялась
  itd.server()                      — снапшот целиком + сокет: open|reconnecting|closed, lastEventId, rtt, reconnects, sid, sidSwitches
  itd.nodes()                       — все объекты живых сцен: {scene, type, id, text, x, y, w, h, cx, cy, visible, alpha, interactive, depth, active}; x/y — по origin объекта, cx/cy — центр bounds (точка для клика)
  itd.text()                        — nodes() с непустым текстом
  itd.ids()                         — стабильные id интерактивов (btn.*, nav.*, office.*, room.*, menu.*, modal.*) + active
                                       active — состояние переключателя (btn.speed.*, nav.*, btn.skip_reports, btn.debug, menu.zoom.*), null у прочих; НЕ GameObject.active
  itd.click('btn.hire')             — клик по id: дергает pointerdown-обработчик напрямую, мимо input-слоя
                                       ok:false + code 'debounced' — обработчик отбросил клик (дребезг switchRoom 250 мс игрового времени)
  itd.hover('office.worker.0')      — наведение по id (тултипы)
  itd.key('1'|'enter'|'space'|'esc')— клавиша: 1-4 сложность в меню, up/down — фокус меню, enter — пункт в фокусе меню / отчёт дня, space/esc — отчёт дня
  itd.cmd('hire')                   — команда с квитанцией сервера: Promise<{ok, code?}> — первый state|error после отправки, по порядку команд; серверные коды: no_free_pc, not_enough_money, …; транспортные: not_connected, receipt_timeout, disconnected
  itd.trace(() => itd.click('btn.pc'), 1000) — живая трассировка: подписка ДО action, окно windowMs (0..10000, по умолчанию 1000) ПОСЛЕ него → {ok, error?, result, t0, t1, actionMs, keys[{key, source: dom|itd, handled — есть подписчик, scenes, acted[{scene, action}] — сцена реально отработала; [] — guard отбросил}], sent[{type, office, …}] по порядку, recv[error/day_report…], transitions[{kind: phase|speed|day|scenes, from, to}], toasts[{text, where}], sounds[{name, key, ok}]}; t — мс от t0. Реальная клавиатура — page.keyboard.press внутри окна (action может быть паузой)
  itd.warm()                        — прогреть кадр вручную (шаги лупа); в скрытой вкладке itd делает это сам
  itd.wait(s => s.day === 2)        — промис: поллинг state()/server() до условия (таймаут 5с, второй аргумент — свой); готовность меню — wait(s => s.menuReady), до старта партии state() null, но menuReady уже честен
  itd.overlaps({minAreaRatio}?)     — линтер вёрстки: kind: text — тексты одного depth; occlusion — текст под непрозрачной плашкой; interactive — интерактив частично перекрыт интерактивом или текстом (вложенность целиком — не находка); пара {scene, kind, a, b, overlap{w,h}, at{x,y}, ratio, threshold}: ratio — площадь пересечения / площадь меньшего из пары (occlusion — / площадь текста), threshold — порог сравнения; minAreaRatio 0..1 заменяет пороги по умолчанию (text/interactive 0, occlusion 0.25 + >50% по каждой оси; заданный minAreaRatio заменяет и правило по осям — для occlusion находок может стать больше): 0 — строгий режим, 0.3 — порог по площади для всех kind
  itd.offscreen()                   — линтер: вылезание за канвас 1280×720; + {scene:'page', type:'canvas'} — канвас не влез в окно (CSS px)
  itd.hit('btn.menu')               — попадёт ли НАСТОЯЩИЙ клик в центр объекта в него: {ok, at{x,y}, top{scene,id,type,depth}} — top перехватит (затемнение отчёта поверх HUD); itd.click этого не видит
  itd.blocker()                     — что перекрывает ввод во весь холст (затемнение отчёта, модалка) или null
  itd.offline()                     — последний офлайн-догон страницы {ticks, days, shown, at}: shown:false — догон внутри дня, окна «Пока вас не было» не было
  itd.contrast()                    — линтер: контраст текста к фону ниже 3:1
  itd.tiny()                        — линтер: шрифт мельче 12px
  itd.log(50)                       — журнал переходов (кольцевой на 200, переживает чистку консоли); + {type:'sound', key:'sfx:bong', name, volume, scene, ok}, {type:'toast', text, where, ms, bg, scene}
                                       Пример: itd.log(200).filter(e => e.type === 'sound').map(e => e.key)
  itd.errors()                      — ошибки страницы (window.onerror + unhandledrejection), переживают перезагрузку вкладки: load — номер загрузки
  itd.net(20)                       — последние сообщения WS в обе стороны + сокет/rtt/реконнекты
  itd.version                       — {sha, builtAt} сборки (+ <meta name="build"> в html)
  itd.assets()                      — аудит текстур: размер, прозрачность %, доля #f4f4f4, цвета вне палитры манифеста ключа (hd32/sweetie16), дубли ключей
  itd.assetSet()                    — чем рисуют сцены: png (подменён из assets/) или pixelart (кодоген-фолбэк)
  itd.reset()                       — снести все ключи itd.* (sid в обоих хранилищах, сложность, хинты, зум, отчёты)
  itd.pause() / resume() / speed(n) — темп сессии: set_speed 0/1/0..3 (серверный, живёт в сейве); до коннекта — {ok:false, code:'not_connected'}
  itd.step(2000) / step({ticks:60}) — пауза + промотка офлайн-движком (без кофе/событий/поломок/XP, день закрывается без day_report): мс (1 тик = 1000 мс, до 10 тиков) или {ticks: 1..10000}; из фазы отчёта — сначала next_day; сводка — в .advance и «debug · advance» в itd.snapshot().events; вне running (game_over) — 200 с advance.ticks 0, ничего не промотано
  itd.advanceDays(3)                — промотка дней офлайн-движком: день N → N+3 (из фазы отчёта — сначала next_day, и HUD вернёт скорость до отчёта: партия побежит живьём, для паузы — itd.pause() ДО вызова), без day_report; сводка {days, income, payroll, balance} — в ответе .advance и строкой «debug · advance» в itd.snapshot().events, в itd.log() — только смена дня
  itd.set({money: 50000})           — читы живой сессии: {money, day, tickInDay}
  itd.scenario('soft_lock')         — пересоздать партию фикстурой: fresh|broke_day3|mid_day10|full_office|soft_lock|pre_victory|spare_pcs; сбрасывает клиентское состояние партии (офис → О1, оверлеи HUD, пауза отчёта); скорость не трогает — из отчёта или окна выхода партия остаётся на паузе: itd.resume(); работает и после финала
  itd.snapshot()                    — полный стейт с сервера: {state, save, events}; сид нового старта — ?seed=1234 в URL страницы
  itd.restore(save)                 — вернуть состояние из snapshot().save (дельта над текущим); закрытый в новом состоянии активный офис → О1
  itd.quiet()                       — стоп твитов/миганий для стабильных скриншотов
  itd.meta()                        — статистика прогонов и состояние достижений (localStorage)
  itd.resetMeta()                   — сбросить мета-статистику и достижения
  itd.unlockAchievement('id')       — принудительно открыть ачивку: {ok:true, achievement} | {ok:false, code}
  itd.contract()                    — машинный контракт API (методы, типы, коды ошибок); version.hash — цитировать в отчётах, а не пересказ help()
Фоновая вкладка: RAF стоит, но itd сам ведёт луп (пульс 300мс + прогрев в каждом вызове) — ids()/nodes()/click() живут без скриншотов и без «принудительного кадра».
Параллельные вкладки: sid берётся из sessionStorage РАНЬШЕ localStorage; в хранилища ключ попадает ТОЛЬКО с реальной партиёй (чтение его не пишет — «ПРОДОЛЖИТЬ» не врёт). Одна партия = один sid: агрессивным прогонам — sessionStorage.setItem('itd.sid', 'a-<имя>-'+Date.now()) (виден только вкладке, общий ключ не трогает; ЯВНО выставленный sid чтится и для новой партии), игроку достаётся localStorage + зеркало вкладки. Кнопка сложности/1-4 = НОВАЯ партия: без явного sessionStorage-sid берётся свежий sid, чужой сейв из общего ключа НЕ продолжается молча; «ПРОДОЛЖИТЬ»/Enter = восстановление текущего sid. server().sidSwitches > 0 — общий ключ перезаписала соседняя вкладка, реконнект ушёл бы в её партию.
Пример: await itd.scenario('soft_lock'); itd.state().day
Пример: itd.set({money: 50000}); await itd.wait(s => s.balance === 50000)
Пример: await itd.cmd('hire') → {ok:false, code:'no_free_pc'} — сервер отказал, ПК заняты`

function makeApi(game: Phaser.Game): ItdApi {
  const telemetry = startTelemetry(game)

  // Пульс скрытой вкладки (ITGAME-30): пока вкладка спрятана, RAF стоит —
  // грузчик и create() сцен не двигаются вовсе. Раз в 300мс ткнём луп
  // вручную: объекты создаются и живут независимо от рендера. На видимой
  // вкладке пульс — no-op, там работает настоящий RAF.
  const pulse = setInterval(() => {
    if (document.visibilityState === 'hidden') warmTicks(game, 1)
  }, 300)
  game.events.once(Phaser.Core.Events.DESTROY, () => clearInterval(pulse))

  // Прогрев по требованию: каждый читающий метод фасада сначала ткнёт луп
  // несколько раз — в скрытой вкладке это создаёт сцены сразу, не ожидая
  // пульса; на видимой — ничего не меняет (кадры уже идут).
  const warmIfHidden = (): void => {
    if (document.visibilityState === 'hidden') warmTicks(game, 5)
  }
  const warmedNodes = (): AgentNode[] => {
    warmIfHidden()
    return activeNodes(game)
  }

  return {
    version: BUILD,
    state: () => buildState(game),
    server: buildServer,
    nodes: () => warmedNodes(),
    text: () => warmedNodes().filter((n) => n.text !== null && n.text !== ''),
    ids: () =>
      warmedNodes()
        .filter((n) => n.id !== null)
        .map((n) => ({ id: n.id as string, scene: n.scene, type: n.type, text: n.text, active: n.active })),
    click(id) {
      warmIfHidden()
      const hit = findById(game, id)
      if (!hit) return { ok: false, error: `id '${id}' не найден — см. itd.ids()` }
      clickRejection = null
      hit.obj.emit('pointerdown', leftPointer, 0, 0, {})
      const code = clickRejection
      clickRejection = null
      if (code) return { ok: false, code, error: `клик '${id}' отброшен: ${code}`, id, scene: hit.scene }
      return { ok: true, id, scene: hit.scene }
    },
    hover(id) {
      warmIfHidden()
      const hit = findById(game, id)
      if (!hit) return { ok: false, error: `id '${id}' не найден — см. itd.ids()` }
      hit.obj.emit('pointerover', leftPointer, 0, 0, {})
      return { ok: true, id, scene: hit.scene }
    },
    key(k) {
      const def = KEYMAP[k.toLowerCase()]
      if (!def) return { ok: false, error: `неизвестная клавиша '${k}' — есть: ${Object.keys(KEYMAP).join(', ')}` }
      warmIfHidden()
      const event = {
        keyCode: def.keyCode,
        key: def.key,
        code: def.code,
        altKey: false, ctrlKey: false, shiftKey: false, metaKey: false,
        repeat: false, location: 0, timeStamp: performance.now(),
      }
      // ITGAME-37: itd.trace() слушает клавиши itd.key() мимо DOM — ДО цикла
      // emit, потому что обработчик может остановить/сменить сцену (см.
      // handlerScenes в trace.ts, которому нужны сцены ДО обработки).
      notifyItdKey(def.code)
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
    cmd(type, office = 0, extra = {}) {
      // Квитанция сервера (ITGAME-30): ok=true только когда за командой
      // пришёл state; отказ сервера виден кодом, а не молчанием. Проверка
      // рантайм-набора остаётся: itd.cmd() зовут из консоли, не из TS.
      if (!COMMANDS.has(type)) {
        return Promise.resolve({
          ok: false,
          error: `неизвестная команда '${type}' — есть: ${[...COMMANDS].join(', ')}`,
        })
      }
      return client
        .sendWithReceipt(type, office, extra)
        .then((r) => (r.ok ? r : { ...r, error: r.code }))
    },
    trace: (action, windowMs = 1000) => runTrace(game, action, windowMs),
    warm: () => warmTicks(game, 10),
    wait(cond, timeoutMs = 5000) {
      return new Promise<AgentState>((resolve, reject) => {
        const startedAt = Date.now()
        const tick = () => {
          // Скрытая вкладка: условия вида menuReady/ids без прогрева не
          // станут истинными никогда — луп стоит (ITGAME-30).
          warmIfHidden()
          const s = buildState(game)
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
    overlaps: (opts) => findOverlaps(game, opts),
    offscreen: () => findOffscreen(game),
    hit(id) {
      warmIfHidden()
      const n = activeNodes(game).find((x) => x.id === id)
      if (!n) return { ok: false, id, at: null, top: null, why: 'нет узла' }
      if (!n.visible) return { ok: false, id, at: { x: n.cx, y: n.cy }, top: null, why: 'узел невидим' }
      const top = hitAt(game, n.cx, n.cy)
      return { ok: top?.id === id, id, at: { x: n.cx, y: n.cy }, top }
    },
    blocker() {
      warmIfHidden()
      return blockerOf(game)
    },
    offline: () => client.lastOffline,
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
      // Единый namespace itd.* (ITGAME-28): снести всё разом — sid (обе
      // копии: sessionStorage вкладки + localStorage игрока, ITGAME-30),
      // сложность, хинты, зум, тумблеры. Страницу перезагружает агент.
      const removed: string[] = []
      for (const store of [localStorage, sessionStorage]) {
        for (let i = store.length - 1; i >= 0; i--) {
          const k = store.key(i)
          if (k?.startsWith('itd.')) {
            store.removeItem(k)
            removed.push(k)
          }
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
      // Честный отказ до коннекта (ITGAME-30): раньше — тихий no-op c ok:true.
      return client.send('set_speed', 0, { speed: 0 })
        ? { ok: true }
        : { ok: false, code: 'not_connected', error: 'сокет не открыт — пауза не отправлена' }
    },
    resume() {
      return client.send('set_speed', 0, { speed: 1 })
        ? { ok: true }
        : { ok: false, code: 'not_connected', error: 'сокет не открыт — resume не отправлен' }
    },
    speed(n) {
      if (!Number.isInteger(n) || n < 0 || n > 3) {
        return { ok: false, error: 'скорость — целое 0..3 (0 — пауза)' }
      }
      return client.send('set_speed', 0, { speed: n })
        ? { ok: true }
        : { ok: false, code: 'not_connected', error: 'сокет не открыт — скорость не отправлена' }
    },
    async step(msOrTicks) {
      let ticks: number
      if (typeof msOrTicks === 'number') {
        // мс-форма (как раньше): 1 тик = 1000 мс, до 10 тиков за вызов
        if (!Number.isFinite(msOrTicks) || msOrTicks <= 0 || msOrTicks > 10000) {
          throw new Error('step: мс — 1..10000 (или {ticks: 1..10000})')
        }
        ticks = Math.round(msOrTicks / 1000)
        if (ticks < 1) throw new Error('step: меньше 500 мс — это 0 тиков (1 тик = 1000 мс)')
      } else {
        ticks = msOrTicks?.ticks
        if (!Number.isInteger(ticks) || ticks < 1 || ticks > 10000) {
          throw new Error('step: {ticks} — целое 1..10000')
        }
      }
      client.send('set_speed', 0, { speed: 0 }) // степпинг только на паузе
      return debugFetch<DebugAdvanceResult>('POST', '/advance', { ticks })
    },
    advanceDays(n) {
      if (!Number.isInteger(n) || n < 1 || n > 90) {
        return Promise.reject(new Error('advanceDays: целое 1..90'))
      }
      return debugFetch<DebugAdvanceResult>('POST', '/advance', { days: n })
    },
    set(patch) {
      if (patch.tickInDay !== undefined && client.latest?.phase === 'day_report') {
        return Promise.reject(new Error('set: tickInDay недоступен в фазе day_report'))
      }
      if (patch.money === undefined && patch.day === undefined && patch.tickInDay === undefined) {
        return Promise.reject(new Error('set: нужен хотя бы один из money/day/tickInDay'))
      }
      return debugFetch<DebugState>('POST', '/state', { ...patch })
    },
    async scenario(name) {
      // ITGAME-64: сервер пушит снапшот новой партии РАНЬШЕ ответа — на время POST HUD не
      // возвращает скорость из учёта паузы старой партии.
      partyChange.pending = true
      let r: DebugState
      try {
        r = await debugFetch<DebugState>('POST', '/state', { scenario: name })
      } finally {
        partyChange.pending = false
      }
      // ITGAME-55: сервер пересоздал партию, а клиентское состояние прошлой (активный
      // офис) осталось. Снапшот пуша мог уже дойти — переигрываем его со сбросом.
      // ITGAME-64: тот же сброс чистит оверлеи HUD и учёт паузы отчёта (party.ts).
      resetForNewGame()
      client.readoptSid() // после финала clearSession() стёр sid — партия снова живая под sid сокета
      client.reemit()
      return r
    },
    snapshot() {
      return debugFetch<DebugState>('GET', '/state')
    },
    async restore(save) {
      const r = await debugFetch<DebugState>('POST', '/state', { state: save })
      // ITGAME-63: дельта могла закрыть офис, на котором стоит вкладка. Партию не
      // сбрасываем (resetForNewGame — только новой партии): агент остаётся в своём офисе.
      if (!r.state.offices[nav.activeOffice]?.unlocked) {
        nav.activeOffice = 0
        client.reemit() // пуш уже нарисовал закрытый офис — перерисовываем
      }
      return r
    },
    quiet() {
      // Заморозка визуального шума: мигание поломок, всплывающие циферки.
      // TweenManager живёт на сценах, не на игре. Игровое время не трогаем —
      // пауза отдельно через itd.pause().
      for (const scene of game.scene.getScenes(true)) scene.tweens.pauseAll()
      return { ok: true }
    },
    meta: () => ({
      stats: loadStats(),
      achievements: getAchievementsSummary(),
    }),
    resetMeta: () => {
      resetMeta()
      return { ok: true }
    },
    unlockAchievement: (id: string) => {
      if (!ACHIEVEMENTS.some((a) => a.id === id)) {
        return { ok: false, code: 'unknown_achievement', error: `Неизвестное достижение: ${id}` }
      }
      const ach = unlockAchievement(id)
      return ach
        ? { ok: true, achievement: ach }
        : { ok: false, code: 'already_unlocked', error: `Достижение ${id} уже разблокировано` }
    },
    help() {
      console.log(HELP)
      return HELP
    },
    // itd.contract() (ITGAME-39): structuredClone — CONTRACT — единственный
    // объект модуля, отдавать ссылку на него небезопасно (вызывающий может
    // мутировать общий кэш). version подмешивает актуальный BUILD, а не
    // {sha,builtAt} времени генерации contract.gen.ts — hash при этом
    // остаётся хэшем самого контракта (methods/types), а не билда.
    contract: () => structuredClone({
      schema: CONTRACT.schema,
      version: { ...BUILD, hash: CONTRACT.hash },
      methods: CONTRACT.methods,
      types: CONTRACT.types,
    }),
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
