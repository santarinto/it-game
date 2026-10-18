// Деньги в UI — только через fmtMoney, чтобы формат был единым.
export function fmtMoney(n: number): string {
  return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US')
}

// «4 места», «15 мест», «21 место» — тариф антивируса, строка «Админы» отчёта дня.
export function seatsLabel(n: number): string {
  const d = n % 10
  const dd = n % 100
  const word = d === 1 && dd !== 11 ? 'место' : d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? 'места' : 'мест'
  return `${n} ${word}`
}

// Колонка значений отчёта дня: «Доход:     $X» — значение с 12-го знака.
const REPORT_VALUE_COL = 11

// Строки «Админы» отчёта дня (ITGAME-159): что админы сделали за день — глаголом. Обе части
// одной строкой («Админы:    починили k ПК, вычистили m мест», 42–44 знака) в панель 440 не
// входят: 16 px Departure Mono — 10,18 px на знак, внутри полей 24 px — 38 знаков. Поэтому
// вторая часть — второй строкой под колонкой значений, запятая — в конце первой: склеенные,
// строки читаются одной фразой. Нулевая часть не пишется; обе нулевые — строк нет.
export function adminsReportLines(repairs: number, cleaned: number): string[] {
  const parts: string[] = []
  if (repairs > 0) parts.push(`починили ${repairs} ПК`)
  if (cleaned > 0) parts.push(`вычистили ${seatsLabel(cleaned)}`)
  return parts.map((p, i) => (i === 0 ? 'Админы:' : '').padEnd(REPORT_VALUE_COL) + p + (i < parts.length - 1 ? ',' : ''))
}
