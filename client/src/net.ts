import { resetForNewGame } from './party'
import { localStore, sessionStore } from './storage'
import type { CommandType, DayReportMessage, DifficultyId, GameOverMessage, OfflineReportMessage, SaveSummaryMessage, ServerErrorCode, ServerMessage, StateMessage, VictoryMessage } from './protocol'

// Транспортные коды отказа (ITGAME-39): квитанция команды (sendWithReceipt)
// падает ими, когда сервер вовсе не ответил — в отличие от ServerErrorCode,
// который приходит В сообщении error от сервера. Источник истины для
// itd.contract() (enum TransportErrorCode).
export const TRANSPORT_ERROR_CODES = ['not_connected', 'receipt_timeout', 'disconnected'] as const

export type TransportErrorCode = (typeof TRANSPORT_ERROR_CODES)[number]

// Статусы сокета (ITGAME-39): источник истины для itd.server().socket,
// itd.net().socket и enum SocketStatus в itd.contract().
export const SOCKET_STATUSES = ['open', 'reconnecting', 'closed'] as const

export type SocketStatus = (typeof SOCKET_STATUSES)[number]

// Уход без ухода со страницы (ITGAME-76, itd.away): close — как закрытая
// вкладка (close-фрейм, сервер знает сразу), net — как обрыв сети (debug-ручка
// POST /api/debug/drop: сервер молчит и замечает уход своим таймаутом чтения).
export const AWAY_MODES = ['close', 'net'] as const

export type AwayMode = (typeof AWAY_MODES)[number]

// Ответ ручки drop (mode net): когда сервер замолчал и когда заметит уход.
export interface AwayDrop {
  at: number // epoch ms: сервер перестал читать и писать в соединение вкладки
  timeoutMs: number // таймаут чтения этого соединения
  noticeBy: number // at + timeoutMs: раньше сервер уход не заметит
}

// Итог client.away: возврат в ту же партию (тот же sid, первый снапшот resumed).
export interface AwayReturn {
  ok: boolean
  code?: 'already_away' | 'not_connected' | 'finished' | 'drop_failed' | 'interrupted' | 'no_return' | 'not_resumed'
  error?: string
  mode: AwayMode
  sid: string | null // sid после возврата (= до ухода, если ok)
  leftAt: number | null // epoch ms ухода: вкладка «пропала» для сервера
  back: number | null // epoch ms возврата: первый снапшот нового сокета
  resumed: boolean | null // первый снапшот возврата помечен resumed (та же партия)
  incompatible: boolean | null // первый снапшот возврата: сервер отверг сейв sid как чужого формата (ITGAME-174/224); null — не вернулись
  rev: number | null // его rev (cause 'resume')
  drop: AwayDrop | null // mode net: ответ ручки drop
}

// Квитанция команды (ITGAME-30/45): ok — сервер принял (state с re = id),
// иначе code — серверный отказ или транспортный. id — номер команды на
// проводе (её sent в itd.net()/itd.trace()), rev — версия состояния ответа
// (у отказа — текущая); у транспортных отказов нет rev, у not_connected — id.
export interface Receipt {
  ok: boolean
  code?: ServerErrorCode | TransportErrorCode
  id?: number
  rev?: number
}

export interface Listener {
  onState(s: StateMessage): void
  onError(code: ServerErrorCode): void
  onDisconnect(reason?: string): void
  // Только HUD показывает отчёты, банкротство и офлайн-итог — для
  // остальных сцен опциональны.
  onDayReport?(r: DayReportMessage): void
  onGameOver?(o: GameOverMessage): void
  onVictory?(v: VictoryMessage): void
  onOfflineReport?(r: OfflineReportMessage): void
  // Сервер отверг сейв sid как чужого формата и начал новую партию (ITGAME-174): флаг первого
  // снапшота сокета — разовое событие, как отчёты (ITGAME-224): уходит первому подписчику с этим
  // обработчиком, ждёт его, если HUD ещё не создан, и второй раз не приходит.
  onIncompatible?(): void
  // Реконнект в процессе (деплой рвёт WS): баннер «переподключение».
  onReconnecting?(attempt: number): void
  // Команда send() не ушла: сокет не открыт или вкладка в уходе (ITGAME-90) —
  // HUD скажет игроку «нет связи» вместо молчаливого клика.
  onNotConnected?(cmd: CommandType): void
  // Наблюдатель (телеметрия itd): видит разовые сообщения, но не показывает
  // их игроку — его получение не снимает сообщение с очереди (ITGAME-19).
  observer?: boolean
}

const SID_KEY = 'itd.sid'
const DIFF_KEY = 'itd.diff'
// Метка зеркала: значение sid, которым КЛИЕНТ писал зеркало вкладки.
// Если sessionStorage['itd.sid'] ≠ метке — sid выставлен ЯВНО (агентом),
// и его чтим; совпадает — это наше зеркало текущей партии, новая партия
// может его сменить. Самоисцеляющаяся: ручная перезапись sid ломает
// совпадение без дополнительной гигиены.
const SID_AUTO_KEY = 'itd.sid.auto'

// Ключ сессии в памяти вкладки: чтение больше НИЧЕГО не пишет в хранилища
// (ITGAME-30). Раньше геттер создавал uuid при первом чтении и клал его в
// localStorage — страница просто открыта, сейва нет, а меню уже показывает
// «ПРОДОЛЖИТЬ» и честное лицо теряет. Теперь ключ появляется в хранилищах
// только с настоящей партией — в connect().
let memorySid: string | null = null
// Откуда пришёл sid: 'session' — вкладочный (зеркало или агентский),
// 'local' — общий ключ игрока, 'generated' — создан этой страницей.
let sidOrigin: 'session' | 'local' | 'generated' | null = null
// Происхождение ТЕКУЩЕЙ партии фиксируется на коннекте: дальнейшие чтения
// sessionId() честно перекладывают origin на зеркало sessionStorage, а
// гарда общего ключа должна знать, чья партия на самом деле.
let partyOrigin: 'session' | 'local' | 'generated' | null = null

