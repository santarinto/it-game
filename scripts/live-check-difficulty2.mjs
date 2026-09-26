// Живая проверка «Сложности 2.0» (ITGAME-9) против реального сервера.
// Запуск: go run ./cmd/server -addr :8091 (из server/), затем
//   node scripts/live-check-difficulty2.mjs
//
// Хардкор: поля кредита/рынка/дедлайна в снапшоте, день 1 без качелей,
// завтрашний рынок виден заранее; поздний найм (после 12:00, до 15:00)
// уводит вечерний ФОТ в долг — отчёт дня вместо game_over, кредит в логе,
// день 2 продолжается. Норма: кредитов и рынка нет, цель — только деньги.
//
// Сид фиксирован: ролл выработки найма воспроизводим целиком. SEED=… —
// проверить другой сид.
let step = 0
const ok = (name) => console.log(`ok ${++step} — ${name}`)
const fail = (name, got) => {
  console.error(`FAIL — ${name}:`, got)
  process.exit(1)
}

const SWING = [-15, -10, -5, 0, 5, 10, 15]

// Фиксированный сид: ролл выработки найма воспроизводим. Без него ~1%
// прогонов ловили «звезду» 14–17 $/тик — вечер в плюс, проверка долга падала.
const SEED = process.env.SEED ?? '3' // сид 3: найм 8 $/тик без звезды, вечер −$135

let phase = 'start'
let lastState = null
let prevTomorrow = null
const ws = new WebSocket(`ws://localhost:8091/ws?difficulty=hardcore&seed=${SEED}`)
const timeout = setTimeout(() => fail('таймаут 180с', { phase, day: lastState?.day }), 180_000)
ws.onclose = () => fail('соединение закрылось до конца проверки', { phase })
ws.onerror = () => fail('WebSocket error — сервер запущен на :8091?', null)

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.type === 'state') lastState = m
  if (m.type === 'game_over') fail(`хардкор: долг в пороге $10k, а пришёл game_over (сид ${SEED})`, m)

  if (phase === 'start' && m.type === 'state') {
    const checks = {
      money: m.money === 480,
      hire: m.prices.hire === 450,
      creditLimit: m.creditLimit === 10000,
      creditRatePct: m.creditRatePct === 15,
      winTarget: m.winTarget === 1000000,
      winDayLimit: m.winDayLimit === 30,
      winStaff: m.winStaff === 0,
      marketDay1: m.marketToday === 0,
      marketTomorrow: SWING.includes(m.marketTomorrow),
      seed: m.seed === SEED,
    }
    for (const [k, v] of Object.entries(checks)) if (!v) fail(`хардкор state.${k}`, m)
    prevTomorrow = m.marketTomorrow
    ok(`хардкор: кредит $${m.creditLimit} (${m.creditRatePct}%/д), дедлайн день ${m.winDayLimit}, рынок д1 ${m.marketToday}% / завтра ${m.marketTomorrow > 0 ? '+' : ''}${m.marketTomorrow}%`)
    ws.send(JSON.stringify({ type: 'set_speed', speed: 3 })) // день ~18с
    phase = 'speed'
  } else if (phase === 'speed' && m.type === 'state' && m.speed === 3) {
    phase = 'wait_midday'
    console.log('… ждём 12:00, найм в обеденное окно')
  } else if (phase === 'wait_midday' && m.type === 'state') {
    const h = parseInt(m.clock.slice(0, 2), 10)
    if (h >= 12 && h < 15) {
      // Найм в 12:00: 36 продуктивных тиков (12 под жаждой ×0.85 и 24 под
      // жаждой и голодом ×0.7225) — у обычного сотрудника (7..11 $/тик)
      // это максимум ~$300 при дефиците $345, вечер гарантированно в долг.
      ws.send(JSON.stringify({ type: 'hire', office: 0 }))
      phase = 'wait_debt'
      console.log(`… наняли в ${m.clock}, ждём конец дня и отчёт с долгом`)
    }
  } else if (phase === 'wait_debt' && m.type === 'day_report') {
    if (m.balance >= 0) {
      fail(`хардкор: ждали отрицательный баланс дня (сид ${SEED}) — ролл найма, возьмите другой SEED`, m)
    }
    if (!m.events.some((e) => e.includes('кредит'))) fail('в отчёте нет строки кредита', m.events)
    if (Math.abs(m.balance) > 10000) fail('долг за кредитным порогом', m)
    ok(`долг живой: баланс ${m.balance}, проценты в логе (${m.events.at(-1)})`)
    ws.send(JSON.stringify({ type: 'next_day' }))
    phase = 'day2'
  } else if (phase === 'day2' && m.type === 'state' && m.day === 2 && m.phase === 'running') {
    if (m.marketToday !== prevTomorrow) {
      fail('вчерашнее «завтра» не стало «сегодня»', { prevTomorrow, today: m.marketToday })
    }
    if (!SWING.includes(m.marketToday) || !SWING.includes(m.marketTomorrow)) {
      fail('рынок дня 2 вне сетки ±15%', m)
    }
    ok(`день 2 идёт из долга, рынок ${m.marketToday}% (вчерашний прогноз), завтра ${m.marketTomorrow}%`)
    ws.onclose = null // закрытие тут — часть сценария, а не авария
    ws.send(JSON.stringify({ type: 'abandon' }))
    ws.close()
    clearTimeout(timeout)
    normalCheck()
  }
}

function normalCheck() {
  const ws2 = new WebSocket(`ws://localhost:8091/ws?difficulty=normal&seed=${SEED}`)
  const to = setTimeout(() => fail('норма: таймаут 20с', {}), 20_000)
  ws2.onerror = () => fail('WebSocket error — сервер запущен на :8091?', null)
  ws2.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.type !== 'state') return
    const checks = {
      creditLimit: m.creditLimit === 0,
      creditRatePct: m.creditRatePct === 0,
      winDayLimit: m.winDayLimit === 0,
      winStaff: m.winStaff === 0,
      winCore: m.winCore === 0,
      winTarget: m.winTarget === 250000,
      marketToday: m.marketToday === 0,
      marketTomorrow: m.marketTomorrow === 0,
    }
    for (const [k, v] of Object.entries(checks)) if (!v) fail(`норма state.${k}`, m)
    ok('норма: без кредита, рынка и дедлайна — как до итерации 17')
    ws2.close()
    clearTimeout(to)
    console.log(`\nDIFFICULTY2 OK — ${step} проверок`)
  }
}
