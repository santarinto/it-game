// Рабочий день для полосы дня в шапке HUD (ITGAME-21). Зеркало DefaultConfig сервера
// (server/internal/game/config.go: WorkdayStart/LunchStart/LunchEnd/WorkdayEnd и тики
// событий дедлайна 17:00 и аудита 18:00) — менять только вместе с ним. Число тиков
// в часе клиент берёт из снапшота (ticksPerHour), здесь только часы.
export const WORKDAY = { start: 10, lunchStart: 14, lunchEnd: 15, end: 19, deadlineHour: 17, auditHour: 18 } as const

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

// Доля рабочего дня, прошедшая к часу hour (0..1).
export function hourShare(hour: number): number {
  return clamp01((hour - WORKDAY.start) / (WORKDAY.end - WORKDAY.start))
}

// Доля дня по тику внутри дня.
export function dayShare(tickInDay: number, ticksPerHour: number): number {
  const total = (WORKDAY.end - WORKDAY.start) * ticksPerHour
  return total > 0 ? clamp01(tickInDay / total) : 0
}
