// Зеркало server/internal/ws/protocol.go — менять синхронно.

export interface EmployeeInfo {
  name: string
  incomePerTick: number
  connected: boolean
  unpaidToday: boolean
}

export interface OfficeInfo {
  unlocked: boolean
  price: number
  pcs: number
  routerTier: number
  ports: number
  nextRouter: number
  boss: string
  bossUnpaidToday: boolean
  employees: EmployeeInfo[]
}

export interface StateMessage {
  type: 'state'
  money: number
  offices: OfficeInfo[]
  servers: number
  gateway: boolean
  multiplier: number
  incomePerTick: number
  day: number
  clock: string
  isLunch: boolean
  ticksPerHour: number
  payrollPerDay: number
  salaryPerDay: number
  bossSalaryPerDay: number
  forecastEndOfDay: number
  staffLimit: number
  officeSlots: number
  phase: 'running' | 'day_report' | 'game_over'
  rackSlots: number
  prices: { pc: number; hire: number; server: number; boss: number; gateway: number }
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
  gatewayOpex: number
}

export interface GameOverMessage {
  type: 'game_over'
  daysSurvived: number
  peakIncomePerTick: number
  balance: number
}

export type ServerMessage = StateMessage | ErrorMessage | DayReportMessage | GameOverMessage

export type CommandType =
  | 'buy_pc' | 'hire' | 'buy_router' | 'hire_boss' | 'buy_office'
  | 'buy_server' | 'buy_gateway' | 'next_day' | 'restart'
