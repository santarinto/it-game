// Живая проверка событий «Unseen Forces» (итерация 10) против реального
// сервера. Запуск: go run ./cmd/server -addr :8091 (из server/), затем
//   node scripts/live-check-events.mjs
// Другой порт сервера — PORT=8191.
//
// Детерминированная часть: день 1 без событий, event_choice/no_event,
// поле salary, events в отчёте. Само событие — шанс 75%/день: ждём до
// 3 дней. С фиксированным сидом прогон воспроизводим целиком; на другом
// SEED событие может не выпасть или партия обанкротится — скрипт честно
// падает с причиной, а не висит до таймаута.
let step = 0
const ok = (name) => console.log(`ok ${++step} — ${name}`)
const fail = (name, got) => {
  console.error(`FAIL — ${name}:`, got)
  process.exit(1)
}

// Фиксированный сид (ITGAME-26): ролл событий, поломок и выработки
// воспроизводим — без него прогон мог обанкротиться (один сотрудник,
// тонкий баланс) и висел до таймаута. SEED=… — проверить другой сид.
// Сид 3 перепроверен 09.10.2026 после ITGAME-50 (аудит убран из дней 2–4):
// «Дедлайн от бизнеса» на день 2, прогон ~36 с. Проверка принимает ЛЮБОЕ
// событие на днях 2–4; имя — справочная заметка, не утверждение (см. EXPECT).
// Подобрать другой сид: make sim ARGS="--diff normal --seed 1..50 --days 4
// --policy greedy --events-text", затем подтвердить живым прогоном.
const SEED = process.env.SEED ?? '3'
// Мягкое ожидание: если событие называется иначе — строка note, не падение
// (дрейф пула виден, проверка не хрупкая). EXPECT='' отключает заметку.
const EXPECT = process.env.EXPECT ?? 'Дедлайн'
const PORT = process.env.PORT ?? '8091'
const ws = new WebSocket(`ws://localhost:${PORT}/ws?difficulty=normal&seed=${SEED}`)
let phase = 'start'
let lastState = null
const timeout = setTimeout(
  () => fail(`таймаут 240с (сид ${SEED})`, { phase, day: lastState?.day }),
  240_000,
)
ws.onclose = () => fail('соединение закрылось до конца проверки', { phase })

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.type === 'state') lastState = m
  if (m.type === 'game_over') {
    // Сценарий не рассчитан на финал: без этой ветки скрипт молча ждал
    // таймаут 240с. Банкротство здесь — ролл, а не баг протокола.
    fail(`финал партии раньше конца сценария (сид ${SEED}) — возьмите другой SEED`, m)
  }
  if (phase === 'start' && m.type === 'state') {
    ws.send(JSON.stringify({ type: 'set_speed', speed: 3 })) // день ~18с
    phase = 'speed'
  } else if (phase === 'speed' && m.type === 'state' && m.speed === 3) {
    ws.send(JSON.stringify({ type: 'hire', office: 0 }))
    phase = 'day1'
    console.log('… день 1 идёт (3x): событий быть не должно')
  } else if (phase === 'day1' && m.type === 'state' && m.activeEvent) {
    fail('день 1 без событий — онбординг', m.activeEvent)
  } else if (phase === 'day1' && m.type === 'day_report') {
    if (!Array.isArray(m.events)) fail('events отчёта дня 1 — не массив', m.events)
    ok(`день 1 без событий, отчёт events=${JSON.stringify(m.events)}`)
    ws.send(JSON.stringify({ type: 'next_day' }))
    phase = 'wait_event'
    console.log('… ждём событие (до 3 дней, шанс 75%/день)')
  } else if (phase === 'wait_event' && m.type === 'state' && m.activeEvent) {
    const ev = m.activeEvent
    if (!ev.title || !ev.text || !Array.isArray(ev.options) || ev.options.length === 0) {
      fail('структура activeEvent', ev)
    }
    const e0 = m.offices[0].employees[0]
    if (typeof e0?.salary !== 'number' || e0.salary < 250) fail('employee.salary', e0)
    if (EXPECT && !ev.title.includes(EXPECT)) {
      console.log(`note — ждали «${EXPECT}», пришло «${ev.title}»`)
    }
    ok(`событие «${ev.title}» (день ${m.day}), ${ev.options.length} опц.; salary сотрудника $${e0.salary}`)
    ws.send(JSON.stringify({ type: 'event_choice', slot: 0 }))
    phase = 'chosen'
  } else if (phase === 'chosen' && m.type === 'state' && !m.activeEvent && m.phase === 'running') {
    ok('event_choice закрыл событие')
    ws.send(JSON.stringify({ type: 'event_choice', slot: 0 }))
    phase = 'no_event'
  } else if (phase === 'no_event' && m.type === 'error') {
    if (m.code !== 'no_event') fail('повторный выбор', m.code)
    ok('повторный выбор: error no_event')
    phase = 'wait_report'
    console.log('… ждём конца дня за логом событий')
  } else if (phase === 'wait_event' && m.type === 'day_report') {
    // Дни без события: продолжаем ждать, всего не больше 3.
    if (m.day >= 4) fail('события не выпали за 3 дня (75%/день) — повторить прогон', { day: m.day })
    ws.send(JSON.stringify({ type: 'next_day' }))
  } else if (phase === 'wait_report' && m.type === 'day_report') {
    if (!Array.isArray(m.events)) fail('events отчёта — не массив', m.events)
    ok(`отчёт дня ${m.day}: events=${JSON.stringify(m.events)}`)
    clearTimeout(timeout)
    console.log('СОБЫТИЯ UNSEEN FORCES ОК')
    process.exit(0)
  }
}
ws.onerror = () => fail(`WebSocket error — сервер запущен на :${PORT}?`, null)
