import Phaser from 'phaser'
import { client } from '../net'
import type { StateMessage } from '../protocol'
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
}
