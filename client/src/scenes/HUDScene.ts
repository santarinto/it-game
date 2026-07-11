import Phaser from 'phaser'
import { client } from '../net'
import type { StateMessage } from '../protocol'

const ERROR_TEXTS: Record<string, string> = {
  not_enough_money: 'Не хватает денег',
  no_free_office_slot: 'В офисе нет свободных мест',
  no_free_pc: 'Нет свободного ПК — купите ПК',
  no_free_rack_slot: 'В серверной нет свободных стоек',
  router_maxed: 'Роутер уже максимального тира',
  unknown_command: 'Неизвестная команда',
}

interface Button {
  setLabel(s: string): void
}

export class HUDScene extends Phaser.Scene {
  private moneyText!: Phaser.GameObjects.Text
  private incomeText!: Phaser.GameObjects.Text
  private netText!: Phaser.GameObjects.Text
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

    this.pcBtn = this.makeButton(300, 10, () => client.send('buy_pc'))
    this.hireBtn = this.makeButton(300, 52, () => client.send('hire'))
    this.routerBtn = this.makeButton(520, 10, () => client.send('buy_router'))
    this.serverBtn = this.makeButton(520, 52, () => client.send('buy_server'))

    this.switchBtn = this.makeButton(740, 31, () => this.switchRoom())
    this.switchBtn.setLabel('В серверную →')

    const unsub = client.subscribe({
      onState: (s) => this.refresh(s),
      onError: (code) => this.toast(ERROR_TEXTS[code] ?? code),
      onDisconnect: () => {}, // экран дисконнекта — задача 12
    })
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, unsub)
  }

  private refresh(s: StateMessage) {
    this.moneyText.setText(`$${s.money}`)
    this.incomeText.setText(`+$${s.incomePerTick}/сек`)
    this.netText.setText(`Сотрудники: ${s.employees} · в сети ${s.connected} · ×${s.multiplier.toFixed(1)}`)
    this.pcBtn.setLabel(`Купить ПК  $${s.prices.pc}`)
    this.hireBtn.setLabel(`Нанять  $${s.prices.hire}`)
    this.routerBtn.setLabel(s.prices.nextRouter > 0 ? `Роутер  $${s.prices.nextRouter}` : 'Роутер MAX')
    this.serverBtn.setLabel(`Сервер  $${s.prices.server}`)
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