// Песочница агента (ITGAME-77, itd.sandbox): запись во вкладке (sessionStorage) —
// метка и снятые при входе ключи владельца. Пока она есть, партии вкладки живут
// только под вкладочными sid вида a-<метка>-<время>: новая партия и финал НЕ
// откатываются к общему localStorage-ключу владельца (иначе после «Сдаться»
// sessionId() взял бы его sid, а «НОРМА» перезаписала бы его новым).
export const SANDBOX_KEY = 'itd.sandbox'
export interface SandboxRecord {
  label: string
  ownerSid: string | null // localStorage itd.sid при входе
  ownerDiff: string | null // localStorage itd.diff при входе
  ownerOnboard?: string | null // localStorage itd.onboard при входе (ITGAME-21); нет поля — запись старой вкладки
  ownerZoom?: string | null // localStorage itd.uiScale при входе (ITGAME-155); нет поля — запись старой вкладки
  zoom?: string // последний масштаб, который вкладка песочницы записала в itd.uiScale (uiscale.ts onZoomWrite)
  tabSid: string | null // sessionStorage itd.sid вкладки при входе
  tabAuto: string | null // sessionStorage itd.sid.auto при входе
  fake: { sid: string; diff: string } | null // «чужой» общий ключ fakeOwner()
  at: number
}

export function sandboxRecord(): SandboxRecord | null {
  try {
    const raw = sessionStore.get(SANDBOX_KEY)
    const r = raw ? (JSON.parse(raw) as SandboxRecord) : null
    return r && typeof r.label === 'string' ? r : null
  } catch {
    return null
  }
}

export function sandboxSid(label: string): string {
  return `a-${label}-${Date.now()}`
}

// Явный sid вкладки (без метки зеркала — prepareNewGame его чтит), память тоже.
export function adoptTabSid(sid: string): void {
  sessionStore.set(SID_KEY, sid)
  sessionStore.remove(SID_AUTO_KEY)
  memorySid = sid
  sidOrigin = 'session'
}

// Выход из песочницы: память вкладки забывает её sid — следующее чтение
// sessionId() честно возьмёт хранилища.
export function forgetTabSid(): void {
  memorySid = null
  sidOrigin = null
}

function newSid(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : 'sid-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
}

// sessionId — ключ сейва на сервере. Приоритет: sessionStorage →
// localStorage → память вкладки (сгенерированный, ещё не записанный).
// Хранилище всегда важнее памяти: агент может вызвать itd.server() до
// установки своего sid — кэш не должен побить явную установку.
// Параллельным вкладкам/агентским прогонам общий localStorage-ключ —
// ловушка: вкладки тихо перезаписывают sid друг другу, команда уезжает в
// чужую партию. sessionStorage виден только своей вкладке — агрессивные
// сценарии ставят sid туда и не воюют с соседями.
export function sessionId(): string {
  const fromSession = sessionStore.get(SID_KEY)
  if (fromSession) {
    memorySid = fromSession
    sidOrigin = 'session'
    return memorySid
  }
  // Песочница (ITGAME-77): общий ключ владельца не читаем — свежий sid песочницы
  // в памяти с origin 'session': persistSid() положит его только в зеркало вкладки.
  const sandbox = sandboxRecord()
  if (sandbox) {
    if (!memorySid) memorySid = sandboxSid(sandbox.label)
    sidOrigin = 'session'
    return memorySid
  }
  const fromLocal = localStore.get(SID_KEY)
  if (fromLocal) {
    memorySid = fromLocal
    sidOrigin = 'local'
    return memorySid
  }
  if (memorySid) return memorySid
  memorySid = newSid()
  sidOrigin = 'generated'
  return memorySid
}

// Записать ключ с реальной партией (connect): зеркало вкладки всегда,
// общий ключ игрока — только если sid не вкладочный: партии агентов из
// sessionStorage в общий ключ не попадают. Сразу фиксируем происхождение
// партии для гарды общего ключа.
function persistSid(): void {
  const sid = sessionId()
  partyOrigin = sidOrigin
  sessionStore.set(SID_KEY, sid)
  sessionStore.set(SID_AUTO_KEY, sid)
  if (sidOrigin !== 'session') localStore.set(SID_KEY, sid)
}

// Новая партия по явному выбору игрока (кнопка сложности, клавиши 1-4):
// если вкладке не выставлен ЯВНЫЙ sid (агентский sessionStorage без нашей
// метки), текущий sid забывается везде — и зеркало, и общий ключ: иначе
// sessionId() молча продолжит чужой сейв из localStorage (волна B: «НОРМА»
// открывала существующую партию). Живой сосед вернёт себе общий ключ гарде,
// а connect() новой партии запишет туда уже свежий sid. Явно выставленный
// sid чтим — на нём держатся агентские прогоны (?seed/?scenario + sid).
export function prepareNewGame(): void {
  const explicit = sessionStore.get(SID_KEY)
  if (explicit !== null && explicit !== sessionStore.get(SID_AUTO_KEY)) return
  const sandbox = sandboxRecord()
  if (sandbox) {
    // новая партия песочницы — новый sid песочницы, общий ключ не трогаем (ITGAME-77)
    sessionStore.remove(SID_KEY)
    sessionStore.remove(SID_AUTO_KEY)
    memorySid = sandboxSid(sandbox.label)
    sidOrigin = 'session'
    return
  }
  const sid = newSid()
  memorySid = sid
  sidOrigin = 'generated'
  sessionStore.remove(SID_KEY)
  sessionStore.remove(SID_AUTO_KEY)
  // Общий ключ сразу ПЕРЕЗАПИСЫВАЕМ на новую партию (S→N), а не удаляем:
  // соседняя живая вкладка увидит запись, а не стирание — гарда общего
  // ключа не вступит в гонку за указатель. Удаление остаётся у финала
  // партии (game_over), где его и возвращает живой сосед.
  localStore.set(SID_KEY, sid)
}

// Есть ли сейв для «Продолжить» в меню: ключ в хранилищах теперь появляется
// только с настоящей партией — «ПРОДОЛЖИТЬ» больше не судит по ключу,
// созданному голым чтением.
export function hasSavedSession(): boolean {
  if (sandboxRecord()) return sessionStore.get(SID_KEY) !== null // общий ключ — владельца (ITGAME-77)
  return sessionStore.get(SID_KEY) !== null || localStore.get(SID_KEY) !== null
}

