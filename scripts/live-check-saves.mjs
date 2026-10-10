// Живая проверка сейвов/реконнекта/офлайна (ITGAME-8) и версии состояния
// rev/cause, переживающей resume (ITGAME-45).
// Запуск: go run ./cmd/server -addr :8091 (из server/), затем
//   node scripts/live-check-saves.mjs          — быстрый сценарий (~12с)
//   OFFLINE=1 node scripts/live-check-saves.mjs — плюс офлайн-догон (~70с)
//   PORT=4402 node scripts/live-check-saves.mjs — сервер не на :8091
const BASE = `ws://localhost:${process.env.PORT || 8091}/ws`
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
    ws.lastRev = 0 // rev последнего state этого соединения (ITGAME-45)
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.type === 'state') ws.lastRev = m.rev
      ws.once.forEach((h) => h(m))
    }
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
  if (first.rev !== 1 || first.cause !== 'start') fail('rev/cause новой игры', { rev: first.rev, cause: first.cause })
  ok('новая игра: $600, не resumed, rev 1 cause start')

  // 2. Найм — прогресс в сейве; ответ на команду — state с re = id.
  a.send(JSON.stringify({ type: 'hire', office: 0, id: 1 }))
  const hired = await next(a, (m) => m.type === 'state' && m.re === 1, 'найм')
  if (hired.offices[0].employees.length !== 1 || hired.cause !== 'cmd') fail('найм с re', hired)
  ok(`найм: ${hired.offices[0].employees[0].name}, баланс $${hired.money}, rev ${hired.rev}`)

  // 3. Обрыв и реконнект с тем же sid: тихий resume без потери прогресса.
  const revA = a.lastRev
  a.close()
  const b = await connect(`?difficulty=hardcore&sid=${SID}`) // сложность игнорируется при resume
  const resumed = await next(b, (m) => m.type === 'state', 'resumed-снапшот')
  if (!resumed.resumed) fail('resumed-флаг', resumed)
  if (resumed.money !== hired.money || resumed.offices[0].employees.length !== 1) {
    fail('прогресс после реконнекта', { was: hired.money, now: resumed.money })
  }
  if (resumed.difficulty !== 'normal') fail('сложность должна прийти из сейва', resumed.difficulty)
  if (resumed.cause !== 'resume' || !(resumed.rev > revA)) fail('rev после реконнекта', { was: revA, now: resumed.rev, cause: resumed.cause })
  ok(`реконнект: тот же баланс $${resumed.money}, тот же сотрудник, сложность из сейва, rev ${revA} → ${resumed.rev} (resume)`)

  // 4. Офлайн-догон: рвём соединение и живём без него (по умолчанию ~10с —
  // тиков хватает только на текущий день; OFFLINE=1 ждёт полного дня+).
  await new Promise((r) => setTimeout(r, 1500)) // пара тиков вживую: rev растёт и в сейве
  const revB = b.lastRev
  b.close()
  const gapMs = process.env.OFFLINE ? 70_000 : 10_000
  console.log(`… офлайн ${gapMs / 1000}с`)
  await new Promise((r) => setTimeout(r, gapMs))
  const c = await connect(`?sid=${SID}`)
  const back = await next(c, (m) => m.type === 'state', 'возврат')
  if (!back.resumed) fail('resumed после офлайна', back)
  if (back.money <= resumed.money) fail('офлайн-доход не начислен', { before: resumed.money, after: back.money })
  if (back.cause !== 'resume' || !(back.rev > revB)) fail('rev после офлайна', { was: revB, now: back.rev, cause: back.cause })
  ok(`офлайн-догон: $${resumed.money} → $${back.money} (день ${back.day}, ${back.clock}), rev ${revB} → ${back.rev}`)
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
  if (fresh.rev !== 1 || fresh.cause !== 'start') fail('rev новой партии после abandon', { rev: fresh.rev, cause: fresh.cause })
  ok('abandon: сейв удалён, новая игра с $600, rev снова 1 (start)')
  e.close()

  console.log('ПРОТОКОЛ ОК')
  process.exit(0)
}

main().catch((err) => fail('сценарий', err.message))
