// Живая проверка протокола итерации 2 против реального сервера.
// Запуск: go run ./cmd/server -addr :8091 (из server/), затем node scripts/live-check.mjs
// Ждёт настоящий конец дня (~60 сек) — это осознанно: проверяем прод-тайминги.
const FIELDS = [
  'money', 'pcs', 'employees', 'routerTier', 'ports', 'connected', 'servers',
  'multiplier', 'incomePerTick', 'officeSlots', 'rackSlots', 'prices',
  'day', 'dayTicks', 'dayProgress', 'payrollPerDay', 'phase',
]
let step = 0
const ok = (name) => console.log(`ok ${++step} — ${name}`)
const fail = (name, got) => {
  console.error(`FAIL — ${name}:`, got)
  process.exit(1)
}

const ws = new WebSocket('ws://localhost:8091/ws')
const timeout = setTimeout(() => fail('таймаут 90с', null), 90_000)
let phase = 'start'

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (phase === 'start' && m.type === 'state') {
    const missing = FIELDS.filter((f) => !(f in m))
    if (missing.length) fail('нет полей снапшота', missing)
    ok(`снапшот: все ${FIELDS.length} полей на месте`)
    if (m.phase !== 'running' || m.day !== 1) fail('стартовая фаза/день', m)
    ok('старт: phase=running, day=1')
    ws.send(JSON.stringify({ type: 'hire' }))
    phase = 'hired'
  } else if (phase === 'hired' && m.type === 'state' && m.employees === 1) {
    if (m.payrollPerDay !== 250) fail('ФОТ после найма', m.payrollPerDay)
    ok('найм: payrollPerDay=250')
    ws.send(JSON.stringify({ type: 'next_day' })) // вне фазы отчёта — ждём ошибку
    phase = 'wrong_phase'
  } else if (phase === 'wrong_phase' && m.type === 'error') {
    if (m.code !== 'wrong_phase') fail('код ошибки next_day в running', m.code)
    ok('next_day в running: error wrong_phase')
    phase = 'wait_report'
    console.log('… ждём конца дня (~60 сек)')
  } else if (phase === 'wait_report' && m.type === 'day_report') {
    if (m.day !== 1 || m.payroll !== 250) fail('отчёт дня', m)
    ok(`отчёт дня 1: income=${m.income} payroll=${m.payroll} balance=${m.balance}`)
    ws.send(JSON.stringify({ type: 'next_day' }))
    phase = 'day2'
  } else if (phase === 'day2' && m.type === 'state' && m.day === 2 && m.phase === 'running') {
    ok('next_day: день 2 запущен')
    clearTimeout(timeout)
    console.log('ПРОТОКОЛ ОК')
    process.exit(0)
  }
}
ws.onerror = () => fail('WebSocket error — сервер запущен на :8091?', null)
