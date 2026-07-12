// Живая проверка протокола итерации 4 против реального сервера.
// Запуск: go run ./cmd/server -addr :8091 (из server/), затем node scripts/live-check.mjs
const FIELDS = [
  'money', 'offices', 'servers', 'gateway', 'multiplier', 'incomePerTick',
  'day', 'clock', 'isLunch', 'ticksPerHour', 'payrollPerDay', 'salaryPerDay',
  'bossSalaryPerDay', 'forecastEndOfDay', 'staffLimit', 'officeSlots',
  'phase', 'rackSlots', 'prices',
]
let step = 0
const ok = (name) => console.log(`ok ${++step} — ${name}`)
const fail = (name, got) => {
  console.error(`FAIL — ${name}:`, got)
  process.exit(1)
}

const ws = new WebSocket('ws://localhost:8091/ws')
let phase = 'start'
const timeout = setTimeout(() => fail('таймаут 90с', { phase }), 90_000)
ws.onclose = () => fail('соединение закрылось до конца проверки', { phase })

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (phase === 'start' && m.type === 'state') {
    const missing = FIELDS.filter((f) => !(f in m))
    if (missing.length) fail('нет полей снапшота', missing)
    ok(`снапшот: все ${FIELDS.length} полей на месте`)
    if (m.offices.length !== 3 || !m.offices[0].unlocked || m.offices[1].unlocked ||
        m.offices[1].price !== 15000 || m.offices[2].price !== 40000) {
      fail('офисы на старте', m.offices)
    }
    ok('офисы: 1 открыт, 2-3 закрыты с ценами')
    ws.send(JSON.stringify({ type: 'hire', office: 0 }))
    phase = 'hired'
  } else if (phase === 'hired' && m.type === 'state' && m.offices[0].employees.length === 1) {
    const e = m.offices[0].employees[0]
    if (!e.name || e.incomePerTick < 9 || e.incomePerTick > 14 || e.unpaidToday) {
      fail('нанятый сотрудник (утро — должен быть оплачиваемым)', e)
    }
    ok(`найм в офис 0: ${e.name}, $${e.incomePerTick}/тик`)
    phase = 'cooler_wait'
    console.log('… ждём денег на кулер (money >= 400)')
  } else if (phase === 'cooler_wait' && m.type === 'state' && m.money >= 400) {
    ws.send(JSON.stringify({ type: 'buy_cooler', office: 0 }))
    phase = 'cooler'
  } else if (phase === 'cooler' && m.type === 'state' && m.offices[0].cooler) {
    if (!('effects' in m.offices[0].employees[0])) fail('нет effects у сотрудника', m.offices[0].employees[0])
    ok('кулер куплен, effects присутствует')
    ws.send(JSON.stringify({ type: 'buy_cooler', office: 0 }))
    phase = 'cooler_dup'
  } else if (phase === 'cooler_dup' && m.type === 'error') {
    if (m.code !== 'equipment_already') fail('код повторной покупки', m.code)
    ok('повторный кулер: error equipment_already')
    ws.send(JSON.stringify({ type: 'hire', office: 1 })) // закрытый офис
    phase = 'locked'
  } else if (phase === 'locked' && m.type === 'error') {
    if (m.code !== 'office_locked') fail('код ошибки найма в закрытый офис', m.code)
    ok('найм в закрытый офис: error office_locked')
    ws.send(JSON.stringify({ type: 'buy_gateway', office: 0 }))
    phase = 'gateway'
  } else if (phase === 'gateway' && m.type === 'error') {
    if (m.code !== 'not_enough_money') fail('шлюз должен быть не по карману на старте', m.code)
    ok('шлюз без денег: error not_enough_money')
    phase = 'wait_report'
    console.log('… ждём конца дня (~54 сек)')
  } else if (phase === 'wait_report' && m.type === 'day_report') {
    if (m.day !== 1 || m.payroll !== 250 || m.gatewayOpex !== 0) fail('отчёт дня', m)
    ok(`отчёт дня 1: income=${m.income} payroll=${m.payroll} opex=${m.gatewayOpex}`)
    ws.send(JSON.stringify({ type: 'next_day', office: 0 }))
    phase = 'day2'
  } else if (phase === 'day2' && m.type === 'state' && m.day === 2 && m.phase === 'running') {
    ok('день 2 запущен, время ' + m.clock)
    clearTimeout(timeout)
    console.log('ПРОТОКОЛ ОК')
    process.exit(0)
  }
}
ws.onerror = () => fail('WebSocket error — сервер запущен на :8091?', null)
