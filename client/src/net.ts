import type { CommandType, DayReportMessage, DifficultyId, GameOverMessage, OfflineReportMessage, ServerMessage, StateMessage, VictoryMessage } from './protocol'

export interface Listener {
  onState(s: StateMessage): void
  onError(code: string): void
  onDisconnect(reason?: string): void
  // Только HUD показывает отчёты, банкротство и офлайн-итог — для
  // остальных сцен опциональны.
  onDayReport?(r: DayReportMessage): void
  onGameOver?(o: GameOverMessage): void
  onVictory?(v: VictoryMessage): void
  onOfflineReport?(r: OfflineReportMessage): void
  // Реконнект в процессе (деплой рвёт WS): баннер «переподключение».
  onReconnecting?(attempt: number): void
}

const SID_KEY = 'itd.sid'
const DIFF_KEY = 'itd.diff'

// sessionId — ключ сейва на сервере: живёт в localStorage, переживает
// перезагрузку страницы и рестарт сервера (мягкий деплой).
export function sessionId(): string {
  let sid = localStorage.getItem(SID_KEY)
  if (!sid) {
    sid = typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : 'sid-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
    localStorage.setItem(SID_KEY, sid)
  }

  return sid
}

// Есть ли сейв для «Продолжить» в меню (sid + сложность прошлой игры).
export function hasSavedSession(): boolean {
  return localStorage.getItem(SID_KEY) !== null
}

export function savedDifficulty(): DifficultyId {
  return (localStorage.getItem(DIFF_KEY) as DifficultyId) ?? 'normal'
}

// clearSession — сейва больше нет (финал/сдаться): спрятать «Продолжить».
export function clearSession(): void {
  localStorage.removeItem(SID_KEY)
  localStorage.removeItem(DIFF_KEY)
}

// GameClient — единственная точка общения с сервером.
// Сцены подписываются и получают снапшоты; игровой логики здесь нет.
// Разрыв соединения (кроме намеренного и session_taken) лечится
// автопереподключением с тем же sid: сервер восстанавливает прогресс.
export class GameClient {
  latest: StateMessage | null = null
  // Телеметрия сокета для агентского фасада window.itd (ITGAME-24):
  // единственный честный источник — сам клиент, сцены ничего не знают.
  readonly stats = {
    messages: 0, // счётчик принятых сообщений = lastEventId
    reconnects: 0, // сколько раз рвалось и чинилось
    lastMessageAt: 0, // epoch ms последнего сообщения
    rtt: null as number | null, // мс от последней команды до ответа
  }
  // Эфир WS для itd.net(): последние сообщения в обе стороны (ITGAME-25).
  readonly wire: { dir: 'in' | 'out'; at: number; type: string; info: Record<string, unknown> }[] = []
  private commandSentAt: number | null = null
  private ws!: WebSocket
  private listeners: Listener[] = []
  private intentionalClose = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  private takenOver = false
  private difficulty: DifficultyId = 'normal'

  // Статус сокета одним словом — для itd.server() и баннеров.
  socketStatus(): 'open' | 'reconnecting' | 'closed' {
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
    this.wire.push({ dir, at: Date.now(), type, info: brief })
    if (this.wire.length > 100) this.wire.splice(0, this.wire.length - 100)
  }

  connect(difficulty: DifficultyId): void {
    this.latest = null
    this.intentionalClose = false
    this.takenOver = false
    this.difficulty = difficulty
    localStorage.setItem(DIFF_KEY, difficulty)
    this.openSocket()
  }

  private openSocket(): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const sid = encodeURIComponent(sessionId())
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
      `${proto}://${location.host}/ws?difficulty=${this.difficulty}&sid=${sid}${qs ? `&${qs}` : ''}`,
    )
    this.ws.onmessage = (ev) => {
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
        // соединение живое: банк экспоненты сброс
        this.reconnectAttempt = 0
        this.latest = msg
        this.listeners.forEach((l) => l.onState(msg))
      } else if (msg.type === 'error') {
        this.listeners.forEach((l) => l.onError(msg.code))
      } else if (msg.type === 'day_report') {
        this.listeners.forEach((l) => l.onDayReport?.(msg))
      } else if (msg.type === 'game_over') {
        // финал: сейв на сервере удалён, «Продолжить» ни к чему
        clearSession()
        this.listeners.forEach((l) => l.onGameOver?.(msg))
      } else if (msg.type === 'victory') {
        // финал: сейв на сервере удалён, «Продолжить» ни к чему
        clearSession()
        this.listeners.forEach((l) => l.onVictory?.(msg))
      } else if (msg.type === 'offline_report') {
        if (msg.gameOver || msg.victory) clearSession()
        this.listeners.forEach((l) => l.onOfflineReport?.(msg))
      } else {
        console.error('неизвестный тип сообщения от сервера', msg)
      }
    }
    // onerror и onclose могут прийти оба — реакция одна, ровно один раз.
    let handled = false
    const onGone = (ev: CloseEvent | null) => {
      if (this.intentionalClose || handled) return
      handled = true
      const reason = ev?.reason ?? ''
      if (reason.includes('session_taken')) {
        // Другая вкладка забрала сессию: реконнект устроит войну вкладок.
        this.takenOver = true
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
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.ws.close()
    this.latest = null
  }

  // Сдаться: удалить сейв на сервере и забыть сессию локально.
  abandon(): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'abandon' }))
    }
    clearSession()
    this.disconnect()
  }

  get sessionTakenOver(): boolean {
    return this.takenOver
  }

  send(cmd: CommandType, office = 0, extra: Record<string, number> = {}): void {
    // Соединение ещё не открыто или уже потеряно — команду безопасно игнорируем,
    // сервер всё равно источник истины.
    if (this.ws.readyState !== WebSocket.OPEN) return
    this.commandSentAt = Date.now()
    this.ws.send(JSON.stringify({ type: cmd, office, ...extra }))
    this.logWire('out', cmd, { type: cmd, office, ...extra })
  }

  // Повторно раздаёт последний снапшот — перерисовка сцен без сервера
  // (debug-тумблер меняет только клиентское состояние).
  reemit(): void {
    if (this.latest) this.listeners.forEach((l) => l.onState(this.latest!))
  }

  // Возвращает функцию отписки — сцены зовут её на shutdown.
  subscribe(l: Listener): () => void {
    this.listeners.push(l)
    if (this.latest) l.onState(this.latest)
    return () => {
      this.listeners = this.listeners.filter((x) => x !== l)
    }
  }
}

export const client = new GameClient()
