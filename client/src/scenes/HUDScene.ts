import Phaser from 'phaser'
import { GAME_H, GAME_W, HUD_H, NAV_W } from '../layout'
import { client } from '../net'
import type { DayReportMessage, GameOverMessage, OfflineReportMessage, StateMessage, VictoryMessage } from '../protocol'
import { fmtMoney } from '../format'
import { nav } from '../rooms'
import { debug, drawDebugFrames, setDebug } from '../debug'
import { showModal } from '../ui/modal'
import { playSfx } from '../audio'

const CX = GAME_W / 2 // центр поля — якорь модалок и тостов

const ERROR_TEXTS: Record<string, string> = {
  not_enough_money: 'Не хватает денег',
  no_free_office_slot: 'В офисе нет свободных мест',
  no_free_pc: 'Нет свободного ПК — купите ПК',
  no_free_rack_slot: 'У офиса нет свободных стоек',
  router_maxed: 'Роутер уже максимального тира',
  unknown_command: 'Неизвестная команда',
  wrong_phase: 'Сейчас нельзя — дождитесь начала дня',
  staff_limit: 'Наймите начальника — он откроет ещё 3 места',
  office_locked: 'Этот офис ещё не куплен',
  boss_already: 'Начальник уже нанят',
  offices_maxed: 'Все офисы уже куплены',
  gateway_already: 'Шлюз уже установлен',
  bad_office: 'Нет такого офиса',
  bad_speed: 'Нет такой скорости',
  bad_slot: 'Нет такой стойки',
  server_maxed: 'Серверная стойка уже максимального уровня',
  core_maxed: 'Стойка роутеров уже максимального уровня',
  motivate_cooldown: 'Мотивация ещё не готова',
  not_broken: 'ПК не сломан',
  no_event: 'Событие уже закрыто',
  bad_option: 'Нет такого варианта',
}

interface Button {
  setLabel(s: string): void
}

export class HUDScene extends Phaser.Scene {
  private moneyText!: Phaser.GameObjects.Text
  private incomeText!: Phaser.GameObjects.Text
  private netText!: Phaser.GameObjects.Text
  private payrollText!: Phaser.GameObjects.Text
  private dayText!: Phaser.GameObjects.Text
  private goalText!: Phaser.GameObjects.Text
  private dayProfitText!: Phaser.GameObjects.Text
  private marketText!: Phaser.GameObjects.Text
  private debtText!: Phaser.GameObjects.Text
  private pcBtn!: Button
  private hireBtn!: Button
  private bossBtn!: Button
  private gatewayBtn!: Button
  private navItems: { bg: Phaser.GameObjects.Rectangle; label: Phaser.GameObjects.Text; sub: Phaser.GameObjects.Text }[] = []
  private currentRoom: 'office' | 'serverRoom' = 'office'
  private reportUI: Phaser.GameObjects.GameObject[] = []
  private eventUI: Phaser.GameObjects.GameObject[] = []
  private gameOverUI: Phaser.GameObjects.GameObject[] = []
  private victoryUI: Phaser.GameObjects.GameObject[] = []
  private skipReports = localStorage.getItem('skipReports') === '1'
  private switching = false
  private speedBtns: { bg: Phaser.GameObjects.Rectangle; speed: number }[] = []
  private hudInteractive: Phaser.GameObjects.GameObject[] = []
  private debugFrames: Phaser.GameObjects.GameObject[] = []
  private reconnectUI: Phaser.GameObjects.GameObject[] = []
  private offlineUI: Phaser.GameObjects.GameObject[] = []

  constructor() {
    super('hud')
  }

