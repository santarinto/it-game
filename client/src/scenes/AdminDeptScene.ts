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
import type { AdminShiftInfo, OfficeInfo, StateMessage } from '../protocol'

// Отдел админов (ITGAME-101/144/145): у админов своя комната — вкладка «АДМ»
// рядом с «СРВ». В каждом офисе до трёх смен админов (день + 2 ночи).
// Найм по очереди заполняет смены (1 → 2 → 3).

// Кликов админа за тик — зеркало Config.AdminClicksPerTick сервера (только
// для строки тултипа; кликает сервер).
const ADMIN_CLICKS = 2

// Центры X столбцов офисов:
const SEAT_X = [330, 560, 790]
// Центры Y для трёх смен (с запасом под фигурку 64×64 и тексты):
const SHIFT_Y = [230, 370, 510]
const SHIFT_BOX_W = 190
const SHIFT_BOX_H = 126

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
  private hoveredShift = -1

  constructor() {
    super({ key: 'adminDept', cameras: HIRES_CAMERA })
  }

  create() {
    // сцены перезапускаются при переключении комнат — сбрасываем ссылки прошлого цикла
    this.objects = []
    this.hoveredSeat = -1
    this.hoveredShift = -1
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
        this.add.text(GAME_W / 2, 430, `Админы офиса чинят ПК и чистят вирус: ${ADMIN_CLICKS} клика в тик днём и 90 ночью`, {
          fontFamily: FONT, fontSize: '13px', color: '#5d7275',
        }).setOrigin(0.5),
      )
      this.objects.push(...drawDebugFrames(this, this.objects))
      return
    }

    s.offices.forEach((o, oi) => {
      const cx = SEAT_X[oi]
      this.objects.push(
        this.add.text(cx, 156, `офис ${oi + 1}`, {
          fontFamily: FONT, fontSize: '13px', color: o.unlocked ? '#f4f4f4' : '#5d7275',
        }).setOrigin(0.5),
      )

      for (let shift = 1; shift <= 3; shift++) {
        const cy = SHIFT_Y[shift - 1]
        const box = this.add.rectangle(cx, cy, SHIFT_BOX_W, SHIFT_BOX_H, 0x232640).setStrokeStyle(2, 0x3a3f5c)
        this.objects.push(box)

        const shiftHeader = shift === 1 ? '1. День (10:00–19:00)' : shift === 2 ? '2. Ночь 1 (19:00–02:30)' : '3. Ночь 2 (02:30–10:00)'
        this.objects.push(
          this.add.text(cx, cy - 48, shiftHeader, {
            fontFamily: FONT, fontSize: '10px', color: '#8fa1a4',
          }).setOrigin(0.5),
        )

        if (!o.unlocked) {
          box.setAlpha(0.4)
          if (shift === 1) {
            this.objects.push(this.add.text(cx, cy + 6, 'офис не куплен', {
              fontFamily: FONT, fontSize: '11px', color: '#5d7275',
            }).setOrigin(0.5))
          }
          continue
        }

        let shiftData = o.adminShifts?.find((sh) => sh.shift === shift)
        if (!shiftData && shift === 1 && o.admin !== '') {
          shiftData = { shift: 1, name: o.admin, unpaidToday: o.adminUnpaidToday, firePrice: o.adminFirePrice }
        }

        if (!shiftData) {
          const emptyLabel = shift === 1 ? 'нет админа' : 'вакансия'
          this.objects.push(this.add.text(cx, cy + 6, emptyLabel, {
            fontFamily: FONT, fontSize: '11px', color: '#5d7275',
          }).setOrigin(0.5))
          continue
        }

        const imgTag = shift === 1 ? `dept.admin.${oi}` : `dept.admin.${oi}.${shift}`
        const img = tag(addSprite(this, cx, cy - 6, 'worker', 'person').setInteractive({ useHandCursor: true }), imgTag)
        const currentShift = shiftData
        img.on('pointerdown', (p: Phaser.Input.Pointer) => {
          if (p.rightButtonDown()) this.openFireModal(o, oi, currentShift)
        })
        img.on('pointerover', () => {
          if (this.windowOpen()) return
          this.hoveredSeat = oi
          this.hoveredShift = currentShift.shift
          this.showTooltip(o, oi, s, cx, cy, currentShift)
        })
        img.on('pointerout', () => {
          this.hoveredSeat = -1
          this.hoveredShift = -1
          this.hideTooltip()
        })

        const nameObj = this.add.text(cx, cy + 39, shiftData.name, {
          fontFamily: FONT, fontSize: '11px', color: '#f4f4f4',
        }).setOrigin(0.5)
        if (shift === 1) tag(nameObj, `dept.name.${oi}`)

        const statusStr = shift === 1 ? adminStatus(o) : 'дежурит ночью'
        const statusCol = shift === 1 ? (KIND_COLOR[o.adminKind] ?? '#5d7275') : '#8fa1a4'
        const statusObj = this.add.text(cx, cy + 54, statusStr, {
          fontFamily: FONT, fontSize: '10px', color: statusCol,
        }).setOrigin(0.5)
        if (shift === 1) tag(statusObj, `dept.status.${oi}`)

        this.objects.push(img, nameObj, statusObj)

        if (this.hoveredSeat === oi && this.hoveredShift === shift) {
          const p = this.input.activePointer
          if (img.getBounds().contains(p.worldX, p.worldY) && !this.windowOpen()) {
            this.showTooltip(o, oi, s, cx, cy, currentShift)
          } else {
            this.hoveredSeat = -1
            this.hoveredShift = -1
          }
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
      const nextShift = o.adminNextShift ?? (o.admin === '' ? 1 : (o.adminShifts?.length ?? 1) < 3 ? (o.adminShifts?.length ?? 1) + 1 : 0)
      if (!o.unlocked) {
        btn.setLabel(`Админ О${oi + 1}\n${fmtMoney(s.prices.admin)}`)
        btn.setEnabled(false, `Офис ${oi + 1} не куплен`)
      } else if (nextShift === 0) {
        btn.setLabel(`Админ О${oi + 1} ✓`)
        btn.setEnabled(false, `Все 3 смены укомплектованы`)
      } else if (s.money < s.prices.admin) {
        const shiftSuffix = nextShift === 1 ? '' : nextShift === 2 ? ' (н1)' : ' (н2)'
        btn.setLabel(`Админ О${oi + 1}${shiftSuffix}\n${fmtMoney(s.prices.admin)}`)
        btn.setEnabled(false, `не хватает ${fmtMoney(s.prices.admin - s.money)}`)
      } else {
        const shiftSuffix = nextShift === 1 ? '' : nextShift === 2 ? ' (н1)' : ' (н2)'
        btn.setLabel(`Админ О${oi + 1}${shiftSuffix}\n${fmtMoney(s.prices.admin)}`)
        btn.setEnabled(true)
      }
    })
  }

  private showTooltip(o: OfficeInfo, oi: number, s: StateMessage, x: number, y: number, shift: AdminShiftInfo) {
    if (this.windowOpen()) return
    const lines = [shift.name]
    if (shift.shift === 1) {
      lines.push(
        `Админ офиса ${oi + 1}: чинит и чистит его места сам`,
        `${ADMIN_CLICKS} клика в тик, сначала вирус, потом поломка`,
        `Зарплата:  ${fmtMoney(s.adminSalaryPerDay)}/день${shift.unpaidToday ? ' (сегодня без оплаты)' : ''}`,
      )
      const e = o.adminSlot >= 0 ? o.employees[o.adminSlot] : undefined
      if (e && o.adminKind === 'repair') {
        lines.push(`Сейчас: чинит место ${o.adminSlot + 1} — ${e.repairClicks}/${e.repairNeeded}`)
      } else if (e && o.adminKind === 'virus') {
        lines.push(`Сейчас: чистит место ${o.adminSlot + 1} — ${e.virusClicks}/${e.virusNeeded}`)
      } else {
        lines.push('Сейчас: свободен — в офисе всё цело')
      }
    } else {
      const shiftName = shift.shift === 2 ? 'ночь 1, 19:00–02:30' : 'ночь 2, 02:30–10:00'
      lines.push(
        `Ночной админ офиса ${oi + 1} (${shiftName})`,
        `45 тиков (90 кликов) ремонта и чистки перед открытием офиса`,
        `Зарплата:  ${fmtMoney(s.adminSalaryPerDay)}/день${shift.unpaidToday ? ' (сегодня без оплаты)' : ''}`,
        'Дежурит ночью, сводка утром в журнале дня',
      )
    }
    lines.push(`уволить: ${fmtMoney(shift.firePrice)} (правый клик)`)
    this.tooltipText.setText(lines.join('\n'))
    this.tooltipBg.setSize(this.tooltipText.width + 20, this.tooltipText.height + 16)
    const tx = Math.min(x + SHIFT_BOX_W / 2 + 8, GAME_W - this.tooltipBg.width - 8)
    const ty = Phaser.Math.Clamp(y - SHIFT_BOX_H / 2, 4, GAME_H - this.tooltipBg.height - 4)
    this.tooltip.setPosition(tx, ty).setVisible(true)
  }

  private hideTooltip() {
    this.tooltip?.setVisible(false)
  }

  private openFireModal(o: OfficeInfo, oi: number, shift: AdminShiftInfo) {
    const shiftName = shift.shift === 1 ? 'Смена 1 (день)' : shift.shift === 2 ? 'Смена 2 (ночь 1)' : 'Смена 3 (ночь 2)'
    this.modal('Уволить админа?', [
      shift.name,
      shiftName,
      `Компенсация: ${fmtMoney(shift.firePrice)}`,
      `Офис ${oi + 1}: смена станет вакантной.`,
    ], [
      {
        label: `Уволить (${fmtMoney(shift.firePrice)})`,
        onClick: () => client.send('fire_admin', oi, { slot: shift.shift }),
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
