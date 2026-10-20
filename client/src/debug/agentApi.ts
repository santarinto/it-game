import Phaser from 'phaser'
import { client, sessionId } from '../net'
import { localStore, sessionStore } from '../storage'
import { partyChange, partyReplaced, resetForNewGame } from '../party'
import { nav } from '../rooms'
import { GAME_H, GAME_W } from '../layout'
import type { AwayMode, AwayReturn, OfflineCatchUp, SocketStatus, TransportErrorCode } from '../net'
import { COMMAND_TYPES } from '../protocol'
import type { CommandType, ServerErrorCode, StateCause, StateMessage } from '../protocol'
import { CONTRACT } from './contract.gen'
import { checkStale, lastStale } from '../buildstamp'
import { makeSandbox } from './sandbox'
import type { FakeOwnerResult, SandboxApi, SandboxRestore, SandboxResult } from './sandbox'
import { isHiddenOriginal, makeSpriteApi, triedKeys } from './spriteTry'
import type { SpriteApi } from './spriteTry'
export type { FakeOwnerResult, SandboxApi, SandboxRestore, SandboxResult }
import type { StaleInfo } from '../buildstamp'
export type { StaleInfo }
import { AI_SPRITES } from '../scenes/BootScene'
import type { MenuScene } from '../scenes/MenuScene'
import { PALETTES, SPRITES } from '../assets/manifest'
import type { PaletteName } from '../assets/manifest'
import { findLowContrast, findOffscreen, findOverlaps, findTiny } from './lint'
import type { ContrastEntry, OffscreenEntry, OverlapEntry, OverlapOptions, TinyEntry } from './lint'
import { startTelemetry } from './telemetry'
import type { ErrorEntry, LogEntry } from './telemetry'
import { inItdCall, notifyItdKey, runTrace, peekTrace, startTrace, stopTrace, summaryTrace } from './trace'
import type { PointerProbe, TracePointer, TraceResult, TraceSent, TraceStart, TraceStartOptions, TraceSummary, TraceTarget } from './trace'
export type { TracePointer, TraceResult, TraceSent, TraceStart, TraceStartOptions, TraceSummary, TraceTarget }
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

// ITGAME-72: кнопка покупки/найма неактивна (нет денег, мест, ПК) — флаг D в
// itd.screen() и поле disabled в itd.nodes(). Свой data-ключ, как у markActive:
// клик по такой кнопке обработчик принимает (звук ошибки, тряска), но не покупает.
export function markDisabled<T extends Phaser.GameObjects.GameObject>(obj: T, on: boolean): T {
  obj.setData('disabled', on)
  return obj
}

// ITGAME-72: заголовок окна на его подложке (оверлей модалки, отчёта, финала) или
// панели — itd.screen().meta.title и blocker().title берут его явно, без эвристик
// по тексту.
export function markTitle<T extends Phaser.GameObjects.GameObject>(obj: T, title: string): T {
  obj.setData('title', title)
  return obj
}

// ITGAME-87: затемнение модалки во весь холст (отчёт дня, финал, «Пока вас не
// было», showModal, окна меню, обрыв связи) — markTitle + data-ключ 'dim'. Единое
// правило линтера: затемнение — не перекрывающий в itd.overlaps() (раньше решала
// альфа: 0.9 у финала проходила порог, 0.75 у отчёта — нет); что оно закрывает
// от клика — забота itd.hit()/stack(). Новое затемнение — через markDim.
export function markDim<T extends Phaser.GameObjects.GameObject>(obj: T, title: string): T {
  obj.setData('dim', true)
  return markTitle(obj, title)
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

// Ответ POST /api/debug/format (ITGAME-154): сейв sid помечен другим форматом.
export interface StaleSaveResult {
  sid: string
  was: number // game.format сейва до метки
  format: number // game.format после — не формат сервера
  live: boolean // true — сейв держит живая партия: её актор пишет метку до выхода, «В меню» → карточка, переподключение → новая партия молча (ITGAME-174); false — сейв переписан в сторе: меню после перезагрузки → «СЕЙВ НЕСОВМЕСТИМ»
}

// ── Партия и бухгалтерия из консоли (ITGAME-73) ────────────────────────────

// Шаг itd.play(): команда с квитанцией (как itd.cmd) …
export interface PlayCmdStep {
  cmd: CommandType
  office?: number // по умолчанию 0
  extra?: Record<string, number> // поля команды: {speed: 0} у set_speed, {slot: n} у fire/motivate/…
}

// … или промотка n целых дней офлайн-движком (как itd.advanceDays).
export interface PlayDaysStep {
  days: number // 1..90
}

export type PlayStep = PlayCmdStep | PlayDaysStep

// Покупка дня в itd.ledger(): списано командой.
export interface LedgerPurchase {
  type: string // команда протокола: buy_pc, hire, fire, call_master, …; event_choice — звезда из события; «…» — сводная строка сверх 32
  price: number // списано, $
  clock: string // «HH:MM» игрового дня
  n?: number // у сводной строки «…» — сколько покупок в ней
}

// Деньги исхода события в itd.ledger(), со знаком.
export interface LedgerEvent {
  what: string // «аудит провален», «дедлайн выполнен», «дедлайн отклонён», …
  money: number // со знаком: штраф < 0, награда > 0
  clock: string // «HH:MM» игрового дня
}

// Книга дня (GET /api/debug/ledger): balanceStart + income + eventMoney −
// purchasesTotal − payroll − gatewayOpex − antivirus − interest + adjust = balanceEnd.
export interface DayLedger {
  day: number
  fromTick: number // книга с этого тика: 0 — с утра; >0 — фикстура посреди дня или сейв до ITGAME-73
  balanceStart: number
  income: number // доход тиков
  eventMoney: number // деньги событий, со знаком (= day_report.eventMoney)
  events: LedgerEvent[]
  purchases: LedgerPurchase[]
  purchasesTotal: number
  payroll: number // зарплаты вечером (= day_report.payroll); у открытого дня 0
  gatewayOpex: number // опекс шлюза вечером
  antivirus: number // подписка на антивирус вечером (ITGAME-137), в «Прибыль» входит
  interest: number // процент по долгу при закрытии дня (кредит), в «Прибыль» не входит
  adjust: number // debug-правка баланса (itd.set, itd.restore); в игре 0
  balanceEnd: number // у текущего дня — живой баланс
  profit: number // income + eventMoney − payroll − gatewayOpex − antivirus = day_report.profit закрытого дня
  delta: number // balanceEnd − balanceStart
  balanced: boolean // слагаемые сходятся с delta ровно
  closed: boolean // вечер прошёл, ФОТ списан
  offline: boolean // день закрыт офлайн-движком (itd.advanceDays/step, догон после реконнекта)
  history: number[] // дни, по которым есть книга: 7 закрытых + текущий
}

// Запись журнала партии (ITGAME-46, GET /api/debug/journal) — без тяжёлых
// полей: save/state/rng заменены флагами hasSave/hasState.
export interface JournalRecord {
  k: 'start' | 'cmd' | 'debug' | 'day' | 'cp' | 'resume' | 'end'
  seq: number
  tk?: number // тиков g.Tick() с прошлой записи
  rev: number // rev снапшота после входа (ITGAME-45)
  day: number
  tick: number
  money: number
  phase: string
  speed: number
  h: string // хэш состояния после входа — его сверяет реплей
  id?: number // cmd: id команды клиента — тот же, что в itd.trace().sent и квитанции itd.cmd()
  type?: string // cmd: тип команды
  office?: number
  slot?: number
  arg?: number // cmd: speed у set_speed/exit (0 сервер опускает)
  err?: string // cmd: код отказа
  conn?: number // cmd/start/resume (ITGAME-91): номер соединения в партии (1, 2, … по порядку появления); пара (conn, id) у cmd уникальна в партии
  src?: 'tab' | 'bridge' // cmd/start/resume (ITGAME-91): источник — вкладка (/ws) или мост агента (/ws/agent)
  op?: string // debug: patch | scenario | restore | advance
  patch?: { money?: number; day?: number; tickInDay?: number }
  scenario?: string
  days?: number
  ticks?: number
  pre?: string // resume: хэш поднятого сейва до догона
  offline?: number // resume: тики офлайн-догона
  saveSpeed?: number
  took?: boolean // resume: прежний актор не закрыл журнал — перехват
  evicted?: boolean // end: сессию забрал другой актор (в строке — «end evicted»)
  reason?: string // end: read_timeout | debug_drop — закрыл сторож чтения (в строке — «end read_timeout»/«end debug_drop»); нет evicted и reason — «end disconnect»: соединение закрыл клиент (вкладка закрыта, F5, itd.away close, abandon)
  hasSave?: boolean // в записи был полный сейв (cp, resume)
  hasState?: boolean // debug restore: была дельта состояния
}

// itd.journal(): хвост журнала своей партии.
export interface JournalView {
  sid: string
  seed: string
  difficulty: string
  scenario: string
  version: string // sha сервера, писавшего журнал
  total: number // записей в журнале (без заголовка)
  dropped: number // срезано кольцом с головы
  overflow: boolean // журнал упёрся в потолок без чекпоинта
  kinds: Record<string, number> // сколько записей каждого вида во всём журнале
  /**
   * Хвост одной строкой на запись: «#seq k что | dN tN $M phase Nx revR +tk». «что» по
   * виду: cmd — «тип [oN] [sN] [=скорость] cN [bridge] idN ok|FAIL код» (cN — номер
   * соединения в партии, bridge — команда моста агента, ITGAME-91); start/resume —
   * «cN [bridge]», у resume ещё «offline Nt [took]»; debug — «op детали»; end —
   * evicted (сессию забрал другой актор: вторая вкладка, реконнект раньше, чем
   * сервер заметил обрыв) | read_timeout (сторож чтения: вкладка молчала дольше
   * ITGAME_READ_TIMEOUT) | debug_drop (сторож после POST /api/debug/drop, itd.away
   * net) | disconnect (соединение закрыл клиент: вкладка, F5, away close, abandon);
   * +tk — тики с прошлой записи.
   */
  lines: string[]
  records: JournalRecord[] // тот же хвост объектами
  url: string // полный JSONL: GET этого адреса; реплей — make replay ARGS="-url <origin> -sid <sid>"
}

// ── Штамп версии и ассеты (ITGAME-28) ──────────────────────────────────────

// Версия сборки: sha коммита и время билда (vite define; dev — HEAD на
// момент старта vite). Плюс <meta name="build"> в index.html.
export const BUILD = { sha: __BUILD_SHA__, builtAt: __BUILD_AT__, version: __BUILD_VERSION__ }

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
  source: 'png' | 'pixelart' | 'tried' // подменённый PNG, кодоген или проба itd.sprite.try (ITGAME-119)
  w: number
  h: number
  transparentPct: number // доля прозрачных пикселей (alpha < 26)
  f4Pct: number // доля #f4f4f4: детектор запечённого чекерборда/фона
  offPalette: string[] // цвета вне палитры манифеста этого ключа (у кодогена и render: smooth пусто всегда)
  render: 'pixel' | 'smooth' // как ключ рисуется (ITGAME-83): smooth — LINEAR, палитра не контракт
}

export interface AssetSetEntry {
  key: string
  pngLoaded: boolean // ai:<key> приехал с сервера
  active: 'png' | 'pixelart' | 'tried' // чем реально рисуют сцены; tried — проба itd.sprite.try
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
  // render: smooth (ITGAME-83) — тона вне палитры законны, сотни «нарушений» только шумят
  const render = SPRITES[key]?.render ?? 'pixel'
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
    if (render === 'pixel' && !paletteSet.has(hex)) off.set(hex, (off.get(hex) ?? 0) + 1)
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
      render,
    },
    sig: `${w}x${h}:${bin}`,
  }
}

// Один и тот же источник у двух ключей? (подмена PNG в BootScene)
function sameSource(game: Phaser.Game, a: string, b: string): boolean {
  if (!game.textures.exists(a) || !game.textures.exists(b)) return false
  return game.textures.get(a).getSourceImage() === game.textures.get(b).getSourceImage()
}

// ITGAME-131: debug-ручки сервера (/api/debug/state, /advance, /ledger) говорят с ЖИВОЙ сессией,
// а её у вкладки нет без своей партии: главное меню до первой партии и после «В меню»/«Сдаться»
// (disconnect/abandon обнуляют liveSid), перехват сессии другой вкладкой. Раньше запрос уходил
// под sid хранилища, и сервер отвечал 404 session_not_live «откройте страницу игры с этим sid» —
// при открытой странице. Клик по сложности ставит liveSid синхронно (connect → openSocket):
// открывающийся сокет, отчёт дня, финал, реконнект и itd.away сюда не попадают. Журнал
// (fetchJournal) партии не требует: он живёт на сервере и после её конца.
const NOT_IN_PARTY =
  'not_in_party: вкладка не в партии — debug-вызовы идут только в живую партию вкладки; ' +
  "сначала выберите сложность: itd.click('menu.diff.normal'), затем await itd.wait(s => s.connected); " +
  "при живом сейве меню спросит «Начать заново?» — itd.click('modal.btn.confirm'), или продолжите его: itd.click('menu.continue'); " +
  'если сессию забрала другая вкладка — меню нет, обновите страницу (F5)'

// sid живой партии вкладки или отказ not_in_party без запроса — единственный источник sid
// для debugFetch (и для itd.step до его паузы).
function partySid(): string {
  const sid = client.liveSid()
  if (sid === null) throw new Error(NOT_IN_PARTY)
  return sid
}

