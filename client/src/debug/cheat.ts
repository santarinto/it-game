// Чит денег для localhost (ITGAME-194): в консоли cheat.money() — +$10 000 живой
// партии вкладки, cheat.money(50000) — +$50 000. Без ?debug=1 и без ITGAME_DEBUG,
// в любой сборке, но только на localhost: сервер (POST /api/cheat/money) пускает
// лишь локальный запрос. Снапшот с новым балансом приходит по /ws сам.
import { client } from '../net'
import { isLocalHostname } from './localhost'

const DEFAULT_AMOUNT = 10_000

async function money(amount: number = DEFAULT_AMOUNT): Promise<number> {
  if (!Number.isInteger(amount) || amount < 1 || amount > 10_000_000) {
    throw new Error('cheat.money: сумма — целое 1..10000000')
  }
  const sid = client.liveSid()
  if (sid === null) throw new Error('cheat.money: вкладка не в партии — сначала начните или продолжите игру')
  const res = await fetch('/api/cheat/money', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sid, amount }),
  })
  const data = (await res.json().catch(() => ({}))) as { error?: string; state?: { money: number } }
  if (!res.ok || !data.state) throw new Error(`cheat.money: ${data.error ?? `HTTP ${res.status}`}`)
  console.info(`cheat: +$${amount.toLocaleString('ru-RU')} → $${data.state.money.toLocaleString('ru-RU')}`)
  return data.state.money
}

export function installCheats(): void {
  if (!isLocalHostname(location.hostname)) return
  ;(window as unknown as { cheat: { money: typeof money } }).cheat = { money }
}
