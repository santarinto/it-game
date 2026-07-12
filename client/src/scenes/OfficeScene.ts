import Phaser from 'phaser'
import { fmtMoney } from '../format'
import { GAME_H, GAME_W, HUD_H, NAV_W } from '../layout'
import { client } from '../net'
import { nav } from '../rooms'
import type { CommandType, EmployeeInfo, OfficeInfo, StateMessage } from '../protocol'

const SCALE = 4 // 16px спрайт → 64px на экране
const GRID = { cols: 4, startX: 260, startY: 220, stepX: 270, stepY: 170 }
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
    this.add.rectangle(NAV_W, HUD_H, GAME_W - NAV_W, GAME_H - HUD_H, 0x2b2f4a).setOrigin(0) // пол офиса

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
    const office = s.offices[nav.activeOffice]
    this.hideTooltip() // спрайты пересоздаются — старая цель тултипа мертва
    this.objects.forEach((o) => o.destroy())
    this.objects = []

    this.objects.push(
      this.add.text(GAME_W / 2, HUD_H + 20, `ОФИС ${nav.activeOffice + 1}`, {
        fontFamily: 'monospace', fontSize: '16px', color: '#5d7275',
      }).setOrigin(0.5),
    )

    if (!office.unlocked) {
      this.objects.push(
        this.add.text(GAME_W / 2, 300, `Офис ${nav.activeOffice + 1} закрыт`, {
          fontFamily: 'monospace', fontSize: '24px', color: '#5d7275',
        }).setOrigin(0.5),
      )
      // Открывать офисы можно только по порядку — если предыдущий ещё
      // не куплен, кнопка неактивна и подсказывает, что делать сначала.
      const canBuy = !(nav.activeOffice > 0 && !s.offices[nav.activeOffice - 1].unlocked)
      const btn = this.add.rectangle(GAME_W / 2 - 130, 360, 260, 40, 0x3b5dc9).setOrigin(0, 0)
      if (canBuy) btn.setInteractive({ useHandCursor: true })
      const txt = this.add.text(GAME_W / 2, 380, canBuy ? `Купить офис — ${fmtMoney(office.price)}` : 'Сначала купите предыдущий', {
        fontFamily: 'monospace', fontSize: '14px', color: '#f4f4f4',
      }).setOrigin(0.5)
      if (canBuy) btn.on('pointerdown', () => client.send('buy_office', nav.activeOffice))
      this.objects.push(btn, txt)
      return
    }

    // Специальный слот роутера: рабочее место сюда не поставить.
    const rx = GAME_W - 130
    const ry = 170
    this.objects.push(
      this.add.rectangle(rx, ry, 84, 84, 0x232640).setStrokeStyle(2, 0x5d7275),
      this.add.text(rx, ry - 56, 'сеть', { fontFamily: 'monospace', fontSize: '12px', color: '#5d7275' }).setOrigin(0.5),
    )
    if (office.routerTier > 0) {
      this.objects.push(
        this.add.image(rx, ry, 'router').setScale(SCALE),
        this.add.text(rx, ry + 52, `роутер т${office.routerTier} · ${office.ports} порт.`, {
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

    // Слот начальника — рядом со слотом роутера, но ниже.
    const bx = GAME_W - 130
    const by = 320
    this.objects.push(
      this.add.rectangle(bx, by, 84, 84, 0x232640).setStrokeStyle(2, 0x5d7275),
      this.add.text(bx, by - 56, 'начальник', { fontFamily: 'monospace', fontSize: '12px', color: '#5d7275' }).setOrigin(0.5),
    )
    if (office.boss !== '') {
      const bossImg = this.add.image(bx, by, 'worker').setScale(5).setInteractive({ useHandCursor: true })
      bossImg.on('pointerover', () => this.showBossTooltip(office, s, bx, by))
      bossImg.on('pointerout', () => this.hideTooltip())
      this.objects.push(bossImg)
    } else {
      this.objects.push(this.add.text(bx, by, 'нет', { fontFamily: 'monospace', fontSize: '11px', color: '#5d7275' }).setOrigin(0.5))
    }

    // Рабочие места: первые pcs слотов — с ПК, дальше сотрудники из массива;
    // слоты за потолком штата закрыты, а слоты за 9 — до найма начальника.
    const cap = office.boss !== '' ? s.officeSlots : s.staffLimit
    for (let i = 0; i < s.officeSlots; i++) {
      const x = GRID.startX + (i % GRID.cols) * GRID.stepX
      const y = GRID.startY + Math.floor(i / GRID.cols) * GRID.stepY
      if (i >= cap) {
        this.objects.push(
          this.add.rectangle(x, y, 80, 64, 0x232640, 0.5).setStrokeStyle(2, 0x3a3f5c),
          this.add.text(x, y, 'наймите\nначальника', {
            fontFamily: 'monospace', fontSize: '10px', color: '#5d7275', align: 'center',
          }).setOrigin(0.5),
        )
        continue
      }
      this.objects.push(this.add.image(x, y, i < office.pcs ? 'desk_pc' : 'desk_empty').setScale(SCALE))
      const e = office.employees[i]
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

    // Полка быт-устройств: без них сотрудники ловят дебаффы.
    const amenities: { key: 'cooler' | 'fridge' | 'coffee_machine'; owned: boolean; price: number; cmd: CommandType; label: string; hint: string }[] = [
      { key: 'cooler', owned: office.cooler, price: s.prices.cooler, cmd: 'buy_cooler', label: 'кулер',
        hint: 'Без кулера: жажда −10% с 12:00' },
      { key: 'fridge', owned: office.fridge, price: s.prices.fridge, cmd: 'buy_fridge', label: 'холодильник',
        hint: 'Без холодильника: голод −10% после обеда' },
      { key: 'coffee_machine', owned: office.coffeeMachine, price: s.prices.coffeeMachine, cmd: 'buy_coffee', label: 'кофеварка',
        hint: 'Дважды в день 40% офиса: кофе +15% на час' },
    ]
    amenities.forEach((a, i) => {
      const ax = 220 + i * 130
      const ay = 660
      const box = this.add.rectangle(ax, ay, 72, 72, 0x232640, a.owned ? 1 : 0.5)
        .setStrokeStyle(2, a.owned ? 0x38b764 : 0x3a3f5c)
        .setInteractive({ useHandCursor: !a.owned })
      this.objects.push(box)
      if (a.owned) {
        const img = this.add.image(ax, ay, a.key).setScale(3).setInteractive({ useHandCursor: true })
        img.on('pointerover', () => this.showTextTooltip(`${a.label}\n${a.hint}`, ax, ay - 40))
        img.on('pointerout', () => this.hideTooltip())
        this.objects.push(img)
      } else {
        this.objects.push(this.add.text(ax, ay, `${a.label}\n${fmtMoney(a.price)}`, {
          fontFamily: 'monospace', fontSize: '10px', color: '#5d7275', align: 'center',
        }).setOrigin(0.5))
        box.on('pointerdown', () => client.send(a.cmd, nav.activeOffice))
      }
    })
  }

  private showTooltip(e: EmployeeInfo, s: StateMessage, x: number, y: number) {
    const lines = [
      e.name,
      `Выработка: ${fmtMoney(e.incomePerTick * s.ticksPerHour)}/час`,
      `Зарплата:  ${fmtMoney(s.salaryPerDay)}/день${e.unpaidToday ? ' (сегодня без оплаты)' : ''}`,
    ]
    const EFFECT_NAMES: Record<string, string> = { thirst: 'жажда', hunger: 'голоден', coffee: 'выпил кофе' }
    for (const ef of e.effects) {
      const sign = ef.percent > 0 ? '+' : ''
      lines.push(`${EFFECT_NAMES[ef.token] ?? ef.token} ${sign}${ef.percent}%${ef.until ? ` (до ${ef.until})` : ''}`)
    }
    this.tooltipText.setText(lines.join('\n'))
    this.tooltipBg.setSize(this.tooltipText.width + 20, this.tooltipText.height + 16)
    // Не выпускаем тултип за правый край поля.
    const tx = Math.min(x + 40, GAME_W - this.tooltipBg.width - 8)
    this.tooltip.setPosition(tx, y - 20).setVisible(true)
  }

  // Универсальный текстовый тултип — для полки устройств и прочих
  // подсказок без структуры сотрудника/офиса.
  private showTextTooltip(text: string, x: number, y: number) {
    this.tooltipText.setText(text)
    this.tooltipBg.setSize(this.tooltipText.width + 20, this.tooltipText.height + 16)
    const tx = Math.min(x, GAME_W - this.tooltipBg.width - 8)
    this.tooltip.setPosition(tx, y).setVisible(true)
  }

  private showBossTooltip(o: OfficeInfo, s: StateMessage, x: number, y: number) {
    this.tooltipText.setText([
      o.boss,
      'Начальник — открывает места 10–12',
      `Зарплата:  ${fmtMoney(s.bossSalaryPerDay)}/день${o.bossUnpaidToday ? ' (сегодня без оплаты)' : ''}`,
    ].join('\n'))
    this.tooltipBg.setSize(this.tooltipText.width + 20, this.tooltipText.height + 16)
    this.tooltip.setPosition(Math.min(x + 40, GAME_W - this.tooltipBg.width - 8), y - 20).setVisible(true)
  }

  private hideTooltip() {
    this.tooltip.setVisible(false)
  }
}
