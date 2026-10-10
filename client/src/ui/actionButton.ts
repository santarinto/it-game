import Phaser from 'phaser'
import { GAME_H, GAME_W } from '../layout'
import { markDisabled, rejectClick, tag } from '../debug/agentApi'
import { playSfx } from '../audio'
import { FONT } from '../render'

// Кнопки действий комнаты (ITGAME-94): покупка ПК, найм, начальник — в офисе,
// шлюз — в серверной. До ITGAME-94 жили в шапке HUD (общей для всех комнат);
// механика осталась прежней (ITGAME-17): затемнение недоступной, тултип с
// причиной при наведении, тряска и звук отказа на клике, флаг D в itd.screen()
// (markDisabled, ITGAME-72). id кнопок (btn.pc, btn.hire, btn.boss, btn.gateway)
// не менялись. Тост/звук «нет связи» (ITGAME-90) приходит из HUD сам:
// client.send зовёт onNotConnected у всех подписчиков.
//
// Сцены комнат перерисовывают объекты на каждый снапшот, а кнопки создаются
// один раз в create() и живут до SHUTDOWN сцены: иначе пересоздание каждую
// секунду сбивало бы наведение, тултип и тряску.

// Колонка действий — у правого края комнаты (x 1142..1270), в одном столбце
// с устройствами комнаты (сеть и начальник в офисе, шлюз в серверной —
// их центры сдвинуты на ACTION_COL_CX). Сюда не дотягиваются ни тосты HUD
// (до 924px шириной по центру поля — правый край не дальше x 1102), ни
// панель события (x 400..880), ни столы офиса (правый столбец с кнопкой
// мастера и меткой «✖ чинить» кончается на x 1124). Подпись в две строки:
// действие и цена.
export const ACTION_W = 128
export const ACTION_H = 44
const ACTION_GAP = 10
export const ACTION_COL_X = GAME_W - 10 - ACTION_W
export const ACTION_COL_CX = ACTION_COL_X + ACTION_W / 2

// y верхнего края i-й кнопки колонки, начинающейся с top.
export function actionColY(top: number, i: number): number {
  return top + i * (ACTION_H + ACTION_GAP)
}

export interface ActionButton {
  setLabel(s: string): void
  setEnabled(enabled: boolean, tooltip?: string): void
  isEnabled(): boolean
  // Закрытый офис (ITGAME-94): колонки нет — кнопка невидима и без ввода,
  // itd.click() по ней отвечает code 'hidden'.
  setShown(shown: boolean): void
}

// Живые колонки всех сцен: HUD гасит их тултипы, когда открывает своё окно
// (отчёт дня, выход, реконнект, событие), — раньше это делал его собственный
// hideButtonTooltip().
const live = new Set<ActionBar>()

export function hideActionTooltips(): void {
  live.forEach((b) => b.hideTooltip())
}

export class ActionBar {
  private readonly scene: Phaser.Scene
  private readonly blocked: () => boolean
  private readonly tooltip: Phaser.GameObjects.Container
  private readonly tooltipBg: Phaser.GameObjects.Rectangle
  private readonly tooltipText: Phaser.GameObjects.Text
  private hoveredId: string | null = null
  // Подложки кнопок — для рамок отладки (drawDebugFrames) сцены.
  readonly interactive: Phaser.GameObjects.Rectangle[] = []

