import type { CommandType, DayReportMessage, GameOverMessage, ServerMessage, StateMessage } from './protocol'

export interface Listener {
  onState(s: StateMessage): void
  onError(code: string): void
  onDisconnect(): void
  // Только HUD показывает отчёты и банкротство — для остальных сцен опциональны.
  onDayReport?(r: DayReportMessage): void
  onGameOver?(o: GameOverMessage): void
}

// GameClient — единственная точка общения с сервером.
// Сцены подписываются и получают снапшоты; игровой логики здесь нет.
export class GameClient {
  latest: StateMessage | null = null
  private ws!: WebSocket
  private listeners: Listener[] = []

  connect(): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    this.ws = new WebSocket(`${proto}://${location.host}/ws`)
    this.ws.onmessage = (ev) => {
      let msg: ServerMessage
      try {
        msg = JSON.parse(ev.data as string) as ServerMessage
      } catch {
        console.error('битое сообщение от сервера', ev.data)
        return
      }
      if (msg.type === 'state') {
        this.latest = msg
        this.listeners.forEach((l) => l.onState(msg))
      } else if (msg.type === 'error') {
        this.listeners.forEach((l) => l.onError(msg.code))
      } else if (msg.type === 'day_report') {
        this.listeners.forEach((l) => l.onDayReport?.(msg))
      } else if (msg.type === 'game_over') {
        this.listeners.forEach((l) => l.onGameOver?.(msg))
      } else {
        console.error('неизвестный тип сообщения от сервера', msg)
      }
    }
    // onerror и onclose могут прийти оба — дисконнект сообщаем один раз.
    let disconnected = false
    const fireDisconnect = () => {
      if (disconnected) return
      disconnected = true
      this.listeners.forEach((l) => l.onDisconnect())
    }
    this.ws.onclose = fireDisconnect
    this.ws.onerror = fireDisconnect
  }

  send(cmd: CommandType, office = 0): void {
    // Соединение ещё не открыто или уже потеряно — команду безопасно игнорируем,
    // сервер всё равно источник истины.
    if (this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({ type: cmd, office }))
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
