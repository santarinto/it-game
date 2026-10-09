import type { DifficultyId, GameOverMessage, StateMessage, VictoryMessage } from './protocol'

// Мета-прогресс и достижения (ITGAME-10).
// Полностью на клиенте в localStorage, без сервера.

export interface DifficultyStats {
  runs: number
  wins: number
  bankruptcies: number
  timeUps: number
  bestDay: number
  bestWinDay: number | null
  bestBalance: number
}

export interface MetaStats {
  totalRuns: number
  totalWins: number
  totalLosses: number
  peakBalance: number
  peakDay: number
  byDifficulty: Record<DifficultyId, DifficultyStats>
}

export interface AchievementDef {
  id: string
  title: string
  desc: string
  icon: string
}

export interface AchievementState {
  id: string
  unlockedAt: number // timestamp
}

export const ACHIEVEMENTS: AchievementDef[] = [
  {
    id: 'first_hire',
    title: 'Первые кадры',
    desc: 'Нанять первого сотрудника компании',
    icon: '👥',
  },
  {
    id: 'first_day',
    title: 'Первый рабочий день',
    desc: 'Завершить 1-й день и получить отчёт',
    icon: '📅',
  },
  {
    id: 'coffee_break',
    title: 'Кофейная пауза',
    desc: 'Купить кофемашину в офис',
    icon: '☕',
  },
  {
    id: 'star_hunter',
    title: 'Охотник за звёздами',
    desc: 'Нанять сотрудника со статусом «звезда»',
    icon: '⭐',
  },
  {
    id: 'survivor_10',
    title: '10 дней без банкротства',
    desc: 'Продержаться в кресле директора 10 дней',
    icon: '⏳',
  },
  {
    id: 'three_offices',
    title: 'Корпорация',
    desc: 'Открыть все 3 офиса компании',
    icon: '🏢',
  },
  {
    id: 'full_staff',
    title: 'Полный штат',
    desc: 'Нанять всех 36 сотрудников',
    icon: '👔',
  },
  {
    id: 'core_max',
    title: 'Ядро системы',
    desc: 'Прокачать Core-коммутатор до максимума',
    icon: '🎛️',
  },
  {
    id: 'network_36',
    title: '36/36 в сети',
    desc: 'Подключить всех 36 сотрудников к сети',
    icon: '🌐',
  },
  {
    id: 'millionaire',
    title: 'Первый миллион',
    desc: 'Накопить на балансе $1,000,000',
    icon: '💰',
  },
  {
    id: 'clean_win',
    title: 'Победа без аменити',
    desc: 'Одержать победу без кулеров, холодильников и кофе',
    icon: '🛡️',
  },
  {
    id: 'hardcore_win',
    title: 'Хардкорный директор',
    desc: 'Одержать победу на сложности ХАРДКОР',
    icon: '🏆',
  },
]

const STATS_KEY = 'itd.meta_stats'
const ACHIEVEMENTS_KEY = 'itd.meta_achievements'

function defaultDiffStats(): DifficultyStats {
  return {
    runs: 0,
    wins: 0,
    bankruptcies: 0,
    timeUps: 0,
    bestDay: 0,
    bestWinDay: null,
    bestBalance: 0,
  }
}

export function defaultStats(): MetaStats {
  return {
    totalRuns: 0,
    totalWins: 0,
    totalLosses: 0,
    peakBalance: 0,
    peakDay: 0,
    byDifficulty: {
      easy: defaultDiffStats(),
      normal: defaultDiffStats(),
      hard: defaultDiffStats(),
      hardcore: defaultDiffStats(),
    },
  }
}

export function loadStats(): MetaStats {
  try {
    const raw = localStorage.getItem(STATS_KEY)
    if (!raw) return defaultStats()
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaultStats()
    const obj = parsed as Partial<MetaStats>
    const res = defaultStats()
    if (typeof obj.totalRuns === 'number' && Number.isFinite(obj.totalRuns)) res.totalRuns = obj.totalRuns
    if (typeof obj.totalWins === 'number' && Number.isFinite(obj.totalWins)) res.totalWins = obj.totalWins
    if (typeof obj.totalLosses === 'number' && Number.isFinite(obj.totalLosses)) res.totalLosses = obj.totalLosses
    if (typeof obj.peakBalance === 'number' && Number.isFinite(obj.peakBalance)) res.peakBalance = obj.peakBalance
    if (typeof obj.peakDay === 'number' && Number.isFinite(obj.peakDay)) res.peakDay = obj.peakDay

    const diffs: DifficultyId[] = ['easy', 'normal', 'hard', 'hardcore']
    for (const d of diffs) {
      const dObj = obj.byDifficulty?.[d]
      if (dObj && typeof dObj === 'object' && !Array.isArray(dObj)) {
        const target = res.byDifficulty[d]
        if (typeof dObj.runs === 'number' && Number.isFinite(dObj.runs)) target.runs = dObj.runs
        if (typeof dObj.wins === 'number' && Number.isFinite(dObj.wins)) target.wins = dObj.wins
        if (typeof dObj.bankruptcies === 'number' && Number.isFinite(dObj.bankruptcies)) target.bankruptcies = dObj.bankruptcies
        if (typeof dObj.timeUps === 'number' && Number.isFinite(dObj.timeUps)) target.timeUps = dObj.timeUps
        if (typeof dObj.bestDay === 'number' && Number.isFinite(dObj.bestDay)) target.bestDay = dObj.bestDay
        if (typeof dObj.bestWinDay === 'number' && Number.isFinite(dObj.bestWinDay)) target.bestWinDay = dObj.bestWinDay
        if (typeof dObj.bestBalance === 'number' && Number.isFinite(dObj.bestBalance)) target.bestBalance = dObj.bestBalance
      }
    }
    return res
  } catch (e) {
    console.error('Ошибка загрузки статистики мета-прогресса:', e)
    return defaultStats()
  }
}

