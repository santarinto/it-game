import Phaser from 'phaser'
import { GAME_H, GAME_W, HUD_H, NAV_W } from '../layout'
import { FONT, HIRES_CAMERA } from '../render'
import { addSprite } from '../pixelart'
import { tag } from '../debug/agentApi'
import { fmtMoney } from '../format'
import { client } from '../net'
import type { StateMessage } from '../protocol'
import { playSfx } from '../audio'

const CX = NAV_W + Math.round((GAME_W - NAV_W) / 2)
const TOP_Y = 170
const CARD_X = 450
const CARD_W = 750
const CARD_H = 114
const CARD_GAP = 18

export class DirectorScene extends Phaser.Scene {
  private objects: Phaser.GameObjects.GameObject[] = []

  constructor() {
    super({ key: 'director', cameras: HIRES_CAMERA })
  }

  create() {
    this.objects = []

    this.add.rectangle(NAV_W, HUD_H, GAME_W - NAV_W, GAME_H - HUD_H, 0x1f2233).setOrigin(0)

    const unsub = client.subscribe({
      onState: (s) => this.render(s),
      onError: () => {},
      onDisconnect: () => {},
    })
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, unsub)
  }

  private render(s: StateMessage) {
    this.objects.forEach((o) => o.destroy())
    this.objects = []

    // Заголовок сцены (по центру доступной области правее nav)
    this.objects.push(
      this.add.text(CX, HUD_H + 20, 'КАБИНЕТ ДИРЕКТОРА', {
        fontFamily: FONT, fontSize: '18px', color: '#f4f4f4',
      }).setOrigin(0.5),
      this.add.text(CX, HUD_H + 44, 'Рабочее место руководителя · Прокачка очков действий', {
        fontFamily: FONT, fontSize: '12px', color: '#8fa1a4',
      }).setOrigin(0.5),
    )

    // Левая карточка: Аватар и статус директора
    const avatarCard = this.add.rectangle(84, TOP_Y, 340, 510, 0x232640).setOrigin(0).setStrokeStyle(2, 0x3a3f5c)
    const rug = this.add.rectangle(114, TOP_Y + 30, 280, 160, 0x1a1c2c).setOrigin(0)

    const bossKey = s.isLunch ? 'boss_lunch' : 'boss'
    const boss = tag(addSprite(this, 254, TOP_Y + 100, bossKey, 'person'), 'director.avatar')
    const desk = addSprite(this, 254, TOP_Y + 135, 'desk_pc', 'desk')

    const title = this.add.text(254, TOP_Y + 200, 'IT-ДИРЕКТОР', {
      fontFamily: FONT, fontSize: '16px', color: '#fbcc58',
    }).setOrigin(0.5)

    const levelText = tag(this.add.text(254, TOP_Y + 235, `Уровень: ${s.directorLevel}`, {
      fontFamily: FONT, fontSize: '14px', color: '#f4f4f4',
    }).setOrigin(0.5), 'director.level')

    const expText = tag(this.add.text(254, TOP_Y + 265, `Опыт: День ${s.day} (+${s.directorExpBonus} ОД/день)`, {
      fontFamily: FONT, fontSize: '12px', color: '#8fa1a4',
    }).setOrigin(0.5), 'director.exp')

    const pointsText = tag(this.add.text(254, TOP_Y + 295, `Очки действий: ${s.actionPoints} / ${s.actionPointsMax}`, {
      fontFamily: FONT, fontSize: '14px', color: '#38b764',
    }).setOrigin(0.5), 'director.points')

    const info = this.add.text(254, TOP_Y + 380, '1 очко действий тратится на старт\nремонта или чистки заражённого ПК.\nОчки восстанавливаются каждое утро.', {
      fontFamily: FONT, fontSize: '11px', color: '#5d7275', align: 'center', lineSpacing: 4,
    }).setOrigin(0.5)

    this.objects.push(avatarCard, rug, boss, desk, title, levelText, expText, pointsText, info)

    // Правая панель: Список улучшений кабинета
    const levels = s.prices.directorCabinetLevels || []
    levels.forEach((lvl, idx) => {
      const y = TOP_Y + idx * (CARD_H + CARD_GAP)
      const isUnlocked = idx < s.directorCabinet
      const isCurrent = idx === s.directorCabinet
      const isLocked = idx > s.directorCabinet

      const borderColor = isUnlocked ? 0x38b764 : isCurrent ? 0x41a6f6 : 0x3a3f5c
      const bgColor = isCurrent ? 0x282c48 : 0x232640

      const box = this.add.rectangle(CARD_X, y, CARD_W, CARD_H, bgColor).setOrigin(0).setStrokeStyle(2, borderColor)
      this.objects.push(box)

      // Название и номер уровня
      const nameTxt = this.add.text(CARD_X + 24, y + 24, `${idx + 1}. ${lvl.name}`, {
        fontFamily: FONT, fontSize: '15px', color: isLocked ? '#5d7275' : '#f4f4f4',
      })
      this.objects.push(nameTxt)

      // Описание бонуса
      const bonusTxt = this.add.text(CARD_X + 24, y + 58, `Прибавка к рабочему времени: +${lvl.bonus} ОД каждое утро`, {
        fontFamily: FONT, fontSize: '12px', color: isUnlocked ? '#38b764' : isLocked ? '#5d7275' : '#8fa1a4',
      })
      this.objects.push(bonusTxt)

      if (isUnlocked) {
        const badge = this.add.text(CARD_X + CARD_W - 24, y + CARD_H / 2, '✓ УСТАНОВЛЕНО', {
          fontFamily: FONT, fontSize: '13px', color: '#38b764',
        }).setOrigin(1, 0.5)
        this.objects.push(badge)
      } else if (isCurrent) {
        const canAfford = s.money >= lvl.price
        const btnBgColor = canAfford ? 0x3b5dc9 : 0x232640
        const btnStrokeColor = canAfford ? 0x41a6f6 : 0x3a3f5c

        const btn = tag(
          this.add.rectangle(CARD_X + CARD_W - 224, y + 33, 200, 48, btnBgColor)
            .setOrigin(0).setStrokeStyle(2, btnStrokeColor).setInteractive({ useHandCursor: canAfford }),
          'director.upgrade',
        )
        const btnTxt = this.add.text(CARD_X + CARD_W - 124, y + 57, `Улучшить · ${fmtMoney(lvl.price)}`, {
          fontFamily: FONT, fontSize: '13px', color: canAfford ? '#f4f4f4' : '#5d7275',
        }).setOrigin(0.5)

        if (canAfford) {
          btn.on('pointerdown', () => {
            playSfx(this, 'select')
            client.send('upgrade_director')
          })
          btn.on('pointerover', () => btn.setFillStyle(0x41a6f6))
          btn.on('pointerout', () => btn.setFillStyle(0x3b5dc9))
        }

        this.objects.push(btn, btnTxt)
      } else {
        const lockTxt = this.add.text(CARD_X + CARD_W - 24, y + CARD_H / 2, `Требуется уровень ${idx}`, {
          fontFamily: FONT, fontSize: '12px', color: '#5d7275',
        }).setOrigin(1, 0.5)
        this.objects.push(lockTxt)
      }
    })
  }
}
