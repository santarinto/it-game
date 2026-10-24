// load-bots — нагрузка сервера игры ботами-партиями поверх /ws (ITGAME-193).
//
//   node scripts/load-bots.mjs --base wss://stage.itgame.santarinto.ru --steps 10:180,25:180,50:300
//
// Каждый бот — своя партия: свой sid (loadbot-<run>-<i>), сложности по кругу
// easy/normal/hard/hardcore, темп 3. Решает по каждому снапшоту не больше одной
// команды: next_day на отчёте дня, событие — первый вариант (не по карману —
// следующий), вирус и поломка — клики по месту, мёртвый ПК — замена, затем ПК и
// найм в пределах staffLimit, пока хватает денег; банкротство — restart, победа —
// новая партия под новым sid. На паузе отчёта снапшоты не идут — сторож раз в
// секунду решает по последнему, если полторы секунды тихо. Ступени
// «боты:секунды» наращивают число ботов; после последней все отключаются.
// Раз в 10 с — строка сводки: боты на связи, снапшоты/с, команды/с, отказы,
// переподключения. Ctrl+C — отключить всех и выйти.
//
// Прод (адрес без «stage» и не localhost) — только с --allow-prod: прод и
// стейдж живут на одном боксе, нагрузку смотрят на стейдже.

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? 'true' : all[i + 1]])
    return acc
  }, []),
)
const die = (msg) => {
  console.error(`LOAD-BOTS: ${msg}`)
  process.exit(2)
}

