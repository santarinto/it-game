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
    title: 'Победа без аментий',
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
    const parsed = JSON.parse(raw) as Partial<MetaStats>
    const res = defaultStats()
    if (typeof parsed.totalRuns === 'number') res.totalRuns = parsed.totalRuns
    if (typeof parsed.totalWins === 'number') res.totalWins = parsed.totalWins
    if (typeof parsed.totalLosses === 'number') res.totalLosses = parsed.totalLosses
    if (typeof parsed.peakBalance === 'number') res.peakBalance = parsed.peakBalance
    if (typeof parsed.peakDay === 'number') res.peakDay = parsed.peakDay

    const diffs: DifficultyId[] = ['easy', 'normal', 'hard', 'hardcore']
    for (const d of diffs) {
      if (parsed.byDifficulty?.[d]) {
        res.byDifficulty[d] = {
          ...defaultDiffStats(),
          ...parsed.byDifficulty[d],
        }
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
    return (JSON.parse(raw) as Record<string, AchievementState>) || {}
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

  // 5. 10 дней без банкротства
  tryUnlock('survivor_10', state.day >= 10)

  // 6. Корпорация: все 3 офиса разблокированы
  tryUnlock('three_offices', state.offices.length >= 3 && state.offices.every((o) => o.unlocked))

  // 7. Полный штат: все 36 сотрудников
  tryUnlock('full_staff', staff >= 36)

  // 8. Ядро системы: Core прокачан на максимум
  tryUnlock('core_max', Boolean(state.core?.maxed))

  // 9. 36/36 в сети
  tryUnlock('network_36', connectedStaff >= 36)

  // 10. Первый миллион
  tryUnlock('millionaire', state.money >= 1_000_000)

  // 11. Победа без аментий
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
    if (state.money > d.bestBalance) {
      d.bestBalance = state.money
      changed = true
    }
  }

  if (changed) {
    saveStats(stats)
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
    isRecord = true
  }
  if (v.day > stats.peakDay) {
    stats.peakDay = v.day
  }

  saveStats(stats)

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
    } else {
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