  // depth — тултип поверх сцены, но под окнами (модалка — depth 70);
  // blocked — у сцены открыто своё окно: тултип не показываем (ITGAME-89).
  constructor(scene: Phaser.Scene, opts: { depth: number; blocked?: () => boolean }) {
    this.scene = scene
    this.blocked = opts.blocked ?? (() => false)
    this.tooltipText = tag(
      scene.add.text(10, 7, '', {
        fontFamily: FONT, fontSize: '12px', color: '#ffcd75', align: 'center',
      }).setOrigin(0, 0).setVisible(false),
      'room.tooltip.text',
    )
    this.tooltipBg = tag(
      scene.add.rectangle(0, 0, 10, 10, 0x14162b, 0.95)
        .setOrigin(0, 0).setStrokeStyle(1, 0x41a6f6).setVisible(false),
      'room.tooltip.bg',
    )
    this.tooltip = scene.add.container(0, 0, [this.tooltipBg, this.tooltipText])
      .setDepth(opts.depth).setVisible(false)
    live.add(this)
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => live.delete(this))
  }

  // Кнопка колонки: левый край ACTION_COL_X, верх y.
  add(y: number, id: string, onClick: () => void): ActionButton {
    const x = ACTION_COL_X
    const scene = this.scene
    let enabled = true
    let shown = true
    let tooltipText: string | undefined
    let isShaking = false

    const bg = tag(
      scene.add.rectangle(x, y, ACTION_W, ACTION_H, 0x3b5dc9)
        .setOrigin(0, 0)
        .setInteractive({ useHandCursor: true }),
      id,
    )
    const txt = scene.add
      .text(x + ACTION_W / 2, y + ACTION_H / 2, '…', {
        fontFamily: FONT, fontSize: '13px', color: '#f4f4f4', align: 'center', lineSpacing: 2,
      })
      .setOrigin(0.5)

    const applyState = () => {
      if (enabled) {
        bg.setFillStyle(this.hoveredId === id ? 0x41a6f6 : 0x3b5dc9)
        bg.setStrokeStyle(0)
        bg.setAlpha(1)
        txt.setAlpha(1)
      } else {
        bg.setFillStyle(0x232640)
        bg.setStrokeStyle(2, 0x3a3f5c)
        bg.setAlpha(0.45)
        txt.setAlpha(0.45)
      }
      markDisabled(bg, !enabled) // ITGAME-72: флаг D в itd.screen()
    }

    const shake = () => {
      if (isShaking) return
      isShaking = true
      scene.tweens.addCounter({
        from: 0,
        to: Math.PI * 4,
        duration: 180,
        onUpdate: (tween) => {
          if (!bg.scene) return
          const offset = Math.sin(tween.getValue() ?? 0) * 5
          bg.x = x + offset
          txt.x = x + ACTION_W / 2 + offset
        },
        onComplete: () => {
          if (bg.scene) {
            bg.x = x
            txt.x = x + ACTION_W / 2
          }
          isShaking = false
        },
      })
    }

    bg.on('pointerdown', () => {
      if (!shown) {
        rejectClick('hidden')
        return
      }
      if (!enabled) {
        playSfx(scene, 'error')
        shake()
        return
      }
      onClick()
    })

    bg.on('pointerover', () => {
      if (!shown) return
      this.hoveredId = id
      if (enabled) {
        bg.setFillStyle(0x41a6f6)
      } else {
        bg.setFillStyle(0x232640)
        if (tooltipText) this.showTooltip(tooltipText, x, y)
      }
    })

    bg.on('pointerout', () => {
      if (this.hoveredId === id) this.hideTooltip()
      applyState()
    })

    this.interactive.push(bg)

    return {
      setLabel: (s: string) => txt.setText(s),
      setEnabled: (e: boolean, tooltip?: string) => {
        enabled = e
        tooltipText = tooltip
        applyState()
        if (this.hoveredId === id) {
          if (!enabled && tooltipText) {
            this.showTooltip(tooltipText, x, y)
          } else {
            this.tooltip.setVisible(false)
            this.tooltipText.setVisible(false)
            this.tooltipBg.setVisible(false)
          }
        }
      },
      isEnabled: () => enabled,
      setShown: (s: boolean) => {
        if (s === shown) return
        shown = s
        bg.setVisible(s)
        txt.setVisible(s)
        if (s) {
          bg.setInteractive({ useHandCursor: true })
        } else {
          bg.disableInteractive()
          if (this.hoveredId === id) this.hideTooltip()
        }
      },
    }
  }

  // Слева от кнопки, по её середине: колонка стоит у правого края поля.
  private showTooltip(text: string, x: number, y: number) {
    if (!text || this.blocked()) {
      this.hideTooltip()
      return
    }
    this.tooltipText.setText(text).setVisible(true)
    this.tooltipBg.setSize(this.tooltipText.width + 20, this.tooltipText.height + 14).setVisible(true)
    const w = this.tooltipBg.width
    const h = this.tooltipBg.height
    const tx = Math.max(8, x - w - 6)
    const ty = Phaser.Math.Clamp(y + ACTION_H / 2 - h / 2, 4, GAME_H - h - 4)
    this.tooltip.setPosition(tx, ty).setVisible(true)
  }

  hideTooltip() {
    this.hoveredId = null
    this.tooltip.setVisible(false)
    this.tooltipText.setVisible(false)
    this.tooltipBg.setVisible(false)
  }
}
