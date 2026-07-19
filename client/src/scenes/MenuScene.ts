import Phaser from 'phaser'
import { GAME_H, GAME_W } from '../layout'
import { client } from '../net'
import type { DifficultyId } from '../protocol'

const CX = GAME_W / 2

// Описания уровней — цифры из спеки итерации 8 (сервер — источник истины,
// тут только витрина для выбора).
const LEVELS: { id: DifficultyId; label: string; desc: string; goal: string; color: number }[] = [
  { id: 'easy', label: 'ЛЕГКО', desc: 'цены и зарплаты −20% · старт $900 · выработка +15%', goal: 'Цель: $60,000', color: 0x38b764 },
  { id: 'normal', label: 'НОРМА', desc: 'базовый баланс', goal: 'Цель: $120,000', color: 0x41a6f6 },
  { id: 'hard', label: 'СЛОЖНО', desc: 'цены и зарплаты +25% · старт $540 · выработка −10%', goal: 'Цель: $250,000', color: 0xffcd75 },
  { id: 'hardcore', label: 'ХАРДКОР', desc: 'цены и зарплаты +50% · старт $480 · выработка −20%', goal: 'Цель: $500,000', color: 0xb13e53 },
]

export class MenuScene extends Phaser.Scene {
  constructor() {
    super('menu')
  }

  create() {
    this.add.rectangle(0, 0, GAME_W, GAME_H, 0x1a1c2c).setOrigin(0)
    this.add
      .text(CX, 90, 'IT DIRECTOR', { fontFamily: 'monospace', fontSize: '42px', color: '#ffcd75' })
      .setOrigin(0.5)
    this.add
      .text(CX, 140, 'Выберите сложность', { fontFamily: 'monospace', fontSize: '16px', color: '#f4f4f4' })
      .setOrigin(0.5)

    LEVELS.forEach((lvl, i) => {
      const y = 200 + i * 96
      const bg = this.add.rectangle(CX - 260, y, 520, 80, 0x232640)
        .setOrigin(0).setStrokeStyle(2, 0x3a3f5c).setInteractive({ useHandCursor: true })
      this.add.text(CX - 240, y + 14, lvl.label, {
        fontFamily: 'monospace', fontSize: '20px',
        color: '#' + lvl.color.toString(16).padStart(6, '0'),
      })
      this.add.text(CX - 240, y + 44, lvl.desc, { fontFamily: 'monospace', fontSize: '12px', color: '#5d7275' })
      this.add.text(CX + 240, y + 14, lvl.goal, { fontFamily: 'monospace', fontSize: '13px', color: '#f4f4f4' }).setOrigin(1, 0)
      bg.on('pointerover', () => bg.setStrokeStyle(2, lvl.color))
      bg.on('pointerout', () => bg.setStrokeStyle(2, 0x3a3f5c))
      bg.on('pointerdown', () => this.startGame(lvl.id))
    })
  }

  private startGame(d: DifficultyId) {
    client.connect(d)
    this.scene.start('office') // start глушит menu
    this.scene.launch('hud')
  }
}
