import Phaser from 'phaser'
import { fmtMoney } from '../format'
import { GAME_H, GAME_W, HUD_H, NAV_W } from '../layout'
import { client } from '../net'
import { drawDebugFrames } from '../debug'
import { tag } from '../debug/agentApi'
import { partyModals } from '../ui/modal'
import { ActionBar, actionColY, type ActionButton } from '../ui/actionButton'
import { playSfx } from '../audio'
import { addSprite } from '../pixelart'
import { FONT, HIRES_CAMERA } from '../render'
import type { OfficeInfo, StateMessage } from '../protocol'

// Отдел админов (ITGAME-101/145, решение владельца 17.10): у админов своя
// комната — вкладка «АДМ» рядом с «СРВ», закрыта и покупается, как офис;
// потом здесь встанут шкафы с оборудованием и верстаки (нижняя половина
// комнаты оставлена под них). Админ закреплён за своим офисом: место
// в отделе на офис, найм — кнопками колонки «Админ ОN».

// Кликов админа за тик — зеркало Config.AdminClicksPerTick сервера (только
// для строки тултипа; кликает сервер).
const ADMIN_CLICKS = 2

// Места админов в ряд, по офису на место: центры x и y ряда.
const SEAT_X = [330, 560, 790]
const SEAT_Y = 300
const SEAT_BOX = 92

// Колонка действий отдела: устройств над ней нет — начинается сразу под шапкой.
const ACTIONS_TOP = 170

// Тултип — над комнатой, под окнами (подложка модалки — depth 70).
const TOOLTIP_DEPTH = 40

// Цвета цели админа: ремонт — красный поломки, чистка — зелёный вируса
// (как метки места в офисе, sweetie16).
const KIND_COLOR: Record<string, string> = { repair: '#b13e53', virus: '#a7f070', '': '#5d7275' }

// Строка цели админа: «чинит место 5» / «чистит место 3» / «свободен».
export function adminStatus(o: OfficeInfo): string {
  if (o.adminKind === 'repair') return `чинит место ${o.adminSlot + 1}`
  if (o.adminKind === 'virus') return `чистит место ${o.adminSlot + 1}`
  return 'свободен'
}

export class AdminDeptScene extends Phaser.Scene {
  private objects!: Phaser.GameObjects.GameObject[]
  private modal!: ReturnType<typeof partyModals>
  private actions!: ActionBar
  private hireBtns!: ActionButton[]
  private tooltip!: Phaser.GameObjects.Container
  private tooltipBg!: Phaser.GameObjects.Rectangle
  private tooltipText!: Phaser.GameObjects.Text
  private hoveredSeat = -1

  constructor() {
    super({ key: 'adminDept', cameras: HIRES_CAMERA })
  }