// Окно «Пока вас не было» — только при смене дня или финале; короткий догон
// внутри дня сервер тоже присылает, но игроку он тих (приёмка 10.10).
export function offlineShown(r: OfflineReportMessage): boolean {
  return r.days > 0 || r.gameOver || r.victory
}

// Последний офлайн-догон этой страницы (для itd.offline()).
export interface OfflineCatchUp {
  ticks: number
  days: number
  shown: boolean // показано ли игроку окно «Пока вас не было»
  at: number // epoch ms прихода
  droppedAt: number | null // epoch ms последнего сейва: тогда сервер заметил обрыв
  leftAt: number | null // epoch ms ухода со страницы (pagehide этой вкладки), null — не знаем
  liveTicks: number | null // тиков прошло вживую между уходом и тем, как сервер заметил обрыв
}

// Уход со страницы (pagehide): когда и на какой скорости — чтобы offline()
// разделил «шло вживую, пока сервер не заметил» и догон (ретро 10.10).
const LEFT_KEY = 'itd.leftAt'

function readLeft(): { at: number; speed: number } | null {
  try {
    const raw = sessionStore.get(LEFT_KEY)
    sessionStore.remove(LEFT_KEY)
    const v = raw ? (JSON.parse(raw) as { at?: unknown; speed?: unknown }) : null
    return v && typeof v.at === 'number' && typeof v.speed === 'number' ? { at: v.at, speed: v.speed } : null
  } catch {
    return null
  }
}

export function savedDifficulty(): DifficultyId {
  return (localStore.get(DIFF_KEY) as DifficultyId) ?? 'normal'
}

// clearSession — сейва больше нет (финал/сдаться): спрятать «Продолжить».
// Память вкладки тоже забываем: следующее чтение честно создаст новый sid.
// Общий ключ игрока (и его сложность) стираем, только если там лежит ЭТА
// партия: агентская вкладка с явным sid или вкладка, чей общий ключ уже
// перезаписал сосед новой партией, чужой сейв не трогают (приёмка ITGAME-65,
// 10.10: «Сдаться» в агентской партии стёрло «Продолжить» владельца).
export function clearSession(): void {
  const mine = memorySid
  memorySid = null
  sidOrigin = null
  partyOrigin = null
  sessionStore.remove(SID_KEY)
  sessionStore.remove(SID_AUTO_KEY)
  sessionStore.remove('itd.speedBeforeReport')
  if (mine !== null && localStore.get(SID_KEY) === mine) {
    localStore.remove(SID_KEY)
    localStore.remove(DIFF_KEY)
  }
}

// peekSave (ITGAME-19): факты сейва для меню — «День 3 · $60 · НОРМА».
// Короткий WS на тот же /ws (в проде наружу проксируется только он) с
// peek=1: сервер шлёт save_summary и закрывает, сессию не захватывает.
// null — сервер не ответил за timeoutMs или ответил не тем: меню остаётся
// с обобщённым «Продолжить», как до сводки.
export function peekSave(sid: string, timeoutMs = 1500): Promise<SaveSummaryMessage | null> {
  return new Promise((resolve) => {
    let done = false
    let ws: WebSocket | null = null
    const finish = (v: SaveSummaryMessage | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { ws?.close() } catch {}
      resolve(v)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    try {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      ws = new WebSocket(`${proto}://${location.host}/ws?peek=1&sid=${encodeURIComponent(sid)}`)
    } catch {
      finish(null)
      return
    }
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as SaveSummaryMessage
        finish(msg && msg.type === 'save_summary' ? msg : null)
      } catch {
        finish(null)
      }
    }
    ws.onerror = () => finish(null)
    ws.onclose = () => finish(null)
  })
}

interface ItdChannelMessage {
  type: 'ping_sid' | 'pong_sid'
  sid: string
  day?: number
}

export interface NeighborSessionInfo {
  active: boolean
  day?: number
}

// Запись эфира WS (ITGAME-25/37): краткая выжимка сообщения (logWire ужимает
// снапшоты до нужных полей — полный raw живёт только в аргументе tapWire).
export type WireEntry = { dir: 'in' | 'out'; at: number; type: string; info: Record<string, unknown> }

// checkActiveNeighbor (ITGAME-35): опрашивает соседние вкладки через BroadcastChannel('itd').
// Возвращает { active: true, day?: number } если живая соседняя вкладка ответила,
// либо { active: false } если за timeoutMs ответа не поступило.
export function checkActiveNeighbor(sid: string, timeoutMs = 250): Promise<NeighborSessionInfo> {
  if (typeof BroadcastChannel === 'undefined' || !sid) {
    return Promise.resolve({ active: false })
  }
  return new Promise((resolve) => {
    let resolved = false
    let ch: BroadcastChannel | null = null
    try {
      ch = new BroadcastChannel('itd')
    } catch {
      resolve({ active: false })
      return
    }

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true
        try { ch?.close() } catch {}
        resolve({ active: false })
      }
    }, timeoutMs)

    ch.onmessage = (ev) => {
      const data = ev.data as ItdChannelMessage
      if (data && data.type === 'pong_sid' && data.sid === sid) {
        if (!resolved) {
          resolved = true
          clearTimeout(timer)
          try { ch?.close() } catch {}
          resolve({ active: true, day: data.day })
        }
      }
    }

    try {
      ch.postMessage({ type: 'ping_sid', sid } satisfies ItdChannelMessage)
    } catch {
      if (!resolved) {
        resolved = true
        clearTimeout(timer)
        try { ch?.close() } catch {}
        resolve({ active: false })
      }
    }
  })
}

// GameClient — единственная точка общения с сервером.
// Сцены подписываются и получают снапшоты; игровой логики здесь нет.
// Разрыв соединения (кроме намеренного и session_taken) лечится
// автопереподключением с тем же sid: сервер восстанавливает прогресс.
type OneShotMessage = DayReportMessage | GameOverMessage | VictoryMessage | OfflineReportMessage

// Обработчик слушателя для разового сообщения — или null, если он такие не принимает.
function oneShotHandler(l: Listener, m: OneShotMessage): (() => void) | null {
  switch (m.type) {
    case 'day_report': return l.onDayReport ? () => l.onDayReport!(m) : null
    case 'game_over': return l.onGameOver ? () => l.onGameOver!(m) : null
    case 'victory': return l.onVictory ? () => l.onVictory!(m) : null
    case 'offline_report': return l.onOfflineReport ? () => l.onOfflineReport!(m) : null
  }
}

