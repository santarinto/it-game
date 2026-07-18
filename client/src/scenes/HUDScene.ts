import Phaser from 'phaser'
import { GAME_H, GAME_W, HUD_H, NAV_W } from '../layout'
import { client } from '../net'
import type { DayReportMessage, GameOverMessage, StateMessage } from '../protocol'
import { fmtMoney } from '../format'
import { nav } from '../rooms'
import { debug, drawDebugFrames, setDebug } from '../debug'

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
  private pcBtn!: Button
  private hireBtn!: Button
  private bossBtn!: Button
  private gatewayBtn!: Button
  private navItems: { bg: Phaser.GameObjects.Rectangle; label: Phaser.GameObjects.Text; sub: Phaser.GameObjects.Text }[] = []
  private currentRoom: 'office' | 'serverRoom' = 'office'
  private reportUI: Phaser.GameObjects.GameObject[] = []
  private gameOverUI: Phaser.GameObjects.GameObject[] = []
  private skipReports = localStorage.getItem('skipReports') === '1'
  private switching = false
  private speedBtns: { bg: Phaser.GameObjects.Rectangle; speed: number }[] = []
  private hudInteractive: Phaser.GameObjects.GameObject[] = []
  private debugFrames: Phaser.GameObjects.GameObject[] = []

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

    this.pcBtn = this.makeButton(420, 10, () => client.send('buy_pc', nav.activeOffice))
    this.hireBtn = this.makeButton(420, 52, () => client.send('hire', nav.activeOffice))
    this.bossBtn = this.makeButton(640, 10, () => client.send('hire_boss', nav.activeOffice))
    this.gatewayBtn = this.makeButton(640, 52, () => client.send('buy_gateway'))

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
      onError: (code) => this.toast(ERROR_TEXTS[code] ?? code),
      onDisconnect: () => this.showDisconnect(),
      onDayReport: (r) => this.onDayReport(r),
      onGameOver: (o) => this.showGameOver(o),
    })
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, unsub)
  }

  private showDisconnect() {
    this.add.rectangle(0, 0, GAME_W, GAME_H, 0x1a1c2c, 0.85).setOrigin(0).setDepth(100)
    this.add
      .text(CX, 300, 'Соединение потеряно', {
        fontFamily: 'monospace', fontSize: '28px', color: '#b13e53',
      })
      .setOrigin(0.5)
      .setDepth(101)
    this.add
      .text(CX, 344, 'Игра не сохраняется — обновите страницу, чтобы начать заново', {
        fontFamily: 'monospace', fontSize: '15px', color: '#f4f4f4',
      })
      .setOrigin(0.5)
      .setDepth(101)
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

  private refresh(s: StateMessage) {
    if (s.phase === 'running') {
      this.closeReport()
      this.closeGameOver()
    }
    const employees = s.offices.flatMap((o) => o.employees)
    const active = s.offices[nav.activeOffice]
    this.moneyText.setText(fmtMoney(s.money))
    this.incomeText.setText(`+${fmtMoney(s.incomePerTick)}/сек`)
    this.payrollText.setText(`Расходы ${fmtMoney(s.payrollPerDay)}/день`)
    // Прогноз считает сервер: клиент не знает про обеденные тики.
    this.payrollText.setColor(s.forecastEndOfDay < 0 ? '#b13e53' : '#5d7275')
    this.dayText.setText(`День ${s.day} · ${s.clock}${s.isLunch ? ' · обед' : ''}`)
    this.netText.setText(`Сотрудники: ${employees.length} · в сети ${s.core.connected}/${employees.length}`)
    this.pcBtn.setLabel(`Купить ПК  ${fmtMoney(s.prices.pc)}`)
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
    this.debugFrames.forEach((f) => f.destroy())
    this.debugFrames = drawDebugFrames(this, this.hudInteractive)
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

  private toast(text: string) {
    const t = this.add
      .text(CX, GAME_H - 40, text, {
        fontFamily: 'monospace', fontSize: '18px', color: '#f4f4f4',
        backgroundColor: '#b13e53', padding: { x: 12, y: 6 },
      })
      .setOrigin(0.5)
    this.tweens.add({ targets: t, alpha: 0, y: GAME_H - 80, duration: 1500, onComplete: () => t.destroy() })
  }

  private onDayReport(r: DayReportMessage) {
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
    this.closeReport()
    this.closeGameOver()
    const overlay = this.add.rectangle(0, 0, GAME_W, GAME_H, 0x1a1c2c, 0.9).setOrigin(0).setDepth(60).setInteractive()
    const title = this.add
      .text(CX, 220, 'БАНКРОТСТВО', { fontFamily: 'monospace', fontSize: '32px', color: '#b13e53' })
      .setOrigin(0.5).setDepth(61)
    const body = this.add
      .text(CX, 300, [
        `Прожито дней: ${o.daysSurvived}`,
        `Пик дохода: ${fmtMoney(o.peakIncomePerTick)}/сек`,
        `На зарплаты не хватило: ${fmtMoney(-o.balance)}`,
      ].join('\n'), { fontFamily: 'monospace', fontSize: '16px', color: '#f4f4f4', lineSpacing: 8, align: 'center' })
      .setOrigin(0.5).setDepth(61)
    const btnBg = this.add
      .rectangle(CX - 100, 380, 200, 34, 0x3b5dc9).setOrigin(0, 0).setDepth(61)
      .setInteractive({ useHandCursor: true })
    const btnText = this.add
      .text(CX, 397, 'Начать заново', { fontFamily: 'monospace', fontSize: '14px', color: '#f4f4f4' })
      .setOrigin(0.5).setDepth(62)
    btnBg.on('pointerdown', () => client.send('restart'))
    btnBg.on('pointerover', () => btnBg.setFillStyle(0x41a6f6))
    btnBg.on('pointerout', () => btnBg.setFillStyle(0x3b5dc9))
    this.gameOverUI = [overlay, title, body, btnBg, btnText]
    this.gameOverUI.push(...drawDebugFrames(this, this.gameOverUI))
  }

  private closeGameOver() {
    this.gameOverUI.forEach((o) => o.destroy())
    this.gameOverUI = []
  }
}
