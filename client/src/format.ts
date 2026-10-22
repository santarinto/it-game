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

// Строка «Вирус» отчёта дня (ITGAME-103, ITGAME-180): новые заражения дня и упущенный из-за −30%
// доход (save.dayVirusLost — всех заражённых мест, и вчерашних). День без новых заражений, но с
// убытком — «новых нет (−$X)»: «+0 ПК за день (−$X)» читалось как «вирус ничего не сделал»
// (решение владельца 22.10). Ни заражений, ни убытка — строки нет. ≤ 38 знаков (ITGAME-159).
export function virusReportLines(newPCs: number, lost: number): string[] {
  if (newPCs <= 0 && lost <= 0) return []
  const head = 'Вирус:'.padEnd(REPORT_VALUE_COL)
  return [head + (newPCs > 0 ? `+${newPCs} ПК за день (−${fmtMoney(lost)})` : `новых нет (−${fmtMoney(lost)})`)]
}

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

// Строки денег экрана банкротства (ITGAME-176, решение владельца 21.10, вариант В): весь долг
// на момент банкротства и нехватка последнего вечера — то, на сколько долг вышел за порог
// (овердрафт на Лёгком и Норме — расходы вечера, кредит на Сложном и Хардкоре — лимит уровня;
// сервер шлёт её в game_over.shortfall). Нехватки нет или она равна долгу (порог нулевой) —
// одна строка долга: вторая её бы повторила.
export function bankruptLines(balance: number, shortfall: number): string[] {
  const debt = Math.max(0, -balance)
  const lines = [`Долг на момент банкротства: ${fmtMoney(debt)}`]
  if (shortfall > 0 && shortfall < debt) lines.push(`На зарплаты не хватило: ${fmtMoney(shortfall)}`)
  return lines
}
