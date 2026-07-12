// Живая проверка протокола итерации 6 против реального сервера.
// Запуск: go run ./cmd/server -addr :8091 (из server/), затем node scripts/live-check.mjs
const FIELDS = [
  'money', 'offices', 'gateway', 'core', 'incomePerTick',
  'day', 'clock', 'isLunch', 'ticksPerHour', 'payrollPerDay', 'salaryPerDay',
  'bossSalaryPerDay', 'forecastEndOfDay', 'staffLimit', 'officeSlots',
  'phase', 'speed', 'prices',
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
    if (m.offices.some((o) => !Array.isArray(o.servers))) fail('offices[].servers не массив', m.offices)
    ok('servers всех офисов — массивы (не null)')
    if (m.offices[0].serverSlots !== 3) fail('serverSlots на офис (ждём 3, не 4)', m.offices[0].serverSlots)
    ok('serverSlots на офис: 3 (12 рабочих мест / 4 работника на сервер)')
    if (m.core.level !== 0 || m.core.nextPrice !== 1500) fail('core на старте', m.core)
    ok('core на старте: уровень 0, следующий за $1500')
    if (m.speed !== 1) fail('стартовая скорость', m.speed)
    ok('стартовая скорость 1x')
    ws.send(JSON.stringify({ type: 'set_speed', speed: 2 }))
    phase = 'speed_up'
  } else if (phase === 'speed_up' && m.type === 'state' && m.speed === 2) {
    ok('set_speed 2 → скорость 2x в снапшоте')
    ws.send(JSON.stringify({ type: 'upgrade_core' }))
    phase = 'core_broke'
  } else if (phase === 'core_broke' && m.type === 'error') {
    if (m.code !== 'not_enough_money') fail('апгрейд core без денег ($600 < $1500)', m.code)
    ok('upgrade_core при $600: error not_enough_money')
    ws.send(JSON.stringify({ type: 'set_speed', speed: 9 }))
    phase = 'bad_speed'
  } else if (phase === 'bad_speed' && m.type === 'error') {
    if (m.code !== 'bad_speed') fail('код ошибки set_speed вне 0..3', m.code)
    ok('set_speed 9: error bad_speed')
    ws.send(JSON.stringify({ type: 'set_speed', speed: 1 }))
    phase = 'speed_reset'
  } else if (phase === 'speed_reset' && m.type === 'state' && m.speed === 1) {
    ok('set_speed 1 → скорость обратно 1x')
    ws.send(JSON.stringify({ type: 'hire', office: 0 }))
    phase = 'hired'
  } else if (phase === 'hired' && m.type === 'state' && m.offices[0].employees.length === 1) {
    const e = m.offices[0].employees[0]
    if (!e.name || e.incomePerTick < 9 || e.incomePerTick > 14 || e.unpaidToday) {
      fail('нанятый сотрудник (утро — должен быть оплачиваемым)', e)
    }
    if (e.serverSlot !== 0 || e.netMult !== 1) fail('сотрудник без сети должен быть на ×1.0', e)
    ok(`найм в офис 0: ${e.name}, $${e.incomePerTick}/тик, без сервера ×1.0`)
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
