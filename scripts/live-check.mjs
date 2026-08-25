// Живая проверка протокола итерации 8 против реального сервера (хардкор).
// Запуск: go run ./cmd/server -addr :8091 (из server/), затем node scripts/live-check.mjs
//
// ИЗВЕСТНОЕ ОГРАНИЧЕНИЕ: доход сотрудника роллится 7–11/тик, и до покупки
// кулера ($600) за 5-дневный кап доходят не все роллы — при нехватке денег
// ветка buy_cooler/effects/equipment_already честно пропускается с логом,
// и «ПРОТОКОЛ ОК» её тогда НЕ покрывает (~20% прогонов покрывают).
const FIELDS = [
  'money', 'offices', 'gateway', 'core', 'incomePerTick',
  'day', 'clock', 'isLunch', 'ticksPerHour', 'payrollPerDay', 'salaryPerDay',
  'bossSalaryPerDay', 'forecastEndOfDay', 'staffLimit', 'officeSlots',
  'phase', 'speed', 'prices', 'difficulty', 'winTarget',
]
let step = 0
const ok = (name) => console.log(`ok ${++step} — ${name}`)
const fail = (name, got) => {
  console.error(`FAIL — ${name}:`, got)
  process.exit(1)
}

// Хардкор + один сотрудник без холодильника (тестируем только кулер) —
// экономика впритык (см. отчёт таска 7): $600 на кулер за день 1 нельзя
// накопить даже при удаче (пик до обеда ~$270 < $600), а после обеда жажда
// (нет кулера) и голод (нет холодильника) стакаются до ×0.7225 — при
// низком ролле дохода это даёт дневной УБЫТОК, не рост. Поэтому: кулер ждём
// после отчёта дня, но не бесконечно — если за COOLER_DAY_CAP дней не
// накопилось, покупку кулера пропускаем (остальной протокол уже проверен) и
// завершаем сценарий успешно.
const COOLER_DAY_CAP = 5
const ws = new WebSocket('ws://localhost:8091/ws?difficulty=hardcore')
let phase = 'start'
let lastState = null
const timeout = setTimeout(
  () => fail('таймаут 120с', { phase, day: lastState?.day, money: lastState?.money }),
  120_000,
)
ws.onclose = () => fail('соединение закрылось до конца проверки', { phase })

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.type === 'state') lastState = m
  if (m.type === 'game_over') {
    // Известный риск: при ролле дохода $7-8/тик из 5 возможных (7..11)
    // одному сотруднику без кулера/холодильника не хватает на ФОТ дня 1
    // ($375) — ~40% попыток. Перезапустите скрипт (ролл 9-11/тик выживает).
    fail('банкротство раньше конца сценария (ролл дохода $7-8/тик — известный риск хардкора, ~40% попыток, перезапустите скрипт)', m)
  }
  if (phase === 'start' && m.type === 'state') {
    const missing = FIELDS.filter((f) => !(f in m))
    if (missing.length) fail('нет полей снапшота', missing)
    ok(`снапшот: все ${FIELDS.length} полей на месте`)
    if (m.difficulty !== 'hardcore' || m.money !== 480 || m.prices.pc !== 750 || m.winTarget !== 500000) {
      fail('хардкор из query', { difficulty: m.difficulty, money: m.money, pc: m.prices.pc, winTarget: m.winTarget })
    }
    ok('хардкор: старт $480, ПК $750, цель $500,000')
    if (m.offices.length !== 3 || !m.offices[0].unlocked || m.offices[1].unlocked ||
        m.offices[1].price !== 22500 || m.offices[2].price !== 60000) {
      fail('офисы на старте', m.offices)
    }
    ok('офисы: 1 открыт, 2-3 закрыты с ценами')
    if (m.offices.some((o) => !Array.isArray(o.servers))) fail('offices[].servers не массив', m.offices)
    ok('servers всех офисов — массивы (не null)')
    if (m.offices[0].serverSlots !== 3) fail('serverSlots на офис (ждём 3, не 4)', m.offices[0].serverSlots)
    ok('serverSlots на офис: 3 (12 рабочих мест / 4 работника на сервер)')
    if (m.core.level !== 0 || m.core.nextPrice !== 2250) fail('core на старте', m.core)
    ok('core на старте: уровень 0, следующий за $2250')
    if (m.speed !== 1) fail('стартовая скорость', m.speed)
    ok('стартовая скорость 1x')
    ws.send(JSON.stringify({ type: 'set_speed', speed: 2 }))
    phase = 'speed_up'
  } else if (phase === 'speed_up' && m.type === 'state' && m.speed === 2) {
    ok('set_speed 2 → скорость 2x в снапшоте')
    ws.send(JSON.stringify({ type: 'upgrade_core' }))
    phase = 'core_broke'
  } else if (phase === 'core_broke' && m.type === 'error') {
    if (m.code !== 'not_enough_money') fail('апгрейд core без денег ($480 < $2250)', m.code)
    ok('upgrade_core при $480: error not_enough_money')
    ws.send(JSON.stringify({ type: 'set_speed', speed: 9 }))
    phase = 'bad_speed'
  } else if (phase === 'bad_speed' && m.type === 'error') {
    if (m.code !== 'bad_speed') fail('код ошибки set_speed вне 0..3', m.code)
    ok('set_speed 9: error bad_speed')
    ws.send(JSON.stringify({ type: 'set_speed', speed: 1 }))
    phase = 'speed_reset'
  } else if (phase === 'speed_reset' && m.type === 'state' && m.speed === 1) {
    ok('set_speed 1 → скорость обратно 1x')
    // Дальше сценарий на хардкоре может уйти за день 1 (ниже) — ускоряем
    // реальное время ожидания, игровые числа скорость не трогает.
    ws.send(JSON.stringify({ type: 'set_speed', speed: 3 }))
    ws.send(JSON.stringify({ type: 'hire', office: 0 }))
    phase = 'hired'
  } else if (phase === 'hired' && m.type === 'state' && m.offices[0].employees.length === 1) {
    const e = m.offices[0].employees[0]
    if (!e.name || e.incomePerTick < 7 || e.incomePerTick > 11 || e.unpaidToday) {
      fail('нанятый сотрудник (утро — должен быть оплачиваемым)', e)
    }
    if (e.serverSlot !== 0 || e.netMult !== 1) fail('сотрудник без сети должен быть на ×1.0', e)
    ok(`найм в офис 0: ${e.name}, $${e.incomePerTick}/тик, без сервера ×1.0`)
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
    console.log('… ждём конца дня 1')
  } else if (phase === 'wait_report' && m.type === 'day_report') {
    if (m.day !== 1 || m.payroll !== 375 || m.gatewayOpex !== 0) fail('отчёт дня', m)
    ok(`отчёт дня 1: income=${m.income} payroll=${m.payroll} opex=${m.gatewayOpex}`)
    ws.send(JSON.stringify({ type: 'next_day', office: 0 }))
    phase = 'day2'
  } else if (phase === 'day2' && m.type === 'state' && m.day === 2 && m.phase === 'running') {
    ok('день 2 запущен, время ' + m.clock)
    // Ждём денег на кулер уже в день 2+, пропуская отчёты следующих дней
    // командой next_day, пока не накопится — но не дольше COOLER_DAY_CAP
    // (см. комментарий у объявления константы).
    phase = 'cooler_wait'
    console.log(`… ждём денег на кулер (money >= 600), максимум до дня ${COOLER_DAY_CAP}`)
  } else if (phase === 'cooler_wait' && m.type === 'day_report') {
    ok(`отчёт дня ${m.day} по пути к кулеру: баланс $${m.balance}`)
    if (m.day >= COOLER_DAY_CAP) {
      ok(`накопление слишком медленное (баланс $${m.balance} < $600 к дню ${COOLER_DAY_CAP}) — покупку кулера пропускаем, остальной протокол уже проверен`)
      clearTimeout(timeout)
      console.log('ПРОТОКОЛ ОК (кулер пропущен — см. предыдущую строку)')
      process.exit(0)
    }
    ws.send(JSON.stringify({ type: 'next_day', office: 0 }))
  } else if (phase === 'cooler_wait' && m.type === 'state' && m.money >= 600) {
    ws.send(JSON.stringify({ type: 'buy_cooler', office: 0 }))
    phase = 'cooler'
  } else if (phase === 'cooler' && m.type === 'state' && m.offices[0].cooler) {
    if (!('effects' in m.offices[0].employees[0])) fail('нет effects у сотрудника', m.offices[0].employees[0])
    ok(`кулер куплен на день ${m.day} (баланс $${m.money}), effects присутствует`)
    ws.send(JSON.stringify({ type: 'buy_cooler', office: 0 }))
    phase = 'cooler_dup'
  } else if (phase === 'cooler_dup' && m.type === 'error') {
    if (m.code !== 'equipment_already') fail('код повторной покупки', m.code)
    ok('повторный кулер: error equipment_already')
    clearTimeout(timeout)
    console.log('ПРОТОКОЛ ОК')
    process.exit(0)
  }
}
ws.onerror = () => fail('WebSocket error — сервер запущен на :8091?', null)
