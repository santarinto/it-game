import type { StateMessage } from '../protocol'

// Что мобильный каркас (ITGAME-227) показывает из снапшота: минимум, по которому видно, что
// партия жива и state приходит, — деньги, день и время, открытые офисы и фаза. Импорт только
// типов: npm test берёт файл как есть (как src/format.ts), деньги форматирует переданный
// fmtMoney — копии формата здесь нет.
export interface MobileSummary {
  money: string
  day: string // «День 3 · 14:20», в обед — « · обед»
  offices: string[] // по строке на открытый офис
  phase: string // что сейчас с партией одним словом-фразой
}

export function mobileSummary(s: StateMessage, money: (n: number) => string): MobileSummary {
  const offices: string[] = []
  s.offices.forEach((o, i) => {
    if (!o.unlocked) return
    const broken = o.employees.filter((e) => e.pcBroken).length
    offices.push(`Офис ${i + 1}: людей ${o.employees.length}, ПК ${o.pcs}` + (broken > 0 ? `, сломано ${broken}` : ''))
  })
  return {
    money: money(s.money),
    day: `День ${s.day} · ${s.clock}` + (s.isLunch ? ' · обед' : ''),
    offices,
    phase: phaseLine(s),
  }
}

function phaseLine(s: StateMessage): string {
  switch (s.phase) {
    case 'day_report': return 'день закрыт'
    case 'game_over': return 'банкротство'
    case 'won': return 'победа'
    default: return s.speed === 0 ? 'пауза' : `идёт, скорость ×${s.speed}`
  }
}
