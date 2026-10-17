// Журнал событий нижней полосы HUD (ITGAME-21): строки по изменениям между двумя
// снапшотами одной партии считает клиент, итоги событий дня сервер шлёт сам —
// state.dayLog (ITGAME-163). Без Phaser.
import type { StateMessage } from './protocol'

export const LOG_LINES = 5

// Строка ленты: clock null — часы ленты в момент, когда строка легла.
export interface LogEntry { clock: string | null; text: string }

// Строка журнала сервера начинается со своего «HH:MM» (logEvent) — в ленту идёт оно,
// а не часы прихода (ITGAME-150).
export function parseLogLine(e: string): LogEntry {
  const at = /^(\d\d:\d\d) (.*)$/.exec(e)
  return at ? { clock: at[1], text: at[2] } : { clock: null, text: e }
}

// Сколько строк журнала дня key («сид:день») лента уже положила.
export interface DayLogCursor { key: string; shown: number }

// Новые строки журнала дня (ITGAME-163): журнал дня только растёт, так что новое —
// хвост после shown; другой key (новый день, другая партия) — журнал с начала. Его
// читают и снапшот (вживую), и вечерний отчёт: что лента уже видела, второй раз не идёт.
// Журнал того же дня короче (restore) — без повторов, курсор встаёт на его длину.
export function takeDayLog(cur: DayLogCursor, key: string, log: string[]): { cursor: DayLogCursor; lines: LogEntry[] } {
  const from = cur.key === key ? cur.shown : 0
  return { cursor: { key, shown: log.length }, lines: log.slice(from).map(parseLogLine) }
}

// «Утро, день N» (ITGAME-163: строка дня — слово владельца 18.10, текст — выбор владельца в
// приёмке 163 из «Новый день N» / «День N» / «Утро, день N»): день той же партии сменился между
// снапшотами — граница дня в ленте. Часы — начало дня, даже если вкладка увидела день
// не с первого тика; офлайн на несколько дней — одна строка на итоговый день.
export function newDayLine(prev: StateMessage | null, s: StateMessage): LogEntry | null {
  if (!prev || prev.seed !== s.seed || s.day <= prev.day) return null
  const [h, m] = s.clock.split(':').map(Number)
  const start = h * 60 + m - Math.round((s.tickInDay * 60) / s.ticksPerHour)
  const pad = (n: number) => String(n).padStart(2, '0')
  return { clock: `${pad(Math.floor(start / 60))}:${pad(start % 60)}`, text: `Утро, день ${s.day}` }
}

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

// Перенос строки журнала по ширине maxW (ITGAME-141): по словам, слово шире строки режется по
// знакам; строки продолжения начинаются с indent — висячий отступ под текстом после «· ».
// measure — ширина строки в шрифте, где она будет нарисована (context.measureText Text-объекта).
export function wrapHanging(line: string, maxW: number, measure: (s: string) => number, indent: string): string[] {
  const out: string[] = []
  let cur = ''
  const lead = () => (out.length > 0 ? indent : '')
  const push = () => { out.push(lead() + cur); cur = '' }
  for (let word of line.split(' ')) {
    const cand = cur ? `${cur} ${word}` : word
    if (measure(lead() + cand) <= maxW) { cur = cand; continue }
    if (cur) push()
    while (word.length > 1 && measure(lead() + word) > maxW) {
      let n = word.length - 1
      while (n > 1 && measure(lead() + word.slice(0, n)) > maxW) n--
      cur = word.slice(0, n)
      push()
      word = word.slice(n)
    }
    cur = word
  }
  if (cur || out.length === 0) push()
  return out
}
