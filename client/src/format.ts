// Деньги в UI — только через fmtMoney, чтобы формат был единым.
export function fmtMoney(n: number): string {
  return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US')
}