export function saveStats(stats: MetaStats): void {
  try {
    localStorage.setItem(STATS_KEY, JSON.stringify(stats))
  } catch (e) {
    console.error('Ошибка сохранения статистики мета-прогресса:', e)
  }
}

export function loadAchievements(): Record<string, AchievementState> {
  try {
    const raw = localStorage.getItem(ACHIEVEMENTS_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const res: Record<string, AchievementState> = {}
    for (const def of ACHIEVEMENTS) {
      const st = (parsed as Record<string, unknown>)[def.id]
      if (st && typeof st === 'object' && !Array.isArray(st)) {
        const at = (st as AchievementState).unlockedAt
        if (typeof at === 'number' && Number.isFinite(at)) {
          res[def.id] = { id: def.id, unlockedAt: at }
        }
      }
    }
    return res
  } catch (e) {
    console.error('Ошибка загрузки достижений:', e)
    return {}
  }
}

export function saveAchievements(unlocked: Record<string, AchievementState>): void {
  try {
    localStorage.setItem(ACHIEVEMENTS_KEY, JSON.stringify(unlocked))
  } catch (e) {
    console.error('Ошибка сохранения достижений:', e)
  }
}

export function resetMeta(): void {
  try {
    localStorage.removeItem(STATS_KEY)
    localStorage.removeItem(ACHIEVEMENTS_KEY)
  } catch (e) {
    console.error('Ошибка сброса мета-прогресса:', e)
  }
}

export function getAchievementsSummary(): {
  unlockedCount: number
  totalCount: number
  list: (AchievementDef & { unlocked: boolean; unlockedAt?: number })[]
} {
  const unlocked = loadAchievements()
  const list = ACHIEVEMENTS.map((a) => {
    const st = unlocked[a.id]
    return {
      ...a,
      unlocked: Boolean(st),
      unlockedAt: st?.unlockedAt,
    }
  })
  const unlockedCount = list.filter((a) => a.unlocked).length
  return {
    unlockedCount,
    totalCount: ACHIEVEMENTS.length,
    list,
  }
}

export function unlockAchievement(id: string): AchievementDef | null {
  const def = ACHIEVEMENTS.find((a) => a.id === id)
  if (!def) return null
  const unlocked = loadAchievements()
  if (unlocked[id]) return null // уже получено

  unlocked[id] = { id, unlockedAt: Date.now() }
  saveAchievements(unlocked)
  return def
}

// Проверка достижений по снапшоту игры. Возвращает массив вновь открытых достижений.
export function checkAchievements(
  state: StateMessage,
  isVictory = false,
  victoryMsg?: VictoryMessage,
): AchievementDef[] {
  const unlocked = loadAchievements()
  const newlyUnlocked: AchievementDef[] = []

  const tryUnlock = (id: string, condition: boolean) => {
    if (!unlocked[id] && condition) {
      const def = ACHIEVEMENTS.find((a) => a.id === id)
      if (def) {
        unlocked[id] = { id, unlockedAt: Date.now() }
        newlyUnlocked.push(def)
      }
    }
  }

  const staff = state.offices.reduce((n, o) => n + o.employees.length, 0)
  const connectedStaff = state.offices.reduce(
    (n, o) => n + o.employees.filter((e) => e.connected).length,
    0,
  )

  // 1. Первые кадры: штат > 0
  tryUnlock('first_hire', staff > 0)

  // 2. Первый рабочий день: день > 1
  tryUnlock('first_day', state.day > 1)

  // 3. Кофейная пауза: кофемашина в любом офисе
  tryUnlock('coffee_break', state.offices.some((o) => o.coffeeMachine))

  // 4. Охотник за звёздами: есть хотя бы один звёздный сотрудник
  tryUnlock('star_hunter', state.offices.some((o) => o.employees.some((e) => e.star)))

  // 5. 10 дней без банкротства: день > 10 (прожито 10 полных дней)
  tryUnlock('survivor_10', state.day > 10)

  // 6. Корпорация: все 3 офиса разблокированы
  tryUnlock('three_offices', state.offices.length >= 3 && state.offices.every((o) => o.unlocked))

  // 7. Полный штат: все сотрудники наняты (все слоты заняты)
  const totalSlots = (state.officeSlots || 12) * state.offices.length
  tryUnlock('full_staff', staff >= totalSlots)

  // 8. Ядро системы: Core прокачан на максимум
  tryUnlock('core_max', Boolean(state.core?.maxed))

  // 9. 36/36 в сети: все сотрудники подключены
  tryUnlock('network_36', connectedStaff >= totalSlots)

  // 10. Первый миллион
  tryUnlock('millionaire', state.money >= 1_000_000)

  // 11. Победа без аменити
  if (isVictory) {
    const noAmenities = state.offices.every(
      (o) => !o.cooler && !o.fridge && !o.coffeeMachine,
    )
    tryUnlock('clean_win', noAmenities)
  }

  // 12. Хардкорный директор
  if (isVictory) {
    const diff = victoryMsg?.difficulty ?? state.difficulty
    tryUnlock('hardcore_win', diff === 'hardcore')
  }

  if (newlyUnlocked.length > 0) {
    saveAchievements(unlocked)
  }

  return newlyUnlocked
}

let lastSavedDay = 0
let lastSavedMoney = 0
// Троттлинг saveStats принадлежит партии: сбрасывается из resetForNewGame() (party.ts).
export function resetOngoingStatsThrottle(): void { lastSavedDay = 0; lastSavedMoney = 0 }

export function updateOngoingStats(state: StateMessage): void {
  const stats = loadStats()
  let changed = false

  if (state.money > stats.peakBalance) {
    stats.peakBalance = state.money
    changed = true
  }
  if (state.day > stats.peakDay) {
    stats.peakDay = state.day
    changed = true
  }

  const d = stats.byDifficulty[state.difficulty]
  if (d) {
    if (state.day > d.bestDay) {
      d.bestDay = state.day
      changed = true
    }
    // d.bestBalance намеренно не обновляется здесь — это рекорд финального баланса ПОБЕДЫ,
    // он фиксируется только в recordVictory.
  }

  if (changed) {
    const dayChanged = state.day !== lastSavedDay
    const bigMoneyJump = Math.abs(state.money - lastSavedMoney) >= 10000
    if (dayChanged || bigMoneyJump) {
      saveStats(stats)
      lastSavedDay = state.day
      lastSavedMoney = state.money
    }
  }
}

export function recordVictory(
  v: VictoryMessage,
  state?: StateMessage,
): { newAchievements: AchievementDef[]; isRecord: boolean } {
  const stats = loadStats()
  stats.totalRuns++
  stats.totalWins++

  const d = stats.byDifficulty[v.difficulty]
  let isRecord = false
  if (d) {
    d.runs++
    d.wins++
    if (v.day > d.bestDay) d.bestDay = v.day
    if (d.bestWinDay === null || v.day < d.bestWinDay) d.bestWinDay = v.day
    if (v.balance > d.bestBalance) {
      d.bestBalance = v.balance
      isRecord = true
    }
  }

  if (v.balance > stats.peakBalance) {
    stats.peakBalance = v.balance
  }
  if (v.day > stats.peakDay) {
    stats.peakDay = v.day
  }

  saveStats(stats)
  lastSavedDay = v.day
  lastSavedMoney = v.balance

  let newAchievements: AchievementDef[] = []
  if (state) {
    newAchievements = checkAchievements(state, true, v)
  } else {
    // Если снапшота нет, проверяем чисто по победе
    const unlocked = loadAchievements()
    if (v.difficulty === 'hardcore' && !unlocked['hardcore_win']) {
      const def = unlockAchievement('hardcore_win')
      if (def) newAchievements.push(def)
    }
  }

  return { newAchievements, isRecord }
}

export function recordGameOver(
  o: GameOverMessage,
  difficulty: DifficultyId,
  state?: StateMessage,
): { newAchievements: AchievementDef[] } {
  const stats = loadStats()
  stats.totalRuns++
  stats.totalLosses++

  const d = stats.byDifficulty[difficulty]
  if (d) {
    d.runs++
    if (o.reason === 'time_up') {
      d.timeUps++
    } else if (o.reason === 'bankrupt') {
      d.bankruptcies++
    }
    if (o.daysSurvived > d.bestDay) d.bestDay = o.daysSurvived
  }

  if (o.daysSurvived > stats.peakDay) {
    stats.peakDay = o.daysSurvived
  }

  saveStats(stats)

  let newAchievements: AchievementDef[] = []
  if (state) {
    newAchievements = checkAchievements(state, false)
  } else if (o.daysSurvived >= 10) {
    const unlocked = loadAchievements()
    if (!unlocked['survivor_10']) {
      const def = unlockAchievement('survivor_10')
      if (def) newAchievements.push(def)
    }
  }

  return { newAchievements }
}
