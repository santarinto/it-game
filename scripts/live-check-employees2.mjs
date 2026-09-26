// Живая проверка сотрудников 2.0 (итерация 15) против реального сервера.
// Запуск: go run ./cmd/server -addr :8091 (из server/), затем
//   node scripts/live-check-employees2.mjs
//
// Всё делаем в первые секунды дня 1 (событий нет, ФОТ только вечером —
// банкротство исключено): поля level/xp/xpNext/star/firePrice/hiredToday
// у свежего найма, fire bad_slot, увольнение освобождает ПК (найм без
// buy_pc), компенсация сходится с балансом, опыт капает 2/тик.
// Менторство (3/тик с начальником) live не ждём: копить $1000 на босса
// на раннем балансе — ловить случайные события (аудит −$1200); механика
// покрыта Go-тестом TestXPMentor.
let step = 0
const ok = (name) => console.log(`ok ${++step} — ${name}`)
const fail = (name, got) => {
  console.error(`FAIL — ${name}:`, got)
  process.exit(1)
}

// Легко: старт $900 — хватает на найм → увольнение → повторный найм
// без ожидания дохода. Цены скалируются сложностью, поэтому сверяем
// баланс динамически с prices/firePrice из снапшота.
const ws = new WebSocket('ws://localhost:8091/ws?difficulty=easy')
let phase = 'start'
let lastState = null
let m0 = 0
let comp = 0
let prevXp = null
let seenDelta2 = false
const timeout = setTimeout(
  () => fail('таймаут 60с', { phase, day: lastState?.day, money: lastState?.money }),
  60_000,
)
ws.onclose = () => fail('соединение закрылось до конца проверки', { phase })

const send = (msg) => ws.send(JSON.stringify(msg))

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.type === 'state') lastState = m
  if (m.type === 'day_report') {
    send({ type: 'next_day' })
    return
  }

  // Потоковая проверка опыта: дельта XP между снапшотами-тиками.
  if (m.type === 'state' && m.phase === 'running') {
    const e = m.offices[0].employees[0]
    if (e && prevXp !== null) {
      const d = e.xp - prevXp
      if (d > 0) {
        if (d !== 2) fail(`дельта XP за тик = ${d}, хотим 2 (без босса)`, { xp: e.xp, prevXp })
        seenDelta2 = true
      }
    }
    if (e) prevXp = e.xp
  }

  if (phase === 'start' && m.type === 'state') {
    m0 = m.money
    send({ type: 'set_speed', speed: 3 })
    send({ type: 'hire', office: 0 })
    phase = 'hired'
  } else if (phase === 'hired' && m.type === 'state' && m.offices[0].employees.length === 1) {
    const e = m.offices[0].employees[0]
    if (e.level !== 0 || e.xp !== 0 || e.xpNext <= 0) fail('поля уровня свежего найма', e)
    if (e.hiredToday !== true || e.firePrice <= 0) fail('день найма: firePrice/hiredToday', e)
    if (typeof e.star !== 'boolean') fail('star не boolean', e)
    comp = e.firePrice
    ok(`найм: level=0, xp=0/${e.xpNext}, firePrice=$${e.firePrice} (день найма), star=${e.star}`)
    send({ type: 'fire', office: 0, slot: 5 })
    phase = 'bad_slot'
  } else if (phase === 'bad_slot' && m.type === 'error') {
    if (m.code !== 'bad_slot') fail('fire вне штата', m.code)
    ok('fire вне штата: error bad_slot')
    send({ type: 'fire', office: 0, slot: 0 })
    phase = 'fired'
  } else if (phase === 'fired' && m.type === 'state' && m.offices[0].employees.length === 0) {
    const hire = lastState?.prices?.hire
    if (m.offices[0].pcs !== 1) fail('ПК должен остаться в офисе', m.offices[0])
    if (m.money !== m0 - hire - comp) fail('баланс: найм + компенсация', { m0, hire, comp, money: m.money })
    ok(`уволен: ПК остался, баланс $${m.money} = старт − найм $${hire} − компенсация $${comp}`)
    send({ type: 'hire', office: 0 })
    phase = 'rehired'
  } else if (phase === 'rehired' && m.type === 'state' && m.offices[0].employees.length === 1) {
    ok(`найм в освободившийся ПК без buy_pc (баланс $${m.money})`)
    phase = 'xp_stream'
  } else if (phase === 'xp_stream' && m.type === 'state' && seenDelta2) {
    ok('опыт капает: 2 XP за продуктивный тик')
    clearTimeout(timeout)
    console.log('СОТРУДНИКИ 2.0 ОК')
    process.exit(0)
  }
}
ws.onerror = () => fail('WebSocket error — сервер запущен на :8091?', null)