export class GameClient {
  latest: StateMessage | null = null
  speedSeq = 0
  // Телеметрия сокета для агентского фасада window.itd (ITGAME-24):
  // единственный честный источник — сам клиент, сцены ничего не знают.
  readonly stats = {
    messages: 0, // счётчик принятых сообщений = lastEventId
    reconnects: 0, // сколько раз рвалось и чинилось
    lastMessageAt: 0, // epoch ms последнего сообщения
    rtt: null as number | null, // мс от последней команды до ответа
    sidSwitches: 0, // ITGAME-30: sid сменился между соединениями (гарда вкладок)
  }
  // Эфир WS для itd.net(): последние сообщения в обе стороны (ITGAME-25).
  readonly wire: WireEntry[] = []
  // Живая подписка на эфир для itd.trace() (ITGAME-37): в отличие от wire
  // (срез кольцевого буфера), тут вызывающий видит КАЖДОЕ сообщение с
  // момента подписки — trace.ts ставит tapWire ДО action и не пропускает
  // события, случившиеся между чтениями itd.net().
  private wireTaps = new Set<(e: WireEntry, raw: Record<string, unknown>) => void>()
  private commandSentAt: number | null = null
  private ws!: WebSocket
  private listeners: Listener[] = []
  private intentionalClose = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  private takenOver = false
  // Следующий state — первый на текущем сокете (в нём resumed значим, ITGAME-54).
  private firstOfSocket = false
  private difficulty: DifficultyId = 'normal'
  lastOffline: OfflineCatchUp | null = null
  private broadcastChannel: BroadcastChannel | null = null
  // Уход (ITGAME-76, itd.away): сокет, который вкладка «потеряла». Пока он
  // есть, клиент сервера не видит: входящее этого сокета выбрасывается, команды
  // не уходят, сам не реконнектится — вернётся away() по истечении срока.
  private awayState: { mode: AwayMode; ws: WebSocket } | null = null
  // Номер сокета (растёт в openSocket) и номер сокета последнего state: away
  // ждёт первый снапшот нового сокета фактом (waitState), а не таймером.
  private socketSeq = 0
  private stateSocket = 0
  // Ожидающие сообщения конкретного сокета (away: offline_report следом за resume).
  private msgWaiters = new Set<(type: string, seq: number) => void>()