async function debugFetch<T>(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<T> {
  // Debug-вызовы идут в партию, которую показывает вкладка (ITGAME-64): после финала net.ts
  // стирает sid из хранилищ, но liveSid сокета жив до «В меню». Без партии — отказ (ITGAME-131).
  const sid = partySid()
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

// fetchJournal — itd.journal(): JSONL журнала → хвост строками и объектами.
// Тяжёлые поля (save, state, rng, config) не тащим в ответ агенту.
async function fetchJournal(sid: string, tail: number): Promise<JournalView> {
  const url = `/api/debug/journal?sid=${encodeURIComponent(sid)}`
  const res = await fetch(url)
  const text = await res.text()
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      msg = (JSON.parse(text) as { error?: string }).error ?? msg
    } catch {
      // не JSON — код ответа
    }
    throw new Error(msg)
  }
  const rows = text.split('\n').filter((l) => l.trim() !== '')
  const header = JSON.parse(rows[0] ?? '{}') as Record<string, unknown>
  const kinds: Record<string, number> = {}
  const records: JournalRecord[] = []
  const from = Math.max(1, rows.length - tail)
  for (let i = 1; i < rows.length; i++) {
    const raw = JSON.parse(rows[i]) as Record<string, unknown>
    const k = String(raw.k)
    kinds[k] = (kinds[k] ?? 0) + 1
    if (i < from) continue
    const { save, state, rng, ...rest } = raw
    void rng
    const rec = rest as unknown as JournalRecord
    if (save !== undefined) rec.hasSave = true
    if (state !== undefined) rec.hasState = true
    records.push(rec)
  }
  return {
    sid: String(header.sid ?? sid),
    seed: String(header.seed ?? ''),
    difficulty: String(header.difficulty ?? ''),
    scenario: String(header.scenario ?? ''),
    version: String(header.version ?? ''),
    total: rows.length - 1,
    dropped: Number(header.dropped ?? 0),
    overflow: header.overflow === true,
    kinds,
    lines: records.map(journalLine),
    records,
    url,
  }
}

// ITGAME-91: « c2» / « c3 bridge» — соединение команды в партии; вкладку не
// подписываем (её большинство), журнал до ITGAME-91 — пусто.
function connOf(r: JournalRecord): string {
  if (!r.conn) return ''
  return ` c${r.conn}${r.src === 'bridge' ? ' bridge' : ''}`
}

// journalLine — запись журнала одной строкой для агента.
function journalLine(r: JournalRecord): string {
  let what = ''
  switch (r.k) {
    case 'cmd': {
      const where = [r.office ? `o${r.office}` : '', r.slot ? `s${r.slot}` : '', r.type === 'set_speed' || r.type === 'exit' ? `=${r.arg ?? 0}` : '']
        .filter(Boolean)
        .join(' ')
      what = `${r.type}${where ? ' ' + where : ''}${connOf(r)} id${r.id ?? 0} ${r.err ? 'FAIL ' + r.err : 'ok'}`
      break
    }
    case 'start':
      what = connOf(r).trim()
      break
    case 'debug': {
      const detail = r.patch
        ? JSON.stringify(r.patch)
        : r.scenario
          ? r.scenario
          : r.op === 'advance'
            ? r.days
              ? `${r.days}d`
              : `${r.ticks ?? 0}t`
            : r.hasState
              ? 'delta'
              : ''
      what = `${r.op}${detail ? ' ' + detail : ''}`
      break
    }
    case 'resume':
      what = `${connOf(r).trim()}${r.conn ? ' ' : ''}offline ${r.offline ?? 0}t${r.took ? ' took' : ''}`
      break
    case 'end':
      what = r.evicted ? 'evicted' : r.reason ? r.reason : 'disconnect'
      break
  }
  const pos = `d${r.day} t${r.tick} $${r.money} ${r.phase} ${r.speed}x rev${r.rev}${r.tk ? ' +' + r.tk : ''}`
  return `#${r.seq} ${r.k}${what ? ' ' + what : ''} | ${pos}`
}

// ── Представления ─────────────────────────────────────────────────────────

// state(): плоское клиентское представление — null до первого снапшота,
// чтобы wait()-условия не падали на «ещё не подключено».
export interface AgentState {
  connected: boolean
  // ITGAME-30: меню создано и активно — предикат готовности ДО старта
  // партии (state() там весь null). ITGAME-19: и сводка сейва устоялась. wait(s => s.menuReady) вместо слепого
  // setTimeout; в скрытой вкладке wait() сам прогревает кадр. ITGAME-88: и перезапуск меню не в
  // очереди — после true раскладка меню (cx/cy плашек) больше не сдвигается.
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
  creditLimit: number | null // кредитный порог, $; 0 — кредита нет (Лёгкий/Норма: там овердрафт, порог — debtLimit)
  creditRatePct: number | null
  debtLimit: number | null // порог долга, $: глубже — вечер банкротит; creditLimit или, без кредита, payrollPerDay (овердрафт, ITGAME-156/177)
  bankruptInDays: number | null // обречённая партия: банкротство через N закрытий дня, 0 — нет (ITGAME-118)
  virusPCs: number | null // заражённых мест по компании (ITGAME-103); по офисам — snapshot().state.offices[i].virusPCs
  virusWaveAt: string | null // «HH:MM», с которого видна следующая волна; '' — заражённых нет
  antivirusTier: number | null // подписка на антивирус: 0 — нет, 1..3 (ITGAME-137); подробно — snapshot().state.antivirus
  adminDept: boolean | null // отдел админов куплен (ITGAME-101/145)
  admins: number | null // нанято админов по компании; цель каждого — snapshot().state.offices[i].adminSlot/adminKind
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
  lastEventId: number // счётчик принятых сообщений этой страницы (не rev: тот — версия сессии)
  rev: number | null // ITGAME-45: версия состояния последнего снапшота (+1 на каждый; ждать — wait((s, srv) => srv.rev >= N))
  cause: StateCause | null // ITGAME-45: почему разослан последний снапшот: tick | cmd | debug | start | resume
  rtt: number | null // мс от последней команды до ближайшего ответа
  reconnects: number
  lastMessageAt: number | null // epoch ms
  sid: string // ITGAME-30/68: sid, в чью партию уходят команды и itd.journal(): liveSid ?? sid хранилища; прочие debug-вызовы — только liveSid (ITGAME-131)
  liveSid: string | null // ITGAME-68: sid живой партии вкладки (сокет); null — до первой партии, после «В меню»/«Сдаться»/перехвата: debug-вызовы, кроме journal, тогда отказывают not_in_party (ITGAME-131)
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
  // id без точек (точка → «:»), обратимо: строка вида a.b.c режется инструментом
  // браузерного агента как JWT. click/hover/hit принимают и такой id.
  safe: string | null
  visible: boolean // видим в мире (ITGAME-87): сам и все его контейнеры visible; скрытый контейнер — false у всех детей
  alpha: number
  interactive: boolean
  depth: number
  // ITGAME-38: состояние переключателя (markActive) — true/false для
  // контролов со сменным состоянием, null у всех прочих объектов.
  active: boolean | null
  // ITGAME-72: кнопка неактивна (markDisabled: нет денег/мест/ПК) — true/false у
  // кнопок покупки и найма HUD, null у прочих.
  disabled: boolean | null
  fill: string | null // ITGAME-88: заливка фигуры '#rrggbb' (Rectangle, Triangle, Arc/Circle, Ellipse, Polygon — Shape с isFilled); null — не фигура или без заливки (Text, Image, Container; Graphics — цвет в буфере команд, не отдаём)
}

// hit()/blocker() (приёмка 10.10): кто примет настоящий клик. hit() — настоящий
// хит-тест Phaser, как stack() (ITGAME-74, владелец 10.10); blocker() — видимый
// interactive с наибольшей глубиной, чьи bounds покрывают весь холст. depth у
// вложенного в контейнер — глубина корневого контейнера.
export interface HitTarget {
  scene: string
  type: string
  id: string | null
  safe: string | null // id с «:» вместо точек (ITGAME-72)
  depth: number
  title: string | null // заголовок окна, если это его подложка (markTitle, ITGAME-72)
}

// itd.screen() (ITGAME-72): карта экрана одним вызовом.
export interface ScreenOptions {
  frame?: number // ширина рамки снимка инструмента, px, число ≥ 100 (иначе отказ bad_frame, ITGAME-148): x/y сразу в ней (по умолчанию — CSS px окна)
  free?: boolean // только элементы, которые примут настоящий клик (без флага X)
  scene?: string // только эта сцена (hud, office, serverRoom, adminDept, menu)
}

export interface ScreenMeta {
  sha: string // сборка вкладки (itd.version.sha)
  tab: string // первые 8 символов sid сокета вкладки
  day: number | null
  clock: string | null
  t: number | null // тик дня
  bal: number | null // баланс по серверу
  speed: number | null
  phase: StateMessage['phase'] | null
  staff: string | null // «штат/лимит»
  pay: number | null // ФОТ в день
  hudClock: string | null // что НАРИСОВАНО в hud.day
  hudBal: string | null // что НАРИСОВАНО в hud.money
  blocker: string | null // «safe|сцена@depth» перекрытия во весь холст или null
  title: string | null // заголовок верхнего окна (markTitle) или null
  stale: boolean | null // вкладка на старом JS по последней проверке (itd.stale(), ITGAME-78); null — не проверяли или не с чем
}

export interface ScreenMap {
  ok: true // ITGAME-148: карта; отказ — {ok:false, code:'bad_frame'} (привычное агенту if (!r.ok) карту отказом не считает)
  meta: ScreenMeta
  n: number
  // 'safe|подпись|x|y|флаги': подпись — тексты, целиком лежащие внутри bounds (≤22 символа, «-» у
  // иконок без текста), x/y — центр в CSS px окна (или в рамке frame), флаги:
  // A — выбрана (active), X — перекрыта (hit не ok), D — неактивна (disabled)
  items: string[]
}

export interface HitResult {
  ok: boolean // true — клик в центр цели попадёт в саму цель
  id: string
  at: { x: number; y: number } | null // центр цели, мировые 1280×720 (= nodes().cx/cy)
  top: HitTarget | null // кто примет клик в этой точке; null — никто
  why?: string // нет узла / узел невидим
}

// stack()/zones() (ITGAME-74): НАСТОЯЩИЙ хит-тест Phaser, а не эмуляция hit():
// InputManager.hitTest по input-списку сцены (hitArea, камера, видимость
// родителей), порядок — InputPlugin.sortGameObjects (renderList камеры), сцены
// сверху вниз; первая сцена с попаданием забирает клик (globalTopOnly), в ней —
// верхний объект (topOnly).
export interface StackResult {
  ok: boolean // false — нет узла / узел невидим (why)
  at: { x: number; y: number } | null // точка, мировые 1280×720
  // все interactive под точкой по хит-тесту Phaser, сверху вниз:
  // 'safe scene dN Type WxH'; '!' в конце — сцена этого объекта клик не получит
  // (выше её другая сцена уже забрала его)
  stack: string[]
  wins: HitTarget | null // кто получит pointerdown; null — никто
  why?: string
}

export interface ZoneRect { x: number; y: number; w: number; h: number }

export interface ZonesResult {
  ok: boolean
  a: string
  b: string
  // прямоугольники (мировые px, сетка 1 px), где точка в зоне хит-теста A,
  // но клик забирает B — и наоборот
  aUnderB: ZoneRect[]
  bUnderA: ZoneRect[]
  // площади, px²: зона A целиком / из неё отдано B; то же для B
  area: { a: number; aUnderB: number; b: number; bUnderA: number }
  why?: string
}

// itd.offline(): последний догон + что сейчас на экране.
export interface AgentOffline extends OfflineCatchUp {
  open: boolean // окно «Пока вас не было» открыто сейчас
  paused: boolean // скорость партии сейчас 0
  seq: number // ITGAME-87: номер догона на этой странице (1, 2, … по приходу offline_report); сверять догоны — по нему, не по at
  awayId: number | null // ITGAME-87: itd.away, во время которого догон пришёл (= его awayId); null — не в away (F5, реконнект, «Продолжить»)
}

// itd.away (ITGAME-76): режим и таймаут чтения для net.
export interface AwayOptions {
  mode?: AwayMode // close (по умолчанию) — как закрытая вкладка; net — как обрыв сети (debug-ручка drop)
  timeout?: number // net: таймаут чтения этого соединения на сервере, мс (50..600000); без него — серверный (ITGAME_READ_TIMEOUT, по умолчанию 30 с)
}

// Итог itd.away: возврат в ту же партию + itd.offline() после него.
export interface AwayResult extends AwayReturn {
  awayId: number // ITGAME-87: номер этого ухода на странице (1, 2, …); догон этого ухода — offline.awayId === awayId
  offline: AgentOffline | null // догон ЭТОГО ухода (offline.awayId === awayId) или null — догона не было (сервер не заметил уход до возврата или партия на паузе); itd.offline() тогда отдаёт прежний догон со своим awayId/seq
}

export interface AgentResult {
  ok: boolean
  error?: string
  code?: string
}

// Квитанция команды (ITGAME-30/45): ok=true — сервер принял (state с re = id
// команды), ok=false — код отказа: серверный (ServerErrorCode: no_free_pc,
// not_enough_money, …) или транспортный (TransportErrorCode: not_connected,
// receipt_timeout, disconnected). Квитанцию закрывает только ответ на ЭТУ
// команду (по id), не тик и не снапшот чужой команды.
export interface CmdReceipt {
  ok: boolean
  code?: ServerErrorCode | TransportErrorCode
  error?: string
  id?: number // ITGAME-45: id команды на проводе (= sent[].id в itd.trace(), info.id в itd.net())
  rev?: number // ITGAME-45: rev снапшота-ответа; у серверного отказа — текущий rev (не меняется)
}