const base = (args.base || '').replace(/\/+$/, '')
if (!/^wss?:\/\//.test(base)) die('нужен --base ws(s)://хост, например wss://stage.itgame.santarinto.ru')
const host = new URL(base).hostname
if (!/stage|localhost|127\.0\.0\.1/.test(host) && args['allow-prod'] !== 'true') {
  die(`${host} похож на прод — нагрузку гоняют на стейдже; --allow-prod, если это осознанно`)
}
const steps = (args.steps || '10:60').split(',').map((s) => {
  const [n, sec] = s.split(':').map(Number)
  if (!(n > 0) || !(sec > 0)) die(`ступень «${s}» — нужно боты:секунды`)
  return { n, sec }
})
const run = args.run || Date.now().toString(36)
const DIFFS = ['easy', 'normal', 'hard', 'hardcore']

const stats = { states: 0, cmds: 0, rejected: 0, reconnects: 0, wins: 0, restarts: 0, errors: 0 }
const rejectCodes = new Map()
const bots = []
let stopping = false

class Bot {
  constructor(i) {
    this.i = i
    this.gen = 0
    this.diff = DIFFS[i % DIFFS.length]
    this.nextId = 0
    this.inFlight = 0 // id команды без квитанции; 0 — можно слать
    this.inFlightType = ''
    this.eventSlot = 0 // вариант события; растёт на отказе
    this.sentAt = 0
    this.last = null // последний снапшот
    this.lastAt = 0
    this.connect()
    // Сторож: на паузе (отчёт дня) снапшоты не идут, и отказ wrong_phase на команду,
    // ушедшую до конца дня, оставлял бота молчать навсегда — решить по последнему.
    this.watchdog = setInterval(() => {
      if (!this.open || !this.last) return
      if (this.inFlight && Date.now() - this.sentAt > 3000) this.inFlight = 0
      if (!this.inFlight && Date.now() - this.lastAt > 1500) this.decide(this.last)
    }, 1000)
  }

  get sid() {
    return `loadbot-${run}-${this.i}-${this.gen}`
  }

  connect() {
    if (stopping) return
    this.ws = new WebSocket(`${base}/ws?difficulty=${this.diff}&sid=${encodeURIComponent(this.sid)}&client=bot`)
    this.open = false
    this.ws.onopen = () => (this.open = true)
    this.ws.onmessage = (ev) => this.onMessage(JSON.parse(ev.data))
    this.ws.onerror = () => stats.errors++
    this.ws.onclose = () => {
      this.open = false
      if (stopping || this.closing) return
      stats.reconnects++
      setTimeout(() => this.connect(), 1000 + Math.random() * 2000)
    }
  }

  close() {
    clearInterval(this.watchdog)
    this.closing = true
    try {
      this.ws.close()
    } catch {
      // уже закрыт
    }
  }

  send(type, office = 0, extra = {}) {
    const id = ++this.nextId
    this.ws.send(JSON.stringify({ type, office, ...extra, id }))
    this.inFlight = id
    this.inFlightType = type
    this.sentAt = Date.now()
    stats.cmds++
  }

  onMessage(m) {
    if (m.type === 'error') {
      stats.rejected++
      const k = `${m.re === this.inFlight ? this.inFlightType : '?'}:${m.code}`
      rejectCodes.set(k, (rejectCodes.get(k) || 0) + 1)
      // событие не по карману — в следующий раз другой вариант
      if (m.re === this.inFlight && this.inFlightType === 'event_choice') this.eventSlot++
      if (m.re === this.inFlight) this.inFlight = 0
      return
    }
    if (m.type !== 'state') return
    stats.states++
    this.last = m
    this.lastAt = Date.now()
    if (m.re && m.re === this.inFlight) this.inFlight = 0
    // квитанция потерялась (команда без state, например) — не залипать навсегда
    if (this.inFlight && Date.now() - this.sentAt > 3000) this.inFlight = 0
    if (!this.open || this.inFlight) return
    this.decide(m)
  }

  decide(s) {
    if (s.phase === 'day_report') return this.send('next_day')
    if (s.phase === 'game_over') {
      stats.restarts++
      return this.send('restart')
    }
    if (s.phase === 'won') {
      stats.wins++
      const old = this.ws
      old.onclose = null // свой уход, не обрыв: без переподключения старого sid
      old.close()
      this.open = false
      this.last = null
      this.gen++
      return setTimeout(() => this.connect(), 500)
    }
    if (s.phase !== 'running') return
    if (s.speed !== 3) return this.send('set_speed', 0, { speed: 3 })
    if (!s.activeEvent) this.eventSlot = 0
    else return this.send('event_choice', 0, { slot: this.eventSlot % s.activeEvent.options.length })
    const money = s.money
    for (let o = 0; o < s.offices.length; o++) {
      const off = s.offices[o]
      if (!off.unlocked) continue
      for (let i = 0; i < off.employees.length; i++) {
        const e = off.employees[i]
        if (e.infected && e.virusNeeded > 0) return this.send('virus_click', o, { slot: i })
        const wp = off.workplaces?.[i]
        if (wp?.dead) {
          if (money >= (s.prices.pcReplace)) return this.send('replace_pc', o, { slot: i })
          continue
        }
        if (e.pcBroken && e.repairNeeded > 0) return this.send('repair_click', o, { slot: i })
      }
    }
    const off = s.offices[0]
    const staff = s.offices.reduce((n, x) => n + x.employees.length, 0)
    const roomForStaff = !(s.staffLimit > 0) || staff < s.staffLimit
    if (roomForStaff && off.pcs > off.employees.length && money >= s.prices.hire * 1.5) return this.send('hire', 0)
    if (roomForStaff && off.nextPC > 0 && off.pcs <= off.employees.length && money >= off.nextPC * 1.3) return this.send('buy_pc', 0)
  }
}

function summary(label) {
  const live = bots.filter((b) => b.open).length
  const codes = [...rejectCodes].map(([c, n]) => `${c}:${n}`).join(' ')
  console.log(
    `${new Date().toISOString().slice(11, 19)} ${label} боты ${live}/${bots.length} · снапшоты ${(stats.states / 10).toFixed(1)}/с · команды ${(stats.cmds / 10).toFixed(1)}/с · отказы ${stats.rejected}${codes ? ` (${codes})` : ''} · переподкл ${stats.reconnects} · restart ${stats.restarts} · побед ${stats.wins} · ошибок ${stats.errors}`,
  )
  Object.assign(stats, { states: 0, cmds: 0, rejected: 0, reconnects: 0, errors: 0 })
  rejectCodes.clear()
}

function stopAll(code = 0) {
  stopping = true
  bots.forEach((b) => b.close())
  setTimeout(() => process.exit(code), 500)
}
process.on('SIGINT', () => {
  console.log('LOAD-BOTS: Ctrl+C — отключаю ботов')
  stopAll(130)
})

console.log(`LOAD-BOTS: ${base}, прогон ${run}, ступени ${steps.map((s) => `${s.n}×${s.sec}с`).join(' → ')}`)
let label = ''
const tick = setInterval(() => summary(label), 10_000)
for (const [k, st] of steps.entries()) {
  label = `[ступень ${k + 1}: ${st.n}]`
  while (bots.length < st.n) {
    bots.push(new Bot(bots.length))
    await new Promise((r) => setTimeout(r, 200)) // не все разом: рукопожатия TLS
  }
  console.log(`LOAD-BOTS: ${label} — ${st.n} ботов, ${st.sec} с`)
  await new Promise((r) => setTimeout(r, st.sec * 1000))
}
clearInterval(tick)
summary(label)
console.log('LOAD-BOTS: ступени пройдены — отключаю ботов')
stopAll(0)
