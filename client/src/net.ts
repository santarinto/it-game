import { resetForNewGame } from './party'
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
  // Реконнект в процессе (деплой рвёт WS): баннер «переподключение».
  onReconnecting?(attempt: number): void
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
  const fromSession = sessionStorage.getItem(SID_KEY)
  if (fromSession) {
    memorySid = fromSession
    sidOrigin = 'session'
    return memorySid
  }
  const fromLocal = localStorage.getItem(SID_KEY)
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
  sessionStorage.setItem(SID_KEY, sid)
  sessionStorage.setItem(SID_AUTO_KEY, sid)
  if (sidOrigin !== 'session') localStorage.setItem(SID_KEY, sid)
}

// Новая партия по явному выбору игрока (кнопка сложности, клавиши 1-4):
// если вкладке не выставлен ЯВНЫЙ sid (агентский sessionStorage без нашей
// метки), текущий sid забывается везде — и зеркало, и общий ключ: иначе
// sessionId() молча продолжит чужой сейв из localStorage (волна B: «НОРМА»
// открывала существующую партию). Живой сосед вернёт себе общий ключ гарде,
// а connect() новой партии запишет туда уже свежий sid. Явно выставленный
// sid чтим — на нём держатся агентские прогоны (?seed/?scenario + sid).
export function prepareNewGame(): void {
  const explicit = sessionStorage.getItem(SID_KEY)
  if (explicit !== null && explicit !== sessionStorage.getItem(SID_AUTO_KEY)) return
  const sid = newSid()
  memorySid = sid
  sidOrigin = 'generated'
  sessionStorage.removeItem(SID_KEY)
  sessionStorage.removeItem(SID_AUTO_KEY)
  // Общий ключ сразу ПЕРЕЗАПИСЫВАЕМ на новую партию (S→N), а не удаляем:
  // соседняя живая вкладка увидит запись, а не стирание — гарда общего
  // ключа не вступит в гонку за указатель. Удаление остаётся у финала
  // партии (game_over), где его и возвращает живой сосед.
  localStorage.setItem(SID_KEY, sid)
}

// Есть ли сейв для «Продолжить» в меню: ключ в хранилищах теперь появляется
// только с настоящей партией — «ПРОДОЛЖИТЬ» больше не судит по ключу,
// созданному голым чтением.
export function hasSavedSession(): boolean {
  return sessionStorage.getItem(SID_KEY) !== null || localStorage.getItem(SID_KEY) !== null
}

export function savedDifficulty(): DifficultyId {
  return (localStorage.getItem(DIFF_KEY) as DifficultyId) ?? 'normal'
}

