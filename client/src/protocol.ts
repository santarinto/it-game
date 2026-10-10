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
  // Сотрудники 2.0 (итерация 15).
  level: number // 0–3; производный от XP
  xp: number // накопленный опыт
  xpNext: number // до следующего уровня; 0 — потолок
  star: boolean // звезда: золотой бейдж, выработка ×1.5 при найме
  firePrice: number // компенсация увольнения этого сотрудника
  hiredToday: boolean // нанят в текущий день (компенсация ниже)
}

export interface OfficeInfo {
  unlocked: boolean
  price: number
  pcs: number
  nextPC: number // цена следующего ПК офиса (растёт ×1.15); 0 — мест нет
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
  resumed: boolean // снапшот восстановленной сессии (ITGAME-8)
  seed: string // сид RNG партии, десятичная строка (ITGAME-26)
  scenario: string // фикстура старта (ITGAME-26); '' — обычная партия
  tickInDay: number // тик текущего дня (ITGAME-26)
  dayIncome: number // доход, накопленный за текущий день (ITGAME-26)
  dayProfit: number // прибыль дня с прогнозом до вечера, = «Прибыль» отчёта (ITGAME-53)
  difficulty: DifficultyId
  winTarget: number // денежная часть цели, $
  winStaff: number // комбо-цель: сотрудников (0 — нет; сложность 2.0)
  winCore: number // комбо-цель: уровень core (0 — нет)
  winDayLimit: number // дедлайн цели: дней (0 — нет)
  marketToday: number // рынок: % выработки сегодня (0 — нет)
  marketTomorrow: number // завтрашний рынок, виден заранее
  creditLimit: number // кредитный порог, $ (0 — кредита нет)
  creditRatePct: number // процент за день на долг
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

// Коды отказа сервера (ITGAME-39): зеркало server/internal/game/commands.go
// (Err* + ErrUnknownCommand) и server/internal/ws/session.go (bad_speed).
// Источник истины для itd.contract() (типы types.ServerErrorCode) и для
// scripts/gen-contract.mjs, который сверяет этот список с Go по AST.
export const SERVER_ERROR_CODES = [
  'not_enough_money',
  'no_free_office_slot',
  'no_free_pc',
  'no_free_rack_slot',
  'router_maxed',
  'wrong_phase',
  'staff_limit',
  'office_locked',
  'boss_already',
  'offices_maxed',
  'gateway_already',
  'bad_office',
  'equipment_already',
  'bad_slot',
  'server_maxed',
  'core_maxed',
  'motivate_cooldown',
  'not_broken',
  'no_event',
  'bad_option',
  'unknown_command',
  'bad_speed',
] as const

export type ServerErrorCode = (typeof SERVER_ERROR_CODES)[number]

export interface ErrorMessage {
  type: 'error'
  code: ServerErrorCode
}

export interface DayReportMessage {
  type: 'day_report'
  day: number
  income: number
  payroll: number
  eventMoney: number // деньги исходов событий дня, со знаком (ITGAME-53)
  profit: number // доход + деньги событий − ФОТ − опекс
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
  reason: 'bankrupt' | 'time_up' | 'deadlock' // сложность 2.0 / ITGAME-20: тупик
}

export interface VictoryMessage {
  type: 'victory'
  difficulty: DifficultyId
  day: number
  balance: number
}

// «Пока вас не было» (ITGAME-8): итог офлайн-догона после реконнекта.
// gameOver/victory — финал случился офлайн, отдельного сообщения не будет.
export interface OfflineReportMessage {
  type: 'offline_report'
  ticks: number
  days: number
  income: number
  payroll: number
  balance: number
  gameOver: boolean
  victory: boolean
  reason?: 'bankrupt' | 'time_up' | 'deadlock' // причина офлайн-финала
  savedAt?: number // последний сейв перед уходом, epoch ms — когда сервер заметил обрыв
}

// Сводка сейва для стартового экрана (ITGAME-19): отдельный короткий
// коннект /ws?peek=1&sid=… — одно сообщение и закрытие, сессию не захватывает.
// День и баланс — уже после офлайн-догона, как увидит «Продолжить».
export interface SaveSummaryMessage {
  type: 'save_summary'
  exists: boolean // сейв есть (не истёк, не битый)
  alive: boolean // партию можно продолжить
  day: number
  money: number
  difficulty: DifficultyId | ''
  outcome: '' | 'won' | 'lost' // финал, случившийся офлайн
  reason: '' | 'bankrupt' | 'time_up' | 'deadlock'
}

export type ServerMessage =
  | StateMessage | ErrorMessage | DayReportMessage | GameOverMessage | VictoryMessage | OfflineReportMessage

// Команды протокола (ITGAME-39): зеркало game.Command в
// server/internal/game/commands.go (Cmd* consts) плюс set_speed/abandon/exit
// (server/internal/ws/session.go — команды сессии, не игры). Единственный
// список — client/src/debug/agentApi.ts берёт COMMANDS из него же.
export const COMMAND_TYPES = [
  'buy_pc', 'hire', 'buy_router', 'hire_boss', 'buy_office',
  'buy_server', 'buy_gateway', 'next_day', 'restart',
  'buy_cooler', 'buy_fridge', 'buy_coffee', 'set_speed',
  'upgrade_server', 'upgrade_core',
  'motivate', 'repair_click', 'call_master', 'event_choice', 'fire',
  'abandon', 'exit',
] as const

export type CommandType = (typeof COMMAND_TYPES)[number]
