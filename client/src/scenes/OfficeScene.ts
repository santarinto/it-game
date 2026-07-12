import Phaser from 'phaser'
import { fmtMoney } from '../format'
import { GAME_H, GAME_W, HUD_H } from '../layout'
import { client } from '../net'
import type { EmployeeInfo, StateMessage } from '../protocol'

const SCALE = 4 // 16px спрайт → 64px на экране
const GRID = { cols: 4, startX: 200, startY: 220, stepX: 270, stepY: 170 }
const LUNCH_SHIFT = 24 // на обеде сотрудник отходит от стола

export class OfficeScene extends Phaser.Scene {
  private objects: Phaser.GameObjects.GameObject[] = []
  private tooltip!: Phaser.GameObjects.Container
  private tooltipText!: Phaser.GameObjects.Text
  private tooltipBg!: Phaser.GameObjects.Rectangle
  // Слот под курсором: перерисовка идёт каждую секунду, и без этого
  // тултип гас бы на каждом снапшоте.
  private hoveredSlot = -1

  constructor() {
    super('office')
  }

  create() {
    // сцены перезапускаются при переключении комнат — сбрасываем ссылки прошлого цикла
    this.objects = []
    this.add.rectangle(0, HUD_H, GAME_W, GAME_H - HUD_H, 0x2b2f4a).setOrigin(0) // пол офиса
    this.add.text(GAME_W / 2, HUD_H + 20, 'ОФИС', {
      fontFamily: 'monospace', fontSize: '16px', color: '#5d7275',
    }).setOrigin(0.5)

    // Один переиспользуемый тултип поверх всего; наполняется при наведении.
    this.tooltipText = this.add.text(10, 8, '', {
      fontFamily: 'monospace', fontSize: '13px', color: '#f4f4f4', lineSpacing: 6,
    })
    this.tooltipBg = this.add.rectangle(0, 0, 10, 10, 0x14162b, 0.95).setOrigin(0).setStrokeStyle(1, 0x41a6f6)
    this.tooltip = this.add.container(0, 0, [this.tooltipBg, this.tooltipText]).setDepth(40).setVisible(false)

    const unsub = client.subscribe({
      onState: (s) => this.render(s),
      onError: () => {},
      onDisconnect: () => {},
    })
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, unsub)
  }

  // Полная перерисовка на каждый снапшот: объектов мало, зато нет
  // рассинхрона между стейтом и картинкой.
  private render(s: StateMessage) {
    this.hideTooltip() // спрайты пересоздаются — старая цель тултипа мертва
    this.objects.forEach((o) => o.destroy())
    this.objects = []

    // Специальный слот роутера: рабочее место сюда не поставить.
    const rx = GAME_W - 130
    const ry = 170
    this.objects.push(
      this.add.rectangle(rx, ry, 84, 84, 0x232640).setStrokeStyle(2, 0x5d7275),
      this.add.text(rx, ry - 56, 'сеть', { fontFamily: 'monospace', fontSize: '12px', color: '#5d7275' }).setOrigin(0.5),
    )
    if (s.routerTier > 0) {
      this.objects.push(
        this.add.image(rx, ry, 'router').setScale(SCALE),
        this.add.text(rx, ry + 52, `роутер т${s.routerTier} · ${s.ports} порт.`, {
          fontFamily: 'monospace', fontSize: '11px', color: '#41a6f6',
        }).setOrigin(0.5),
      )
    } else {
      this.objects.push(
        this.add.text(rx, ry, 'нет\nроутера', {
          fontFamily: 'monospace', fontSize: '11px', color: '#5d7275', align: 'center',
        }).setOrigin(0.5),
      )
    }

    // Рабочие места: первые pcs слотов — с ПК, дальше сотрудники из массива;
    // слоты за потолком штата закрыты до начальника.
    for (let i = 0; i < s.officeSlots; i++) {
      const x = GRID.startX + (i % GRID.cols) * GRID.stepX
      const y = GRID.startY + Math.floor(i / GRID.cols) * GRID.stepY
      if (i >= s.staffLimit) {
        this.objects.push(
          this.add.rectangle(x, y, 80, 64, 0x232640, 0.5).setStrokeStyle(2, 0x3a3f5c),
          this.add.text(x, y, 'нужен\nначальник', {
            fontFamily: 'monospace', fontSize: '10px', color: '#5d7275', align: 'center',
          }).setOrigin(0.5),
        )
        continue
      }
      this.objects.push(this.add.image(x, y, i < s.pcs ? 'desk_pc' : 'desk_empty').setScale(SCALE))
      const e = s.employees[i]
      if (e) {
        // На обеде сотрудник отходит от стола.
        const wx = s.isLunch ? x - 52 + LUNCH_SHIFT : x - 52
        const wy = s.isLunch ? y - 6 + LUNCH_SHIFT : y - 6
        const worker = this.add.image(wx, wy, 'worker').setScale(SCALE).setInteractive({ useHandCursor: true })
        worker.on('pointerover', () => {
          this.hoveredSlot = i
          this.showTooltip(e, s, wx, wy)
        })
        worker.on('pointerout', () => {
          this.hoveredSlot = -1
          this.hideTooltip()
        })
        this.objects.push(worker)
        // Спрайт пересоздан — восстанавливаем тултип, но только если курсор
        // реально над спрайтом: pointerout не срабатывает по уничтоженному
        // объекту, и без этой проверки hoveredSlot «залипает».
        if (this.hoveredSlot === i) {
          const p = this.input.activePointer
          if (Math.abs(p.worldX - wx) <= 32 && Math.abs(p.worldY - wy) <= 32) {
            this.showTooltip(e, s, wx, wy)
          } else {
            this.hoveredSlot = -1
          }
        }
        if (e.connected) {
          this.objects.push(this.add.circle(x + 30, y - 30, 4, 0x38b764))
        }
      }
    }
  }

  private showTooltip(e: EmployeeInfo, s: StateMessage, x: number, y: number) {
    this.tooltipText.setText([
      e.name,
      `Выработка: ${fmtMoney(e.incomePerTick * s.ticksPerHour)}/час`,
      `Зарплата:  ${fmtMoney(s.salaryPerDay)}/день`,
    ].join('\n'))
    this.tooltipBg.setSize(this.tooltipText.width + 20, this.tooltipText.height + 16)
    // Не выпускаем тултип за правый край поля.
    const tx = Math.min(x + 40, GAME_W - this.tooltipBg.width - 8)
    this.tooltip.setPosition(tx, y - 20).setVisible(true)
  }

  private hideTooltip() {
    this.tooltip.setVisible(false)
  }
}