// itd.trace (ITGAME-37/88/179) — функция с методами, как itd.sandbox:
// itd.trace(action, windowMs) — окно вокруг действия; itd.trace.start() /
// itd.trace.stop() — открытое окно на сколько угодно вызовов инструмента;
// itd.trace.summary() — окно строками по времени.
export interface TraceApi {
  (action: () => unknown, windowMs?: number): Promise<TraceResult>
  /** Открыть окно: подписки сразу, до stop(id?) или maxMs (1..600000, по умолчанию 120000) → {ok, id, t0, maxMs, open}; коды bad_max, too_many (больше 8 окон). */
  start: (opts?: TraceStartOptions) => TraceStart
  /** Закрыть окно id (без id — последнее открытое) → TraceResult того же вида, что у itd.trace(), с id, windowMs = длина окна, cut — закрылось само по maxMs; нет окна — {ok:false, code:'no_trace'}. */
  stop: (id?: number) => TraceResult | (AgentResult & { code: 'no_trace' })
  /** Прочитать окно, не закрывая (ITGAME-160): копия TraceResult на сейчас (t1 — сейчас, windowMs — от t0; cut-окно — каким закрылось), окно и его maxMs не трогает, луп не шагает; без id — последнее открытое; нет окна — {ok:false, code:'no_trace'}. */
  peek: (id?: number) => TraceResult | (AgentResult & { code: 'no_trace' })
  /** Окно короткими строками по времени (ITGAME-179), не закрывая: summary(id?) — открытое (или cut) окно, без id — последнее; summary(tr) — любой TraceResult → {ok, id?, cut?, error?, lines['t<мс> ptr|key|sent|recv|state|trans|toast|sound …']}; нет окна / не TraceResult — {ok:false, code:'no_trace', lines: []}. */
  summary: (src?: number | TraceResult) => TraceSummary
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
  | { kind: 'prop'; type: string; readonly: boolean; doc: string; examples?: string[] }

// Именованный тип из замыкания членов ItdApi: объект с полями, enum строковых
// литералов (ServerErrorCode, CommandType, …) или произвольный алиас.
export type TypeSpec =
  | { kind: 'object'; fields: Record<string, FieldSpec>; index?: string[]; call?: string[] } // call — сигнатуры вызова (itd.trace(…), itd.sandbox(…)), ITGAME-88
  | { kind: 'enum'; values: string[] }
  | { kind: 'alias'; type: string }

// itd.contract(): машинный контракт фасада целиком — методы, типы (в т.ч.
// коды отказов и команды как enum), штамп версии с hash самого контракта.
// version.hash — то, что цитирует отчёт волны приёмки, а не пересказ help().
export interface ItdContract {
  schema: 1
  version: { sha: string; builtAt: string; version: string; hash: string }
  methods: Record<string, MemberSpec>
  types: Record<string, TypeSpec>
}

export interface ItdApi {
  /**
   * Штамп сборки: {sha, builtAt, version} + `<meta name="build">` в html; version —
   * год.мес.день.час.мин коммита (ITGAME-140), она же в меню; сейв ею не сверяется (ITGAME-169).
   * @example itd.version
   */
  readonly version: { sha: string; builtAt: string; version: string }
  /**
   * Баланс, день, часы, доход, ФОТ, штат, сеть, долг, цель, сид/сценарий
   * (null до первого снапшота); debtLimit — порог долга, глубже которого вечер
   * банкротит: лимит кредита или, на Лёгком/Норме, овердрафт = расходы дня
   * (creditLimit там 0, ITGAME-156); menuReady — меню создано, активно, его перезапуск
   * не в очереди (itd.sandbox()/restore() перезапускают меню) и сводка сейва
   * устоялась: после true плашки меню больше не сдвигаются (ITGAME-88), cx/cy можно
   * брать для настоящего клика. Анимации въезда у меню нет.
   * @example itd.state()
   * @example await itd.wait(s => s.menuReady)
   */
  state(): AgentState
  /**
   * Снапшот целиком + сокет: open|reconnecting|closed, lastEventId, rev/cause
   * последнего снапшота (ITGAME-45), rtt, reconnects, sid (куда уходят команды
   * и itd.journal(): liveSid ?? sid хранилища), liveSid (sid живой партии вкладки
   * или null — тогда прочие debug-вызовы отказывают not_in_party, ITGAME-131),
   * sidSwitches.
   * @example itd.server()
   * @example itd.wait((s, srv) => srv.rev >= 42)
   */
  server(): AgentServer
  /**
   * Все объекты живых сцен: {scene, type, id, text, x, y, w, h, cx, cy,
   * visible, alpha, interactive, depth, active, disabled, fill}. x/y — позиция по origin,
   * cx/cy — центр bounds (точка для настоящего клика); visible — видим в мире:
   * скрытый контейнер даёт false всем детям (ITGAME-87); disabled — кнопка
   * покупки/найма неактивна (ITGAME-72), null у прочих; fill — заливка фигуры
   * '#rrggbb' (Rectangle/Triangle/Arc/Ellipse/Polygon), null у прочих (ITGAME-88).
   * @example itd.nodes()
   * @example itd.nodes().find(n => n.type === 'Triangle' && n.scene === 'menu').fill
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
   * GameObject.active). safe — тот же id с «:» вместо точек (не режется
   * инструментом агента как JWT); click/hover/hit принимают и его.
   * @example itd.ids()
   */
  ids(): { id: string; safe: string; scene: string; type: string; text: string | null; active: boolean | null }[]
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
   * Команда с квитанцией сервера (ITGAME-30/45): Promise<{ok, code?, id, rev}> —
   * ответ на ЭТУ команду по её id (state|error с re = id), тики и команды
   * других соединений квитанцию не закрывают. rev — версия снапшота-ответа.
   * @example await itd.cmd('hire')
   */
  cmd(type: CommandType, office?: number, extra?: Record<string, number>): Promise<CmdReceipt>
  /**
   * Живая трассировка окна вокруг action (ITGAME-37): подписка ДО action,
   * окно windowMs (0..10000, по умолчанию 1000) ПОСЛЕ него — реальный путь
   * игрока (клавиши/команды/переходы/тосты/звуки), а не срез log()/net().
   * ITGAME-45: sent — с id команды, states — снапшоты окна {rev, cause, re?}:
   * ответ на команду — state с re = её id. ITGAME-179: sent[].src — itd (ушла внутри
   * вызова itd.*: cmd/click/key/pause/resume/speed/step) или ui (настоящий клик/клавиша,
   * реакция UI); itd.trace.summary(id? | tr) — окно строками по времени, не закрывая.
   * ITGAME-88: pointer — настоящие
   * mousedown/mouseup в окне: {type: down|up, button, x, y (мировые 1280×720),
   * onCanvas, wins — метка победителя хит-теста Phaser в момент события, та же форма,
   * что got (safe id или тип без id; полная строка — stack[0]), stack — как itd.stack,
   * got — до кого дошёл pointerdown/up (GAMEOBJECT_POINTER_DOWN/UP объекта; кнопка,
   * удалившая себя в pointerdown, в got на down есть, на up её нет; ITGAME-148: gone — на up: получившие этот
   * down и снятые до up (уничтожены, без input, скрыты, сцена не идёт) — «клик принят, цель ушла»; на down [])}; itd.click() сюда не попадает
   * (мимо input-слоя). Открытое окно для клика другим вызовом инструмента:
   * itd.trace.start() → {id} … клик … itd.trace.stop(id?) → тот же TraceResult
   * (windowMs — длина окна; само закроется через maxMs, по умолчанию 120 с, cut: true).
   * itd.trace.peek(id?) — то же окно на сейчас, не закрывая (ITGAME-160).
   * @example itd.trace(() => itd.click('btn.pc'), 1000)
   * @example itd.trace.start()
   * @example itd.trace.stop().pointer
   * @example itd.trace.peek().pointer
   * @example itd.trace.summary().lines
   */
  readonly trace: TraceApi
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
   * непрозрачной плашкой (text и occlusion обходят и контейнеры — ITGAME-117:
   * видимость по всей цепочке предков, альфа — произведение, слой ребёнка —
   * depth верхнего контейнера, «выше» — по порядку отрисовки); interactive — интерактив частично перекрыт
   * интерактивом или текстом (вложенность целиком — не находка). Каждая
   * пара: ratio — площадь пересечения / площадь меньшего из пары (occlusion —
   * / площадь текста), threshold — порог, с которым сравнили. minAreaRatio
   * 0..1 заменяет пороги по умолчанию для всех kind (text и interactive — 0,
   * occlusion — 0.25 и >50% по каждой оси: заданный minAreaRatio снимает и
   * правило по осям, находок может стать больше, чем без него); 0 — строгий
   * режим, вне 0..1 — RangeError. Затемнение модалки (отчёт дня, финал «ТУПИК»/
   * «ПОБЕДА!», «Пока вас не было», showModal, окна меню, обрыв связи — markDim)
   * — не перекрывающий при любой альфе (ITGAME-87; раньше финал 0.9 давал ~22
   * occlusion, отчёт 0.75 — 0): что оно закрывает от клика — itd.hit()/stack().
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
   * Попадёт ли НАСТОЯЩИЙ клик в центр объекта в него самого: настоящий
   * хит-тест Phaser, тот же, что stack() (hitArea, renderList, topOnly; сцены
   * сверху вниз). ok:false + top — кто перехватит клик (например, затемнение
   * отчёта дня поверх HUD); top null — точку не берёт никто (hitArea объекта
   * её не накрывает). itd.click() этого не проверяет: он мимо хит-теста.
   * @example itd.hit('btn.menu')
   * @example itd.hit('btn.menu').top
   */
  hit(id: string): HitResult
  /**
   * Что сейчас перекрывает ввод во весь холст: верхний видимый interactive,
   * чьи bounds покрывают 1280×720 (затемнение отчёта дня, модалки, «Пока вас
   * не было»). null — сплошного перекрытия нет. Под ним нажимаются только
   * объекты той же сцены с большей глубиной. safe — id с «:», title — заголовок
   * окна этой подложки (ITGAME-72).
   * @example itd.blocker()
   */
  blocker(): HitTarget | null
  /**
   * Карта экрана одним вызовом (ITGAME-72): {meta, n, items}. meta — sha, tab
   * (sid), day, clock, t, bal, speed, phase, staff, pay, hudClock/hudBal (что
   * нарисовано в HUD, рядом с серверными clock/bal), blocker, title (заголовок
   * верхнего окна), stale (последний itd.stale()). items — строки 'safe|подпись|x|y|флаги' по видимым
   * интерактивам с id: подпись — тексты, целиком лежащие в рамке элемента (сосед,
   * чей центр лёг на её кромку, — не подпись), x/y — центр в CSS px окна, с frame — в рамке снимка такой
   * ширины (frame — px, число ≥ 100; 1, 0, NaN, строка — {ok:false, code:'bad_frame'}, ITGAME-148); флаги A — выбрана, X — перекрыта (настоящий клик не попадёт), D —
   * неактивна (нет денег/мест). free — только без X, scene — одна сцена.
   * @example itd.screen()
   * @example itd.screen({ free: true, frame: 1280 })
   */
  screen(opts?: ScreenOptions): ScreenMap | (AgentResult & { code: 'bad_frame' })
  /**
   * Вкладка на старом JS? (ITGAME-78) Свежая проверка: {client, server, dist,
   * stale, at}. client — sha этой вкладки, dist — sha сборки, которую стенд
   * отдаст при перезагрузке (meta build его index.html), server — sha бинаря
   * (GET /api/version). stale: client ≠ dist (без dist — ≠ server); null —
   * сверить не с чем: vite dev, либо сборка без git и без штампа BUILD_SHA/-ldflags
   * (sha dev/unknown, ITGAME-81; со штампом без git sha есть). Та же проверка красит метку
   * «устарело, обнови» в #topbar; shown — видна ли метка на экране после неё
   * (ITGAME-88: скрытая метка остаётся в DOM — display:none, 0×0, — по DOM её
   * не судить); false и там, где #topbar нет (без ?debug=1 / itd.admin).
   * @example await itd.stale()
   * @example (await itd.stale()).shown
   */
  stale(): Promise<StaleInfo>
  /**
   * Песочница агента (ITGAME-77): itd.sandbox('acc3') → {ok, sid, owner:{sid,
   * diff}} — ставит вкладке свой sid a-<метка>-<время> и запоминает общие ключи
   * владельца (localStorage itd.sid/itd.diff/itd.onboard, ITGAME-21) и вкладки (sessionStorage); меню
   * перечитывает сводку. Пока песочница есть, новая партия и финал («Сдаться»)
   * берут новый sid песочницы, а не общий ключ. Ставится из меню (в партии —
   * code in_party). itd.sandbox.restore() → {sidSame, diffSame, fake, restored,
   * kept, removed}: сверка (то и есть замер гарда), возврат ключей как при
   * входе — для itd.sid/itd.diff наше (fake) или стёртое значение возвращается,
   * чужое (kept) не перетирается; itd.onboard (его пишет только HUD) возвращается
   * к значению при входе при ЛЮБОМ отличии, даже если его записала вкладка владельца;
   * тоже только из меню. itd.sandbox.fakeOwner() → {sid, diff} —
   * «чужой» общий ключ вызовом игры (agent javascript_tool писать в
   * localStorage не может); restore() вернёт настоящий.
   * @example itd.sandbox('acc3')
   * @example itd.sandbox.fakeOwner()
   * @example itd.sandbox.restore()
   */
  readonly sandbox: SandboxApi
  /**
   * Примерка спрайта (ITGAME-119): itd.sprite.try(key, dataUrl) ставит PNG вместо
   * текстуры ключа манифеста во вкладке и перевешивает живые объекты сцен →
   * {ok, key, w, h, sha256, objects, problems, warnings, stats} — problems считает
   * тот же контракт, что npm run check:sprites (палитра, альфа, шум), текстура при
   * нарушениях всё равно стоит. Третий аргумент {filter: 'linear'} — билинейный
   * фильтр только этой текстуре (вся игра — NEAREST по pixelArt): детальный
   * исходник крупнее слота сжимается гладко; по умолчанию — фильтр ключа (linear у
   * render: smooth в манифесте, иначе nearest), в квитанции
   * и list() — filter. Отказы: unknown_key (ключа нет в sprites.json),
   * bad_src (не data:image/png;base64 или PNG битый), bad_size (не size·frames ×
   * size ключа), bad_filter (не nearest/linear). itd.sprite.list() → [{key, w, h,
   * filter, sha256, problems}];
   * itd.sprite.reset(key?) → {ok, reset[]} — вернуть исходную текстуру (без ключа —
   * все), not_tried — ключ не подменён. В репо, dist и сейв ничего не пишется,
   * перезагрузка страницы снимает подмену.
   * @example await itd.sprite.try('desk_pc', dataUrl)
   * @example await itd.sprite.try('icon_money', dataUrl, { filter: 'linear' })
   * @example itd.sprite.list()
   * @example itd.sprite.reset()
   */
  readonly sprite: SpriteApi
  /**
   * Стек под точкой по НАСТОЯЩЕМУ хит-тесту Phaser (InputManager.hitTest:
   * hitArea, камера, видимость контейнеров; порядок — sortGameObjects по
   * renderList камеры; сцены сверху вниз, globalTopOnly + topOnly). Точка —
   * центр (cx/cy) объекта по id/safe-id или мировые gx, gy (1280×720).
   * stack — все interactive под точкой сверху вниз ('safe scene dN Type WxH';
   * '!' — сцена ниже забравшей клик), wins — кто получит pointerdown (объект; в itd.trace().pointer[].wins с ITGAME-179 — метка-строка, как got).
   * hit() и флаг X в screen() — тот же хит-тест, только верх в центре объекта.
   * Объект, добавленный в этом кадре, виден со следующего кадра (ITGAME-113):
   * setInteractive() ставит его в очередь input-плагина, в список хит-теста он
   * попадает на следующем шаге лупа — и настоящий клик в тот же момент его
   * тоже не видит (уходит тому, кто под ним). Нужен сразу — дождаться кадра:
   * await new Promise(r => requestAnimationFrame(r)); в скрытой вкладке кадр
   * прогревает сам stack().
   * @example itd.stack('office:slot:0')
   * @example itd.stack(260, 190).wins
   */
  stack(safeOrX: string | number, gy?: number): StackResult
  /**
   * Где зона A перекрыта B и наоборот: обход сетки 1 px по объединению bounds
   * A и B тем же хит-тестом, что stack(); aUnderB — прямоугольники, где точка в
   * hitArea A, а клик забирает B (bUnderA — наоборот), area — площади в px².
   * Пустой aUnderB — A везде получает свой клик сам (от B).
   * @example itd.zones('office:slot:0', 'office:master:0')
   */
  zones(safeA: string, safeB: string): ZonesResult
  /**
   * Последний офлайн-догон этой страницы: {ticks, days, shown, at, droppedAt,
   * leftAt, liveTicks, open, paused, seq, awayId} или null. Это ПОСЛЕДНИЙ догон
   * страницы, не «текущий»: после ухода без догона он остаётся прежним — сверять
   * по ключу (ITGAME-87): seq — номер догона на странице (1, 2, …), awayId —
   * itd.away, во время которого он пришёл (null — F5, реконнект, «Продолжить»).
   * droppedAt — последний сейв
   * (сервер заметил обрыв), leftAt — уход со страницы этой вкладки, liveTicks —
   * сколько тиков партия шла вживую между ними. shown:false — догон внутри дня, окно «Пока вас не было» игроку не
   * показано; open — окно открыто сейчас; paused — скорость сейчас 0 (пока окно
   * открыто, партия стоит).
   * Догона нет и при ticks 0 (сейв на паузе или в отчёте дня) — тогда null.
   * @example itd.offline()
   * @example const r = await itd.away(3); itd.offline()?.awayId === r.awayId // false — у этого ухода догона не было
   */
  offline(): AgentOffline | null
  /**
   * Уход без ухода со страницы (ITGAME-76): на sec секунд (0..600) вкладка
   * пропадает для сервера и возвращается в ту же партию — тот же sid,
   * песочницы или владельца; без example.com, новой вкладки и пропавшего
   * первого клика. mode 'close' (по умолчанию) — как закрытая вкладка:
   * close-фрейм без exit, сервер узнаёт сразу. mode 'net' — как обрыв сети:
   * POST /api/debug/drop (ITGAME_DEBUG): сервер перестаёт читать и писать в
   * соединение без close-фрейма и замечает уход своим таймаутом чтения
   * (ITGAME_READ_TIMEOUT, по умолчанию 30 с; timeout — свой для этого
   * соединения, мс), а партия до этого идёт вживую — offline.liveTicks.
   * Всё время ухода вкладка глуха и нема: команды — not_connected, сокет —
   * reconnecting, сама не реконнектится. Ответ {ok, mode, sid, leftAt, back,
   * resumed, rev, drop, awayId, offline}: back — первый снапшот нового сокета (cause
   * resume), drop — ответ ручки {at, timeoutMs, noticeBy}, awayId — номер этого
   * ухода на странице (ITGAME-87), offline — догон ЭТОГО ухода (offline.awayId ===
   * awayId; droppedAt — когда сервер заметил уход) или null; itd.offline() после
   * ухода без догона отдаёт прежний догон с другим awayId. Коды: bad_sec, bad_mode, already_away, not_connected, finished,
   * drop_failed, interrupted (вкладка ушла в меню/новую партию), no_return,
   * not_resumed.
   * @example await itd.away(5)
   * @example await itd.away(20, { mode: 'net', timeout: 3000 })
   */
  away(sec: number, opts?: AwayOptions): Promise<AwayResult | (AgentResult & { code: 'bad_sec' | 'bad_mode' })>
  /**
   * Бросить тестовую ошибку страницы (асинхронно, через setTimeout) — чтобы
   * проверить журнал itd.errors() и его поле load, когда настоящих ошибок 0.
   * Сообщение начинается с «itd.injectError»: в отчёте это не ошибка игры.
   * @example itd.injectError('проверка')
   */
  injectError(message?: string): AgentResult
  /**
   * Линтер: контраст текста к фону ниже 3:1. Тексты в контейнерах тоже (видимость и альфа — по цепочке родителей).
   * @example itd.contrast()
   */
  contrast(): ContrastEntry[]
  /**
   * Линтер: шрифт мельче 12px. Тексты в контейнерах тоже.
   * @example itd.tiny()
   */
  tiny(): TinyEntry[]
  /**
   * Аудит текстур: размер, прозрачность %, доля #f4f4f4, цвета вне
   * палитры манифеста этого ключа (manifest.palettes[spec.palette]), дубли
   * ключей.
   * source: tried — ключ подменён пробой itd.sprite.try (ITGAME-119), это не эталон.
   * @example itd.assets()
   */
  assets(): {
    textures: AssetReport[]
    duplicates: { keys: string[]; expected: boolean }[]
    textTextures: number // растеризации Text-объектов (UUID-ключи), вне аудита
  }
  /**
   * Чем рисуют сцены: png (подменён из assets/), pixelart (кодоген-фолбэк) или
   * tried (проба itd.sprite.try).
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
   * Последние сообщения WS в обе стороны + сокет/rtt/реконнекты и rev
   * последнего снапшота. ITGAME-45: у out в info — id команды, у state — rev,
   * cause и re (id своей команды, породившей снапшот), у error — re и rev.
   * @example itd.net(20)
   */
  net(n?: number): {
    socket: AgentServer['socket']
    reconnects: number
    rtt: number | null
    rev: number | null
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
   * Вне партии вкладки — reject «not_in_party: …» без запроса и без паузы (ITGAME-131, см. scenario).
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
   * Вне партии вкладки — reject «not_in_party: …» без запроса (ITGAME-131, см. scenario).
   * @example itd.advanceDays(3)
   */
  advanceDays(n: number): Promise<DebugAdvanceResult>
  /**
   * Партия из консоли (ITGAME-73): шаги по очереди, на каждый — строка
   * «cmd | ok/FAIL code | dN tN | бал>бал | staff a>b | pay N | phase».
   * Шаг {cmd, office?, extra?} — команда с квитанцией (как itd.cmd), {days: n} —
   * промотка офлайн-движком (как itd.advanceDays). Таймеров нет: шаг ждёт
   * квитанцию своей команды (ответ по id) и снапшот, который она породила
   * (state.rev ≥ rev квитанции; у days — rev ответа advance); «после» — этот
   * снапшот, «до» — последний снапшот вкладки перед шагом. FAIL не прерывает
   * партию; пропал снапшот за 5с — в вердикте «нет rev≥N». Деньги на идущей
   * игре сдвигают и тики — для сверки ставьте первым шагом {cmd:'set_speed', extra:{speed:0}}.
   * Разложение дневной разницы — itd.ledger(day).
   * @example await itd.play([{cmd:'set_speed', extra:{speed:0}}, {cmd:'hire'}, {cmd:'hire'}, {days:1}, {cmd:'buy_pc'}, {cmd:'hire'}, {days:1}])
   */
  play(steps: PlayStep[]): Promise<string[]>
  /**
   * Бухгалтерия дня с сервера (ITGAME-73, GET /api/debug/ledger): из чего
   * сложилась разница баланса — {day, balanceStart, income, eventMoney,
   * events[{what, money, clock}], purchases[{type, price, clock}], payroll,
   * gatewayOpex, antivirus, interest, adjust, balanceEnd, profit, delta, balanced, closed,
   * offline, history}. balanceStart + income + eventMoney − purchasesTotal −
   * payroll − gatewayOpex − antivirus − interest + adjust = balanceEnd ровно (balanced).
   * profit = day_report.profit (покупки и процент в него не входят). Без day —
   * текущий день (balanceEnd — живой баланс, payroll 0 до вечера); иначе один из
   * history: 7 последних закрытых дней + текущий, хранятся в сейве. Дня нет —
   * ошибка «нет книги дня N: есть [...]».
   * Вне партии вкладки — reject «not_in_party: …» без запроса (ITGAME-131, см. scenario).
   * @example await itd.ledger()
   * @example await itd.ledger(1)
   */
  ledger(day?: number): Promise<DayLedger>
  /**
   * Журнал партии (ITGAME-46, GET /api/debug/journal; сервер с ITGAME_DEBUG=1):
   * хвост входов своей партии — команды с id и отказами, debug-правки, вехи
   * дней, resume с офлайн-догоном, end — строками и объектами (без сейвов).
   * tail — сколько последних записей (1..500, по умолчанию 20); sid — чужая
   * партия (по умолчанию — своя: liveSid ?? sid хранилища, как itd.server().sid). Строка:
   * «#seq k что | dДЕНЬ tТИК $ДЕНЬГИ фаза Nx revR +tk», tk — тики с прошлой
   * записи. cmd — «тип cN idN ok|FAIL код»: cN — номер соединения в партии
   * (ITGAME-91: id — счётчик страницы, после F5 снова с 1, у моста агента свой;
   * уникальна пара (conn, id)), « bridge» — команда моста /ws/agent. start/resume
   * — «cN»: соединение, с которого партия началась/продолжилась. end — evicted
   * (сессию забрал другой актор) | read_timeout (сторож чтения: вкладка молчала
   * дольше ITGAME_READ_TIMEOUT) | debug_drop (сторож после /api/debug/drop, itd.away
   * net) | disconnect (соединение закрыл клиент: закрытие, F5, away close).
   * Полный журнал для реплея — по url (make replay ARGS="-url …").
   * Нет журнала — ошибка journal_off / no_journal.
   * Партии во вкладке не требует (ITGAME-131): журнал живёт на сервере и после конца партии. Без sid
   * читается журнал sid вкладки: он цел после «Сохранить и выйти»/«Выйти без сохранения», а после
   * «Сдаться» и после финала → «В меню» sid вкладки стёрт — вызов идёт под свежий sid и отвечает
   * no_journal; тогда возьмите sid из itd.server().sid до выхода и читайте itd.journal({sid}).
   * @example (await itd.journal({tail: 5})).lines
   * @example (await itd.journal({tail: 500})).records.filter(r => r.k === 'cmd').map(r => `c${r.conn}:${r.id}`)
   */
  journal(opts?: { tail?: number; sid?: string }): Promise<JournalView>
  /**
   * Читы живой сессии: {money, day, tickInDay}.
   * Вне партии вкладки — reject «not_in_party: …» без запроса (ITGAME-131, см. scenario).
   * @example itd.set({money: 50000})
   */
  set(patch: { money?: number; day?: number; tickInDay?: number }): Promise<DebugState>
  /**
   * Пересоздать партию фикстурой: fresh|broke_day3|mid_day10|full_office|
   * soft_lock|pre_victory|spare_pcs|broken_pc|doomed_debt|virus_outbreak|admin_dept. Сбрасывает клиентское состояние партии: активный
   * офис → О1 (ITGAME-55), оверлеи HUD — отчёт дня, событие, «Пока вас не было», финал,
   * окно выхода — и учёт паузы отчёта (ITGAME-64), окна офиса и серверной — устройства,
   * увольнение (ITGAME-69). Скорость сессии не трогает: вызванный
   * из открытого отчёта или окна выхода, оставляет новую партию на паузе — itd.resume(). Работает и после
   * финала (сессия жива до «В меню»). Ошибка (неизвестная фикстура) партию не трогает.
   * Только в партии вкладки (ITGAME-131): из меню — до первой партии, после «В меню»/«Сдаться» — и
   * после перехвата сессии другой вкладкой отказ сразу, без запроса: reject «not_in_party: …».
   * Из меню — itd.click('menu.diff.normal') (при живом сейве меню спросит «Начать заново?» —
   * itd.click('modal.btn.confirm'); или itd.click('menu.continue')), затем await itd.wait(s => s.connected);
   * после перехвата меню нет — обновите страницу (F5). Так же set, step, advanceDays, ledger,
   * snapshot, restore; itd.journal() — без этого правила.
   * @example itd.scenario('soft_lock')
   */
  scenario(name: string): Promise<DebugState>
  /**
   * Полный стейт с сервера: {sid, state, save, events}.
   * Вне партии вкладки — reject «not_in_party: …» без запроса (ITGAME-131, см. scenario).
   * @example await itd.snapshot()
   */
  snapshot(): Promise<DebugState>
  /**
   * Вернуть состояние из snapshot().save (дельта над текущим). Партию не сбрасывает;
   * если активный офис в новом состоянии закрыт — вкладка переходит в О1 (ITGAME-63).
   * Окна офиса и серверной (устройства, увольнение) закрывает: они собраны по прошлому
   * стейту (ITGAME-69); оверлеи HUD не трогает.
   * Вне партии вкладки — reject «not_in_party: …» без запроса (ITGAME-131, см. scenario).
   * @example itd.restore(save)
   */
  restore(save: Record<string, unknown>): Promise<DebugState>
  /**
   * Пометить сейв другим форматом (ITGAME-154): POST /api/debug/format (сервер с ITGAME_DEBUG=1).
   * game.format сейва = format (по умолчанию на 1 новее сервера; формат самого сервера — отказ
   * same_format), версия сборки и остальное не трогаются, перезапуск стенда не нужен.
   * sid по умолчанию — свой (liveSid ?? sid хранилища, как itd.journal): партии не требует
   * (не ITGAME-131) — из меню помечает сейв, из которого вкладка вышла.
   * Ответ {sid, was, format, live}: live false — сейв переписан в сторе, перезагрузите меню →
   * «СЕЙВ НЕСОВМЕСТИМ»; live true — сейв держит живая партия, её актор пишет метку до выхода:
   * «В меню» → карточка, переподключение (F5, itd.away) → новая партия молча (ITGAME-174).
   * Отказы — в тексте ошибки: bad_sid, bad_format, same_format, no_save, no_saves; голое
   * HTTP 404 — сервер без ITGAME_DEBUG=1.
   * @example await itd.staleSave()
   * @example await itd.staleSave({format: 0})
   */
  staleSave(opts?: { format?: number; sid?: string }): Promise<StaleSaveResult>
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
  // ITGAME-88: перезапуск меню в очереди SceneManager (itd.sandbox()/restore(),
  // scene.restart() — исполнится на следующем шаге лупа) — старое меню ещё
  // активно и со старой сводкой, но через кадр перестроится: плашки съезжали на
  // 42 px (карточка «Продолжить» появлялась на «загружаю сводку…» и пропадала)
  // уже после menuReady. Пока в очереди есть операция над меню — не готово.
  const queue = (game.scene as unknown as { _queue?: { keyA?: string }[] })._queue ?? []
  const menuReady = game.scene.isActive('menu') && !queue.some((op) => op.keyA === 'menu') && (menu?.saveSettled ?? true)
  const s = client.latest
  if (!s) {
    return {
      connected: false, menuReady, balance: null, day: null, clock: null, lunch: null,
      phase: null, speed: null, difficulty: null, incomePerTick: null,
      payrollPerDay: null, forecastEndOfDay: null, staff: null,
      staffConnected: null, staffLimit: null, officesUnlocked: null,
      officesTotal: null, servers: null, coreLevel: null, coreConnected: null,
      coreCapacity: null, gateway: null, debt: null, creditLimit: null,
      creditRatePct: null, debtLimit: null, bankruptInDays: null, virusPCs: null, virusWaveAt: null, antivirusTier: null, adminDept: null, admins: null,
      winTarget: null, winStaff: null, winCore: null,
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
    debtLimit: s.debtLimit,
    bankruptInDays: s.bankruptInDays,
    virusPCs: s.offices.reduce((n, o) => n + o.virusPCs, 0),
    virusWaveAt: s.virusWaveAt,
    antivirusTier: s.antivirus.tier,
    adminDept: s.adminDept,
    admins: s.offices.filter((o) => o.admin !== '').length,
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
    rev: client.latest?.rev ?? null,
    cause: client.latest?.cause ?? null,
    rtt: client.stats.rtt,
    reconnects: client.stats.reconnects,
    lastMessageAt: client.stats.lastMessageAt || null,
    // ITGAME-68: тот же sid, что у itd.journal() (debugFetch с ITGAME-131 — только liveSid). После финала net.ts стирает sid из хранилищ,
    // и sessionId() выдал бы свежий, которого у живой партии никогда не было.
    sid: client.liveSid() ?? sessionId(),
    liveSid: client.liveSid(),
    sidSwitches: client.stats.sidSwitches,
    snapshot: client.latest,
  }
}

// Обход объектов сцены с рекурсией по контейнерам. Свойства достаём
// защитно: не каждый GameObject имеет x/alpha/bounds. ITGAME-87: visible — видимость
// в мире: скрытый контейнер прячет детей, даже если у ребёнка visible === true
// (текст тултипа офиса после ухода курсора отдавался visible: true).
function walkObjects(sceneKey: string, objects: Phaser.GameObjects.GameObject[], out: AgentNode[], parentVisible = true): void {
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
      isFilled?: boolean
      fillColor?: number
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
    const dis = o.getData?.('disabled')
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
      safe: safeId(typeof o.getData?.('id') === 'string' ? (o.getData('id') as string) : null),
      visible: parentVisible && o.visible !== false,
      alpha: typeof o.alpha === 'number' ? o.alpha : 1,
      interactive: o.input?.enabled === true,
      depth: typeof o.depth === 'number' ? o.depth : 0,
      active: typeof act === 'boolean' ? act : null,
      disabled: typeof dis === 'boolean' ? dis : null,
      fill: o.isFilled === true && typeof o.fillColor === 'number' ? '#' + o.fillColor.toString(16).padStart(6, '0') : null,
    })
    if (o.list) walkObjects(sceneKey, o.list, out, parentVisible && o.visible !== false)
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
        const raw = o.getData?.('id')
        const id = typeof raw === 'string' ? raw : null
        const title = o.getData?.('title')
        if (b) {
          out.push({
            t: { scene: sceneKey, type: o.type ?? 'unknown', id, safe: safeId(id), depth: d, title: typeof title === 'string' ? title : null },
            b, order: out.length,
          })
        }
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

// Кто получит pointerdown в мировой точке — НАСТОЯЩИМ хит-тестом Phaser, тем же,
// что stack() (hitArea, renderList, topOnly/globalTopOnly). hit() и флаг X в
// screen() читают его (владелец, 10.10: раньше — эмуляция по bounds и depth).
function hitAt(game: Phaser.Game, x: number, y: number): HitTarget | null {
  const first = phaserHits(game, x, y)[0]
  return first && first.captured ? stackTarget(first) : null
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

// Заголовок верхнего окна (ITGAME-72): сцены сверху вниз, в сцене — видимый объект
// с data-ключом title (markTitle) наибольшей глубины. Не только подложки: панель
// события и экран обрыва связи не перекрывают ввод, а заголовок у них есть.
function topTitle(game: Phaser.Game): string | null {
  for (const scene of game.scene.getScenes(true, true)) {
    const best = { title: null as string | null, depth: -Infinity }
    const walk = (objects: Phaser.GameObjects.GameObject[], depth: number | null): void => {
      for (const obj of objects) {
        const o = obj as unknown as {
          visible?: boolean; depth?: number; getData?(k: string): unknown; list?: Phaser.GameObjects.GameObject[]
        }
        if (o.visible === false) continue
        const d = depth ?? (typeof o.depth === 'number' ? o.depth : 0)
        const t = o.getData?.('title')
        if (typeof t === 'string' && d >= best.depth) Object.assign(best, { title: t, depth: d })
        if (o.list) walk(o.list, d)
      }
    }
    walk(scene.children.list, null)
    if (best.title !== null) return best.title
  }
  return null
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

// itd.screen() (ITGAME-72; набросок агента из ретро 10.10, правки 6 и 9). Строка на
// элемент, а не объект: 25 элементов отчёта дня влезают в ответ инструмента ~1000
// символов. Точки — центр bounds (cx/cy) через getBoundingClientRect канваса:
// зум, «по окну» и #topbar уже учтены.
function buildScreen(game: Phaser.Game, opts: ScreenOptions = {}): ScreenMap {
  const nodes = activeNodes(game)
  const texts = nodes.filter((t) => t.visible && t.alpha > 0 && t.text)
  const canvas = game.canvas as HTMLCanvasElement | null
  const r = canvas?.getBoundingClientRect()
  const k = r && r.width > 0 ? r.width / GAME_W : 1
  const f = opts.frame && opts.frame > 0 ? innerWidth / opts.frame : 1
  const pt = (gx: number, gy: number): [number, number] => [
    Math.round(((r?.left ?? 0) + gx * k) / f),
    Math.round(((r?.top ?? 0) + gy * k) / f),
  ]
  const s = client.latest
  const drawn = (id: string): string | null => {
    const t = nodes.find((n) => n.id === id && n.visible)
    return t?.text ? oneLine(t.text) : null
  }
  const b = blockerOf(game)
  const meta: ScreenMeta = {
    sha: BUILD.sha,
    tab: (client.liveSid() ?? sessionId()).slice(0, 8),
    day: s?.day ?? null,
    clock: s?.clock ?? null,
    t: s?.tickInDay ?? null,
    bal: s?.money ?? null,
    speed: s?.speed ?? null,
    phase: s?.phase ?? null,
    staff: s ? `${s.offices.reduce((n, o) => n + o.employees.length, 0)}/${s.staffLimit}` : null,
    pay: s?.payrollPerDay ?? null,
    hudClock: drawn('hud.day'),
    hudBal: drawn('hud.money'),
    blocker: b ? `${b.safe ?? b.scene}@${b.depth}` : null,
    title: b?.title ?? topTitle(game),
    stale: lastStale()?.stale ?? null,
  }
  // Подпись — тексты, чей bounds ЦЕЛИКОМ внутри bounds элемента (допуск 2 px). Раньше
  // хватало центра текста в рамке, и чужой текст с центром на кромке клеился: ✕ окна
  // «Выйти в меню?» (центр на верхней кромке btn.event.1 под окном) давал подпись
  // «Отказаться (−$27) ✕» (ITGAME-113).
  const inside = (t: AgentNode, n: AgentNode): boolean =>
    Math.abs(t.cx - n.cx) + t.w / 2 <= n.w / 2 + 2 && Math.abs(t.cy - n.cy) + t.h / 2 <= n.h / 2 + 2
  const items: string[] = []
  for (const n of nodes) {
    if (!n.id || !n.interactive || !n.visible || n.alpha === 0) continue
    if (opts.scene && n.scene !== opts.scene) continue
    const ok = hitAt(game, n.cx, n.cy)?.id === n.id
    if (opts.free && !ok) continue
    const label = texts
      .filter((t) => t.scene === n.scene && inside(t, n))
      .map((t) => oneLine(t.text as string))
      .join(' ')
      .replace(/\|/g, '/')
      .slice(0, 22)
    const [x, y] = pt(n.cx, n.cy)
    const flags = (n.active === true ? 'A' : '') + (ok ? '' : 'X') + (n.disabled === true ? 'D' : '')
    items.push([n.safe, label || '-', x, y, flags].join('|'))
  }
  return { ok: true, meta, n: items.length, items }
}

// ── stack()/zones() (ITGAME-74): настоящий хит-тест Phaser ──────────────────
// Повторяет InputManager.updateInputPlugins → InputPlugin.update →
// hitTestPointer → sortGameObjects без раздачи событий: тот же manager.hitTest
// (hitArea в локальных координатах объекта, inputCandidate — willRender камеры
// и родителей), тот же порядок по camera.renderList прошлого кадра. Указатель —
// заглушка: hitTest пишет в него worldX/worldY, sortGameObjects читает camera.
// _list — тоже состояние прошлого шага лупа, и _pendingInsertion мы не читаем
// намеренно (ITGAME-113, Phaser 3.90): setInteractive() кладёт объект в
// _pendingInsertion, в _list его переносит InputPlugin.preUpdate (PRE_UPDATE сцены)
// на следующем шаге, а mousedown/up Phaser разбирает сразу в DOM-обработчике
// (InputManager.onMouseDown → updateInputPlugins → InputPlugin.update → hitTestPointer
// по тому же _list). Клик до этого шага новый объект не видит — уходит тому, кто
// под ним; воспроизведено и stack(), и настоящим mousedown в канвас. Через шаг объект
// есть и в _list, и в renderList (рендер того же шага) — порядок честный.
interface PhaserHit { obj: Phaser.GameObjects.GameObject; scene: string; captured: boolean }

interface InputInternals {
  _list: Phaser.GameObjects.GameObject[]
  topOnly: boolean
  isActive(): boolean
  manager: { hitTest(p: unknown, list: Phaser.GameObjects.GameObject[], cam: Phaser.Cameras.Scene2D.Camera, out: unknown[]): Phaser.GameObjects.GameObject[] }
  cameras: { getCamerasBelowPointer(p: unknown): Phaser.Cameras.Scene2D.Camera[] }
  sortGameObjects(list: Phaser.GameObjects.GameObject[], p: unknown): Phaser.GameObjects.GameObject[]
}

// Мировая точка → координаты указателя (пиксели канваса): обращаем аффинное
// getWorldPoint главной камеры (у всех сцен игры одна HIRES_CAMERA).
function screenOf(cam: Phaser.Cameras.Scene2D.Camera, gx: number, gy: number): { x: number; y: number } {
  const o = cam.getWorldPoint(0, 0)
  const ex = cam.getWorldPoint(1, 0)
  const ey = cam.getWorldPoint(0, 1)
  const a = ex.x - o.x
  const b = ey.x - o.x
  const c = ex.y - o.y
  const d = ey.y - o.y
  const det = a * d - b * c || 1
  const dx = gx - o.x
  const dy = gy - o.y
  return { x: (d * dx - b * dy) / det, y: (a * dy - c * dx) / det }
}

function phaserHits(game: Phaser.Game, gx: number, gy: number): PhaserHit[] {
  const scenes = game.scene.getScenes(false, true) // сверху вниз, как updateInputPlugins
  const ref = scenes.find((sc) => sc.sys.isActive() && sc.cameras?.main)?.cameras.main
  if (!ref) return []
  const { x, y } = screenOf(ref, gx, gy)
  const out: PhaserHit[] = []
  let captured = false
  for (const sc of scenes) {
    const input = sc.input as unknown as InputInternals | undefined
    if (!input || !input.isActive()) continue
    const pointer = { x, y, worldX: 0, worldY: 0, camera: null as Phaser.Cameras.Scene2D.Camera | null }
    let over: Phaser.GameObjects.GameObject[] = []
    for (const cam of input.cameras.getCamerasBelowPointer(pointer)) {
      over = input.manager.hitTest(pointer, input._list, cam, []).slice()
      if (over.length) {
        pointer.camera = cam
        break
      }
    }
    input.sortGameObjects(over, pointer)
    for (const obj of over) out.push({ obj, scene: sc.scene.key, captured: !captured })
    // попадание в сцене = её pointerdown-события = захват (globalTopOnly)
    if (over.length && game.input.globalTopOnly) captured = true
  }
  return out
}

function stackTarget(h: PhaserHit): HitTarget {
  const o = h.obj as unknown as { type?: string; depth?: number; getData?(k: string): unknown }
  const id = typeof o.getData?.('id') === 'string' ? (o.getData('id') as string) : null
  const title = o.getData?.('title')
  // Вложенный в контейнер рисуется на глубине корневого контейнера — как у
  // interactiveIn/blocker(): глубина сравнима между объектами сцены.
  let root = h.obj as unknown as { depth?: number; parentContainer?: unknown }
  while (root.parentContainer) root = root.parentContainer as typeof root
  return {
    scene: h.scene, type: o.type ?? 'unknown', id, safe: safeId(id), depth: typeof root.depth === 'number' ? root.depth : 0,
    title: typeof title === 'string' ? title : null,
  }
}

function stackAt(game: Phaser.Game, gx: number, gy: number): { stack: string[]; wins: HitTarget | null; hits: PhaserHit[] } {
  const hits = phaserHits(game, gx, gy)
  const stack = hits.map((h) => {
    const t = stackTarget(h)
    let wh = '?x?'
    try {
      const b = (h.obj as unknown as { getBounds(): Phaser.Geom.Rectangle }).getBounds()
      wh = `${Math.round(b.width)}x${Math.round(b.height)}`
    } catch { /* без bounds */ }
    return `${t.safe ?? 'unnamed'} ${t.scene} d${t.depth} ${t.type} ${wh}${h.captured ? '' : ' !'}`
  })
  const first = hits[0]
  return { stack, wins: first && first.captured ? stackTarget(first) : null, hits }
}

// ITGAME-88: указатель трассировки → мировая точка и хит-тест. Тот же путь, что у
// Phaser: ScaleManager.transformX/Y (координаты холста) → getWorldPoint главной
// камеры верхней активной сцены (у всех сцен одна HIRES_CAMERA) → stackAt.
function pointerProbe(game: Phaser.Game): PointerProbe {
  return (ev) => {
    const cam = game.scene.getScenes(false, true).find((sc) => sc.sys.isActive() && sc.cameras?.main)?.cameras.main
    const px = game.scale.transformX(ev.pageX)
    const py = game.scale.transformY(ev.pageY)
    const w = cam ? cam.getWorldPoint(px, py) : { x: px, y: py }
    const { stack, wins, hits } = stackAt(game, w.x, w.y)
    return { x: w.x, y: w.y, wins, stack, objs: hits.map((h) => h.obj) }
  }
}

function makeTrace(game: Phaser.Game): TraceApi {
  const probe = pointerProbe(game)
  const fn = ((action: () => unknown, windowMs = 1000) => runTrace(game, probe, action, windowMs)) as TraceApi
  fn.start = (opts) => startTrace(game, probe, opts)
  fn.stop = (id) => stopTrace(id)
  fn.peek = (id) => peekTrace(id)
  fn.summary = (src) => summaryTrace(src)
  return fn
}

function findObjBySafe(game: Phaser.Game, rawId: string): Phaser.GameObjects.GameObject | null {
  return findById(game, rawId)?.obj ?? null
}

// Склейка точек сетки в прямоугольники: отрезки по строкам, одинаковые
// отрезки соседних строк сливаются вниз.
function rectsOf(rows: Map<number, [number, number][]>): ZoneRect[] {
  const done: ZoneRect[] = []
  let open: ZoneRect[] = []
  const ys = [...rows.keys()].sort((p, q) => p - q)
  let prevY = Number.NaN
  for (const y of ys) {
    const segs = rows.get(y) ?? []
    const next: ZoneRect[] = []
    for (const [x0, x1] of segs) {
      const r = y === prevY + 1 ? open.find((o) => o.x === x0 && o.x + o.w === x1) : undefined
      if (r) {
        r.h++
        next.push(r)
        open = open.filter((o) => o !== r)
      } else {
        next.push({ x: x0, y, w: x1 - x0, h: 1 })
      }
    }
    done.push(...open)
    open = next
    prevY = y
  }
  return done.concat(open).sort((p, q) => p.y - q.y || p.x - q.x)
}

function zonesOf(game: Phaser.Game, rawA: string, rawB: string): ZonesResult {
  const a = realId(rawA)
  const b = realId(rawB)
  const empty = { ok: false, a, b, aUnderB: [], bUnderA: [], area: { a: 0, aUnderB: 0, b: 0, bUnderA: 0 } }
  const oa = findObjBySafe(game, a)
  const ob = findObjBySafe(game, b)
  if (!oa || !ob) return { ...empty, why: `нет узла ${!oa ? a : b}` }
  let ba: Phaser.Geom.Rectangle
  let bb: Phaser.Geom.Rectangle
  try {
    ba = (oa as unknown as { getBounds(): Phaser.Geom.Rectangle }).getBounds()
    bb = (ob as unknown as { getBounds(): Phaser.Geom.Rectangle }).getBounds()
  } catch {
    return { ...empty, why: 'нет bounds' }
  }
  const x0 = Math.floor(Math.min(ba.x, bb.x))
  const y0 = Math.floor(Math.min(ba.y, bb.y))
  const x1 = Math.ceil(Math.max(ba.right, bb.right))
  const y1 = Math.ceil(Math.max(ba.bottom, bb.bottom))
  const ab = new Map<number, [number, number][]>()
  const baRows = new Map<number, [number, number][]>()
  const area = { a: 0, aUnderB: 0, b: 0, bUnderA: 0 }
  const push = (rows: Map<number, [number, number][]>, x: number, y: number) => {
    const segs = rows.get(y) ?? []
    const last = segs[segs.length - 1]
    if (last && last[1] === x) last[1] = x + 1
    else segs.push([x, x + 1])
    rows.set(y, segs)
  }
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      // центр пикселя мира; захватившая сцена — первая в hits, её верх — wins
      const hits = phaserHits(game, x + 0.5, y + 0.5)
      const win = hits[0]?.captured ? hits[0].obj : null
      const inA = hits.some((h) => h.obj === oa)
      const inB = hits.some((h) => h.obj === ob)
      if (inA) area.a++
      if (inB) area.b++
      if (inA && win === ob) {
        area.aUnderB++
        push(ab, x, y)
      }
      if (inB && win === oa) {
        area.bUnderA++
        push(baRows, x, y)
      }
    }
  }
  return { ok: true, a, b, aUnderB: rectsOf(ab), bUnderA: rectsOf(baRows), area }
}

// safe-id (приёмка 10.10): «:» вместо точки; в id игры двоеточий нет, замена обратима.
function safeId(id: string | null): string | null {
  return id === null ? null : id.replace(/\./g, ':')
}

function realId(id: string): string {
  return id.replace(/:/g, '.')
}

function findById(game: Phaser.Game, rawId: string): { obj: Phaser.GameObjects.GameObject; scene: string } | null {
  const id = realId(rawId)
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

const HELP = `itd — агентский API игры (ITGAME-24/25/26/30/37/38/39/73)
  itd.state()                       — баланс, день, часы, доход, ФОТ, штат, сеть, долг, цель, сид/сценарий (null до первого снапшота); debtLimit — порог долга, глубже — вечер банкротит: лимит кредита или, на Лёгком/Норме, овердрафт = расходы дня (creditLimit там 0, ITGAME-156); menuReady — меню создано, активно, перезапуск меню не в очереди и сводка сейва устоялась: после true плашки меню не сдвигаются
  itd.server()                      — снапшот целиком + сокет: open|reconnecting|closed, lastEventId, rev/cause последнего снапшота (tick|cmd|debug|start|resume), rtt, reconnects, sid (куда уходят команды: liveSid ?? хранилище), liveSid (живая партия или null), sidSwitches; ждать версию — itd.wait((s, srv) => srv.rev >= N)
  itd.nodes()                       — все объекты живых сцен: {scene, type, id, text, x, y, w, h, cx, cy, visible, alpha, interactive, depth, active, disabled, fill}; x/y — по origin объекта, cx/cy — центр bounds (точка для клика); visible — видим в мире (скрытый контейнер → false у детей); disabled — кнопка покупки/найма неактивна; fill — заливка фигуры '#rrggbb' (Rectangle/Triangle/Arc/Ellipse/Polygon), иначе null
  itd.text()                        — nodes() с непустым текстом (текст в скрытом контейнере — visible: false: сам текст тултипа хранится и после ухода курсора)
  itd.ids()                         — стабильные id интерактивов (btn.*, nav.*, office.*, room.*, menu.*, modal.*) + active; safe — id с «:» вместо точек (не режется как JWT), click/hover/hit принимают и его
                                       active — состояние переключателя (btn.speed.*, nav.*, btn.skip_reports, btn.debug, menu.zoom.*), null у прочих; НЕ GameObject.active
  itd.click('btn.hire')             — клик по id: дергает pointerdown-обработчик напрямую, мимо input-слоя
                                       ok:false + code 'debounced' — обработчик отбросил клик (дребезг switchRoom 250 мс игрового времени)
  itd.hover('office.worker.0')      — наведение по id (тултипы)
  itd.key('1'|'enter'|'space'|'esc')— клавиша: 1-4 сложность в меню, up/down — фокус меню, enter — пункт в фокусе меню / отчёт дня, space/esc — отчёт дня
  itd.cmd('hire')                   — команда с квитанцией сервера ('abandon' — путём кнопки «Сдаться»: сейв удалён, вкладка в меню): Promise<{ok, code?, id, rev}> — ответ на ЭТУ команду по id (state|error с re = id; тики и чужие команды не в счёт), rev — версия снапшота-ответа; серверные коды: no_free_pc, not_enough_money, …; транспортные: not_connected, receipt_timeout, disconnected
                                       Вирус (ITGAME-103): itd.cmd('virus_click', 0, {slot: 0}) — клик чистки заражённого места (3 на чистку, k в employees[i].virusClicks), здоровое — not_infected; на сломанном заражённом ЛКМ по месту сначала чинит (repair_click); подписка — itd.cmd('set_antivirus', 0, {slot: 1..3}) (0 — отключить), bad_tier, antivirus_already, повышение без денег — not_enough_money; кнопка btn.antivirus в серверной → окно с modal.av.1..3 / modal.av.off
                                       Админ (ITGAME-101): itd.cmd('buy_admin_dept') — отдел админов (admin_dept_already), без него hire_admin — admin_dept_locked; itd.cmd('hire_admin', 0) / itd.cmd('fire_admin', 0) — найм и увольнение админа офиса (admin_already, no_admin, not_enough_money); state.offices[i].admin, adminSlot/adminKind — его следующая цель (-1/'' — свободен), adminFirePrice; 2 клика в тик сами, сначала заражённые места, потом сломанное. Комната — вкладка nav.adminDept («АДМ», ITGAME-145): закрыта — dept.buy «Купить отдел», открыта — места dept.admin.0..2 (наведение — тултип, ПКМ — «Уволить админа?»), строки dept.name.N / dept.status.N («чинит место 5» / «чистит место 3» / «свободен»), найм — кнопки колонки btn.admin.0..2; в офисе у админа кнопки и слота нет, тултип места — «чинит админ» / «чистит админ»; фикстура admin_dept
  itd.trace(() => itd.click('btn.pc'), 1000) — живая трассировка: подписка ДО action, окно windowMs (0..10000, по умолчанию 1000) ПОСЛЕ него → {ok, error?, result, t0, t1, actionMs, keys[{key, source: dom|itd, handled — есть подписчик, scenes, acted[{scene, action}] — сцена реально отработала; [] — guard отбросил}], sent[{type, office, id, src, …}] по порядку (src: itd — ушла синхронно внутри itd.* — cmd/click/key/pause/resume/speed/step; ui — настоящий клик/клавиша или реакция UI), recv[error/day_report…] (у error info.re/rev), states[{rev, cause, re?}] — снапшоты окна, transitions[{kind: phase|speed|day|scenes, from, to}], toasts[{text, where}], sounds[{name, key, ok}], pointer[{type: down|up, button, x, y — мировые, onCanvas, wins — метка победителя хит-теста Phaser в момент события, та же форма, что got (safe id или тип без id; полная строка — stack[0]), stack — как itd.stack, got — до кого дошёл pointerdown/up объекта, в т.ч. удалившегося в обработчике (✕ модалки) — на up его уже нет; [] — до объектов не дошло, gone — на up: получившие этот down и снятые до up (уничтожены, без input, скрыты, сцена не идёт) — «клик принят, цель ушла»; на down []}]}; t — мс от t0. Реальная клавиатура — page.keyboard.press внутри окна (action может быть паузой); itd.click() в pointer не попадает (мимо input-слоя)
  itd.trace.start({maxMs?})          — открытое окно (ITGAME-88): подписки сразу → {ok, id, t0, maxMs, open}; настоящий клик/клавиша — другим вызовом инструмента; само закроется через maxMs (по умолчанию 120000, до 600000; cut: true); коды bad_max, too_many (больше 8 окон)
  itd.trace.stop(id?)               — закрыть окно (без id — последнее) → тот же TraceResult, что у itd.trace() (+ id, windowMs = длина окна); нет окна — {ok:false, code:'no_trace'}. Пример: const {id} = itd.trace.start(); …клик…; const tr = itd.trace.stop(id); tr.pointer[0].wins — 'btn:pc', tr.sent[0].src, itd.trace.summary(tr).lines
  itd.trace.peek(id?)               — прочитать окно, не закрывая (ITGAME-160): копия TraceResult на сейчас (t1 — сейчас, windowMs от t0; cut-окно — каким закрылось), окно, maxMs и луп не трогает; нет окна — {ok:false, code:'no_trace'}. Счёт посреди пункта без stop → start
  itd.trace.summary(id? | tr)       — окно строками по времени (ITGAME-179), не закрывая: id / без id — открытое (или cut) окно, tr — любой TraceResult → {ok, id?, cut?, error?, lines}; строки «t812 ptr down 640,360 canvas wins btn:pc got [btn:pc]», «t815 sent buy_pc o0 id7 ui», «t930 recv error not_enough_money re8 rev12», «t841 state rev12 cmd re7», «t50 key ENTER dom handled [hud] acted [hud:next_day]», «t813 ptr up 640,360 canvas wins - got [] gone [modal:close]», «t990 trans speed 0→1», «t931 toast "Не хватает денег"», «t842 sound select ok»; при равном t — ptr, key, sent, recv, state, trans, toast, sound; нет окна — {ok:false, code:'no_trace', lines: []}
  itd.warm()                        — прогреть кадр вручную (шаги лупа); в скрытой вкладке itd делает это сам
  itd.wait(s => s.day === 2)        — промис: поллинг state()/server() до условия (таймаут 5с, второй аргумент — свой); готовность меню — wait(s => s.menuReady), до старта партии state() null, но menuReady уже честен
  itd.overlaps({minAreaRatio}?)     — линтер вёрстки: kind: text — тексты одного depth (в т.ч. внутри контейнеров, depth ребёнка = depth верхнего контейнера); occlusion — текст под непрозрачной плашкой (плашка тоже может быть внутри контейнера); interactive — интерактив частично перекрыт интерактивом или текстом (вложенность целиком — не находка); пара {scene, kind, a, b, overlap{w,h}, at{x,y}, ratio, threshold}: ratio — площадь пересечения / площадь меньшего из пары (occlusion — / площадь текста), threshold — порог сравнения; minAreaRatio 0..1 заменяет пороги по умолчанию (text/interactive 0, occlusion 0.25 + >50% по каждой оси; заданный minAreaRatio заменяет и правило по осям — для occlusion находок может стать больше): 0 — строгий режим, 0.3 — порог по площади для всех kind; затемнение модалки (markDim: отчёт дня, финал, «Пока вас не было», окна, обрыв связи) — не перекрывающий при любой альфе: что оно закрывает от клика — itd.hit()/stack(); пара через затемнение (один объект под ним, другой — модалка над ним) — тоже не находка (ITGAME-141)
  itd.offscreen()                   — линтер: вылезание за канвас 1280×720; + {scene:'page', type:'canvas'} — канвас не влез в окно (CSS px)
  itd.hit('btn.menu')               — попадёт ли НАСТОЯЩИЙ клик в центр объекта в него (хит-тест Phaser, как stack): {ok, at{x,y}, top{scene,id,safe,type,depth,title}} — top перехватит (затемнение отчёта поверх HUD); itd.click этого не видит
  itd.blocker()                     — что перекрывает ввод во весь холст (затемнение отчёта, модалка) или null: {scene, type, id, safe, depth, title — заголовок окна}
  itd.screen({frame?, free?, scene?}) — карта экрана: {ok: true, meta:{sha, tab, day, clock, t, bal, speed, phase, staff, pay, hudClock, hudBal, blocker, title, stale}, n, items:['safe|подпись|x|y|флаги']}; подпись — тексты целиком в рамке элемента; x/y — центр в CSS px окна (frame — в рамке снимка такой ширины, px, число ≥ 100, иначе {ok:false, code:'bad_frame'}); флаги A выбрана, X перекрыта, D неактивна; free — только без X
  itd.stack('office:slot:0')      — стек под центром объекта (или itd.stack(gx, gy)) по НАСТОЯЩЕМУ хит-тесту Phaser (hitArea, renderList, topOnly): {ok, at{x,y}, stack['safe scene dN Type WxH'], wins{scene,id,safe,type,depth,title}} — wins получит pointerdown; '!' — сцена под забравшей клик; объект, добавленный в этом кадре, виден со следующего кадра (и настоящий клик в тот же момент его не видит)
  itd.zones('office:slot:0', 'office:master:0') — где зона A перекрыта B и наоборот (сетка 1 px, тот же хит-тест): {aUnderB[{x,y,w,h}], bUnderA[…], area{a, aUnderB, b, bUnderA}}
  itd.offline()                     — последний офлайн-догон страницы {ticks, days, shown, at, droppedAt, leftAt, liveTicks, open, paused, seq, awayId} — liveTicks: шло вживую, пока сервер не заметил уход: shown:false — догон внутри дня, окна «Пока вас не было» не было; пока окно открыто, партия на паузе; ПОСЛЕДНИЙ, не «текущий»: seq — номер догона на странице, awayId — itd.away, во время которого пришёл (null — F5/реконнект); сверять по ключу, не по at
  await itd.away(5, {mode, timeout}) — уход на 5 с без ухода со страницы и возврат в ту же партию (тот же sid: песочницы или владельца): mode 'close' — как закрытая вкладка (close-фрейм, сервер знает сразу), 'net' — как обрыв сети (POST /api/debug/drop: сервер молчит и замечает уход своим таймаутом чтения — ITGAME_READ_TIMEOUT, 30 с; timeout — мс для этого соединения; до того партия идёт вживую) → {ok, mode, sid, leftAt, back, resumed, rev, drop{at, timeoutMs, noticeBy}, awayId — номер ухода, offline — догон ЭТОГО ухода (offline.awayId === awayId) или null}; пока в уходе — команды not_connected, сокет reconnecting
  itd.injectError('x')              — бросить тестовую ошибку страницы «itd.injectError: x» (проверить журнал errors() и поле load; у записи injected: true)
  itd.contrast()                    — линтер: контраст текста к фону ниже 3:1; тексты в контейнерах тоже, невидимый предок прячет
  itd.tiny()                        — линтер: шрифт мельче 12px; тексты в контейнерах тоже
  itd.log(50)                       — журнал переходов (кольцевой на 200, переживает чистку консоли); + {type:'sound', key:'sfx:bong', name, volume, scene, ok}, {type:'toast', text, where, ms, bg, scene}
                                       Пример: itd.log(200).filter(e => e.type === 'sound').map(e => e.key)
  itd.errors()                      — ошибки страницы (window.onerror + unhandledrejection), переживают перезагрузку вкладки: load — номер загрузки
  itd.net(20)                       — последние сообщения WS в обе стороны + сокет/rtt/реконнекты/rev; info: out — id, state — rev/cause/re, error — code/re/rev
  itd.version                       — {sha, builtAt, version} сборки (+ <meta name="build"> в html); version — год.мес.день.час.мин коммита (ITGAME-140), для людей: сейв сверяется по формату (ITGAME-169)
  itd.sandbox('acc3')               — своя партия вкладки: sid a-acc3-<время> во вкладку, ключи владельца (localStorage itd.sid/itd.diff/itd.onboard, sessionStorage вкладки) запомнены → {ok, sid, owner:{sid, diff}}; новая партия и «Сдаться» берут новый sid песочницы, общий ключ не трогают; из меню (в партии — in_party)
  itd.sandbox.fakeOwner()           — «чужой» общий ключ itd.sid/itd.diff вызовом игры (проверить гард «Сдаться») → {sid, diff}; restore() вернёт настоящий
  itd.sandbox.restore()             — выйти из песочницы (из меню): {sidSame, diffSame, fake, restored, kept, removed} — sidSame/diffSame: общий ключ тот, что при входе (или fake); itd.sid/itd.diff: наше/стёртое значение возвращено, чужое (kept) не перетёрто; itd.onboard возвращается к значению при входе при любом отличии
  await itd.stale()                 — вкладка на старом JS? {client, server, dist, stale, at, shown}: shown — метка «устарело, обнови» видна на экране (скрытая живёт в DOM как display:none 0×0); client — sha вкладки, dist — sha сборки, которую стенд отдаст на F5, server — sha бинаря (/api/version); stale null — сверить не с чем (vite dev; сборка без git и без штампа BUILD_SHA/-ldflags — sha dev/unknown; со штампом sha есть); красная метка «устарело, обнови» в #topbar — та же проверка
  itd.assets()                      — аудит текстур: размер, прозрачность %, доля #f4f4f4, цвета вне палитры манифеста ключа (hd32/sweetie16; у render: smooth не считаются), дубли ключей; source: tried — проба itd.sprite.try
  itd.assetSet()                    — чем рисуют сцены: png (подменён из assets/) или pixelart (кодоген-фолбэк); active: tried — проба itd.sprite.try
  await itd.sprite.try(key, dataUrl, {filter?}) — примерка спрайта: PNG (data:image/png;base64,…) вместо текстуры ключа манифеста во вкладке → {ok, key, w, h, filter, sha256, objects, problems, warnings, stats}; filter 'nearest' | 'linear' (гладкое сжатие только этой текстуры), по умолчанию — как ключ рисуется в игре (linear у render: smooth); problems — контракт check:sprites, текстура стоит и с нарушениями; отказы unknown_key | bad_src | bad_size | bad_filter; в репо и сейв ничего не пишется
  itd.sprite.list() / reset(key?)   — что подменено [{key, w, h, filter, sha256, problems}] / вернуть исходную текстуру (без ключа — все), not_tried — ключ не подменён
  itd.reset()                       — снести все ключи itd.* (sid в обоих хранилищах, сложность, хинты, зум, отчёты)
  itd.pause() / resume() / speed(n) — темп сессии: set_speed 0/1/0..3 (серверный, живёт в сейве); до коннекта — {ok:false, code:'not_connected'}
  itd.step(2000) / step({ticks:60}) — пауза + промотка офлайн-движком (без кофе/событий/поломок/волн вируса/XP, день закрывается без day_report; таймер волны стоит — волну видно только живыми тиками): мс (1 тик = 1000 мс, до 10 тиков) или {ticks: 1..10000}; из фазы отчёта — сначала next_day; сводка — в .advance и «debug · advance» в itd.snapshot().events; вне running (game_over) — 200 с advance.ticks 0, ничего не промотано
  itd.advanceDays(3)                — промотка дней офлайн-движком: день N → N+3 (из фазы отчёта — сначала next_day, и HUD вернёт скорость до отчёта: партия побежит живьём, для паузы — itd.pause() ДО вызова), без day_report; сводка {days, income, payroll, balance} — в ответе .advance и строкой «debug · advance» в itd.snapshot().events, в itd.log() — только смена дня
  await itd.play([{cmd:'set_speed', extra:{speed:0}}, {cmd:'hire'}, {days:1}]) — партия из консоли: шаг {cmd, office?, extra?} (квитанция как у itd.cmd) или {days: n} (как itd.advanceDays); строка на шаг «cmd | ok/FAIL code | dN tN | бал>бал | staff a>b | pay N | phase»; без таймеров — шаг ждёт квитанцию и снапшот rev ≥ её rev; FAIL партию не прерывает
  await itd.ledger(day?)            — бухгалтерия дня с сервера: {day, balanceStart, income, eventMoney, events[{what, money, clock}], purchases[{type, price, clock}], purchasesTotal, payroll, gatewayOpex, antivirus, interest, adjust, balanceEnd, profit, delta, balanced, closed, offline, history}; слагаемые = balanceEnd − balanceStart ровно; profit = day_report.profit; без day — текущий (payroll 0 до вечера), иначе один из history (7 закрытых + текущий)
  await itd.journal({tail?, sid?})  — журнал партии (ITGAME-46, сервер с ITGAME_DEBUG=1): хвост входов (tail 1..500, по умолчанию 20) строками «#seq k что | dN tN $M фаза Nx revR +tk» и объектами без сейвов; kinds по всему журналу, total, dropped; url — полный JSONL для make replay ARGS="-url …"; cmd несёт id, как itd.trace().sent, и conn/src (ITGAME-91): «buy_pc c2 id1 ok» — соединение 2 партии, «c3 bridge» — мост агента; уникальна пара (conn, id), не id; end — evicted | read_timeout | debug_drop | disconnect (закрыл клиент)
  itd.set({money: 50000})           — читы живой сессии: {money, day, tickInDay}
  itd.scenario('soft_lock')         — пересоздать партию фикстурой: fresh|broke_day3|mid_day10|full_office|soft_lock|pre_victory|spare_pcs|broken_pc|doomed_debt|virus_outbreak|admin_dept; сбрасывает клиентское состояние партии (офис → О1, оверлеи HUD, окна офиса/серверной, пауза отчёта); скорость не трогает — из отчёта или окна выхода партия остаётся на паузе: itd.resume(); работает и после финала; из меню — сразу not_in_party (ниже)
  itd.snapshot()                    — полный стейт с сервера: {state, save, events}; сид нового старта — ?seed=1234 в URL страницы
  itd.restore(save)                 — вернуть состояние из snapshot().save (дельта над текущим); закрытый в новом состоянии активный офис → О1; окна офиса/серверной закрывает
  await itd.staleSave({format?, sid?}) — пометить сейв чужим форматом (ITGAME-154, /api/debug/format): game.format = format (по умолчанию на 1 новее сервера), версия не трогается, без перезапуска; sid — свой (liveSid ?? хранилище), из меню тоже → {sid, was, format, live}; live:false — сейв переписан, перезагрузите меню → «СЕЙВ НЕСОВМЕСТИМ»; live:true — метку держит актор партии: «В меню» → карточка, переподключение → новая партия молча (ITGAME-174)
  itd.quiet()                       — стоп твитов/миганий для стабильных скриншотов
  itd.meta()                        — статистика прогонов и состояние достижений (localStorage)
  itd.resetMeta()                   — сбросить мета-статистику и достижения
  itd.unlockAchievement('id')       — принудительно открыть ачивку: {ok:true, achievement} | {ok:false, code}
  itd.contract()                    — машинный контракт API (методы, типы, коды ошибок); version.hash — цитировать в отчётах, а не пересказ help()
Фоновая вкладка: RAF стоит, но itd сам ведёт луп (пульс 300мс + прогрев в каждом вызове) — ids()/nodes()/click() живут без скриншотов и без «принудительного кадра».
Параллельные вкладки: sid берётся из sessionStorage РАНЬШЕ localStorage; в хранилища ключ попадает ТОЛЬКО с реальной партиёй (чтение его не пишет — «ПРОДОЛЖИТЬ» не врёт). Одна партия = один sid: агрессивным прогонам — itd.sandbox('<имя>') (или вручную sessionStorage.setItem('itd.sid', 'a-<имя>-'+Date.now()): виден только вкладке, общий ключ не трогает; ЯВНО выставленный sid чтится и для новой партии), игроку достаётся localStorage + зеркало вкладки. Кнопка сложности/1-4 = НОВАЯ партия: без явного sessionStorage-sid берётся свежий sid, чужой сейв из общего ключа НЕ продолжается молча; «ПРОДОЛЖИТЬ»/Enter = восстановление текущего sid. server().sidSwitches > 0 — общий ключ перезаписала соседняя вкладка, реконнект ушёл бы в её партию.
Вне партии: debug-вызовы (set, step, advanceDays, play {days}, ledger, scenario, snapshot, restore) идут только в живую партию вкладки (server().liveSid) — из меню (до первой партии, после «В меню»/«Сдаться») и после перехвата сессии другой вкладкой они сразу отказывают «not_in_party: …», без запроса на сервер (ITGAME-131). Из меню — itd.click('menu.diff.normal') (при живом сейве меню спросит «Начать заново?» — itd.click('modal.btn.confirm'); или itd.click('menu.continue')), затем await itd.wait(s => s.connected); после перехвата меню нет — обновите страницу (F5). itd.journal() — без этого правила: журнал живёт на сервере; без sid он читается после «Сохранить и выйти»/«Выйти без сохранения», а после «Сдаться» и финала → «В меню» sid вкладки стёрт (no_journal) — берите sid из server().sid до выхода и читайте itd.journal({sid}). itd.staleSave() — тоже: сейв помечают и из меню.
Пример: await itd.scenario('soft_lock'); itd.state().day
Пример: itd.set({money: 50000}); await itd.wait(s => s.balance === 50000)
Пример: await itd.cmd('hire') → {ok:false, code:'no_free_pc'} — сервер отказал, ПК заняты`

// ── itd.play (ITGAME-73) ───────────────────────────────────────────────────

// Срез снапшота для строки шага.
function playSnap(s: StateMessage | null) {
  if (!s) return null
  return {
    day: s.day, t: s.tickInDay, bal: s.money, phase: s.phase, pay: s.payrollPerDay,
    staff: s.offices.reduce((n, o) => n + o.employees.length, 0),
  }
}

// Один шаг партии: действие, квитанция, снапшот rev ≥ её rev — строка.
async function playStep(api: ItdApi, st: PlayStep): Promise<string> {
  const before = playSnap(client.latest)
  let name: string
  let verdict: string
  let after: StateMessage | null = null
  if (st && typeof st === 'object' && 'days' in st) {
    name = `days${st.days}`
    try {
      const r = await api.advanceDays(st.days)
      after = await client.waitRev(r.state.rev, 5000)
      verdict = after ? 'ok' : `ok (нет rev≥${r.state.rev})`
      after ??= r.state
    } catch (e) {
      verdict = `FAIL ${e instanceof Error ? e.message : String(e)}`
      after = client.latest
    }
  } else if (st && typeof st === 'object' && typeof (st as PlayCmdStep).cmd === 'string') {
    const { cmd, office = 0, extra = {} } = st as PlayCmdStep
    name = [cmd, ...Object.values(extra).map(String), ...(office ? [`o${office}`] : [])].join(' ')
    const r = await api.cmd(cmd, office, extra)
    verdict = r.ok ? 'ok' : `FAIL ${r.code ?? r.error ?? '?'}`
    if (typeof r.rev === 'number') {
      after = await client.waitRev(r.rev, 5000)
      if (!after) verdict += ` (нет rev≥${r.rev})`
    }
    after ??= client.latest
  } else {
    return `${JSON.stringify(st)} | FAIL bad_step: {cmd, office?, extra?} или {days: n}`
  }
  const a = playSnap(after)
  if (!a) return `${name} | ${verdict} | нет снапшота`
  return [
    name, verdict, `d${a.day} t${a.t}`, `${before?.bal ?? '?'}>${a.bal}`,
    `staff ${before?.staff ?? '?'}>${a.staff}`, `pay ${a.pay}`, a.phase,
  ].join(' | ')
}

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
  // ITGAME-87: ключ догона. client.lastOffline — последний догон страницы, он не
  // сбрасывается, и после away без догона itd.offline() отдавал прошлый, а сверка
  // по at была только в away. Каждый offline_report получает seq (счётчик
  // страницы) и awayId (уход, во время которого пришёл): эфир видим раньше, чем
  // net.ts кладёт lastOffline, ключ к объекту привязываем при чтении.
  let offlineSeq = 0
  let awaySeq = 0
  let awayNow: number | null = null
  let tappedKey: { seq: number; awayId: number | null } | null = null
  const offlineKeys = new WeakMap<OfflineCatchUp, { seq: number; awayId: number | null }>()
  client.tapWire((e) => {
    if (e.dir === 'in' && e.type === 'offline_report') tappedKey = { seq: ++offlineSeq, awayId: awayNow }
  })
  const offlineKey = (last: OfflineCatchUp): { seq: number; awayId: number | null } => {
    let k = offlineKeys.get(last)
    if (!k) {
      k = tappedKey ?? { seq: ++offlineSeq, awayId: null }
      tappedKey = null
      offlineKeys.set(last, k)
    }
    return k
  }
  // itd.offline(): последний догон + окно на экране и пауза сейчас.
  const offlineNow = (): AgentOffline | null => {
    const last = client.lastOffline
    if (!last) return null
    warmIfHidden()
    const open = activeNodes(game).some((n) => n.visible && (n.id === 'btn.offline.continue' || n.id === 'btn.offline.menu'))
    return { ...last, open, paused: (client.latest?.speed ?? 0) === 0, ...offlineKey(last) }
  }

  const api: ItdApi = {
    version: BUILD,
    state: () => buildState(game),
    server: buildServer,
    nodes: () => warmedNodes(),
    text: () => warmedNodes().filter((n) => n.text !== null && n.text !== ''),
    ids: () =>
      warmedNodes()
        .filter((n) => n.id !== null)
        .map((n) => ({ id: n.id as string, safe: n.safe as string, scene: n.scene, type: n.type, text: n.text, active: n.active })),
    click(id) {
      warmIfHidden()
      const hit = findById(game, id)
      if (!hit) return { ok: false, error: `id '${id}' не найден — см. itd.ids()` }
      clickRejection = null
      // ITGAME-179: команда, ушедшая внутри вызова, — sent[].src 'itd'
      inItdCall(() => hit.obj.emit('pointerdown', leftPointer, 0, 0, {}))
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
      inItdCall(() => {
        for (const scene of game.scene.getScenes(true)) {
          const kb = scene.input.keyboard
          if (!kb) continue
          scenes.push(scene.scene.key)
          kb.emit(`keydown-${def.code}`, event)
          kb.emit('keydown', event)
        }
      })
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
      // «Сдаться» — путём кнопки: голый abandon удалял сейв, а клиент
      // переподключался и сервер заводил под тем же sid новую партию.
      if (type === 'abandon') {
        const hud = game.scene.getScene('hud') as unknown as { abandonParty?(): void } | null
        if (!game.scene.isActive('hud') || !hud?.abandonParty || !client.latest) {
          return Promise.resolve({ ok: false, code: 'not_connected', error: 'нет живой партии' })
        }
        inItdCall(() => hud.abandonParty!())
        return Promise.resolve({ ok: true })
      }
      return inItdCall(() => client.sendWithReceipt(type, office, extra))
        .then((r) => (r.ok ? r : { ...r, error: r.code }))
    },
    trace: makeTrace(game),
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
    hit(rawId) {
      warmIfHidden()
      const id = realId(rawId)
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
    screen(opts) {
      // ITGAME-148: рамка — ширина снимка в px; frame: 1 молча давал координаты для кадра шириной 1
      const fr = opts?.frame
      if (fr != null && !(typeof fr === 'number' && Number.isFinite(fr) && fr >= 100)) {
        return { ok: false, code: 'bad_frame', error: `itd.screen: frame — ширина рамки снимка, px, число ≥ 100 (получено ${String(fr)})` }
      }
      warmIfHidden()
      return buildScreen(game, opts)
    },
    stale: () => checkStale(),
    sandbox: makeSandbox(game),
    sprite: makeSpriteApi(game),
    stack(safeOrX, gy) {
      warmIfHidden()
      let x: number
      let y: number
      if (typeof safeOrX === 'string') {
        const id = realId(safeOrX)
        const n = activeNodes(game).find((m) => m.id === id)
        if (!n) return { ok: false, at: null, stack: [], wins: null, why: 'нет узла' }
        if (!n.visible) return { ok: false, at: { x: n.cx, y: n.cy }, stack: [], wins: null, why: 'узел невидим' }
        x = n.cx
        y = n.cy
      } else {
        if (typeof gy !== 'number' || !Number.isFinite(safeOrX) || !Number.isFinite(gy)) {
          return { ok: false, at: null, stack: [], wins: null, why: 'нужны id или gx, gy' }
        }
        x = safeOrX
        y = gy
      }
      const { stack, wins } = stackAt(game, x, y)
      return { ok: true, at: { x, y }, stack, wins }
    },
    zones(safeA, safeB) {
      warmIfHidden()
      return zonesOf(game, safeA, safeB)
    },
    offline: offlineNow,
    async away(sec, opts = {}) {
      if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 0 || sec > 600) {
        return { ok: false, code: 'bad_sec', error: 'sec — секунды ухода, 0..600' }
      }
      const mode = opts.mode ?? 'close'
      if (mode !== 'close' && mode !== 'net') {
        return { ok: false, code: 'bad_mode', error: "mode — 'close' или 'net'" }
      }
      const awayId = ++awaySeq
      awayNow = awayId
      let r: AwayReturn
      try {
        r = await client.away(sec * 1000, mode, { timeoutMs: opts.timeout })
      } finally {
        awayNow = null
      }
      // догон этого ухода, а не прошлого — по ключу (ITGAME-87), не по at
      const off = offlineNow()
      return { ...r, awayId, offline: r.ok && off?.awayId === awayId ? off : null }
    },
    injectError(message = 'проверка журнала') {
      setTimeout(() => { throw new Error(`itd.injectError: ${message}`) }, 0)
      return { ok: true }
    },
    contrast: () => findLowContrast(game),
    tiny: () => findTiny(game),
    assets() {
      const textures: AssetReport[] = []
      const bySig = new Map<string, string[]>()
      let textTextures = 0
      const tried = triedKeys()
      for (const key of game.textures.getTextureKeys()) {
        if (isHiddenOriginal(key)) continue // оригинал под пробой itd.sprite.try — не отдельная текстура
        if (INTERNAL_TEXTURES.has(key) || UUID_KEY.test(key)) {
          if (UUID_KEY.test(key)) textTextures++
          continue
        }
        // Источник: ai:<key> — сам PNG; <key> — проба itd.sprite.try (ITGAME-119),
        // PNG, если подменён источником ai:<key> в BootScene, иначе кодоген.
        let source: AssetReport['source'] = 'pixelart'
        if (key.startsWith('ai:')) source = 'png'
        else if (tried.has(key)) source = 'tried'
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
    reset() {
      // Единый namespace itd.* (ITGAME-28): снести всё разом — sid (обе
      // копии: sessionStorage вкладки + localStorage игрока, ITGAME-30),
      // сложность, хинты, зум, тумблеры. Страницу перезагружает агент.
      const removed = [...localStore.clearPrefix('itd.'), ...sessionStore.clearPrefix('itd.')]
      return { ok: true, removed }
    },
    log: (n = 50) => telemetry.log(n),
    errors: () => telemetry.errors(),
    net(n = 20) {
      return {
        socket: client.socketStatus(),
        reconnects: client.stats.reconnects,
        rtt: client.stats.rtt,
        rev: client.latest?.rev ?? null,
        last: client.wire.slice(-n),
      }
    },
    pause() {
      // Честный отказ до коннекта (ITGAME-30): раньше — тихий no-op c ok:true.
      return inItdCall(() => client.send('set_speed', 0, { speed: 0 }))
        ? { ok: true }
        : { ok: false, code: 'not_connected', error: 'сокет не открыт — пауза не отправлена' }
    },
    resume() {
      return inItdCall(() => client.send('set_speed', 0, { speed: 1 }))
        ? { ok: true }
        : { ok: false, code: 'not_connected', error: 'сокет не открыт — resume не отправлен' }
    },
    speed(n) {
      if (!Number.isInteger(n) || n < 0 || n > 3) {
        return { ok: false, error: 'скорость — целое 0..3 (0 — пауза)' }
      }
      return inItdCall(() => client.send('set_speed', 0, { speed: n }))
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
      partySid() // ITGAME-131: вне партии — отказ до паузы, без set_speed в закрытый сокет (HUD дал бы тост «нет связи»)
      inItdCall(() => client.send('set_speed', 0, { speed: 0 })) // степпинг только на паузе
      return debugFetch<DebugAdvanceResult>('POST', '/advance', { ticks })
    },
    advanceDays(n) {
      if (!Number.isInteger(n) || n < 1 || n > 90) {
        return Promise.reject(new Error('advanceDays: целое 1..90'))
      }
      return debugFetch<DebugAdvanceResult>('POST', '/advance', { days: n })
    },
    async play(steps) {
      if (!Array.isArray(steps)) {
        throw new Error("play: массив шагов [{cmd, office?, extra?} | {days: n}]")
      }
      const rows: string[] = []
      for (const st of steps) rows.push(await playStep(api, st))
      return rows
    },
    ledger(day) {
      if (day !== undefined && (!Number.isInteger(day) || day < 1)) {
        return Promise.reject(new Error('ledger: day — целое ≥ 1 (без него — текущий день)'))
      }
      return debugFetch<DayLedger>('GET', day === undefined ? '/ledger' : `/ledger?day=${day}`)
    },
    journal(opts) {
      const tail = opts?.tail ?? 20
      if (!Number.isInteger(tail) || tail < 1 || tail > 500) {
        return Promise.reject(new Error('journal: tail — целое 1..500'))
      }
      return fetchJournal(opts?.sid ?? client.liveSid() ?? sessionId(), tail)
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
      // ITGAME-69: окна офиса и серверной собраны по прошлому стейту — закрываем.
      partyReplaced()
      // ITGAME-63: дельта могла закрыть офис, на котором стоит вкладка. Партию не
      // сбрасываем (resetForNewGame — только новой партии): агент остаётся в своём офисе.
      if (!r.state.offices[nav.activeOffice]?.unlocked) {
        nav.activeOffice = 0
        client.reemit() // пуш уже нарисовал закрытый офис — перерисовываем
      }
      return r
    },
    async staleSave(opts) {
      const format = opts?.format
      if (format !== undefined && (!Number.isInteger(format) || format < 0)) {
        throw new Error('staleSave: format — целое ≥ 0 (без него — на 1 новее формата сервера)')
      }
      // ITGAME-154: не debugFetch — тот требует живой партии (ITGAME-131), а сейв помечают и из меню
      const sid = opts?.sid ?? client.liveSid() ?? sessionId()
      const res = await fetch('/api/debug/format', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(format === undefined ? { sid } : { sid, format }),
      })
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null
      if (!res.ok) {
        throw new Error((data?.error as string | undefined) ?? `HTTP ${res.status}${res.status === 404 ? ' (сервер без ITGAME_DEBUG=1?)' : ''}`)
      }
      return data as unknown as StaleSaveResult
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
  return api
}

// Ставится в main.ts после готовности сцен: до этого сцен ещё нет,
// nodes()/click() смотрели бы в пустоту.
export function installAgentApi(game: Phaser.Game): void {
  const enabled =
    import.meta.env.DEV ||
    new URLSearchParams(location.search).get('debug') === '1' ||
    localStore.get('itd.debug') === '1'
  if (!enabled) return
  game.events.once(Phaser.Core.Events.READY, () => {
    window.itd = makeApi(game)
    console.log(`[itd] agent api ready {build:${import.meta.env.MODE}}`)
  })
}
