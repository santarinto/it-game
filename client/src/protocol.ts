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
  repairClicks: number // клики починки уже сделаны (k из «k/N»)
  repairNeeded: number // N кликов этой поломки, 3..15 (ITGAME-93); 0 — ПК цел
  motivateReadyAt: string // «HH:MM» клика возможен; '' — уже можно
  // Вирус (ITGAME-103): заражение места и чистка «k/3».
  infected: boolean
  virusClicks: number // клики чистки уже сделаны (k)
  virusNeeded: number // кликов на чистку (3); 0 — место здорово
  avCovered: boolean // место под подпиской на антивирус: не заражается (ITGAME-137)
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
  // Админ офиса (ITGAME-101): не сотрудник — места не занимает.
  admin: string // '' — админа нет
  adminUnpaidToday: boolean
  adminSlot: number // место, по которому его следующий клик; -1 — свободен или админа нет
  adminKind: 'repair' | 'virus' | '' // что он там делает
  adminFirePrice: number // компенсация увольнения; 0 — админа нет
  employees: EmployeeInfo[]
  cooler: boolean
  fridge: boolean
  coffeeMachine: boolean
  virusPCs: number // заражённых мест офиса (ITGAME-103)
  servers: ServerInfo[]
  serverSlots: number
}

export interface ActiveEventInfo {
  id: 'virus' | 'deadline' | 'audit' | 'raise' | 'star'
  title: string
  text: string
  options: string[] // индекс опции уходит в event_choice (slot)
}

// Почему разослан снапшот (ITGAME-45): тик, команда, отладка (/api/debug/*,
// debug_* моста), первый снапшот сессии — новой партии (start) или из сейва
// (resume). Зеркало stateCause("…") в server/internal/ws/protocol.go —
// scripts/gen-contract.mjs сверяет списки.
export const STATE_CAUSES = ['tick', 'cmd', 'debug', 'start', 'resume'] as const

export type StateCause = (typeof STATE_CAUSES)[number]

export interface StateMessage {
  type: 'state'
  // Версия состояния сессии (ITGAME-45): +1 на каждый разосланный снапшот,
  // переживает resume через сейв; новая партия под тем же sid (cause start)
  // начинает с 1. Копия без изменений (первый снапшот наблюдателя, GET
  // /api/debug/state) несёт текущие rev и cause.
  rev: number
  cause: StateCause
  re?: number // id команды ЭТОГО соединения, породившей снапшот; у других соединений нет
  money: number
  offices: OfficeInfo[]
  gateway: boolean
  adminDept: boolean // отдел админов куплен (ITGAME-101): без него админов не нанять
  core: CoreInfo
  incomePerTick: number
  day: number
  clock: string
  isLunch: boolean
  ticksPerHour: number
  payrollPerDay: number
  salaryPerDay: number
  bossSalaryPerDay: number
  adminSalaryPerDay: number // зарплата админа офиса (ITGAME-101)
  forecastEndOfDay: number
  staffLimit: number
  officeSlots: number
  phase: 'running' | 'day_report' | 'game_over' | 'won'
  speed: number // темп сессии: 0 — пауза, 1..3
  resumed: boolean // снапшот восстановленной сессии (ITGAME-8)
  offlineReport?: boolean // первый снапшот после resume: следом идёт offline_report (ITGAME-76)
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
  debtLimit: number // порог долга, $: глубже — вечер банкротит; creditLimit или, без кредита, payrollPerDay (овердрафт, ITGAME-156)
  bankruptInDays: number // обречённая партия: банкротство через N закрытий дня, 0 — нет (ITGAME-118)
  virusWaveAt: string // «HH:MM», с которого видна следующая волна вируса; '' — заражённых нет (ITGAME-103)
  antivirus: AntivirusInfo // подписка на антивирус (ITGAME-137)
  activeEvent: ActiveEventInfo | null // висящее событие Unseen Forces
  // Итоги событий текущего дня «HH:MM текст» (ITGAME-163): те же строки, что придут в
  // dayReport.events, но вживую — лента HUD кладёт строку, когда событие случилось.
  dayLog: string[]
  prices: {
    pc: number
    hire: number
    boss: number
    admin: number // найм админа офиса (ITGAME-101)
    adminDept: number // покупка отдела админов
    gateway: number
    cooler: number
    fridge: number
    coffeeMachine: number
    repair: number // «вызвать мастера» для сломанного ПК
    serverLevels: { mult: number; price: number }[]
    coreLevels: { capacity: number; price: number; mult: number }[]
    antivirusTiers: { name: string; seats: number; price: number }[] // по возрастанию цены; seats 0 — все места (ITGAME-137)
  }
}

// Подписка на антивирус (ITGAME-137): одна на компанию, защищает первые seats
// мест в порядке core, вечером списывается самый дорогой тариф дня.
export interface AntivirusInfo {
  tier: number // 0 — нет, 1..3 — prices.antivirusTiers[tier - 1]
  name: string // '' — нет
  seats: number // мест в тарифе; 0 — все
  covered: number // мест под защитой сейчас
  billedToday: number // спишется вечером, $
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
  'not_infected',
  'no_event',
  'bad_option',
  'need_cooler',
  'bad_tier',
  'antivirus_already',
  'admin_already',
  'no_admin',
  'admin_dept_already',
  'admin_dept_locked',
  'unknown_command',
  'bad_speed',
] as const

export type ServerErrorCode = (typeof SERVER_ERROR_CODES)[number]

export interface ErrorMessage {
  type: 'error'
  code: ServerErrorCode
  re?: number // id отклонённой команды (ITGAME-45); нет — команда без id
  rev: number // версия состояния, при которой сервер отказал (отказ её не меняет)
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
  antivirus: number // подписка на антивирус за день (ITGAME-137)
  incidents: number // поломок ПК за день
  lostIncome: number // упущено из-за поломок, $
  virusPCs: number // новых заражений за день (ITGAME-103)
  virusLost: number // упущено из-за вируса, $
  adminRepairs: number // ПК, починенных админами за день (ITGAME-101)
  adminCleaned: number // мест, вычищенных админами за день
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
  // ITGAME-140/169: version — сборка сервера ('' — без версии), для людей; сейв другого
  // формата — exists false, incompatible true, saveVersion писавшей его сборки ('' — сейв до ITGAME-140).
  version: string
  incompatible: boolean
  saveVersion: string
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
  'virus_click', 'set_antivirus', 'hire_admin', 'fire_admin', 'buy_admin_dept',
  'abandon', 'exit',
] as const

export type CommandType = (typeof COMMAND_TYPES)[number]
