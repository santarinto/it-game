// Зеркало server/internal/ws/protocol.go — менять синхронно.

export interface StateMessage {
  type: 'state'
  money: number
  pcs: number
  employees: number
  routerTier: number
  ports: number
  connected: number
  servers: number
  multiplier: number
  incomePerTick: number
  officeSlots: number
  rackSlots: number
  prices: { pc: number; hire: number; server: number; nextRouter: number }
}

export interface ErrorMessage {
  type: 'error'
  code: string
}

export type ServerMessage = StateMessage | ErrorMessage

export type CommandType = 'buy_pc' | 'hire' | 'buy_router' | 'buy_server'
