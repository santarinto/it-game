import Phaser from 'phaser'
import { GAME_H, GAME_W } from '../layout'
import { client, hasSavedSession, savedDifficulty } from '../net'
import { activeZoom, applyZoom, ZOOM_OPTIONS } from '../uiscale'
import { tag } from '../debug/agentApi'
import type { DifficultyId } from '../protocol'

const CX = GAME_W / 2

// Описания уровней — витрина выбора (сервер — источник истины).
// Цели итерации 14 + рычаги «Сложности 2.0» (ITGAME-9).
const LEVELS: { id: DifficultyId; label: string; desc: string; goal: string; color: number }[] = [
  { id: 'easy', label: 'ЛЕГКО', desc: 'цены и зарплаты −20% · старт $900 · выработка +15%', goal: '$60k', color: 0x38b764 },
  { id: 'normal', label: 'НОРМА', desc: 'базовый баланс', goal: '$250k', color: 0x41a6f6 },
  { id: 'hard', label: 'СЛОЖНО', desc: '+25% цены · рынок ±10% · кредит $5k (10%/д)', goal: '$500k + сеть', color: 0xffcd75 },
  { id: 'hardcore', label: 'ХАРДКОР', desc: '+50% цены · рынок ±15% · кредит $10k (15%/д)', goal: '$1M до дня 30', color: 0xb13e53 },
]

export class MenuScene extends Phaser.Scene {
  private started = false

  constructor() {
    super('menu')
  }

  create() {
    this.started = false
    this.add.rectangle(0, 0, GAME_W, GAME_H, 0x1a1c2c).setOrigin(0)
    this.add
      .text(CX, 90, 'IT DIRECTOR', { fontFamily: 'monospace', fontSize: '42px', color: '#ffcd75' })
      .setOrigin(0.5)

    let firstY = 200
    // «Продолжить» (ITGAME-8): на сервере живёт сейв сессии — возвращаем
    // игрока в его партию (сложность игнорируется, конфиг в сейве).
    if (hasSavedSession()) {
      const y = 150
      const bg = tag(
        this.add.rectangle(CX - 260, y, 520, 56, 0x253d2a)
          .setOrigin(0).setStrokeStyle(2, 0x38b764).setInteractive({ useHandCursor: true }),
        'menu.continue',
      )
      this.add.text(CX - 240, y + 16, 'ПРОДОЛЖИТЬ', {
        fontFamily: 'monospace', fontSize: '18px', color: '#38b764',
      })
      this.add.text(CX - 240, y + 38, 'сохранённая игра — день, баланс и офисы на месте', {
        fontFamily: 'monospace', fontSize: '11px', color: '#5d7275',
      })
      bg.on('pointerover', () => bg.setStrokeStyle(2, 0xffcd75))
      bg.on('pointerout', () => bg.setStrokeStyle(2, 0x38b764))
      bg.on('pointerdown', () => this.startGame(savedDifficulty()))
      firstY = 244
      this.add
        .text(CX, 224, 'или начните новую:', { fontFamily: 'monospace', fontSize: '12px', color: '#5d7275' })
        .setOrigin(0.5)
    } else {
      this.add
        .text(CX, 140, 'Выберите сложность', { fontFamily: 'monospace', fontSize: '16px', color: '#f4f4f4' })
        .setOrigin(0.5)
    }

    LEVELS.forEach((lvl, i) => {
      const y = firstY + i * 96
      const bg = tag(
        this.add.rectangle(CX - 260, y, 520, 80, 0x232640)
          .setOrigin(0).setStrokeStyle(2, 0x3a3f5c).setInteractive({ useHandCursor: true }),
        `menu.diff.${lvl.id}`,
      )
      this.add.text(CX - 240, y + 14, lvl.label, {
        fontFamily: 'monospace', fontSize: '20px',
        color: '#' + lvl.color.toString(16).padStart(6, '0'),
      })
      this.add.text(CX - 240, y + 44, lvl.desc, { fontFamily: 'monospace', fontSize: '12px', color: '#5d7275' })
      this.add.text(CX + 240, y + 14, `Цель: ${lvl.goal}`, { fontFamily: 'monospace', fontSize: '13px', color: '#f4f4f4' }).setOrigin(1, 0)
      bg.on('pointerover', () => bg.setStrokeStyle(2, lvl.color))
      bg.on('pointerout', () => bg.setStrokeStyle(2, 0x3a3f5c))
      bg.on('pointerdown', () => this.startGame(lvl.id))
    })

    // Масштаб UI (ITGAME-15): стартовый экран — единственное место, где все
    // варианты видны рядом; применяется на лету, переживает перезагрузку.
    this.add
      .text(449, 665, 'Масштаб:', { fontFamily: 'monospace', fontSize: '12px', color: '#5d7275' })
      .setOrigin(0, 0.5)
    const zoomBtns: { bg: Phaser.GameObjects.Rectangle; value: (typeof ZOOM_OPTIONS)[number]['value'] }[] = []
    ZOOM_OPTIONS.forEach((o, i) => {
      const x = 519 + i * 80
      const bg = tag(
        this.add.rectangle(x, 650, 72, 30, 0x232640)
          .setOrigin(0).setStrokeStyle(2, 0x3a3f5c).setInteractive({ useHandCursor: true }),
        `menu.zoom.${o.value}`,
      )
      this.add
        .text(x + 36, 665, o.label, { fontFamily: 'monospace', fontSize: '12px', color: '#f4f4f4' })
        .setOrigin(0.5)
      const highlight = () => bg.setStrokeStyle(2, activeZoom() === o.value ? 0x41a6f6 : 0x3a3f5c)
      highlight()
      bg.on('pointerdown', () => {
        applyZoom(this.game, o.value)
        zoomBtns.forEach((b) => b.bg.setStrokeStyle(2, activeZoom() === b.value ? 0x41a6f6 : 0x3a3f5c))
      })
      bg.on('pointerover', highlight)
      bg.on('pointerout', highlight)
      zoomBtns.push({ bg, value: o.value })
    })

    this.registerKeys()
  }

  // Клавиатура меню (ITGAME-24): 1-4 — сложность, Enter — «Продолжить»
  // (или «НОРМА», если сейва нет). itd.key() дергает те же обработчики.
  private registerKeys() {
    const kb = this.input.keyboard
    if (!kb) return
    kb.on('keydown-ONE', () => this.startGame('easy'))
    kb.on('keydown-TWO', () => this.startGame('normal'))
    kb.on('keydown-THREE', () => this.startGame('hard'))
    kb.on('keydown-FOUR', () => this.startGame('hardcore'))
    kb.on('keydown-ENTER', () => this.startGame(hasSavedSession() ? savedDifficulty() : 'normal'))
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => kb.removeAllListeners())
  }

  private startGame(d: DifficultyId) {
    if (this.started) return
    // Флаг — только после фактического старта (ITGAME-24): ошибка старта
    // раньше молча залипала меню, кнопки переставали отвечать.
    try {
      client.connect(d)
      this.scene.start('office') // start глушит menu
      this.scene.launch('hud')
      this.started = true
    } catch (e) {
      console.error('не удалось начать игру', e)
      this.toastStartError()
    }
  }

  private toastStartError() {
    const t = this.add
      .text(CX, 700, 'Не удалось начать игру — попробуйте ещё раз', {
        fontFamily: 'monospace', fontSize: '13px', color: '#f4f4f4',
        backgroundColor: '#b13e53', padding: { x: 12, y: 6 },
      })
      .setOrigin(0.5)
    this.time.delayedCall(3000, () => t.destroy())
  }
}
