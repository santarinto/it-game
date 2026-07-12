// Зеркало server/internal/ws/protocol.go — менять синхронно.

export interface EmployeeInfo {
  name: string
  incomePerTick: number
  connected: boolean
}

export interface StateMessage {
  type: 'state'
  money: number
  pcs: number
  routerTier: number
  ports: number
  servers: number
  multiplier: number
  incomePerTick: number
  employees: EmployeeInfo[]
  day: number
  dayTicks: number
  dayProgress: number
  clock: string
  isLunch: boolean
  ticksPerHour: number
  payrollPerDay: number
  salaryPerDay: number
  forecastEndOfDay: number
  staffLimit: number
  phase: 'running' | 'day_report' | 'game_over'
  officeSlots: number
  rackSlots: number
  prices: { pc: number; hire: number; server: number; nextRouter: number }
}

export interface ErrorMessage {
  type: 'error'
  code: string
}

export interface DayReportMessage {
  type: 'day_report'
  day: number
  income: number
  payroll: number
  profit: number
  balance: number
}

export interface GameOverMessage {
  type: 'game_over'
  daysSurvived: number
  peakIncomePerTick: number
  balance: number
}

export type ServerMessage = StateMessage | ErrorMessage | DayReportMessage | GameOverMessage

export type CommandType = 'buy_pc' | 'hire' | 'buy_router' | 'buy_server' | 'next_day' | 'restart'