  create() {
    // сцены перезапускаются при переключении комнат — сбрасываем ссылки прошлого цикла
    this.objects = []
    this.hoveredSeat = -1
    const openModal = partyModals(this)
    this.modal = (...args) => {
      this.actions.hideTooltip()
      this.hideTooltip()
      return openModal(...args)
    }
    this.add.rectangle(NAV_W, HUD_H, GAME_W - NAV_W, GAME_H - HUD_H, 0x1f2233).setOrigin(0)
    this.add.text(GAME_W / 2, HUD_H + 20, 'ОТДЕЛ АДМИНОВ', {
      fontFamily: FONT, fontSize: '16px', color: '#5d7275',
    }).setOrigin(0.5)

    this.tooltipText = this.add.text(10, 8, '', {
      fontFamily: FONT, fontSize: '13px', color: '#f4f4f4', lineSpacing: 6,
    })
    this.tooltipBg = this.add.rectangle(0, 0, 10, 10, 0x14162b, 0.95).setOrigin(0).setStrokeStyle(1, 0x41a6f6)
    this.tooltip = this.add.container(0, 0, [this.tooltipBg, this.tooltipText]).setDepth(TOOLTIP_DEPTH).setVisible(false)

    this.actions = new ActionBar(this, { depth: TOOLTIP_DEPTH, blocked: () => this.windowOpen() })
    this.hireBtns = [0, 1, 2].map((oi) => this.actions.add(actionColY(ACTIONS_TOP, oi), `btn.admin.${oi}`, () => {
      playSfx(this, 'select')
      client.send('hire_admin', oi)
    }))

    const unsub = client.subscribe({
      onState: (s) => this.render(s),
      onError: () => {},
      onDisconnect: () => {},
    })
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, unsub)
  }

  private render(s: StateMessage) {
    this.hideTooltip()
    this.objects.forEach((o) => o.destroy())
    this.objects = []
    this.refreshActions(s)

    if (!s.adminDept) {
      // Как закрытый офис: заголовок, кнопка покупки и одна строка о том, что даёт отдел.
      this.objects.push(
        this.add.text(GAME_W / 2, 300, 'Отдел админов закрыт', {
          fontFamily: FONT, fontSize: '24px', color: '#5d7275',
        }).setOrigin(0.5),
      )
      const btn = tag(
        this.add.rectangle(GAME_W / 2 - 150, 360, 300, 40, 0x3b5dc9).setOrigin(0, 0).setInteractive({ useHandCursor: true }),
        'dept.buy',
      )
      btn.on('pointerdown', () => {
        playSfx(this, 'select')
        client.send('buy_admin_dept')
      })
      this.objects.push(
        btn,
        this.add.text(GAME_W / 2, 380, `Купить отдел — ${fmtMoney(s.prices.adminDept)}`, {
          fontFamily: FONT, fontSize: '14px', color: '#f4f4f4',
        }).setOrigin(0.5),
        this.add.text(GAME_W / 2, 430, `Админ офиса сам чинит ПК и чистит вирус: ${ADMIN_CLICKS} клика в тик`, {
          fontFamily: FONT, fontSize: '13px', color: '#5d7275',
        }).setOrigin(0.5),
      )
      this.objects.push(...drawDebugFrames(this, this.objects))
      return
    }

    s.offices.forEach((o, oi) => {
      const x = SEAT_X[oi]
      const y = SEAT_Y
      const box = this.add.rectangle(x, y, SEAT_BOX, SEAT_BOX, 0x232640).setStrokeStyle(2, 0x5d7275)
      this.objects.push(
        box,
        this.add.text(x, y - SEAT_BOX / 2 - 16, `офис ${oi + 1}`, {
          fontFamily: FONT, fontSize: '12px', color: o.unlocked ? '#f4f4f4' : '#5d7275',
        }).setOrigin(0.5),
      )
      if (!o.unlocked) {
        box.setAlpha(0.4)
        this.objects.push(this.add.text(x, y + SEAT_BOX / 2 + 16, 'офис не куплен', {
          fontFamily: FONT, fontSize: '11px', color: '#5d7275',
        }).setOrigin(0.5))
        return
      }
      if (o.admin === '') {
        this.objects.push(this.add.text(x, y, 'нет админа', {
          fontFamily: FONT, fontSize: '11px', color: '#5d7275',
        }).setOrigin(0.5))
        return
      }
      const img = tag(addSprite(this, x, y, 'worker', 'person').setInteractive({ useHandCursor: true }), `dept.admin.${oi}`)
      // ЛКМ ничего не делает: админ работает сам; ПКМ — увольнение, как у сотрудника.
      img.on('pointerdown', (p: Phaser.Input.Pointer) => {
        if (p.rightButtonDown()) this.openFireModal(o, oi)
      })
      img.on('pointerover', () => {
        if (this.windowOpen()) return
        this.hoveredSeat = oi
        this.showTooltip(o, oi, s, x, y)
      })
      img.on('pointerout', () => {
        this.hoveredSeat = -1
        this.hideTooltip()
      })
      this.objects.push(
        img,
        tag(this.add.text(x, y + SEAT_BOX / 2 + 14, o.admin, {
          fontFamily: FONT, fontSize: '12px', color: '#f4f4f4',
        }).setOrigin(0.5), `dept.name.${oi}`),
        tag(this.add.text(x, y + SEAT_BOX / 2 + 32, adminStatus(o), {
          fontFamily: FONT, fontSize: '11px', color: KIND_COLOR[o.adminKind] ?? '#5d7275',
        }).setOrigin(0.5), `dept.status.${oi}`),
      )
      // Спрайт пересоздан — тултип восстанавливаем, но только если курсор
      // реально над ним: pointerout по уничтоженному объекту не приходит,
      // и без этой проверки hoveredSeat «залипает» (как место в офисе).
      if (this.hoveredSeat === oi) {
        const p = this.input.activePointer
        if (img.getBounds().contains(p.worldX, p.worldY) && !this.windowOpen()) {
          this.showTooltip(o, oi, s, x, y)
        } else {
          this.hoveredSeat = -1
        }
      }
    })
    this.objects.push(...drawDebugFrames(this, this.objects))
  }

  // Колонка: «Админ ОN $600» — найм; нанят — «✓»; офис закрыт или денег
  // нет — выключена с причиной. В закрытом отделе колонки нет.
  private refreshActions(s: StateMessage) {
    this.hireBtns.forEach((btn, oi) => {
      btn.setShown(s.adminDept)
      const o = s.offices[oi]
      if (o.admin !== '') {
        btn.setLabel(`Админ О${oi + 1} ✓`)
        btn.setEnabled(false, `Нанят: ${o.admin}`)
      } else if (!o.unlocked) {
        btn.setLabel(`Админ О${oi + 1}\n${fmtMoney(s.prices.admin)}`)
        btn.setEnabled(false, `Офис ${oi + 1} не куплен`)
      } else if (s.money < s.prices.admin) {
        btn.setLabel(`Админ О${oi + 1}\n${fmtMoney(s.prices.admin)}`)
        btn.setEnabled(false, `не хватает ${fmtMoney(s.prices.admin - s.money)}`)
      } else {
        btn.setLabel(`Админ О${oi + 1}\n${fmtMoney(s.prices.admin)}`)
        btn.setEnabled(true)
      }
    })
  }

  private showTooltip(o: OfficeInfo, oi: number, s: StateMessage, x: number, y: number) {
    if (this.windowOpen()) return
    const lines = [
      o.admin,
      `Админ офиса ${oi + 1}: чинит и чистит его места сам`,
      `${ADMIN_CLICKS} клика в тик, сначала вирус, потом поломка`,
      `Зарплата:  ${fmtMoney(s.adminSalaryPerDay)}/день${o.adminUnpaidToday ? ' (сегодня без оплаты)' : ''}`,
    ]
    const e = o.adminSlot >= 0 ? o.employees[o.adminSlot] : undefined
    if (e && o.adminKind === 'repair') {
      lines.push(`Сейчас: чинит место ${o.adminSlot + 1} — ${e.repairClicks}/${e.repairNeeded}`)
    } else if (e && o.adminKind === 'virus') {
      lines.push(`Сейчас: чистит место ${o.adminSlot + 1} — ${e.virusClicks}/${e.virusNeeded}`)
    } else {
      lines.push('Сейчас: свободен — в офисе всё цело')
    }
    lines.push(`уволить: ${fmtMoney(o.adminFirePrice)} (правый клик)`)
    this.tooltipText.setText(lines.join('\n'))
    this.tooltipBg.setSize(this.tooltipText.width + 20, this.tooltipText.height + 16)
    const tx = Math.min(x + SEAT_BOX / 2 + 8, GAME_W - this.tooltipBg.width - 8)
    this.tooltip.setPosition(tx, y - SEAT_BOX / 2).setVisible(true)
  }

  private hideTooltip() {
    this.tooltip?.setVisible(false)
  }

  private openFireModal(o: OfficeInfo, oi: number) {
    this.modal('Уволить админа?', [
      o.admin,
      `Компенсация: ${fmtMoney(o.adminFirePrice)}`,
      `Офис ${oi + 1} останется без админа — чинить и чистить снова руками.`,
    ], [
      {
        label: `Уволить (${fmtMoney(o.adminFirePrice)})`,
        onClick: () => client.send('fire_admin', oi),
      },
    ])
  }

  // Открыто окно сцены — над тултипом интерактивная подложка (модалка: depth 70).
  private windowOpen(): boolean {
    return this.children.list.some((o) => {
      const g = o as Phaser.GameObjects.GameObject & { depth?: number }
      return g !== this.tooltip && (g.depth ?? 0) > TOOLTIP_DEPTH && g.input?.enabled === true
    })
  }
}
