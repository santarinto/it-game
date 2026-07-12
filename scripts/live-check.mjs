// Живая проверка протокола итерации 3 против реального сервера.
// Запуск: go run ./cmd/server -addr :8091 (из server/), затем node scripts/live-check.mjs
// Ждёт настоящий конец дня (~54 сек) — осознанно: проверяем прод-тайминги.
const FIELDS = [
  'money', 'pcs', 'routerTier', 'ports', 'servers', 'multiplier', 'incomePerTick',
  'employees', 'day', 'dayTicks', 'dayProgress', 'clock', 'isLunch', 'ticksPerHour',
  'payrollPerDay', 'salaryPerDay', 'forecastEndOfDay', 'staffLimit',
  'phase', 'officeSlots', 'rackSlots', 'prices',
]
let step = 0
const ok = (name) => console.log(`ok ${++step} — ${name}`)
const fail = (name, got) => {
  console.error(`FAIL — ${name}:`, got)
  process.exit(1)
}

const ws = new WebSocket('ws://localhost:8091/ws')
const timeout = setTimeout(() => fail('таймаут 90с', { phase }), 90_000)
ws.onclose = () => fail('соединение закрылось до конца проверки', { phase })
let phase = 'start'

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (phase === 'start' && m.type === 'state') {
    const missing = FIELDS.filter((f) => !(f in m))
    if (missing.length) fail('нет полей снапшота', missing)
    ok(`снапшот: все ${FIELDS.length} полей на месте`)
    if (m.phase !== 'running' || m.day !== 1 || m.clock !== '10:00' || m.dayTicks !== 54) {
      fail('старт: фаза/день/часы', m)
    }
    ok('старт: running, день 1, 10:00, день 54 тика')
    ws.send(JSON.stringify({ type: 'hire' }))
    phase = 'hired'
  } else if (phase === 'hired' && m.type === 'state' && m.employees.length === 1) {
    const e = m.employees[0]
    if (m.payrollPerDay !== 250 || !e.name || e.incomePerTick < 9 || e.incomePerTick > 14) {
      fail('нанятый сотрудник', { payroll: m.payrollPerDay, e })
    }
    ok(`найм: ${e.name}, $${e.incomePerTick}/тик, зарплата 250`)
    ws.send(JSON.stringify({ type: 'next_day' })) // вне фазы отчёта — ждём ошибку
    phase = 'wrong_phase'
  } else if (phase === 'wrong_phase' && m.type === 'error') {
    if (m.code !== 'wrong_phase') fail('код ошибки next_day в running', m.code)
    ok('next_day в running: error wrong_phase')
    phase = 'wait_lunch'
    console.log('… ждём обеда (~24 сек) и конца дня (~54 сек)')
  } else if (phase === 'wait_lunch' && m.type === 'state' && m.isLunch) {
    if (m.incomePerTick !== 0) fail('в обед доход за тик не 0', m.incomePerTick)
    ok(`обед в ${m.clock}: доход 0`)
    phase = 'wait_report'
  } else if (phase === 'wait_report' && m.type === 'day_report') {
    if (m.day !== 1 || m.payroll !== 250) fail('отчёт дня', m)
    ok(`отчёт дня 1: income=${m.income} payroll=${m.payroll} balance=${m.balance}`)
    ws.send(JSON.stringify({ type: 'next_day' }))
    phase = 'day2'
  } else if (phase === 'day2' && m.type === 'state' && m.day === 2 && m.phase === 'running') {
    ok('next_day: день 2 запущен, время ' + m.clock)
    clearTimeout(timeout)
    console.log('ПРОТОКОЛ ОК')
    process.exit(0)
  }
}
ws.onerror = () => fail('WebSocket error — сервер запущен на :8091?', null)
