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
