// Живая проверка сейвов/реконнекта/офлайна (ITGAME-8).
// Запуск: go run ./cmd/server -addr :8091 (из server/), затем
//   node scripts/live-check-saves.mjs          — быстрый сценарий (~5с)
//   OFFLINE=1 node scripts/live-check-saves.mjs — плюс офлайн-догон (~70с)
const BASE = 'ws://localhost:8091/ws'
const SID = 'live-saves-' + Date.now().toString(36)

let step = 0
const ok = (name) => console.log(`ok ${++step} — ${name}`)
const fail = (name, got) => {
  console.error(`FAIL — ${name}:`, got)
  process.exit(1)
}

function connect(query) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BASE + query)
    ws.once = []
    ws.onmessage = (ev) => ws.once.forEach((h) => h(JSON.parse(ev.data)))
    ws.onopen = () => resolve(ws)
    ws.onerror = () => reject(new Error('WS error — сервер запущен на :8091?'))
  })
}

function next(ws, pred, what) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('таймаут: ' + what)), 30_000)
    const handler = (m) => {
      if (!pred(m)) return
      clearTimeout(timer)
      ws.once = ws.once.filter((h) => h !== handler)
      resolve(m)
    }
    ws.once.push(handler)
  })
}

const main = async () => {
  // 1. Новая игра с sid.
  const a = await connect(`?difficulty=normal&sid=${SID}`)
  const first = await next(a, (m) => m.type === 'state', 'первый снапшот')
  if (first.resumed !== false || first.money !== 600) fail('новая игра', first)
  ok('новая игра: $600, не resumed')

  // 2. Найм — прогресс в сейве.
  a.send(JSON.stringify({ type: 'hire', office: 0 }))
  const hired = await next(a, (m) => m.type === 'state' && m.offices[0].employees.length === 1, 'найм')
  ok(`найм: ${hired.offices[0].employees[0].name}, баланс $${hired.money}`)

  // 3. Обрыв и реконнект с тем же sid: тихий resume без потери прогресса.
  a.close()
  const b = await connect(`?difficulty=hardcore&sid=${SID}`) // сложность игнорируется при resume
  const resumed = await next(b, (m) => m.type === 'state', 'resumed-снапшот')
  if (!resumed.resumed) fail('resumed-флаг', resumed)
  if (resumed.money !== hired.money || resumed.offices[0].employees.length !== 1) {
    fail('прогресс после реконнекта', { was: hired.money, now: resumed.money })
  }
  if (resumed.difficulty !== 'normal') fail('сложность должна прийти из сейва', resumed.difficulty)
  ok(`реконнект: тот же баланс $${resumed.money}, тот же сотрудник, сложность из сейва`)

  // 4. Офлайн-догон: рвём соединение и живём без него (по умолчанию ~10с —
  // тиков хватает только на текущий день; OFFLINE=1 ждёт полного дня+).
  b.close()
  const gapMs = process.env.OFFLINE ? 70_000 : 10_000
  console.log(`… офлайн ${gapMs / 1000}с`)
  await new Promise((r) => setTimeout(r, gapMs))
  const c = await connect(`?sid=${SID}`)
  const back = await next(c, (m) => m.type === 'state', 'возврат')
  if (!back.resumed) fail('resumed после офлайна', back)
  if (back.money <= resumed.money) fail('офлайн-доход не начислен', { before: resumed.money, after: back.money })
  ok(`офлайн-догон: $${resumed.money} → $${back.money} (день ${back.day}, ${back.clock})`)
  if (process.env.OFFLINE) {
    const rep = await next(c, (m) => m.type === 'offline_report', 'offline_report')
    if (rep.days < 1 || rep.income <= 0) fail('offline_report', rep)
    ok(`offline_report: ${rep.days} дн., доход $${rep.income}, ФОТ $${rep.payroll}, баланс $${rep.balance}`)
  }

  // 5. Дубликат вкладки забирает сессию, старому соединению — session_taken.
  let closed = null
  // подписка ДО захвата: close летит сразу
  c.onclose = (ev) => { closed = ev.reason }
  const d = await connect(`?sid=${SID}`)
  const stolen = await next(d, (m) => m.type === 'state' && m.resumed, 'перехват сессии')
  if (stolen.offices[0].employees.length !== 1) fail('перехватил не ту сессию', stolen)
  await new Promise((r) => setTimeout(r, 1500))
  if (!String(closed).includes('session_taken')) fail('первое соединение не закрыто session_taken', closed)
  ok('дубликат вкладки: сессия у новой, старая закрыта с session_taken')

  // 6. abandon: сейв удалён, следующий заход — новая игра.
  d.send(JSON.stringify({ type: 'abandon' }))
  await new Promise((r) => setTimeout(r, 500))
  const e = await connect(`?sid=${SID}`)
  const fresh = await next(e, (m) => m.type === 'state', 'снапшот после abandon')
  if (fresh.resumed || fresh.money !== 600 || fresh.offices[0].employees.length !== 0) {
    fail('после abandon ждём новую игру', fresh)
  }
  ok('abandon: сейв удалён, новая игра с $600')
  e.close()

  console.log('ПРОТОКОЛ ОК')
  process.exit(0)
}

main().catch((err) => fail('сценарий', err.message))