  constructor() {
    window.addEventListener('pagehide', () => {
      if (!this.latest) return
      sessionStore.set(LEFT_KEY, JSON.stringify({ at: Date.now(), speed: this.latest.speed }))
    })
    // Гарда общего ключа (ITGAME-30): чужой game_over в соседней вкладке
    // вытирает ОБЩИЙ localStorage-sid — под ним может жить НАША партия.
    // Пока партия жива (есть снапшот), возвращаем свой ключ на место;
    // finished-вкладке он больше не нужен, войны не возникает.
    window.addEventListener('storage', (ev) => {
      if (ev.key !== SID_KEY || ev.newValue !== null) return
      if (!this.latest || partyOrigin === 'session') return
      const sid = sessionId()
      if (localStore.get(SID_KEY) !== sid) localStore.set(SID_KEY, sid)
    })

    // Канал межвкладочной координации (ITGAME-35):
    // живые вкладки отвечают на пинг соседних вкладок, чтобы «ПРОДОЛЖИТЬ» в новой
    // вкладке не выбивало тихо сессию из живой (session_taken).
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        this.broadcastChannel = new BroadcastChannel('itd')
        this.broadcastChannel.onmessage = (ev) => {
          const data = ev.data as ItdChannelMessage
          if (data && data.type === 'ping_sid' && data.sid) {
            const sid = this.sessionSid
            const status = this.socketStatus()
            if (sid && sid === data.sid && (status === 'open' || status === 'reconnecting')) {
              this.broadcastChannel?.postMessage({
                type: 'pong_sid',
                sid,
                day: this.latest?.day,
              } satisfies ItdChannelMessage)
            }
          }
        }
      } catch {
        // BroadcastChannel недоступен
      }
    }
  }
  // Квитанции команд (ITGAME-45): по id команды. Сервер возвращает его как re
  // в error и в снапшоте, порождённом командой, — только отправителю. FIFO
  // (ITGAME-30) путал тиковый снапшот «в пути» и снапшот команды агента-
  // наблюдателя с ответом на свою команду. Map хранит порядок вставки:
  // settleOldest — фолбэк для сервера без rev (старый бинарь в dev).
  private receipts = new Map<number, (r: Receipt) => void>()
  // Номер команды на проводе: растёт всю жизнь страницы, через сокеты и
  // партии — запоздалый ответ старого сокета не совпадёт с новой командой.
  private nextCmdId = 0
  // Ожидающие снапшота (waitState): проверяются на каждом state.
  private stateWaiters = new Set<(s: StateMessage) => void>()
  // sid, которым живёт ТЕКУЩЕЕ соединение; гарда «sid сменился подо мной».
  // Легитимная смена (новая партия из меню, abandon) сбрасывается в null
  // в connect()/abandon() — предупреждает только незапланированные.
  private sessionSid: string | null = null

  // Статус сокета одним словом — для itd.server() и баннеров.
  socketStatus(): SocketStatus {
    if (this.awayState) return 'reconnecting' // ITGAME-76: в уходе, away вернёт сокет сам
    if (this.takenOver || this.intentionalClose) return 'closed'
    const rs = this.ws?.readyState
    if (rs === WebSocket.OPEN) return 'open'
    if (rs === WebSocket.CONNECTING || this.reconnectTimer) return 'reconnecting'
    return 'closed'
  }

  // Краткая выжимка сообщения для itd.net(): без массивов сотрудников.
  private logWire(dir: 'in' | 'out', type: string, m: Record<string, unknown>): void {
    const brief: Record<string, unknown> = {}
    if (m.type === 'state') {
      brief.day = m.day
      brief.clock = m.clock
      brief.phase = m.phase
      brief.money = m.money
      // ITGAME-45: версия, причина и (у своего ответа) id команды
      brief.rev = m.rev
      brief.cause = m.cause
      if (m.re !== undefined) brief.re = m.re
    } else if (m.type === 'day_report') {
      brief.day = m.day
      brief.profit = m.profit
    } else if (m.type === 'game_over' || m.type === 'victory') {
      brief.day = m.day
      brief.reason = m.reason
    } else if (dir === 'out') {
      brief.office = m.office
      Object.assign(brief, m.speed !== undefined ? { speed: m.speed } : m.slot !== undefined ? { slot: m.slot } : {})
      if (m.id !== undefined) brief.id = m.id
    } else {
      brief.code = m.code
      if (m.re !== undefined) brief.re = m.re
      if (m.rev !== undefined) brief.rev = m.rev
    }
    const entry: WireEntry = { dir, at: Date.now(), type, info: brief }
    this.wire.push(entry)
    if (this.wire.length > 100) this.wire.splice(0, this.wire.length - 100)
    // try обязателен: logWire('in') зовётся ДО раздачи снапшота слушателям
    // (this.listeners) — упавший тап не должен срывать доставку state/error.
    for (const fn of this.wireTaps) {
      try {
        fn(entry, m)
      } catch (e) {
        console.error('[net] tapWire', e)
      }
    }
  }

  // Живая подписка на эфир (ITGAME-37, itd.trace): вызывающий получает
  // brief-запись (как itd.net()) + сырое сообщение raw — полная команда для
  // sent, снапшот НЕ хранится для recv (см. trace.ts). Возвращает отписку.
  tapWire(fn: (e: WireEntry, raw: Record<string, unknown>) => void): () => void {
    this.wireTaps.add(fn)
    return () => {
      this.wireTaps.delete(fn)
    }
  }

  connect(difficulty: DifficultyId): void {
    this.latest = null
    this.pending = []
    this.incompatibleDue = false
    this.awayState = null // новая партия отменяет уход (away вернёт interrupted)
    this.intentionalClose = false
    this.takenOver = false
    this.sessionSid = null // смена sid здесь запланирована (новая партия)
    this.difficulty = difficulty
    // Ключ сессии появляется в хранилищах только здесь — с реальной партией
    // (ITGAME-30): зеркало вкладки (sessionStorage) держит партию против
    // чужого clearSession, общий ключ игрока не затирается вкладочными sid.
    persistSid()
    // Сложность общего ключа — пара к нему: вкладочная (агентская) партия её
    // не пишет, как и сам ключ.
    if (partyOrigin !== 'session') localStore.set(DIFF_KEY, difficulty)
    this.openSocket()
  }

  private openSocket(): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const sid = sessionId()
    if (this.sessionSid !== null && this.sessionSid !== sid) {
      // Гарда (ITGAME-30): между соединениями общий ключ перезаписала
      // другая вкладка — реконнект молча ушёл бы в её партию.
      this.stats.sidSwitches++
      console.warn(
        `[net] sid сменился подо мной: ${this.sessionSid} → ${sid}. ` +
          'Реконнект уйдёт в чужую партию. Параллельные вкладки: ' +
          `sessionStorage.setItem('${SID_KEY}', '<уникальный sid>').`,
      )
    }
    this.sessionSid = sid
    const urlSid = encodeURIComponent(sid)
    // Отладочные параметры страницы (ITGAME-26) пробрасываются в WS:
    // ?seed= задаёт сид НОВОЙ партии, ?scenario= — её фиксуру. Сервер
    // применяет их только к новой партии: живой сейв важнее параметров.
    const page = new URLSearchParams(location.search)
    const extra = new URLSearchParams()
    const seed = page.get('seed')
    const scenario = page.get('scenario')
    if (seed) extra.set('seed', seed)
    if (scenario) extra.set('scenario', scenario)
    const qs = extra.toString()
    this.ws = new WebSocket(
      `${proto}://${location.host}/ws?difficulty=${this.difficulty}&sid=${urlSid}${qs ? `&${qs}` : ''}`,
    )
    // События сокета, который уже заменён (suspend/resume из bfcache), —
    // не наши: запоздалый close старого сокета запустил бы реконнект и
    // войну session_taken с новым.
    const ws = this.ws
    const seq = ++this.socketSeq
    this.firstOfSocket = true
    this.ws.onmessage = (ev) => {
      if (ws !== this.ws) return
      // ITGAME-76: сокет в уходе — сервера «не видим», даже то, что уже летело
      if (this.awayState?.ws === ws) return
      this.stats.messages++
      this.stats.lastMessageAt = Date.now()
      if (this.commandSentAt !== null) {
        this.stats.rtt = Date.now() - this.commandSentAt
        this.commandSentAt = null
      }
      let msg: ServerMessage
      try {
        msg = JSON.parse(ev.data as string) as ServerMessage
      } catch {
        console.error('битое сообщение от сервера', ev.data)
        return
      }
      this.logWire('in', msg.type, msg as unknown as Record<string, unknown>)
      if (msg.type === 'state') {
        // квитанция команды (ITGAME-45): успех — state с re = id команды; тики
        // и снапшоты чужих команд (агент /ws/agent) квитанций не трогают
        if (typeof msg.re === 'number') this.settleReceipt(msg.re, { ok: true, id: msg.re, rev: msg.rev })
        else if (typeof msg.rev !== 'number') this.settleOldest({ ok: true }) // сервер без rev — старый FIFO
        // соединение живое: банк экспоненты сброс
        this.reconnectAttempt = 0
        // ITGAME-54: «Продолжить» на сейве, которого у сервера уже нет, стартует
        // НОВУЮ партию под тем же sid (resumed: false в первом снапшоте сокета) —
        // клиентское состояние прошлой партии вкладки (активный офис) не её.
        // Только первый снапшот сокета: дальше resumed всегда false (в т.ч. пуш отладки).
        if (this.firstOfSocket) {
          this.firstOfSocket = false
          if (!msg.resumed) resetForNewGame()
        }
        // incompatible — событие, не состояние (ITGAME-224): хранимая копия latest его не несёт,
        // иначе HUD, пересозданный до следующего снапшота, и reemit отладки (btn.debug,
        // itd.restore) открыли бы окно «Сейв несовместим» повторно; окну — onIncompatible.
        this.latest = msg.incompatible ? { ...msg, incompatible: false } : msg
        this.stateSocket = seq
        this.listeners.forEach((l) => l.onState(msg))
        if (msg.incompatible) this.deliverIncompatible()
        this.checkStateWaiters(msg)
      } else if (msg.type === 'error') {
        // error = отказ сервера: код уходит квитанции по re, слушателям — как раньше
        if (typeof msg.re === 'number') this.settleReceipt(msg.re, { ok: false, code: msg.code, id: msg.re, rev: msg.rev })
        else if (typeof msg.rev !== 'number') this.settleOldest({ ok: false, code: msg.code })
        this.listeners.forEach((l) => l.onError(msg.code))
      } else if (msg.type === 'day_report') {
        this.deliver(msg)
      } else if (msg.type === 'game_over') {
        // финал: сейв на сервере удалён, «Продолжить» ни к чему
        clearSession()
        this.deliver(msg)
      } else if (msg.type === 'victory') {
        // финал: сейв на сервере удалён, «Продолжить» ни к чему
        clearSession()
        this.deliver(msg)
      } else if (msg.type === 'offline_report') {
        if (msg.gameOver || msg.victory) clearSession()
        const left = readLeft()
        const droppedAt = typeof msg.savedAt === 'number' && msg.savedAt > 0 ? msg.savedAt : null
        this.lastOffline = {
          ticks: msg.ticks, days: msg.days, shown: offlineShown(msg), at: Date.now(),
          droppedAt, leftAt: left?.at ?? null,
          // сейв раньше ухода — сервер заметил в пределах тика: вживую 0
          liveTicks: left && droppedAt !== null ? Math.max(0, Math.round(((droppedAt - left.at) / 1000) * left.speed)) : null,
        }
        this.deliver(msg)
      } else {
        console.error('неизвестный тип сообщения от сервера', msg)
      }
      for (const fn of [...this.msgWaiters]) fn(msg.type, seq)
    }
    // onerror и onclose могут прийти оба — реакция одна, ровно один раз.
    let handled = false
    const onGone = (ev: CloseEvent | null) => {
      if (ws !== this.ws || this.intentionalClose || handled) return
      handled = true
      // ITGAME-76: сокет закрыл сам away (close) или сервер, заметив обрыв (net), —
      // не реконнектимся до конца ухода, слушателям ничего не сообщаем
      if (this.awayState?.ws === ws) return
      this.failReceipts('disconnected')
      const reason = ev?.reason ?? ''
      if (reason.includes('session_taken')) {
        // Другая вкладка забрала сессию: реконнект устроит войну вкладок.
        this.takenOver = true
        this.sessionSid = null
        this.listeners.forEach((l) => l.onDisconnect('session_taken'))

        return
      }
      this.scheduleReconnect()
    }
    this.ws.onclose = (ev) => onGone(ev)
    this.ws.onerror = () => onGone(null)
  }

  // Экспоненциальная пауза 1..15с: деплой поднимает сервер за секунды,
  // но и долгий простой не должен сдаваться.
  private scheduleReconnect(): void {
    this.reconnectAttempt++
    this.stats.reconnects++
    const delay = Math.min(1000 * 2 ** (this.reconnectAttempt - 1), 15_000)
    this.listeners.forEach((l) => l.onReconnecting?.(this.reconnectAttempt))
    this.reconnectTimer = setTimeout(() => this.openSocket(), delay)
  }

  // Намеренный разрыв: onDisconnect не дёргаем, реконнект не планируем.
  disconnect(): void {
    this.intentionalClose = true
    this.awayState = null // выход в меню отменяет уход (away вернёт interrupted)
    this.pending = []
    this.incompatibleDue = false
    this.sessionSid = null
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.failReceipts('disconnected')
    this.ws.close()
    this.latest = null
  }

  // Кэш «назад/вперёд» (ITGAME-19): Chrome кладёт ушедшую страницу в bfcache
  // вместе с открытым WebSocket — сервер разрыва не видит, партия тикает
  // онлайн без игрока и молча гибнет (сейв удалён финалом, замороженная
  // страница ключ не стёрла — меню не знает, что случилось). На pagehide
  // закрываем сокет сами: актор встаёт, пропущенное посчитает офлайн-догон
  // с отчётом «пока вас не было»; на pageshow из кэша — подключаемся снова.
  private suspended = false

  suspend(): void {
    if (!this.ws || this.intentionalClose || this.takenOver) return
    this.awayState = null // bfcache сам ведёт сокет: уход прерван
    this.suspended = true
    this.intentionalClose = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.failReceipts('disconnected')
    this.ws.close()
  }

  resume(): void {
    if (!this.suspended) return
    this.suspended = false
    this.intentionalClose = false
    this.openSocket()
  }

  // Все ждущие квитанции — отказ с кодом (сокет ушёл: висеть им нельзя).
  private failReceipts(code: TransportErrorCode): void {
    const all = [...this.receipts]
    this.receipts.clear()
    for (const [id, settle] of all) settle({ ok: false, code, id })
  }

  private settleReceipt(id: number, r: Receipt): void {
    const settle = this.receipts.get(id)
    if (!settle) return // команда без квитанции (send) или уже по таймауту
    this.receipts.delete(id)
    settle(r)
  }

  private settleOldest(r: Receipt): void {
    const first = this.receipts.entries().next()
    if (first.done) return
    const [id, settle] = first.value
    this.receipts.delete(id)
    settle({ ...r, id })
  }

  private checkStateWaiters(s: StateMessage): void {
    for (const fn of [...this.stateWaiters]) {
      try {
        fn(s)
      } catch (e) {
        console.error('[net] waitState', e)
      }
    }
  }

  // Сдаться: удалить сейв на сервере и забыть сессию локально.
  abandon(): void {
    this.sessionSid = null // смена sid здесь запланирована
    if (this.ws.readyState === WebSocket.OPEN && !this.awayState) {
      this.ws.send(JSON.stringify({ type: 'abandon' }))
      this.logWire('out', 'abandon', { type: 'abandon' })
    }
    clearSession()
    this.disconnect()
  }

  get sessionTakenOver(): boolean {
    return this.takenOver
  }

  send(cmd: CommandType, office = 0, extra: Record<string, number> = {}): boolean {
    // Соединение ещё не открыто или уже потеряно — команду безопасно игнорируем,
    // сервер всё равно источник истины. Возвращаем факт отправки: вызывающий
    // (itd.pause(), itd.cmd) обязан отличить «отправлено» от тихого no-op.
    // Не ушла — слушатели узнают (ITGAME-90): клик без связи не должен молчать.
    if (this.sendCmd(cmd, office, extra) > 0) return true
    this.listeners.forEach((l) => l.onNotConnected?.(cmd))
    return false
  }

  // Отправка с номером (ITGAME-45): каждая команда уходит с id — его видят
  // itd.net()/itd.trace() и сервер вернёт его как re. 0 — сокет не открыт.
  private sendCmd(cmd: CommandType, office: number, extra: Record<string, number>): number {
    if (this.ws?.readyState !== WebSocket.OPEN || this.awayState) return 0
    this.commandSentAt = Date.now()
    if (cmd === 'set_speed') {
      this.speedSeq++
    }
    const id = ++this.nextCmdId
    const msg = { type: cmd, office, ...extra, id } // id последним: extra его не перебьёт
    this.ws.send(JSON.stringify(msg))
    this.logWire('out', cmd, msg)
    return id
  }

  // Команда с квитанцией сервера (ITGAME-30/45): Promise<Receipt>.
  // Успех — state с re = id этой команды, отказ — error с re и кодом сервера
  // (no_free_pc, not_enough_money, …). Тики и чужие команды квитанцию не
  // закрывают. Сокет не открыт — честный {ok:false, code:'not_connected'}
  // сразу; ответа нет за timeoutMs — {ok:false, code:'receipt_timeout'}.
  sendWithReceipt(
    cmd: CommandType,
    office = 0,
    extra: Record<string, number> = {},
    timeoutMs = 5000,
  ): Promise<Receipt> {
    if (this.ws?.readyState !== WebSocket.OPEN || this.awayState) {
      return Promise.resolve({ ok: false, code: 'not_connected' })
    }
    return new Promise((resolve) => {
      const id = this.nextCmdId + 1 // sendCmd возьмёт ровно его: регистрация ДО отправки
      const timer = setTimeout(() => {
        this.receipts.delete(id)
        resolve({ ok: false, code: 'receipt_timeout', id })
      }, timeoutMs)
      this.receipts.set(id, (r) => {
        clearTimeout(timer)
        resolve(r)
      })
      this.sendCmd(cmd, office, extra)
    })
  }

  // Дождаться снапшота (ITGAME-45): первый state, для которого pred — true,
  // начиная с текущего client.latest; null — не дождались за timeoutMs. Без
  // поллинга: проверка на каждом пришедшем state. Для «state.rev ≥ N» —
  // waitRev(N). rev — версия сессии: новая партия под тем же sid (cause start)
  // начинает с 1.
  waitState(pred: (s: StateMessage) => boolean, timeoutMs = 5000): Promise<StateMessage | null> {
    if (this.latest && pred(this.latest)) return Promise.resolve(this.latest)
    return new Promise((resolve) => {
      const done = (v: StateMessage | null) => {
        clearTimeout(timer)
        this.stateWaiters.delete(check)
        resolve(v)
      }
      const check = (s: StateMessage) => {
        if (pred(s)) done(s)
      }
      const timer = setTimeout(() => done(null), timeoutMs)
      this.stateWaiters.add(check)
    })
  }

  waitRev(rev: number, timeoutMs = 5000): Promise<StateMessage | null> {
    return this.waitState((s) => s.rev >= rev, timeoutMs)
  }

  // Сообщение типа type от сокета seq; false — не пришло за timeoutMs. Без
  // поллинга: проверка на каждом входящем. cancel — снять ожидание раньше.
  private waitSocketMessage(seq: number, type: string, timeoutMs: number): { done: Promise<boolean>; cancel: () => void } {
    let finish: (v: boolean) => void = () => {}
    const done = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => finish(false), timeoutMs)
      const check = (t: string, s: number) => {
        if (t === type && s === seq) finish(true)
      }
      finish = (v) => {
        clearTimeout(timer)
        this.msgWaiters.delete(check)
        resolve(v)
      }
      this.msgWaiters.add(check)
    })
    return { done, cancel: () => finish(false) }
  }

  // Уход без ухода со страницы (ITGAME-76, itd.away): на ms миллисекунд вкладка
  // «пропадает» для сервера и возвращается в ту же партию (тот же sid —
  // песочницы или владельца). close — close-фрейм без exit, как закрытая
  // вкладка: сервер узнаёт сразу. net — POST /api/debug/drop (ITGAME_DEBUG):
  // сервер перестаёт читать и писать в соединение без close-фрейма и замечает
  // уход своим таймаутом чтения (timeoutMs укорачивает его для этого
  // соединения), партия до этого идёт вживую. Всё время ухода клиент глух и нем:
  // входящее выбрасывает, команды не шлёт (not_connected), сам не реконнектится.
  // Возврат — первый снапшот нового сокета (waitState), а если он помечен
  // offlineReport — ещё и offline_report следом: itd.offline() уже про этот уход.
  async away(ms: number, mode: AwayMode, opts: { timeoutMs?: number } = {}): Promise<AwayReturn> {
    const result = (r: Partial<AwayReturn> & { ok: boolean }): AwayReturn => ({
      mode, sid: this.sessionSid, leftAt: null, back: null, resumed: null, incompatible: null, rev: null, drop: null, ...r,
    })
    const forgetLeft = () => {
      sessionStore.remove(LEFT_KEY)
    }
    if (this.awayState) return result({ ok: false, code: 'already_away', error: 'уход уже идёт' })
    const sid = this.sessionSid
    const latest = this.latest
    if (!latest || sid === null || this.socketStatus() !== 'open') {
      return result({ ok: false, code: 'not_connected', error: 'сокет не открыт — уходить неоткуда' })
    }
    if (latest.phase === 'game_over' || latest.phase === 'won') {
      return result({ ok: false, code: 'finished', error: 'партия окончена: сейва нет, возврат начал бы новую' })
    }
    const ws = this.ws
    const mine = { mode, ws }
    this.awayState = mine
    this.failReceipts('disconnected')
    const leftAt = Date.now()
    // как pagehide: offline() разделит «шло вживую, пока сервер не заметил» и догон
    sessionStore.set(LEFT_KEY, JSON.stringify({ at: leftAt, speed: latest.speed }))
    let drop: AwayDrop | null = null
    if (mode === 'close') {
      ws.close(1000, 'away')
    } else {
      const q = new URLSearchParams({ sid })
      if (opts.timeoutMs !== undefined) q.set('timeout', String(Math.round(opts.timeoutMs)))
      let error = ''
      try {
        const r = await fetch(`/api/debug/drop?${q}`, { method: 'POST' })
        const body = (await r.json().catch(() => ({}))) as Partial<AwayDrop> & { error?: string }
        if (r.ok) drop = { at: body.at ?? leftAt, timeoutMs: body.timeoutMs ?? 0, noticeBy: body.noticeBy ?? 0 }
        else error = `drop ${r.status}: ${body.error ?? 'нет ответа'}${r.status === 404 && !body.error ? ' (сервер без ITGAME_DEBUG=1?)' : ''}`
      } catch (e) {
        error = `drop: ${e instanceof Error ? e.message : String(e)}`
      }
      if (!drop) {
        // сервер не оборвал — вкладка остаётся на живом сокете
        if (this.awayState === mine) this.awayState = null
        forgetLeft()
        return result({ ok: false, code: 'drop_failed', error, leftAt })
      }
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, leftAt + ms - Date.now())))
    if (this.awayState !== mine) {
      forgetLeft()
      return result({ ok: false, code: 'interrupted', error: 'за время ухода вкладка ушла в меню или новую партию', leftAt, drop })
    }
    this.awayState = null
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.reconnectAttempt = 0
    this.openSocket()
    const seq = this.socketSeq
    // offline_report идёт следом за первым снапшотом — ожидание ставим ДО него
    const offline = this.waitSocketMessage(seq, 'offline_report', 15_000)
    const first = await this.waitState(() => this.stateSocket === seq, 15_000)
    const back = Date.now()
    if (first?.offlineReport) await offline.done
    else offline.cancel()
    // net: старый сокет сервер закрыл сам, если заметил уход; иначе — его уже
    // выселил новый (Begin) — закрываем свою сторону (события его не наши)
    try { if (ws.readyState !== WebSocket.CLOSED) ws.close() } catch { /* уже закрыт */ }
    forgetLeft() // не съеденная offline_report-ом метка не должна лечь на чужой уход
    if (!first) return result({ ok: false, code: 'no_return', error: 'первого снапшота нового сокета нет за 15 с', leftAt, drop })
    // Новая партия — либо сейва нет, либо он чужого формата (ITGAME-224): у второго своя причина.
    const incompatible = first.incompatible === true
    const why = incompatible ? 'сейв под этим sid другого формата — несовместим' : 'сейва под этим sid нет'
    return result({
      ok: first.resumed, ...(first.resumed ? {} : { code: 'not_resumed' as const, error: `сервер начал новую партию: ${why}` }),
      leftAt, back, resumed: first.resumed, incompatible, rev: first.rev, drop,
    })
  }

  // Повторно раздаёт последний снапшот — перерисовка сцен без сервера
  // (debug-тумблер меняет только клиентское состояние).
  // Разовые сообщения без адресата (ITGAME-19): отчёт дня, финал и «пока вас
  // не было» сервер шлёт сразу после подключения, а HUD подписывается, только
  // когда Phaser создаст сцену. Сокет быстрее кадра — и «Итог партии» из меню
  // открывал игру без экрана итога. Неполученное ждёт первого подписчика с
  // нужным обработчиком; новая партия и выход в меню очищают очередь.
  // Наблюдатели (observer: телеметрия itd) доставкой не считаются: иначе
  // dev-сборка и ?debug=1 снова теряли экран итога.
  private pending: OneShotMessage[] = []

  private deliver(msg: OneShotMessage): void {
    let shown = false
    for (const l of this.listeners) {
      const h = oneShotHandler(l, msg)
      if (h) {
        h()
        if (!l.observer) shown = true
      }
    }
    if (!shown) this.pending.push(msg)
  }

  reemit(): void {
    if (this.latest) this.listeners.forEach((l) => l.onState(this.latest!))
  }

  // Окно «Сейв несовместим» (ITGAME-174/224) — как разовые сообщения выше: наблюдатели доставкой
  // не считаются, без адресата событие ждёт первого подписчика с onIncompatible.
  private incompatibleDue = false

  private deliverIncompatible(): void {
    let shown = false
    for (const l of this.listeners) {
      if (!l.onIncompatible) continue
      l.onIncompatible()
      if (!l.observer) shown = true
    }
    this.incompatibleDue = !shown
  }

  // sid сокета, которым живёт текущая партия (ITGAME-64). После финала хранилища уже
  // пусты (clearSession), а сессия на сервере жива до «В меню» (ITGAME-51).
  liveSid(): string | null {
    return this.sessionSid
  }

  // ITGAME-64: debug-scenario после финала оживляет партию под sid сокета — вернуть его в
  // зеркало вкладки, чтобы реконнект и «Продолжить» пришли в пересозданную партию, а не в
  // свежий sid. sessionStorage пишем первым: sessionId() тогда вернёт его с origin 'session',
  // и persistSid() заполнит только вкладочное зеркало, не общий ключ localStorage.
  readoptSid(): void {
    const sid = this.sessionSid
    if (sid === null || sessionStore.get(SID_KEY) !== null) return
    sessionStore.set(SID_KEY, sid)
    persistSid()
  }

  // Возвращает функцию отписки — сцены зовут её на shutdown.
  subscribe(l: Listener): () => void {
    this.listeners.push(l)
    if (this.latest) l.onState(this.latest)
    // Наблюдатели очередь не разбирают: они её уже видели при доставке.
    if (!l.observer) {
      const rest: OneShotMessage[] = []
      for (const m of this.pending) {
        const h = oneShotHandler(l, m)
        if (h) h()
        else rest.push(m)
      }
      this.pending = rest
      if (this.incompatibleDue && l.onIncompatible) {
        this.incompatibleDue = false
        l.onIncompatible()
      }
    }
    return () => {
      this.listeners = this.listeners.filter((x) => x !== l)
    }
  }
}

export const client = new GameClient()
