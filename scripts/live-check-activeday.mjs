// Живая проверка активного дня (итерация 9) против реального сервера.
// Запуск: go run ./cmd/server -addr :8091 (из server/), затем
//   node scripts/live-check-activeday.mjs
//
// Детерминированная часть протокола: мотивация кликом (бафф + кулдаун +
// motivateReadyAt), call_master по целому ПК (not_broken), поля отчёта дня
// (incidents/lostIncome). Случайные поломки в live не ждём — они покрыты
// Go-тестами со 100% шансом (TestActiveDayBrokenSnapshot).
let step = 0
const ok = (name) => console.log(`ok ${++step} — ${name}`)
const fail = (name, got) => {
  console.error(`FAIL — ${name}:`, got)
  process.exit(1)
}

const ws = new WebSocket('ws://localhost:8091/ws?difficulty=normal')
let phase = 'start'
let lastState = null
const timeout = setTimeout(
  () => fail('таймаут 90с', { phase, day: lastState?.day, money: lastState?.money }),
  90_000,
)
ws.onclose = () => fail('соединение закрылось до конца проверки', { phase })

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.type === 'state') lastState = m
  if (phase === 'start' && m.type === 'state') {
    if (m.prices.repair !== 150) fail('prices.repair', m.prices)
    ok('prices.repair = $150')
    ws.send(JSON.stringify({ type: 'hire', office: 0 }))
    phase = 'hire'
  } else if (phase === 'hire' && m.type === 'state' && m.offices[0].employees.length === 1) {
    const e = m.offices[0].employees[0]
    if (e.pcBroken !== false || e.repairClicks !== 0 || e.motivateReadyAt !== '') {
      fail('поля активного дня у свежего сотрудника', e)
    }
    ok('сотрудник: pcBroken=false, repairClicks=0, motivateReadyAt=""')
    ws.send(JSON.stringify({ type: 'motivate', office: 0, slot: 0 }))
    phase = 'motivated'
  } else if (phase === 'motivated' && m.type === 'state' && m.offices[0].employees[0].motivateReadyAt !== '') {
    const e = m.offices[0].employees[0]
    const eff = e.effects.find((x) => x.token === 'motivated')
    if (!eff || eff.percent !== 25 || !eff.until) fail('эффект motivated +25 в снапшоте', e.effects)
    if (!e.motivateReadyAt.match(/^\d{2}:\d{2}$/)) fail('motivateReadyAt «HH:MM»', e.motivateReadyAt)
    ok(`мотивация: +25% до ${eff.until}, кулдаун до ${e.motivateReadyAt}`)
    ws.send(JSON.stringify({ type: 'motivate', office: 0, slot: 0 }))
    phase = 'cooldown'
  } else if (phase === 'cooldown' && m.type === 'error') {
    if (m.code !== 'motivate_cooldown') fail('повторная мотивация', m.code)
    ok('повторная мотивация: error motivate_cooldown')
    ws.send(JSON.stringify({ type: 'call_master', office: 0, slot: 0 }))
    phase = 'not_broken'
  } else if (phase === 'not_broken' && m.type === 'error') {
    if (m.code !== 'not_broken') fail('мастер по целому ПК', m.code)
    ok('мастер по целому ПК: error not_broken')
    ws.send(JSON.stringify({ type: 'motivate', office: 0, slot: 5 }))
    phase = 'bad_slot'
  } else if (phase === 'bad_slot' && m.type === 'error') {
    if (m.code !== 'bad_slot') fail('мотивация вне штата', m.code)
    ok('мотивация вне штата: error bad_slot')
    phase = 'wait_report'
    console.log('… ждём конца дня 1 (мотивация должна спасть к ночи)')
  } else if (phase === 'wait_report' && m.type === 'day_report') {
    if (!('incidents' in m) || !('lostIncome' in m)) fail('поля отчёта дня', m)
    if (m.incidents < 0 || m.lostIncome < 0) fail('отрицательная статистика поломок', m)
    ok(`отчёт дня ${m.day}: incidents=${m.incidents}, lostIncome=${m.lostIncome}`)
    ws.send(JSON.stringify({ type: 'next_day', office: 0 }))
    phase = 'day2'
  } else if (phase === 'day2' && m.type === 'state' && m.day === 2 && m.phase === 'running') {
    const e = m.offices[0].employees[0]
    if (e.effects.some((x) => x.token === 'motivated') || e.motivateReadyAt !== '' || e.pcBroken) {
      fail('ночной ресет активного дня', e)
    }
    ok('день 2: мотивация/кулдаун/поломки сброшены ночью')
    clearTimeout(timeout)
    console.log('ПРОТОКОЛ АКТИВНОГО ДНЯ ОК')
    process.exit(0)
  }
}
ws.onerror = () => fail('WebSocket error — сервер запущен на :8091?', null)
