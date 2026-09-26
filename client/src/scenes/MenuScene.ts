import Phaser from 'phaser'
import { GAME_H, GAME_W } from '../layout'
import { checkActiveNeighbor, client, hasSavedSession, prepareNewGame, savedDifficulty, sessionId } from '../net'
import { activeZoom, applyZoom, ZOOM_OPTIONS } from '../uiscale'
import { markActive, tag } from '../debug/agentApi'
import { fmtMoney } from '../format'
import { getAchievementsSummary, loadStats } from '../meta'
import type { DifficultyId } from '../protocol'
import { emitUi } from '../uibus'

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
  private bg?: Phaser.GameObjects.Rectangle
  private menuUI: (Phaser.GameObjects.GameObject & Phaser.GameObjects.Components.Visible)[] = []
  private modalUI: Phaser.GameObjects.GameObject[] = []

  constructor() {
    super('menu')
  }

  create() {
    this.started = false
    this.menuUI = []
    this.closeModal()
    this.bg = this.add.rectangle(0, 0, GAME_W, GAME_H, 0x1a1c2c).setOrigin(0)
    const title = this.add
      .text(CX, 90, 'IT DIRECTOR', { fontFamily: 'monospace', fontSize: '42px', color: '#ffcd75' })
      .setOrigin(0.5)
    this.menuUI.push(this.bg, title)

    let firstY = 200
    // «Продолжить» (ITGAME-8): на сервере живёт сейв сессии — возвращаем
    // игрока в его партию (сложность игнорируется, конфиг в сейве).
    if (hasSavedSession()) {
      const y = 150
      const continueBg = tag(
        this.add.rectangle(CX - 260, y, 520, 56, 0x253d2a)
          .setOrigin(0).setStrokeStyle(2, 0x38b764).setInteractive({ useHandCursor: true }),
        'menu.continue',
      )
      const continueTxt = this.add.text(CX - 240, y + 16, 'ПРОДОЛЖИТЬ', {
        fontFamily: 'monospace', fontSize: '18px', color: '#38b764',
      })
      const continueDesc = this.add.text(CX - 240, y + 38, 'сохранённая игра — день, баланс и офисы на месте', {
        fontFamily: 'monospace', fontSize: '11px', color: '#5d7275',
      })
      continueBg.on('pointerover', () => continueBg.setStrokeStyle(2, 0xffcd75))
      continueBg.on('pointerout', () => continueBg.setStrokeStyle(2, 0x38b764))
      continueBg.on('pointerdown', () => this.onContinueClick())
      firstY = 244
      const orNew = this.add
        .text(CX, 224, 'или начните новую:', { fontFamily: 'monospace', fontSize: '12px', color: '#5d7275' })
        .setOrigin(0.5)
      this.menuUI.push(continueBg, continueTxt, continueDesc, orNew)
    } else {
      const chooseDiff = this.add
        .text(CX, 140, 'Выберите сложность', { fontFamily: 'monospace', fontSize: '16px', color: '#f4f4f4' })
        .setOrigin(0.5)
      this.menuUI.push(chooseDiff)
    }

    LEVELS.forEach((lvl, i) => {
      const y = firstY + i * 96
      const diffBg = tag(
        this.add.rectangle(CX - 260, y, 520, 80, 0x232640)
          .setOrigin(0).setStrokeStyle(2, 0x3a3f5c).setInteractive({ useHandCursor: true }),
        `menu.diff.${lvl.id}`,
      )
      const diffLbl = this.add.text(CX - 240, y + 14, lvl.label, {
        fontFamily: 'monospace', fontSize: '20px',
        color: '#' + lvl.color.toString(16).padStart(6, '0'),
      })
      const diffDesc = this.add.text(CX - 240, y + 44, lvl.desc, { fontFamily: 'monospace', fontSize: '12px', color: '#5d7275' })
      const diffGoal = this.add.text(CX + 240, y + 14, `Цель: ${lvl.goal}`, { fontFamily: 'monospace', fontSize: '13px', color: '#f4f4f4' }).setOrigin(1, 0)
      diffBg.on('pointerover', () => diffBg.setStrokeStyle(2, lvl.color))
      diffBg.on('pointerout', () => diffBg.setStrokeStyle(2, 0x3a3f5c))
      diffBg.on('pointerdown', () => this.startGame(lvl.id, true))
      this.menuUI.push(diffBg, diffLbl, diffDesc, diffGoal)
    })

    // Мета-прогресс (ITGAME-10): Статистика забегов слева
    const statsBg = tag(
      this.add.rectangle(170, 650, 160, 30, 0x232640)
        .setOrigin(0).setStrokeStyle(2, 0x3a3f5c).setInteractive({ useHandCursor: true }),
      'menu.stats',
    )
    const statsTxt = this.add
      .text(250, 665, '📊 Статистика', { fontFamily: 'monospace', fontSize: '12px', color: '#f4f4f4' })
      .setOrigin(0.5)
    statsBg.on('pointerover', () => statsBg.setStrokeStyle(2, 0x41a6f6))
    statsBg.on('pointerout', () => statsBg.setStrokeStyle(2, 0x3a3f5c))
    statsBg.on('pointerdown', () => this.showStatsModal())
    this.menuUI.push(statsBg, statsTxt)

    // Масштаб UI (ITGAME-15): стартовый экран — единственное место, где все
    // варианты видны рядом; применяется на лету, переживает перезагрузку.
    const zoomLbl = this.add
      .text(449, 665, 'Масштаб:', { fontFamily: 'monospace', fontSize: '12px', color: '#5d7275' })
      .setOrigin(0, 0.5)
    this.menuUI.push(zoomLbl)
    const zoomBtns: { bg: Phaser.GameObjects.Rectangle; value: (typeof ZOOM_OPTIONS)[number]['value'] }[] = []
    ZOOM_OPTIONS.forEach((o, i) => {
      const x = 519 + i * 80
      const zBg = tag(
        this.add.rectangle(x, 650, 72, 30, 0x232640)
          .setOrigin(0).setStrokeStyle(2, 0x3a3f5c).setInteractive({ useHandCursor: true }),
        `menu.zoom.${o.value}`,
      )
      const zTxt = this.add
        .text(x + 36, 665, o.label, { fontFamily: 'monospace', fontSize: '12px', color: '#f4f4f4' })
        .setOrigin(0.5)
      const highlight = () => {
        const on = activeZoom() === o.value
        zBg.setStrokeStyle(2, on ? 0x41a6f6 : 0x3a3f5c)
        markActive(zBg, on)
      }
      highlight()
      zBg.on('pointerdown', () => {
        applyZoom(this.game, o.value)
        zoomBtns.forEach((b) => {
          const on = activeZoom() === b.value
          b.bg.setStrokeStyle(2, on ? 0x41a6f6 : 0x3a3f5c)
          markActive(b.bg, on)
        })
      })
      zBg.on('pointerover', highlight)
      zBg.on('pointerout', highlight)
      zoomBtns.push({ bg: zBg, value: o.value })
      this.menuUI.push(zBg, zTxt)
    })

    // Мета-прогресс (ITGAME-10): Достижения справа
    const { unlockedCount, totalCount } = getAchievementsSummary()
    const achBg = tag(
      this.add.rectangle(870, 650, 240, 30, 0x232640)
        .setOrigin(0).setStrokeStyle(2, 0x3a3f5c).setInteractive({ useHandCursor: true }),
      'menu.achievements',
    )
    const achTxt = this.add
      .text(990, 665, `🏆 Достижения ${unlockedCount}/${totalCount}`, {
        fontFamily: 'monospace', fontSize: '12px', color: '#ffcd75',
      })
      .setOrigin(0.5)
    achBg.on('pointerover', () => achBg.setStrokeStyle(2, 0xffcd75))
    achBg.on('pointerout', () => achBg.setStrokeStyle(2, 0x3a3f5c))
    achBg.on('pointerdown', () => this.showAchievementsModal())
    this.menuUI.push(achBg, achTxt)

    this.registerKeys()
  }

  private closeModal() {
    this.modalUI.forEach((o) => o.destroy())
    this.modalUI = []
    this.menuUI.forEach((o) => o.setVisible(true))
  }

  private createModalFrame(pw: number, ph: number, titleText: string, strokeColor = 0x41a6f6, withDefaultCloseBtn = true) {
    const overlay = this.add.rectangle(0, 0, GAME_W, GAME_H, 0x1a1c2c, 0.85).setOrigin(0).setDepth(80).setInteractive()
    overlay.on('pointerdown', () => this.closeModal())

    const panel = this.add.rectangle(CX, GAME_H / 2, pw, ph, 0x14162b).setStrokeStyle(2, strokeColor).setDepth(81).setInteractive()

    const title = this.add.text(CX, GAME_H / 2 - ph / 2 + 28, titleText, {
      fontFamily: 'monospace', fontSize: '20px', color: '#ffcd75',
    }).setOrigin(0.5).setDepth(82)

    const closeX = tag(this.add.text(CX + pw / 2 - 24, GAME_H / 2 - ph / 2 + 24, '✕', {
      fontFamily: 'monospace', fontSize: '18px', color: '#94b0c2',
    }).setOrigin(0.5).setDepth(82).setInteractive({ useHandCursor: true }), 'modal.close')
    closeX.on('pointerdown', () => this.closeModal())
    closeX.on('pointerover', () => closeX.setColor('#f4f4f4'))
    closeX.on('pointerout', () => closeX.setColor('#94b0c2'))

    const frameUI: Phaser.GameObjects.GameObject[] = [overlay, panel, title, closeX]

    if (withDefaultCloseBtn) {
      const btnCloseBg = tag(this.add.rectangle(CX, GAME_H / 2 + ph / 2 - 28, 140, 32, 0x3b5dc9)
        .setDepth(82).setInteractive({ useHandCursor: true }), 'modal.btn.close')
      const btnCloseTxt = this.add.text(CX, GAME_H / 2 + ph / 2 - 28, 'Закрыть', {
        fontFamily: 'monospace', fontSize: '13px', color: '#f4f4f4',
      }).setOrigin(0.5).setDepth(83)

      btnCloseBg.on('pointerdown', () => this.closeModal())
      btnCloseBg.on('pointerover', () => btnCloseBg.setFillStyle(0x41a6f6))
      btnCloseBg.on('pointerout', () => btnCloseBg.setFillStyle(0x3b5dc9))
      frameUI.push(btnCloseBg, btnCloseTxt)
    }

    return {
      frameUI,
      topY: GAME_H / 2 - ph / 2,
    }
  }

  private showStatsModal() {
    this.closeModal()
    this.menuUI.forEach((o) => {
      if (o !== this.bg) o.setVisible(false)
    })
    const stats = loadStats()
    const pw = 740
    const ph = 470
    const { frameUI, topY } = this.createModalFrame(pw, ph, '📊 СТАТИСТИКА ПРОГОНОВ', 0x41a6f6)

    const topSummary = this.add.text(CX, topY + 65, [
      `Всего игр: ${stats.totalRuns}   ·   Побед: ${stats.totalWins}   ·   Поражений: ${stats.totalLosses}`,
      `Рекордный баланс: ${fmtMoney(stats.peakBalance)}   ·   Максимальный день: ${stats.peakDay}`,
    ].join('\n'), {
      fontFamily: 'monospace', fontSize: '13px', color: '#f4f4f4', align: 'center', lineSpacing: 6,
    }).setOrigin(0.5, 0).setDepth(82)

    const cardYStart = topY + 130
    const cardH = 58
    const cardW = pw - 60

    const diffCards: Phaser.GameObjects.GameObject[] = []
    LEVELS.forEach((df, i) => {
      const cy = cardYStart + i * (cardH + 10)
      const d = stats.byDifficulty[df.id]
      const bg = this.add.rectangle(CX, cy + cardH / 2, cardW, cardH, 0x232640)
        .setStrokeStyle(1, 0x3a3f5c).setDepth(82)

      const hexColor = `#${df.color.toString(16).padStart(6, '0')}`
      const lbl = this.add.text(CX - cardW / 2 + 16, cy + 12, df.label, {
        fontFamily: 'monospace', fontSize: '16px', color: hexColor,
      }).setDepth(83)

      const winDayText = d.bestWinDay ? ` · Победа: день ${d.bestWinDay}` : ''
      const details = this.add.text(CX - cardW / 2 + 16, cy + 34,
        `Игр: ${d.runs} · Побед: ${d.wins} · Банкротств: ${d.bankruptcies} · Поражений по времени: ${d.timeUps}`, {
        fontFamily: 'monospace', fontSize: '11px', color: '#94b0c2',
      }).setDepth(83)

      const records = this.add.text(CX + cardW / 2 - 16, cy + 20,
        `Рекорд: ${fmtMoney(d.bestBalance)} · Макс. день: ${d.bestDay}${winDayText}`, {
        fontFamily: 'monospace', fontSize: '12px', color: '#f4f4f4',
      }).setOrigin(1, 0).setDepth(83)

      diffCards.push(bg, lbl, details, records)
    })

    this.modalUI = [...frameUI, topSummary, ...diffCards]
  }

  private showAchievementsModal() {
    this.closeModal()
    this.menuUI.forEach((o) => {
      if (o !== this.bg) o.setVisible(false)
    })
    const { unlockedCount, totalCount, list } = getAchievementsSummary()
    const pw = 840
    const ph = 500
    const { frameUI, topY } = this.createModalFrame(pw, ph, `🏆 ДОСТИЖЕНИЯ (${unlockedCount} / ${totalCount})`, 0x38b764)

    // 12 достижений в 2 колонки по 6 строк
    const colW = 380
    const rowH = 56
    const leftX = CX - 395
    const rightX = CX + 15
    const listTopY = topY + 64

    const achCards: Phaser.GameObjects.GameObject[] = []
    list.forEach((ach, i) => {
      const col = i % 2 // 0: left, 1: right
      const row = Math.floor(i / 2) // 0..5
      const x = col === 0 ? leftX : rightX
      const y = listTopY + row * (rowH + 8)

      const strokeColor = ach.unlocked ? 0x38b764 : 0x3a3f5c
      const bg = this.add.rectangle(x + colW / 2, y + rowH / 2, colW, rowH, 0x232640)
        .setStrokeStyle(1, strokeColor).setDepth(82)

      const titleColor = ach.unlocked ? '#ffcd75' : '#94b0c2'
      const name = this.add.text(x + 12, y + 10, `${ach.icon} ${ach.title}`, {
        fontFamily: 'monospace', fontSize: '13px', color: titleColor,
      }).setDepth(83)

      const desc = this.add.text(x + 12, y + 32, ach.desc, {
        fontFamily: 'monospace', fontSize: '11px', color: ach.unlocked ? '#f4f4f4' : '#94b0c2',
      }).setDepth(83)

      const statusBadge = this.add.text(x + colW - 12, y + 10, ach.unlocked ? '✓ Получено' : '🔒 Заблокировано', {
        fontFamily: 'monospace', fontSize: '10px', color: ach.unlocked ? '#38b764' : '#94b0c2',
      }).setOrigin(1, 0).setDepth(83)

      achCards.push(bg, name, desc, statusBadge)
    })

    this.modalUI = [...frameUI, ...achCards]
  }

  // Клавиатура меню (ITGAME-24): 1-4 — сложность, Enter — «Продолжить»
  // (или «НОРМА», если сейва нет). itd.key() дергает те же обработчики.
  private registerKeys() {
    const kb = this.input.keyboard
    if (!kb) return
    kb.on('keydown-ONE', () => { if (this.modalUI.length === 0) this.startGame('easy', true) })
    kb.on('keydown-TWO', () => { if (this.modalUI.length === 0) this.startGame('normal', true) })
    kb.on('keydown-THREE', () => { if (this.modalUI.length === 0) this.startGame('hard', true) })
    kb.on('keydown-FOUR', () => { if (this.modalUI.length === 0) this.startGame('hardcore', true) })
    kb.on('keydown-ENTER', () => {
      if (this.modalUI.length === 0) {
        if (hasSavedSession()) {
          this.onContinueClick()
        } else {
          this.startGame('normal', true)
        }
      } else {
        // Если модалка открыта, Enter безопасно закрывает её (отмена).
        // Деструктивный перехват чужой сессии (takeover) доступен только по клику.
        this.closeModal()
      }
    })
    kb.on('keydown-ESC', () => this.closeModal())
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.closeModal()
      kb.removeAllListeners()
    })
  }

  private checkingNeighbor = false

  // «Продолжить» (ITGAME-8, ITGAME-35): проверяем, не играет ли соседняя
  // вкладка эту партию прямо сейчас (через BroadcastChannel), чтобы не устраивать
  // войну session_taken без ведома игрока.
  private async onContinueClick() {
    if (this.started || this.checkingNeighbor) return
    const sid = sessionId()
    this.checkingNeighbor = true
    try {
      const neighbor = await checkActiveNeighbor(sid)
      if (this.started) return
      if (neighbor.active) {
        this.showSessionConflictModal(neighbor.day)
        return
      }
      this.startGame(savedDifficulty(), false)
    } catch (e) {
      console.error('ошибка проверки соседней вкладки', e)
      this.startGame(savedDifficulty(), false)
    } finally {
      this.checkingNeighbor = false
    }
  }

  // Модалка подтверждения перехвата сессии (ITGAME-35).
  private showSessionConflictModal(day?: number) {
    this.closeModal()
    this.menuUI.forEach((o) => {
      if (o !== this.bg) o.setVisible(false)
    })
    const pw = 620
    const ph = 260
    const { frameUI, topY } = this.createModalFrame(pw, ph, '⚠️ ПАРТИЯ В ДРУГОЙ ВКЛАДКЕ', 0xffcd75, false)

    const textLines = [
      `Эта партия прямо сейчас открыта в другой вкладке браузера${day ? ` (день ${day})` : ''}.`,
      'Если продолжить здесь, сервер отключит ту вкладку (session_taken).',
      '',
      'Забрать управление в эту вкладку?',
    ]

    const body = this.add.text(CX, topY + 70, textLines.join('\n'), {
      fontFamily: 'monospace', fontSize: '13px', color: '#f4f4f4', align: 'center', lineSpacing: 6,
    }).setOrigin(0.5, 0).setDepth(82)

    const btnY = topY + ph - 42

    // Кнопка «Остаться в меню»
    const btnCancelBg = tag(
      this.add.rectangle(CX - 120, btnY, 180, 36, 0x232640)
        .setStrokeStyle(2, 0x3a3f5c).setDepth(82).setInteractive({ useHandCursor: true }),
      'modal.btn.cancel',
    )
    const btnCancelTxt = this.add.text(CX - 120, btnY, 'Остаться в меню', {
      fontFamily: 'monospace', fontSize: '13px', color: '#f4f4f4',
    }).setOrigin(0.5).setDepth(83)
    btnCancelBg.on('pointerdown', () => this.closeModal())
    btnCancelBg.on('pointerover', () => btnCancelBg.setStrokeStyle(2, 0x41a6f6))
    btnCancelBg.on('pointerout', () => btnCancelBg.setStrokeStyle(2, 0x3a3f5c))

    // Кнопка «Забрать управление»
    const btnTakeoverBg = tag(
      this.add.rectangle(CX + 120, btnY, 200, 36, 0xb13e53)
        .setDepth(82).setInteractive({ useHandCursor: true }),
      'modal.btn.takeover',
    )
    const btnTakeoverTxt = this.add.text(CX + 120, btnY, 'Забрать управление', {
      fontFamily: 'monospace', fontSize: '13px', color: '#f4f4f4',
    }).setOrigin(0.5).setDepth(83)
    btnTakeoverBg.on('pointerdown', () => {
      this.closeModal()
      this.startGame(savedDifficulty(), false)
    })
    btnTakeoverBg.on('pointerover', () => btnTakeoverBg.setFillStyle(0xef7d57))
    btnTakeoverBg.on('pointerout', () => btnTakeoverBg.setFillStyle(0xb13e53))

    this.modalUI = [...frameUI, body, btnCancelBg, btnCancelTxt, btnTakeoverBg, btnTakeoverTxt]
  }

  // fresh=true — игрок ЯВНО выбрал новую партию (кнопка сложности, 1-4):
  // явный агентский sid чтим, наше зеркало/общий ключ — забываем, партия
  // начинается с новым sid. fresh=false — «Продолжить»/Enter: текущий sid,
  // сервер восстановит сейв (волна B: «НОРМА» молча открывала чужой сейв).
  private startGame(d: DifficultyId, fresh = false) {
    if (this.started) return
    // Флаг — только после фактического старта (ITGAME-24): ошибка старта
    // раньше молча залипала меню, кнопки переставали отвечать.
    try {
      if (fresh) prepareNewGame()
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
    const text = 'Не удалось начать игру — попробуйте ещё раз'
    const ms = 3000
    const bg = '#b13e53'
    emitUi({ type: 'toast', text, where: 'bottom', ms, bg, scene: this.scene.key })
    const t = this.add
      .text(CX, 700, text, {
        fontFamily: 'monospace', fontSize: '13px', color: '#f4f4f4',
        backgroundColor: bg, padding: { x: 12, y: 6 },
      })
      .setOrigin(0.5)
    this.time.delayedCall(ms, () => t.destroy())
  }
}
