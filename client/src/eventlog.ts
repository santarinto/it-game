// Журнал событий нижней полосы HUD (ITGAME-21): сервер ленты событий не шлёт, поэтому
// строки по изменениям между двумя снапшотами одной партии считает клиент. Без Phaser.
import type { StateMessage } from './protocol'

export const LOG_LINES = 5

const names = (o: StateMessage['offices'][number]) => o.employees.map((e) => e.name)

export function diffEvents(prev: StateMessage, next: StateMessage): string[] {
  // Чужая партия, откат версии или день назад (новая партия/restore) — не событие.
  if (prev.seed !== next.seed || next.rev <= prev.rev || next.day < prev.day) return []
  const out: string[] = []
  next.offices.forEach((o, k) => {
    const p = prev.offices[k]
    if (!p) return
    const L = `О${k + 1}`
    if (!p.unlocked && o.unlocked) out.push(`Куплен офис ${L}`)
    if (o.pcs > p.pcs) out.push(`Куплен ПК (${L}, всего ${o.pcs})`)
    const before = names(p), after = names(o)
    for (const e of o.employees) if (!before.includes(e.name)) out.push(`Нанят: ${e.name}${e.star ? ' (звезда)' : ''}`)
    for (const n of before) if (!after.includes(n)) out.push(`Уволен: ${n}`)
    if (o.routerTier > p.routerTier) out.push(`Роутер т${o.routerTier} (${L}), ${o.ports} порт.`)
    if (!p.boss && o.boss) out.push(`Начальник: ${o.boss}`)
    for (const e of o.employees) {
      const pe = p.employees.find((x) => x.name === e.name)
      if (!pe) continue
      if (!pe.pcBroken && e.pcBroken) out.push(`ПК сломался: ${e.name}`)
      if (pe.pcBroken && !e.pcBroken) out.push(`ПК починен: ${e.name}`)
    }
    for (let i = p.servers.length; i < o.servers.length; i++) out.push(`Стойка ${i + 1} (${L})`)
    o.servers.forEach((sv, i) => {
      const ps = p.servers[i]
      if (ps && sv.level > ps.level) out.push(`Стойка ${i + 1} (${L}) → ур.${sv.level}`)
    })
    if (!p.cooler && o.cooler) out.push(`Кулер (${L})`)
    if (!p.fridge && o.fridge) out.push(`Холодильник (${L})`)
    if (!p.coffeeMachine && o.coffeeMachine) out.push(`Кофеварка (${L})`)
  })
  if (!prev.gateway && next.gateway) out.push('Шлюз: интернет ×1.2')
  if (next.core.level > prev.core.level) out.push(`Core ур.${next.core.level}`)
  if (next.activeEvent && next.activeEvent.id !== prev.activeEvent?.id) out.push(`Событие: ${next.activeEvent.title}`)
  return out
}
