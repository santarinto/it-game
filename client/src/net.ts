import type { CommandType, ServerMessage, StateMessage } from './protocol'

export interface Listener {
  onState(s: StateMessage): void
  onError(code: string): void
  onDisconnect(): void
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
      } else {
        this.listeners.forEach((l) => l.onError(msg.code))
      }
    }
    this.ws.onclose = () => this.listeners.forEach((l) => l.onDisconnect())
  }

  send(cmd: CommandType): void {
    // Соединение ещё не открыто или уже потеряно — команду безопасно игнорируем,
    // сервер всё равно источник истины.
    if (this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({ type: cmd }))
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