// clearSession — сейва больше нет (финал/сдаться): спрятать «Продолжить».
// Память вкладки тоже забываем: следующее чтение честно создаст новый sid.
export function clearSession(): void {
  memorySid = null
  sidOrigin = null
  partyOrigin = null
  sessionStorage.removeItem(SID_KEY)
  sessionStorage.removeItem(SID_AUTO_KEY)
  sessionStorage.removeItem('itd.speedBeforeReport')
  localStorage.removeItem(SID_KEY)
  localStorage.removeItem(DIFF_KEY)
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
  private broadcastChannel: BroadcastChannel | null = null

  constructor() {
    // Гарда общего ключа (ITGAME-30): чужой game_over в соседней вкладке
    // вытирает ОБЩИЙ localStorage-sid — под ним может жить НАША партия.
    // Пока партия жива (есть снапшот), возвращаем свой ключ на место;
    // finished-вкладке он больше не нужен, войны не возникает.
    window.addEventListener('storage', (ev) => {
      if (ev.key !== SID_KEY || ev.newValue !== null) return
      if (!this.latest || partyOrigin === 'session') return
      const sid = sessionId()
      if (localStorage.getItem(SID_KEY) !== sid) localStorage.setItem(SID_KEY, sid)
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
  // Квитанции команд (ITGAME-30): FIFO — каждый state|error после отправки
  // закрывает ОДНУ самую старую ждущую квитанцию, порядок команд сохраняется.
  private receipts: ((r: { ok: boolean; code?: ServerErrorCode | TransportErrorCode }) => void)[] = []
  // sid, которым живёт ТЕКУЩЕЕ соединение; гарда «sid сменился подо мной».
  // Легитимная смена (новая партия из меню, abandon) сбрасывается в null
  // в connect()/abandon() — предупреждает только незапланированные.
  private sessionSid: string | null = null

  // Статус сокета одним словом — для itd.server() и баннеров.
  socketStatus(): SocketStatus {
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
    } else if (m.type === 'day_report') {
      brief.day = m.day
      brief.profit = m.profit
    } else if (m.type === 'game_over' || m.type === 'victory') {
      brief.day = m.day
      brief.reason = m.reason
    } else if (dir === 'out') {
      brief.office = m.office
      Object.assign(brief, m.speed !== undefined ? { speed: m.speed } : m.slot !== undefined ? { slot: m.slot } : {})
    } else {
      brief.code = m.code
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
    this.intentionalClose = false
    this.takenOver = false
    this.sessionSid = null // смена sid здесь запланирована (новая партия)
    this.difficulty = difficulty
    localStorage.setItem(DIFF_KEY, difficulty)
    // Ключ сессии появляется в хранилищах только здесь — с реальной партией
    // (ITGAME-30): зеркало вкладки (sessionStorage) держит партию против
    // чужого clearSession, общий ключ игрока не затирается вкладочными sid.
    persistSid()
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
    this.firstOfSocket = true
    this.ws.onmessage = (ev) => {
      if (ws !== this.ws) return
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
        // квитанция команды (ITGAME-30): state = успех, закрывает старейшую
        this.receipts.shift()?.({ ok: true })
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
        this.latest = msg
        this.listeners.forEach((l) => l.onState(msg))
      } else if (msg.type === 'error') {
        // error = отказ сервера: код уходит квитанции, слушателям — как раньше
        this.receipts.shift()?.({ ok: false, code: msg.code })
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
        this.deliver(msg)
      } else {
        console.error('неизвестный тип сообщения от сервера', msg)
      }
    }
    // onerror и onclose могут прийти оба — реакция одна, ровно один раз.
    let handled = false
    const onGone = (ev: CloseEvent | null) => {
      if (ws !== this.ws || this.intentionalClose || handled) return
      handled = true
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
    this.pending = []
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
    while (this.receipts.length > 0) this.receipts.shift()?.({ ok: false, code })
  }

  // Сдаться: удалить сейв на сервере и забыть сессию локально.
  abandon(): void {
    this.sessionSid = null // смена sid здесь запланирована
    if (this.ws.readyState === WebSocket.OPEN) {
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
    if (this.ws?.readyState !== WebSocket.OPEN) return false
    this.commandSentAt = Date.now()
    if (cmd === 'set_speed') {
      this.speedSeq++
    }
    this.ws.send(JSON.stringify({ type: cmd, office, ...extra }))
    this.logWire('out', cmd, { type: cmd, office, ...extra })
    return true
  }

  // Команда с квитанцией сервера (ITGAME-30): Promise<{ok, code?}>.
  // Успех — первый state после отправки, отказ — error с кодом сервера
  // (no_free_pc, not_enough_money, …). Квитанции выдаются по порядку команд.
  // Сокет не открыт — честный {ok:false, code:'not_connected'} сразу;
  // ответа нет за timeoutMs — {ok:false, code:'receipt_timeout'}.
  sendWithReceipt(
    cmd: CommandType,
    office = 0,
    extra: Record<string, number> = {},
    timeoutMs = 5000,
  ): Promise<{ ok: boolean; code?: ServerErrorCode | TransportErrorCode }> {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return Promise.resolve({ ok: false, code: 'not_connected' })
    }
    return new Promise((resolve) => {
      const settle = (r: { ok: boolean; code?: ServerErrorCode | TransportErrorCode }) => {
        clearTimeout(timer)
        resolve(r)
      }
      const timer = setTimeout(() => {
        const i = this.receipts.indexOf(settle)
        if (i >= 0) this.receipts.splice(i, 1)
        resolve({ ok: false, code: 'receipt_timeout' })
      }, timeoutMs)
      this.receipts.push(settle)
      this.send(cmd, office, extra)
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
    if (sid === null || sessionStorage.getItem(SID_KEY) !== null) return
    sessionStorage.setItem(SID_KEY, sid)
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
    }
    return () => {
      this.listeners = this.listeners.filter((x) => x !== l)
    }
  }
}

export const client = new GameClient()
