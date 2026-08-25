import type { OfficeInfo, StateMessage } from './protocol'

// Превью «≈+N в сеть» перед покупкой узла цепочки (итерация 11).
// Оценка по данным снапшота: сколько мест без бонуса доберётся до
// сервера после покупки. Порядок раздачи core «первым N» делает
// оценку чуть консервативной — это превью, не обещание.

// Роутер: кандидаты — места за пределами текущих портов, узкое
// место — порты следующего тира и свободные места в core.
export function routerGain(o: OfficeInfo, coreFree: number): number {
  if (o.nextPorts === 0) return 0
  const waiting = o.employees.filter((e) => e.offlineReason === 'no_router').length
  return Math.max(0, Math.min(waiting, o.nextPorts - o.ports, coreFree))
}

// Core: кандидаты — места с reason no_core; новый уровень отдаёт
// newCap − capacity дополнительных мест.
export function coreGain(s: StateMessage): number {
  if (s.core.maxed) return 0
  const waiting = s.offices
    .filter((o) => o.unlocked)
    .reduce((n, o) => n + o.employees.filter((e) => e.offlineReason === 'no_core').length, 0)
  const newCap = s.prices.coreLevels[s.core.level].capacity
  return Math.max(0, Math.min(waiting, newCap - s.core.capacity))
}

// Серверная стойка: места с reason no_server этого офиса, стойка
// обслуживает четвёрку.
export function serverGain(o: OfficeInfo): number {
  return Math.min(4, o.employees.filter((e) => e.offlineReason === 'no_server').length)
}

// Свободные места в core (0 — core не куплен: все роутеры упрутся).
export function coreFree(s: StateMessage): number {
  return s.core.capacity - s.core.connected
}