  create() {
    // Верхняя панель.
    this.add.rectangle(0, 0, GAME_W, HUD_H, 0x14162b).setOrigin(0)
    this.moneyText = this.add.text(16, 10, '$…', {
      fontFamily: 'monospace', fontSize: '26px', color: '#ffcd75',
    })
    this.incomeText = this.add.text(16, 44, '', {
      fontFamily: 'monospace', fontSize: '15px', color: '#38b764',
    })
    this.netText = this.add.text(16, 66, '', {
      fontFamily: 'monospace', fontSize: '15px', color: '#41a6f6',
    })
    this.payrollText = this.add.text(200, 44, '', {
      fontFamily: 'monospace', fontSize: '15px', color: '#5d7275',
    })
    this.dayText = this.add
      .text(GAME_W - 16, 70, '', { fontFamily: 'monospace', fontSize: '13px', color: '#5d7275' })
      .setOrigin(1, 0)
    this.goalText = this.add
      .text(GAME_W - 16, 52, '', { fontFamily: 'monospace', fontSize: '13px', color: '#ffcd75' })
      .setOrigin(1, 0)
    // Рынок дня (сложность 2.0): сегодня и завтра, тренд виден заранее.
    this.marketText = this.add
      .text(GAME_W - 16, 86, '', { fontFamily: 'monospace', fontSize: '12px', color: '#5d7275' })
      .setOrigin(1, 0)
    // Долг по кредиту (сложность 2.0): виден только в минусе.
    this.debtText = this.add.text(16, 84, '', {
      fontFamily: 'monospace', fontSize: '12px', color: '#b13e53',
    })
    // Темп дня одним взглядом: прогноз прибыли «сейчас до вечера».
    this.dayProfitText = this.add.text(200, 66, '', {
      fontFamily: 'monospace', fontSize: '15px', color: '#38b764',
    })

    this.pcBtn = this.makeButton(420, 10, () => {
      playSfx(this, 'select')
      client.send('buy_pc', nav.activeOffice)
    })
    this.hireBtn = this.makeButton(420, 52, () => {
      playSfx(this, 'select')
      client.send('hire', nav.activeOffice)
    })
    this.bossBtn = this.makeButton(640, 10, () => {
      playSfx(this, 'select')
      client.send('hire_boss', nav.activeOffice)
    })
    this.gatewayBtn = this.makeButton(640, 52, () => {
      playSfx(this, 'select')
      client.send('buy_gateway')
    })

    // Темп времени: пауза и множители. Активная кнопка подсвечивается по speed
    // из снапшота — сервер источник истины.
    const speeds = [
      { s: 0, label: '⏸' }, { s: 1, label: '1x' }, { s: 2, label: '2x' }, { s: 3, label: '3x' },
    ]
    speeds.forEach((sp, i) => {
      const x = GAME_W - 176 + i * 40
      const bg = this.add.rectangle(x, 10, 36, 28, 0x232640)
        .setOrigin(0).setStrokeStyle(2, 0x3a3f5c).setInteractive({ useHandCursor: true })
      this.add.text(x + 18, 24, sp.label, { fontFamily: 'monospace', fontSize: '13px', color: '#f4f4f4' }).setOrigin(0.5)
      bg.on('pointerdown', () => client.send('set_speed', 0, { speed: sp.s }))
      this.speedBtns.push({ bg, speed: sp.s })
      this.hudInteractive.push(bg)
    })
    // Выход в меню из игры (анти-софтлок + «сдаться»): с подтверждением.
    const menuBg = this.add.rectangle(GAME_W - 220, 10, 36, 28, 0x232640)
      .setOrigin(0).setStrokeStyle(2, 0x3a3f5c).setInteractive({ useHandCursor: true })
    this.add.text(GAME_W - 202, 24, '⌂', { fontFamily: 'monospace', fontSize: '14px', color: '#f4f4f4' }).setOrigin(0.5)
    menuBg.on('pointerdown', () => this.confirmExitToMenu())
    menuBg.on('pointerover', () => menuBg.setStrokeStyle(2, 0xb13e53))
    menuBg.on('pointerout', () => menuBg.setStrokeStyle(2, 0x3a3f5c))
    this.hudInteractive.push(menuBg)
    // Тумблер debug: рамки интерактивных зон во всех сценах.
    const dbg = this.add
      .text(GAME_W - 280, 17, this.debugLabel(), { fontFamily: 'monospace', fontSize: '12px', color: '#5d7275' })
      .setInteractive({ useHandCursor: true })
    dbg.on('pointerdown', () => {
      setDebug(!debug.enabled)
      dbg.setText(this.debugLabel())
      client.reemit() // сцены перерисуются по последнему снапшоту
    })
    this.hudInteractive.push(dbg)

    this.createNavPanel()

    const unsub = client.subscribe({
      onState: (s) => this.refresh(s),
      onError: (code) => {
        playSfx(this, 'error')
        this.toast(ERROR_TEXTS[code] ?? code)
      },
      onDisconnect: (reason) => this.showDisconnect(reason),
      onDayReport: (r) => this.onDayReport(r),
      onGameOver: (o) => this.showGameOver(o),
      onVictory: (v) => this.showVictory(v),
      onOfflineReport: (r) => this.showOfflineReport(r),
      onReconnecting: (n) => this.showReconnecting(n),
    })
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, unsub)
  }

  // Баннер реконнекта: деплой/сеть рвут WS — клиент возвращается сам,
  // сервер продолжает сессию по sid (ITGAME-8). Прячется первым снапшотом.
  private showReconnecting(attempt: number) {
    this.reconnectUI.forEach((o) => o.destroy())
    this.reconnectUI = []
    const bg = this.add.rectangle(CX, 130, 360, 30, 0x14162b).setStrokeStyle(2, 0xffcd75).setDepth(90)
    const txt = this.add
      .text(CX, 130, `Переподключение… (попытка ${attempt})`, {
        fontFamily: 'monospace', fontSize: '13px', color: '#ffcd75',
      })
      .setOrigin(0.5).setDepth(91)
    this.reconnectUI.push(bg, txt)
  }

  private showDisconnect(reason?: string) {
    this.reconnectUI.forEach((o) => o.destroy())
    this.reconnectUI = []
    const taken = reason === 'session_taken'
    this.add.rectangle(0, 0, GAME_W, GAME_H, 0x1a1c2c, 0.85).setOrigin(0).setDepth(100)
    this.add
      .text(CX, 300, taken ? 'Игра открыта в другой вкладке' : 'Соединение потеряно', {
        fontFamily: 'monospace', fontSize: '26px', color: '#b13e53',
      })
      .setOrigin(0.5)
      .setDepth(101)
    this.add
      .text(CX, 344, taken
        ? 'Сессия обслуживает одно окно. Обновите страницу, чтобы забрать её сюда'
        : 'Обновите страницу — сохранённая игра продолжится с того же места', {
        fontFamily: 'monospace', fontSize: '15px', color: '#f4f4f4',
      })
      .setOrigin(0.5)
      .setDepth(101)
  }

  // «Пока вас не было»: итог офлайн-догона после реконнекта (ITGAME-8).
  // Финал офлайн (банкротство/победа) не дублируется обычными экранами —
  // его закрывает кнопка «В меню» прямо отсюда.
  private showOfflineReport(r: OfflineReportMessage) {
    playSfx(this, r.gameOver ? 'glitch' : r.victory ? 'confirmation' : 'bong')
    this.offlineUI.forEach((o) => o.destroy())
    const bankrupt = r.gameOver
    const finalLine = bankrupt
      ? r.reason === 'time_up'
        ? 'Срок вышел: цель не достигнута.'
        : 'Компания обанкротилась.'
      : r.victory
        ? 'Цель достигнута — победа!'
        : ''
    const body = [
      `Прошло дней: ${r.days}`,
      `Заработано: ${fmtMoney(r.income)}`,
      `Расходы:    −${fmtMoney(r.payroll)}`,
      `Баланс:      ${fmtMoney(r.balance)}`,
      ...(finalLine ? ['', finalLine] : []),
    ].join('\n')
    const overlay = this.add.rectangle(0, 0, GAME_W, GAME_H, 0x1a1c2c, 0.75).setOrigin(0).setDepth(55).setInteractive()
    const panel = this.add.rectangle(CX, 300, 440, 300, 0x14162b).setStrokeStyle(2, 0xffcd75).setDepth(56)
    const title = this.add
      .text(CX, 180, 'Пока вас не было', { fontFamily: 'monospace', fontSize: '22px', color: '#ffcd75' })
      .setOrigin(0.5).setDepth(56)
    const bodyText = this.add
      .text(CX, 280, body, { fontFamily: 'monospace', fontSize: '16px', color: '#f4f4f4', lineSpacing: 8 })
      .setOrigin(0.5).setDepth(56)
    const final = r.gameOver || r.victory
    this.offlineUI = [overlay, panel, title, bodyText]
    if (final) {
      const btnBg = this.add
        .rectangle(CX - 100, 392, 200, 34, 0x3b5dc9).setOrigin(0, 0).setDepth(56)
        .setInteractive({ useHandCursor: true })
      const btnText = this.add
        .text(CX, 409, 'В меню', { fontFamily: 'monospace', fontSize: '14px', color: '#f4f4f4' })
        .setOrigin(0.5).setDepth(57)
      btnBg.on('pointerdown', () => {
        this.closeOfflineReport()
        this.returnToMenu()
      })
      btnBg.on('pointerover', () => btnBg.setFillStyle(0x41a6f6))
      btnBg.on('pointerout', () => btnBg.setFillStyle(0x3b5dc9))
      this.offlineUI.push(btnBg, btnText)
    } else {
      const btnBg = this.add
        .rectangle(CX - 100, 392, 200, 34, 0x3b5dc9).setOrigin(0, 0).setDepth(56)
        .setInteractive({ useHandCursor: true })
      const btnText = this.add
        .text(CX, 409, 'Продолжить →', { fontFamily: 'monospace', fontSize: '14px', color: '#f4f4f4' })
        .setOrigin(0.5).setDepth(57)
      btnBg.on('pointerdown', () => this.closeOfflineReport())
      btnBg.on('pointerover', () => btnBg.setFillStyle(0x41a6f6))
      btnBg.on('pointerout', () => btnBg.setFillStyle(0x3b5dc9))
      this.offlineUI.push(btnBg, btnText)
    }
  }

  private closeOfflineReport() {
    this.offlineUI.forEach((o) => o.destroy())
    this.offlineUI = []
  }

  // Панель навигации: значки офисов и серверной в колонке слева.
  private createNavPanel() {
    this.add.rectangle(0, HUD_H, NAV_W, GAME_H - HUD_H, 0x14162b).setOrigin(0)
    const rooms: { key: 'office' | 'serverRoom'; office: number; label: string }[] = [
      { key: 'office', office: 0, label: 'О1' },
      { key: 'office', office: 1, label: 'О2' },
      { key: 'office', office: 2, label: 'О3' },
      { key: 'serverRoom', office: -1, label: 'СРВ' },
    ]
    rooms.forEach((r, idx) => {
      const y = HUD_H + 24 + idx * 76
      const bg = this.add.rectangle(8, y, NAV_W - 16, 48, 0x232640)
        .setOrigin(0).setStrokeStyle(2, 0x3a3f5c).setInteractive({ useHandCursor: true })
      const label = this.add
        .text(NAV_W / 2, y + 18, r.label, { fontFamily: 'monospace', fontSize: '13px', color: '#f4f4f4' })
        .setOrigin(0.5)
      const sub = this.add
        .text(NAV_W / 2, y + 36, '', { fontFamily: 'monospace', fontSize: '8px', color: '#5d7275' })
        .setOrigin(0.5)
      bg.on('pointerdown', () => this.switchRoom(r.key, r.office))
      this.navItems.push({ bg, label, sub })
      this.hudInteractive.push(bg)
    })
  }

  private switchRoom(key: 'office' | 'serverRoom', office: number) {
    // Дребезг: два быстрых клика до завершения stop/launch дублируют сцену.
    if (this.switching) return
    this.switching = true
    this.time.delayedCall(250, () => (this.switching = false))
    if (office >= 0) nav.activeOffice = office
    this.scene.stop(this.currentRoom)
    if (key === this.currentRoom && key === 'office') {
      this.scene.launch('office') // рестарт сцены офиса на новый activeOffice
    } else {
      this.scene.launch(key)
    }
    this.currentRoom = key
    this.highlightNav()
  }

  private highlightNav() {
    this.navItems.forEach((item, idx) => {
      const active = this.currentRoom === 'serverRoom' ? idx === 3 : idx === nav.activeOffice
      item.bg.setStrokeStyle(2, active ? 0x41a6f6 : 0x3a3f5c)
    })
  }

  // Цель уровня (сложность 2.0): деньги + комбо (штат/сеть) + дедлайн дней.
  private goalLabel(s: StateMessage): string {
    let goal = `Цель: ${fmtMoney(s.winTarget)}`
    if (s.winStaff > 0) goal += ` + ${s.winStaff} чел.`
    if (s.winCore > 0) goal += ` + core ур.${s.winCore}`
    if (s.winDayLimit > 0) goal += ` до дня ${s.winDayLimit}`
    return goal
  }

  private refresh(s: StateMessage) {
    // Живой снапшот = соединение восстановлено: баннер реконнекта долой.
    this.reconnectUI.forEach((o) => o.destroy())
    this.reconnectUI = []
    if (s.phase === 'running') {
      this.closeReport()
      this.closeGameOver()
      this.closeVictory()
    }
    const employees = s.offices.flatMap((o) => o.employees)
    const active = s.offices[nav.activeOffice]
    this.moneyText.setText(fmtMoney(s.money))
    this.moneyText.setColor(s.money < 0 ? '#b13e53' : '#ffcd75')
    this.incomeText.setText(`+${fmtMoney(s.incomePerTick)}/сек`)
    this.payrollText.setText(`Расходы ${fmtMoney(s.payrollPerDay)}/день`)
    // Прогноз считает сервер: клиент не знает про обеденные тики.
    this.payrollText.setColor(s.forecastEndOfDay < 0 ? '#b13e53' : '#5d7275')
    this.dayText.setText(`День ${s.day} · ${s.clock}${s.isLunch ? ' · обед' : ''}`)
    this.goalText.setText(this.goalLabel(s))
    // Рынок (сложность 2.0): качели выработки ±%, завтра виден заранее.
    if (s.marketToday !== 0 || s.marketTomorrow !== 0) {
      const pct = (v: number) => (v > 0 ? `+${v}` : `${v}`)
      this.marketText.setText(`Рынок ${pct(s.marketToday)}% · завтра ${pct(s.marketTomorrow)}%`)
      this.marketText.setColor(s.marketToday < 0 ? '#b13e53' : s.marketToday > 0 ? '#38b764' : '#5d7275')
    } else {
      this.marketText.setText('')
    }
    // Долг: минус в кредитных уровнях — не приговор, но проценты капают.
    if (s.money < 0 && s.creditLimit > 0) {
      this.debtText.setText(`Долг ${fmtMoney(s.money)} из ${fmtMoney(-s.creditLimit)} · ${s.creditRatePct}%/день`)
    } else {
      this.debtText.setText('')
    }
    // Прогноз считает сервер: остаток дохода дня минус вечерний ФОТ.
    const dayProfit = s.forecastEndOfDay - s.money
    this.dayProfitText.setText(`${dayProfit >= 0 ? '+' : ''}${fmtMoney(dayProfit)}/день`)
    this.dayProfitText.setColor(dayProfit >= 0 ? '#38b764' : '#b13e53')
    this.netText.setText(`Сотрудники: ${employees.length} · в сети ${s.core.connected}/${employees.length}`)
    this.pcBtn.setLabel(active.nextPC > 0 ? `Купить ПК  ${fmtMoney(active.nextPC)}` : 'Купить ПК — мест нет')
    this.hireBtn.setLabel(`Нанять  ${fmtMoney(s.prices.hire)}`)
    this.bossBtn.setLabel(active.boss === '' ? `Начальник  ${fmtMoney(s.prices.boss)}` : 'Начальник ✓')
    this.gatewayBtn.setLabel(s.gateway ? 'Шлюз ✓' : `Шлюз  ${fmtMoney(s.prices.gateway)}`)
    this.navItems.forEach((item, idx) => {
      if (idx === 3) return
      const o = s.offices[idx]
      item.sub.setText(o.unlocked ? `${o.employees.length}/${s.officeSlots}` : fmtMoney(o.price))
    })
    this.highlightNav()
    this.speedBtns.forEach((b) => b.bg.setStrokeStyle(2, b.speed === s.speed ? 0x41a6f6 : 0x3a3f5c))
    if (s.activeEvent && s.phase === 'running') {
      this.showEvent(s.activeEvent)
    } else {
      this.closeEvent() // отчёт дня/победа/банкротство глушат панель
    }
    this.checkHints(s)
    this.debugFrames.forEach((f) => f.destroy())
    this.debugFrames = drawDebugFrames(this, this.hudInteractive)
  }

  // Панель события Unseen Forces: не модальная — игра идёт дальше,
  // пока игрок думает (цифры обновляются с каждым снапшотом).
  private lastEventId = ''

  private showEvent(ev: NonNullable<StateMessage['activeEvent']>) {
    if (ev.id !== this.lastEventId) {
      this.lastEventId = ev.id
      playSfx(this, 'question')
    }
    this.closeEvent()
    const panel = this.add.rectangle(CX, 148, 480, 176, 0x14162b).setStrokeStyle(2, 0xffcd75).setDepth(40)
    const title = this.add
      .text(CX, 84, ev.title, { fontFamily: 'monospace', fontSize: '18px', color: '#ffcd75' })
      .setOrigin(0.5).setDepth(41)
    const body = this.add
      .text(CX, 148, ev.text, {
        fontFamily: 'monospace', fontSize: '13px', color: '#f4f4f4',
        align: 'center', wordWrap: { width: 440 }, lineSpacing: 4,
      })
      .setOrigin(0.5).setDepth(41)
    this.eventUI = [panel, title, body]
    const n = ev.options.length
    ev.options.forEach((label, i) => {
      const w = n > 1 ? 226 : 300
      const x = n > 1 ? CX - 232 + i * 238 : CX - w / 2
      const bg = this.add.rectangle(x, 196, w, 32, 0x3b5dc9).setOrigin(0, 0)
        .setDepth(41).setInteractive({ useHandCursor: true })
      const txt = this.add
        .text(x + w / 2, 212, label, { fontFamily: 'monospace', fontSize: '13px', color: '#f4f4f4' })
        .setOrigin(0.5).setDepth(42)
      bg.on('pointerdown', () => client.send('event_choice', 0, { slot: i }))
      bg.on('pointerover', () => bg.setFillStyle(0x41a6f6))
      bg.on('pointerout', () => bg.setFillStyle(0x3b5dc9))
      this.eventUI.push(bg, txt)
    })
  }

  private closeEvent() {
    this.eventUI.forEach((o) => o.destroy())
    this.eventUI = []
  }

  private makeButton(x: number, y: number, onClick: () => void): Button {
    const bg = this.add
      .rectangle(x, y, 200, 34, 0x3b5dc9)
      .setOrigin(0, 0)
      .setInteractive({ useHandCursor: true })
    const txt = this.add
      .text(x + 100, y + 17, '…', { fontFamily: 'monospace', fontSize: '14px', color: '#f4f4f4' })
      .setOrigin(0.5)
    bg.on('pointerdown', onClick)
    bg.on('pointerover', () => bg.setFillStyle(0x41a6f6))
    bg.on('pointerout', () => bg.setFillStyle(0x3b5dc9))
    this.hudInteractive.push(bg)
    return { setLabel: (s: string) => txt.setText(s) }
  }

  private toast(text: string, ms = 1500) {
    const t = this.add
      .text(CX, GAME_H - 40, text, {
        fontFamily: 'monospace', fontSize: '18px', color: '#f4f4f4',
        backgroundColor: '#b13e53', padding: { x: 12, y: 6 },
      })
      .setOrigin(0.5)
    this.tweens.add({ targets: t, alpha: 0, y: GAME_H - 80, duration: ms, delay: ms * 2, onComplete: () => t.destroy() })
  }

  // Онбординг-хинты (итерация 11): одноразовые тосты по триггерам.
  // Один хинт за снапшот — очередь не копится, следующий придёт своим ходом.
  private checkHints(s: StateMessage) {
    if (s.phase !== 'running') return
    const office = s.offices[nav.activeOffice]
    const emps = office.employees
    const anyEmp = s.offices.some((o) => o.employees.length > 0)
    const clockH = parseInt(s.clock.slice(0, 2), 10)
    const hints: { id: string; when: boolean; text: string }[] = [
      {
        id: 'master', when: s.offices.some((o) => o.employees.some((e) => e.pcBroken)),
        text: 'ПК сломан: доход места 0. Чините кликами по столу или мастером',
      },
      {
        id: 'router', when: emps.some((e) => e.offlineReason === 'no_router'),
        text: 'Сотрудник вне сети: роутер офиса ведёт к серверам (×1.2+). Купите роутер',
      },
      {
        id: 'core', when: emps.some((e) => e.offlineReason === 'no_core'),
        text: 'Мест в стойке роутеров (core) не хватило — расширьте её в серверной',
      },
      {
        id: 'server', when: emps.some((e) => e.offlineReason === 'no_server'),
        text: 'Core есть, но стойка не обслуживает сотрудника — купите серверную стойку',
      },
      {
        id: 'cooler', when: anyEmp && !office.cooler && clockH >= 12,
        text: 'Жажда −10% с 12:00 — кулер снимает дебафф',
      },
      {
        id: 'fridge', when: anyEmp && !office.fridge && clockH >= 15,
        text: 'Голод −10% после обеда — холодильник снимает дебафф',
      },
      {
        id: 'motivate', when: anyEmp && clockH >= 11,
        text: 'Клик по сотруднику мотивирует: +25% на 3 часа',
      },
      {
        id: 'softlock',
        when: !anyEmp && s.money < s.prices.hire,
        text: 'Нанять не на что, а дохода нет — сдаться и начать заново: кнопка ⌂',
      },
    ]
    const hint = hints.find((h) => h.when && !localStorage.getItem('hint:' + h.id))
    if (hint) {
      localStorage.setItem('hint:' + hint.id, '1')
      this.toast(hint.text, 2200)
    }
  }

  private onDayReport(r: DayReportMessage) {
    playSfx(this, r.profit >= 0 ? 'bong' : 'drop')
    if (this.skipReports) {
      client.send('next_day')
      this.toast(`День ${r.day}: прибыль ${fmtMoney(r.profit)} · баланс ${fmtMoney(r.balance)}`)
      return
    }
    this.showReport(r)
  }

  private showReport(r: DayReportMessage) {
    this.closeReport()
    const body = [
      `Доход:     ${fmtMoney(r.income)}`,
      `Зарплата: -${fmtMoney(r.payroll)}`,
      ...(r.gatewayOpex > 0 ? [`Интернет: -${fmtMoney(r.gatewayOpex)}`] : []),
      `Прибыль:   ${fmtMoney(r.profit)}`,
      `Баланс:    ${fmtMoney(r.balance)}`,
      ...(r.incidents > 0 ? [`Поломки:   ${r.incidents} (−${fmtMoney(r.lostIncome)})`] : []),
      ...(r.events?.length ? ['', 'События:', ...r.events.map((e) => `· ${e}`)] : []),
    ].join('\n')
    // Подложка interactive: глушит клики по кнопкам HUD под модалкой.
    const overlay = this.add.rectangle(0, 0, GAME_W, GAME_H, 0x1a1c2c, 0.75).setOrigin(0).setDepth(50).setInteractive()
    const panel = this.add.rectangle(CX, 300, 440, 320, 0x14162b).setStrokeStyle(2, 0x41a6f6).setDepth(51)
    const title = this.add
      .text(CX, 180, `День ${r.day} завершён`, { fontFamily: 'monospace', fontSize: '22px', color: '#ffcd75' })
      .setOrigin(0.5).setDepth(51)
    const bodyText = this.add
      .text(CX, 280, body, { fontFamily: 'monospace', fontSize: '16px', color: '#f4f4f4', lineSpacing: 8 })
      .setOrigin(0.5).setDepth(51)
    const checkbox = this.add
      .text(CX, 366, this.checkboxLabel(), { fontFamily: 'monospace', fontSize: '14px', color: '#5d7275' })
      .setOrigin(0.5).setDepth(51).setInteractive({ useHandCursor: true })
    checkbox.on('pointerdown', () => {
      this.skipReports = !this.skipReports
      localStorage.setItem('skipReports', this.skipReports ? '1' : '0')
      checkbox.setText(this.checkboxLabel())
    })
    const btnBg = this.add
      .rectangle(CX - 100, 400, 200, 34, 0x3b5dc9).setOrigin(0, 0).setDepth(51)
      .setInteractive({ useHandCursor: true })
    const btnText = this.add
      .text(CX, 417, 'Следующий день →', { fontFamily: 'monospace', fontSize: '14px', color: '#f4f4f4' })
      .setOrigin(0.5).setDepth(52)
    btnBg.on('pointerdown', () => {
      client.send('next_day')
      this.closeReport()
    })
    btnBg.on('pointerover', () => btnBg.setFillStyle(0x41a6f6))
    btnBg.on('pointerout', () => btnBg.setFillStyle(0x3b5dc9))
    this.reportUI = [overlay, panel, title, bodyText, checkbox, btnBg, btnText]
    this.reportUI.push(...drawDebugFrames(this, this.reportUI))
  }

  private checkboxLabel(): string {
    return `[${this.skipReports ? 'x' : ' '}] пропускать отчёты`
  }

  private debugLabel(): string {
    return `debug ${debug.enabled ? 'on' : 'off'}`
  }

  private closeReport() {
    this.reportUI.forEach((o) => o.destroy())
    this.reportUI = []
  }

  private showGameOver(o: GameOverMessage) {
    playSfx(this, 'glitch')
    this.closeReport()
    this.closeGameOver()
    const timeUp = o.reason === 'time_up' // дедлайн уровня (сложность 2.0)
    const overlay = this.add.rectangle(0, 0, GAME_W, GAME_H, 0x1a1c2c, 0.9).setOrigin(0).setDepth(60).setInteractive()
    const title = this.add
      .text(CX, 220, timeUp ? 'ВРЕМЯ ВЫШЛО' : 'БАНКРОТСТВО', { fontFamily: 'monospace', fontSize: '32px', color: '#b13e53' })
      .setOrigin(0.5).setDepth(61)
    const body = this.add
      .text(CX, 300, timeUp ? [
        'Инвесторы потеряли терпение:',
        'цель не достигнута к концу срока.',
        `Дней дано: ${o.daysSurvived}`,
        `Баланс: ${fmtMoney(o.balance)}`,
      ].join('\n') : [
        `Прожито дней: ${o.daysSurvived}`,
        `Пик дохода: ${fmtMoney(o.peakIncomePerTick)}/сек`,
        `На зарплаты не хватило: ${fmtMoney(-o.balance)}`,
      ].join('\n'), { fontFamily: 'monospace', fontSize: '16px', color: '#f4f4f4', lineSpacing: 8, align: 'center' })
      .setOrigin(0.5).setDepth(61)
    const btnBg = this.add
      .rectangle(CX - 100, 380, 200, 34, 0x3b5dc9).setOrigin(0, 0).setDepth(61)
      .setInteractive({ useHandCursor: true })
    const btnText = this.add
      .text(CX, 397, 'В меню', { fontFamily: 'monospace', fontSize: '14px', color: '#f4f4f4' })
      .setOrigin(0.5).setDepth(62)
    btnBg.on('pointerdown', () => this.returnToMenu())
    btnBg.on('pointerover', () => btnBg.setFillStyle(0x41a6f6))
    btnBg.on('pointerout', () => btnBg.setFillStyle(0x3b5dc9))
    this.gameOverUI = [overlay, title, body, btnBg, btnText]
    this.gameOverUI.push(...drawDebugFrames(this, this.gameOverUI))
  }

  private closeGameOver() {
    this.gameOverUI.forEach((o) => o.destroy())
    this.gameOverUI = []
  }

  private static DIFF_LABELS: Record<string, string> = {
    easy: 'Легко', normal: 'Норма', hard: 'Сложно', hardcore: 'Хардкор',
  }

  private showVictory(v: VictoryMessage) {
    playSfx(this, 'confirmation')
    this.closeReport()
    this.closeVictory()
    const overlay = this.add.rectangle(0, 0, GAME_W, GAME_H, 0x1a1c2c, 0.9).setOrigin(0).setDepth(60).setInteractive()
    const title = this.add
      .text(CX, 220, 'ПОБЕДА!', { fontFamily: 'monospace', fontSize: '32px', color: '#38b764' })
      .setOrigin(0.5).setDepth(61)
    const body = this.add
      .text(CX, 300, [
        `Сложность: ${HUDScene.DIFF_LABELS[v.difficulty] ?? v.difficulty}`,
        `Дней прошло: ${v.day}`,
        `Баланс: ${fmtMoney(v.balance)}`,
      ].join('\n'), { fontFamily: 'monospace', fontSize: '16px', color: '#f4f4f4', lineSpacing: 8, align: 'center' })
      .setOrigin(0.5).setDepth(61)
    const btnBg = this.add
      .rectangle(CX - 100, 380, 200, 34, 0x3b5dc9).setOrigin(0, 0).setDepth(61)
      .setInteractive({ useHandCursor: true })
    const btnText = this.add
      .text(CX, 397, 'В меню', { fontFamily: 'monospace', fontSize: '14px', color: '#f4f4f4' })
      .setOrigin(0.5).setDepth(62)
    btnBg.on('pointerdown', () => this.returnToMenu())
    btnBg.on('pointerover', () => btnBg.setFillStyle(0x41a6f6))
    btnBg.on('pointerout', () => btnBg.setFillStyle(0x3b5dc9))
    this.victoryUI = [overlay, title, body, btnBg, btnText]
    this.victoryUI.push(...drawDebugFrames(this, this.victoryUI))
  }

  private closeVictory() {
    this.victoryUI.forEach((o) => o.destroy())
    this.victoryUI = []
  }

  // Возврат в меню: намеренный разрыв WS (новая игра = новое подключение).
  // Сейв живёт на сервере — с меню можно вернуться («Продолжить»).
  private returnToMenu() {
    client.disconnect()
    this.scene.stop('office')
    this.scene.stop('serverRoom')
    this.scene.start('menu') // start глушит hud
  }

  // Выход в меню с сейвами (ITGAME-8): выход сохраняет прогресс, сдаться —
  // осознанное удаление сейва. Случайный клик по ⌂ не должен стоить партию.
  private confirmExitToMenu() {
    showModal(this, 'Выйти в меню?', ['Прогресс сохранится — продолжите', 'с главного меню в любое время.'], [
      { label: 'Сохранить и выйти', onClick: () => this.returnToMenu() },
      { label: 'Сдаться (удалить сейв)', onClick: () => { client.abandon(); this.returnToMenu() } },
      { label: 'Отмена', onClick: () => {} },
    ])
  }
}
