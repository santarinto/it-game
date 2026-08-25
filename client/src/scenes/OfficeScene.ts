import Phaser from 'phaser'
import { fmtMoney } from '../format'
import { GAME_H, GAME_W, HUD_H, NAV_W } from '../layout'
import { client } from '../net'
import { nav } from '../rooms'
import type { CommandType, EmployeeInfo, OfficeInfo, StateMessage } from '../protocol'
import { drawDebugFrames } from '../debug'
import { showModal } from '../ui/modal'
import { coreFree, routerGain } from '../network-preview'
import { playSfx } from '../audio'

const SCALE = 4 // 16px спрайт → 64px на экране
const GRID = { cols: 4, startX: 260, startY: 220, stepX: 270, stepY: 170 }
const LUNCH_SHIFT = 24 // на обеде сотрудник отходит от стола

// Метки причин отсутствия сети над столом (итерация 11).
const OFFLINE_LABELS: Record<string, string> = {
  no_router: '✗ роутер',
  no_core: '✗ core',
  no_server: 'без стойки',
}

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
    this.objects.forEach((o) => {
      this.tweens.killTweensOf(o) // мигание поломок не должно переживать перерисовку
      o.destroy()
    })
    this.objects = []

    this.objects.push(
      this.add.text(GAME_W / 2, HUD_H + 20, `ОФИС ${nav.activeOffice + 1}`, {
        fontFamily: 'monospace', fontSize: '16px', color: '#5d7275',
      }).setOrigin(0.5),
    )

    // Вирус: доход офиса проседает — плашка, пока лечат или терпят.
    if (office.virusUntil) {
      const plate = this.add.text(GAME_W / 2, HUD_H + 44, `☣ вирус −30% до ${office.virusUntil}`, {
        fontFamily: 'monospace', fontSize: '13px', color: '#b13e53',
        backgroundColor: '#14162b', padding: { x: 8, y: 4 },
      }).setOrigin(0.5)
      this.objects.push(plate)
    }

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
      if (canBuy) btn.on('pointerdown', () => {
        playSfx(this, 'select')
        client.send('buy_office', nav.activeOffice)
      })
      this.objects.push(btn, txt)
      this.objects.push(...drawDebugFrames(this, this.objects))
      return
    }

    // Специальный слот роутера: рабочее место сюда не поставить.
    const rx = GAME_W - 130
    const ry = 170
    const routerZone = this.add.rectangle(rx, ry, 84, 84, 0x232640)
      .setStrokeStyle(2, 0x5d7275).setInteractive({ useHandCursor: true })
    routerZone.on('pointerdown', () => this.openRouterModal(office, s))
    this.objects.push(
      routerZone,
      this.add.text(rx, ry - 56, 'сеть', { fontFamily: 'monospace', fontSize: '12px', color: '#5d7275' }).setOrigin(0.5),
    )
    if (office.routerTier > 0) {
      const routerImg = this.add.image(rx, ry, 'router').setScale(SCALE).setInteractive({ useHandCursor: true })
      routerImg.on('pointerdown', () => this.openRouterModal(office, s))
      this.objects.push(
        routerImg,
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
      const desk = this.add.image(x, y, i < office.pcs ? 'desk_pc' : 'desk_empty').setScale(SCALE)
      this.objects.push(desk)
      const e = office.employees[i]
      // Сломанный ПК: доход места 0; клики по столу чинят, мастер чинит за деньги.
      if (e?.pcBroken) {
        const overlay = this.add.rectangle(x, y - 8, 76, 56, 0xb13e53, 0.3)
          .setInteractive({ useHandCursor: true })
        overlay.on('pointerdown', () => {
          playSfx(this, 'click')
          client.send('repair_click', nav.activeOffice, { slot: i })
        })
        this.tweens.add({
          targets: overlay, alpha: { from: 0.65, to: 0.15 }, duration: 420, yoyo: true, repeat: -1,
        })
        const masterBg = this.add.rectangle(x, y + 46, 108, 22, 0x3b5dc9)
          .setOrigin(0.5).setInteractive({ useHandCursor: true })
        const masterTxt = this.add.text(x, y + 46, `мастер ${fmtMoney(s.prices.repair)}`, {
          fontFamily: 'monospace', fontSize: '10px', color: '#f4f4f4',
        }).setOrigin(0.5)
        masterBg.on('pointerdown', () => {
          playSfx(this, 'select')
          client.send('call_master', nav.activeOffice, { slot: i })
        })
        this.objects.push(
          this.add.text(x, y - 48, `✖ чинить ${e.repairClicks}/3`, {
            fontFamily: 'monospace', fontSize: '11px', color: '#b13e53',
          }).setOrigin(0.5),
          overlay, masterBg, masterTxt,
        )
      }
      if (e) {
        // На обеде сотрудник отходит от стола.
        const wx = s.isLunch ? x - 52 + LUNCH_SHIFT : x - 52
        const wy = s.isLunch ? y - 6 + LUNCH_SHIFT : y - 6
        const worker = this.add.image(wx, wy, 'worker').setScale(SCALE).setInteractive({ useHandCursor: true })
        // Клик по сотруднику — мотивация: +25% на 3 часа с кулдауном.
        worker.on('pointerdown', () => {
        playSfx(this, 'click')
        client.send('motivate', nav.activeOffice, { slot: i })
      })
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
        if (e.connected && e.serverSlot > 0) {
          this.objects.push(this.add.circle(x + 30, y - 30, 4, 0x38b764))
        }
        // Видимость сети (итерация 11): метка-причина над проблемным
        // столом — точка 4px «почему я без бонуса» не объясняла.
        if (e.offlineReason) {
          const label = OFFLINE_LABELS[e.offlineReason] ?? e.offlineReason
          const color = e.offlineReason === 'no_server' ? '#5d7275' : '#b13e53'
          this.objects.push(this.add.text(x + 30, y - 44, label, {
            fontFamily: 'monospace', fontSize: '9px', color,
          }).setOrigin(0.5))
        }
        // Жёлтый значок-бейдж, пока действует мотивация кликом.
        if (e.effects.some((ef) => ef.token === 'motivated')) {
          this.objects.push(this.add.circle(x - 28, y - 36, 5, 0xffcd75))
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
        box.on('pointerdown', () => {
          playSfx(this, 'select')
          client.send(a.cmd, nav.activeOffice)
        })
      }
    })
    this.objects.push(...drawDebugFrames(this, this.objects))
  }

  private showTooltip(e: EmployeeInfo, s: StateMessage, x: number, y: number) {
    // Выработка — эффективная (с дебаффами/баффами); база в скобках,
    // когда эффекты её меняют.
    const base = e.incomePerTick * s.ticksPerHour
    const effective = e.effectiveIncomePerTick * s.ticksPerHour
    const lines = [
      e.name,
      `Выработка: ${fmtMoney(effective)}/час${effective !== base ? ` (база ${fmtMoney(base)})` : ''}`,
      `Зарплата:  ${fmtMoney(e.salary)}/день${e.unpaidToday ? ' (сегодня без оплаты)' : ''}`,
    ]
    lines.push(e.serverSlot > 0 ? `сервер ${e.serverSlot} · ×${e.netMult.toFixed(1)}` : 'без сервера')
    // Причина отсутствия сети — словами, не кодом.
    if (e.offlineReason === 'no_router') {
      lines.push('✗ ВНЕ СЕТИ: роутер офиса не подключает это место')
    } else if (e.offlineReason === 'no_core') {
      lines.push('✗ ВНЕ СЕТИ: нет места в стойке роутеров (core)')
    } else if (e.offlineReason === 'no_server') {
      lines.push('· в core есть, но серверная стойка не обслуживает место')
    }
    if (e.pcBroken) {
      lines.push('ПК СЛОМАН — доход 0; кликайте по столу')
    }
    lines.push(e.motivateReadyAt ? `мотивация: после ${e.motivateReadyAt}` : 'мотивация: готова (клик)')
    const EFFECT_NAMES: Record<string, string> = { thirst: 'жажда', hunger: 'голоден', coffee: 'выпил кофе', motivated: 'мотивирован', offended: 'обижен' }
    // Ремень безопасности: старый сервер мог прислать null вместо [] —
    // краш тултипа обрывал перерисовку всей сцены.
    for (const ef of e.effects ?? []) {
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

  // Модалка роутера: апгрейд переехал сюда из кнопки HUD (заявка И4).
  private openRouterModal(o: OfficeInfo, s: StateMessage) {
    const connected = o.employees.filter((e) => e.connected).length
    const lines = o.routerTier > 0
      ? [`Тир ${o.routerTier} · ${o.ports} портов`, `Подключено ${connected} из ${o.employees.length}`]
      : ['Роутера нет —', 'офис не подключён к сети.']
    // Превью покупки: сколько мест доберётся до сервера (итерация 11).
    const free = coreFree(s)
    const gain = routerGain(o, free)
    if (o.nextRouter > 0) {
      const waiting = o.employees.filter((e) => e.offlineReason === 'no_router').length
      if (gain > 0) {
        lines.push(`≈ +${gain} в сеть после покупки`)
      } else if (free <= 0 && waiting > 0) {
        lines.push('Мест в core нет — сначала стойка роутеров')
      } else if (waiting > 0) {
        lines.push('Ждут порт роутера, но core уже занят')
      }
    }
    if (o.nextRouter === 0) lines.push('Тир максимальный')
    const buttons = o.nextRouter > 0
      ? [{
          label: o.routerTier === 0
            ? `Купить роутер ${fmtMoney(o.nextRouter)}`
            : `Апгрейд до т${o.routerTier + 1} ${fmtMoney(o.nextRouter)}`,
          onClick: () => client.send('buy_router', nav.activeOffice),
        }]
      : []
    showModal(this, `Роутер — офис ${nav.activeOffice + 1}`, lines, buttons)
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
