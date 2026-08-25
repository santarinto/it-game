// Зеркало server/internal/ws/protocol.go — менять синхронно.

export interface EffectInfo {
  token: 'thirst' | 'hunger' | 'coffee' | 'motivated' | 'offended'
  percent: number
  until: string // «HH:MM»; '' — до конца дня
}

export type DifficultyId = 'easy' | 'normal' | 'hard' | 'hardcore'

export interface ServerInfo {
  slot: number // 0-based индекс стойки
  level: number
  mult: number
  nextPrice: number // 0 — уровень максимальный
  maxed: boolean
  servedFrom: number // обслуживаемые работники офиса, 1-based
  servedTo: number
}

export interface CoreInfo {
  level: number // 0 — не куплен
  capacity: number
  connected: number // занято мест по компании
  mult: number // 1.1 на финальном уровне, иначе 1.0
  nextPrice: number
  maxed: boolean
}

export interface EmployeeInfo {
  name: string
  incomePerTick: number
  // Личная выработка с учётом активных эффектов (без сетевого множителя).
  effectiveIncomePerTick: number
  connected: boolean // получил место в ёмкости core
  unpaidToday: boolean
  effects: EffectInfo[]
  netMult: number
  serverSlot: number // 1-based сервер; 0 — без сервера
  // Видимость сети (итерация 11): причина отсутствия сетевого бонуса.
  offlineReason: '' | 'no_router' | 'no_core' | 'no_server'
  // Активный день (итерация 9).
  pcBroken: boolean // ПК сломан: доход места 0 до починки
  repairClicks: number // клики починки уже сделаны
  motivateReadyAt: string // «HH:MM» клика возможен; '' — уже можно
  // Unseen Forces (итерация 10).
  salary: number // дневная зарплата этого сотрудника с надбавками
}

export interface OfficeInfo {
  unlocked: boolean
  price: number
  pcs: number
  routerTier: number
  ports: number
  nextRouter: number
  nextPorts: number // порты следующего тира; 0 — тир максимальный
  boss: string
  bossUnpaidToday: boolean
  employees: EmployeeInfo[]
  cooler: boolean
  fridge: boolean
  coffeeMachine: boolean
  virusUntil: string // вирус: «HH:MM»; '' — нет
  servers: ServerInfo[]
  serverSlots: number
}

export interface ActiveEventInfo {
  id: 'virus' | 'deadline' | 'audit' | 'raise' | 'star'
  title: string
  text: string
  options: string[] // индекс опции уходит в event_choice (slot)
}

export interface StateMessage {
  type: 'state'
  money: number
  offices: OfficeInfo[]
  gateway: boolean
  core: CoreInfo
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
  phase: 'running' | 'day_report' | 'game_over' | 'won'
  speed: number // темп сессии: 0 — пауза, 1..3
  difficulty: DifficultyId
  winTarget: number // цель победы, $
  activeEvent: ActiveEventInfo | null // висящее событие Unseen Forces
  prices: {
    pc: number
    hire: number
    boss: number
    gateway: number
    cooler: number
    fridge: number
    coffeeMachine: number
    repair: number // «вызвать мастера» для сломанного ПК
    serverLevels: { mult: number; price: number }[]
    coreLevels: { capacity: number; price: number; mult: number }[]
  }
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
  incidents: number // поломок ПК за день
  lostIncome: number // упущено из-за поломок, $
  events: string[] // события дня: по строке на итог
}

export interface GameOverMessage {
  type: 'game_over'
  daysSurvived: number
  peakIncomePerTick: number
  balance: number
}

export interface VictoryMessage {
  type: 'victory'
  difficulty: DifficultyId
  day: number
  balance: number
}

export type ServerMessage = StateMessage | ErrorMessage | DayReportMessage | GameOverMessage | VictoryMessage

export type CommandType =
  | 'buy_pc' | 'hire' | 'buy_router' | 'hire_boss' | 'buy_office'
  | 'buy_server' | 'buy_gateway' | 'next_day' | 'restart'
  | 'buy_cooler' | 'buy_fridge' | 'buy_coffee' | 'set_speed'
  | 'upgrade_server' | 'upgrade_core'
  | 'motivate' | 'repair_click' | 'call_master' | 'event_choice'
