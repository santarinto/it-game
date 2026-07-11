import Phaser from 'phaser'
import { client } from '../net'
import type { DayReportMessage, GameOverMessage, StateMessage } from '../protocol'
import { fmtMoney } from '../format'

const ERROR_TEXTS: Record<string, string> = {
  not_enough_money: 'Не хватает денег',
  no_free_office_slot: 'В офисе нет свободных мест',
  no_free_pc: 'Нет свободного ПК — купите ПК',
  no_free_rack_slot: 'В серверной нет свободных стоек',
  router_maxed: 'Роутер уже максимального тира',
  unknown_command: 'Неизвестная команда',
  wrong_phase: 'Сейчас нельзя — дождитесь начала дня',
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
  private routerBtn!: Button
  private serverBtn!: Button
  private room: 'office' | 'serverRoom' = 'office'
  private switchBtn!: Button
  private reportUI: Phaser.GameObjects.GameObject[] = []
  private gameOverUI: Phaser.GameObjects.GameObject[] = []
  private skipReports = localStorage.getItem('skipReports') === '1'
  private switching = false

  constructor() {
    super('hud')
  }

  create() {
    // Верхняя панель.
    this.add.rectangle(0, 0, 960, 96, 0x14162b).setOrigin(0)
    this.moneyText = this.add.text(16, 10, '$…', {
      fontFamily: 'monospace', fontSize: '26px', color: '#ffcd75',
    })
    this.incomeText = this.add.text(16, 44, '', {
      fontFamily: 'monospace', fontSize: '15px', color: '#38b764',
    })
    this.netText = this.add.text(16, 66, '', {
      fontFamily: 'monospace', fontSize: '15px', color: '#41a6f6',
    })
    this.payrollText = this.add.text(180, 44, '', {
      fontFamily: 'monospace', fontSize: '15px', color: '#5d7275',
    })
    this.dayText = this.add
      .text(944, 70, '', { fontFamily: 'monospace', fontSize: '13px', color: '#5d7275' })
      .setOrigin(1, 0)

    this.pcBtn = this.makeButton(300, 10, () => client.send('buy_pc'))
    this.hireBtn = this.makeButton(300, 52, () => client.send('hire'))
    this.routerBtn = this.makeButton(520, 10, () => client.send('buy_router'))
    this.serverBtn = this.makeButton(520, 52, () => client.send('buy_server'))

    this.switchBtn = this.makeButton(740, 31, () => this.switchRoom())
    this.switchBtn.setLabel('В серверную →')

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
    this.add.rectangle(0, 0, 960, 640, 0x1a1c2c, 0.85).setOrigin(0).setDepth(100)
    this.add
      .text(480, 300, 'Соединение потеряно', {
        fontFamily: 'monospace', fontSize: '28px', color: '#b13e53',
      })
      .setOrigin(0.5)
      .setDepth(101)
    this.add
      .text(480, 344, 'Игра не сохраняется — обновите страницу, чтобы начать заново', {
        fontFamily: 'monospace', fontSize: '15px', color: '#f4f4f4',
      })
      .setOrigin(0.5)
      .setDepth(101)
  }

  private refresh(s: StateMessage) {
    if (s.phase === 'running') {
      this.closeReport()
      this.closeGameOver()
    }
    this.moneyText.setText(fmtMoney(s.money))
    this.incomeText.setText(`+${fmtMoney(s.incomePerTick)}/сек`)
    // Прогноз баланса на конец дня: если уйдём в минус — подсветить ФОТ.
    const forecast = s.money + s.incomePerTick * (s.dayTicks - s.dayProgress) - s.payrollPerDay
    this.payrollText.setText(`ФОТ ${fmtMoney(s.payrollPerDay)}/день`)
    this.payrollText.setColor(forecast < 0 ? '#b13e53' : '#5d7275')
    this.dayText.setText(`День ${s.day} · ${s.dayProgress}/${s.dayTicks}`)
    this.netText.setText(`Сотрудники: ${s.employees} · в сети ${s.connected} · ×${s.multiplier.toFixed(1)}`)
    this.pcBtn.setLabel(`Купить ПК  ${fmtMoney(s.prices.pc)}`)
    this.hireBtn.setLabel(`Нанять  ${fmtMoney(s.prices.hire)}`)
    this.routerBtn.setLabel(s.prices.nextRouter > 0 ? `Роутер  ${fmtMoney(s.prices.nextRouter)}` : 'Роутер MAX')
    this.serverBtn.setLabel(`Сервер  ${fmtMoney(s.prices.server)}`)
  }

  private switchRoom() {
    // Двойной клик до завершения stop/launch дублирует сцену — гасим дребезг.
    if (this.switching) return
    this.switching = true
    this.time.delayedCall(250, () => (this.switching = false))
    const next = this.room === 'office' ? 'serverRoom' : 'office'
    this.scene.stop(this.room)
    this.scene.launch(next)
    this.room = next
    this.switchBtn.setLabel(this.room === 'office' ? 'В серверную →' : '← В офис')
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
    return { setLabel: (s: string) => txt.setText(s) }
  }

  private toast(text: string) {
    const t = this.add
      .text(480, 600, text, {
        fontFamily: 'monospace', fontSize: '18px', color: '#f4f4f4',
        backgroundColor: '#b13e53', padding: { x: 12, y: 6 },
      })
      .setOrigin(0.5)
    this.tweens.add({ targets: t, alpha: 0, y: 560, duration: 1500, onComplete: () => t.destroy() })
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
      `Доход:    ${fmtMoney(r.income)}`,
      `ФОТ:     -${fmtMoney(r.payroll)}`,
      `Прибыль:  ${fmtMoney(r.profit)}`,
      `Баланс:   ${fmtMoney(r.balance)}`,
    ].join('\n')
    // Подложка interactive: глушит клики по кнопкам HUD под модалкой.
    const overlay = this.add.rectangle(0, 0, 960, 640, 0x1a1c2c, 0.75).setOrigin(0).setDepth(50).setInteractive()
    const panel = this.add.rectangle(480, 300, 440, 320, 0x14162b).setStrokeStyle(2, 0x41a6f6).setDepth(51)
    const title = this.add
      .text(480, 180, `День ${r.day} завершён`, { fontFamily: 'monospace', fontSize: '22px', color: '#ffcd75' })
      .setOrigin(0.5).setDepth(51)
    const bodyText = this.add
      .text(480, 280, body, { fontFamily: 'monospace', fontSize: '16px', color: '#f4f4f4', lineSpacing: 8 })
      .setOrigin(0.5).setDepth(51)
    const checkbox = this.add
      .text(480, 366, this.checkboxLabel(), { fontFamily: 'monospace', fontSize: '14px', color: '#5d7275' })
      .setOrigin(0.5).setDepth(51).setInteractive({ useHandCursor: true })
    checkbox.on('pointerdown', () => {
      this.skipReports = !this.skipReports
      localStorage.setItem('skipReports', this.skipReports ? '1' : '0')
      checkbox.setText(this.checkboxLabel())
    })
    const btnBg = this.add
      .rectangle(380, 400, 200, 34, 0x3b5dc9).setOrigin(0, 0).setDepth(51)
      .setInteractive({ useHandCursor: true })
    const btnText = this.add
      .text(480, 417, 'Следующий день →', { fontFamily: 'monospace', fontSize: '14px', color: '#f4f4f4' })
      .setOrigin(0.5).setDepth(52)
    btnBg.on('pointerdown', () => {
      client.send('next_day')
      this.closeReport()
    })
    btnBg.on('pointerover', () => btnBg.setFillStyle(0x41a6f6))
    btnBg.on('pointerout', () => btnBg.setFillStyle(0x3b5dc9))
    this.reportUI = [overlay, panel, title, bodyText, checkbox, btnBg, btnText]
  }

  private checkboxLabel(): string {
    return `[${this.skipReports ? 'x' : ' '}] пропускать отчёты`
  }

  private closeReport() {
    this.reportUI.forEach((o) => o.destroy())
    this.reportUI = []
  }

  private showGameOver(o: GameOverMessage) {
    this.closeReport()
    this.closeGameOver()
    const overlay = this.add.rectangle(0, 0, 960, 640, 0x1a1c2c, 0.9).setOrigin(0).setDepth(60).setInteractive()
    const title = this.add
      .text(480, 220, 'БАНКРОТСТВО', { fontFamily: 'monospace', fontSize: '32px', color: '#b13e53' })
      .setOrigin(0.5).setDepth(61)
    const body = this.add
      .text(480, 300, [
        `Прожито дней: ${o.daysSurvived}`,
        `Пик дохода: ${fmtMoney(o.peakIncomePerTick)}/сек`,
        `На зарплаты не хватило: ${fmtMoney(-o.balance)}`,
      ].join('\n'), { fontFamily: 'monospace', fontSize: '16px', color: '#f4f4f4', lineSpacing: 8, align: 'center' })
      .setOrigin(0.5).setDepth(61)
    const btnBg = this.add
      .rectangle(380, 380, 200, 34, 0x3b5dc9).setOrigin(0, 0).setDepth(61)
      .setInteractive({ useHandCursor: true })
    const btnText = this.add
      .text(480, 397, 'Начать заново', { fontFamily: 'monospace', fontSize: '14px', color: '#f4f4f4' })
      .setOrigin(0.5).setDepth(62)
    btnBg.on('pointerdown', () => client.send('restart'))
    btnBg.on('pointerover', () => btnBg.setFillStyle(0x41a6f6))
    btnBg.on('pointerout', () => btnBg.setFillStyle(0x3b5dc9))
    this.gameOverUI = [overlay, title, body, btnBg, btnText]
  }

  private closeGameOver() {
    this.gameOverUI.forEach((o) => o.destroy())
    this.gameOverUI = []
  }
}
