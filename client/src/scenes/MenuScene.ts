import Phaser from 'phaser'
import { GAME_H, GAME_W } from '../layout'
import { checkActiveNeighbor, client, hasSavedSession, peekSave, prepareNewGame, savedDifficulty, sessionId } from '../net'
import { activeZoom, applyZoom, ZOOM_OPTIONS } from '../uiscale'
import { HIRES_CAMERA } from '../render'
import { markActive, tag } from '../debug/agentApi'
import { fmtMoney } from '../format'
import { getAchievementsSummary, loadStats } from '../meta'
import type { DifficultyId, SaveSummaryMessage } from '../protocol'
import { emitUi } from '../uibus'
import { resetForNewGame } from '../party'

const CX = GAME_W / 2
// Верх нижней панели (статистика, масштаб, достижения): основной блок
// центрируется по вертикали в полосе над ней (ITGAME-19).
const BOTTOM_TOP = 636
// Вторичный текст меню: читаемый на плашках #232640 (ITGAME-19: #5d7275
// в 11–12px не читался).
const DIM = '#94b0c2'
const BASE_STROKE = 0x3a3f5c

// Описания уровней — витрина выбора (сервер — источник истины).
// Цели итерации 14 + рычаги «Сложности 2.0» (ITGAME-9).
const LEVELS: { id: DifficultyId; label: string; desc: string; goal: string; color: number }[] = [
  { id: 'easy', label: 'ЛЕГКО', desc: 'цены и зарплаты −20% · старт $900 · выработка +15%', goal: '$60k', color: 0x38b764 },
  { id: 'normal', label: 'НОРМА', desc: 'базовый баланс', goal: '$250k', color: 0x41a6f6 },
  { id: 'hard', label: 'СЛОЖНО', desc: '+25% цены · рынок ±10% · кредит $5k (10%/д)', goal: '$500k + сеть', color: 0xffcd75 },
  { id: 'hardcore', label: 'ХАРДКОР', desc: '+50% цены · рынок ±15% · кредит $10k (15%/д)', goal: '$1M до дня 30', color: 0xb13e53 },
]

const LOSE_REASON: Record<string, string> = {
  bankrupt: 'банкротство',
  time_up: 'срок вышел',
  deadlock: 'тупик',
}

// Что меню знает о сейве (ITGAME-19):
// none — сейва нет (или сервер сказал, что его нет: истёк, -saves off);
// loading — ключ есть, сводка ещё едет; unknown — сервер не ответил;
// alive — партию можно продолжить; ended — партия кончилась офлайн.
type SaveView = 'none' | 'loading' | 'unknown' | 'alive' | 'ended'

type MenuObject = Phaser.GameObjects.GameObject & Phaser.GameObjects.Components.Visible

// Пункт с клавиатурным фокусом: «Продолжить» и четыре уровня.
interface FocusItem {
  id: string
  bg: Phaser.GameObjects.Rectangle
  y: number // центр плашки — для маркера
  stroke: number // рамка без фокуса
  focus: number // рамка в фокусе
  activate: () => void
}

// Где курсор на экране: clientX/Y последнего DOM-события указателя; без
// события (курсор ещё не двигался) — игровые координаты указателя.
function screenPos(p: Phaser.Input.Pointer): { x: number; y: number } {
  const e = p.event as MouseEvent | TouchEvent | undefined
  if (e && 'clientX' in e) return { x: e.clientX, y: e.clientY }
  return { x: p.x, y: p.y }
}

function levelLabel(d: string): string {
  return LEVELS.find((l) => l.id === d)?.label ?? d
}

// «День 3 · $60 · НОРМА» — факты сейва с сервера.
function saveFacts(s: SaveSummaryMessage): string {
  return `День ${s.day} · ${fmtMoney(s.money)} · ${levelLabel(s.difficulty)}`
}

export class MenuScene extends Phaser.Scene {
  private started = false
  private bg?: Phaser.GameObjects.Rectangle
  private menuUI: MenuObject[] = []
  private modalUI: Phaser.GameObjects.GameObject[] = []
  // Основной блок (заголовок, «Продолжить», уровни) — перестраивается,
  // когда приходит сводка сейва; нижняя панель остаётся.
  private mainUI: MenuObject[] = []
  // undefined — сводка ещё едет, null — сервер не ответил.
  private summary: SaveSummaryMessage | null | undefined = undefined
  // Был ли ключ сейва, когда меню строилось: экран и подтверждение судят
  // по тому, что игрок видит, а не по хранилищу, которое могли переписать
  // после отрисовки (агентский sid, соседняя вкладка).
  private hadSave = false
  private peekToken = 0
  private focusItems: FocusItem[] = []
  private focusId = ''
  private focusMarker?: Phaser.GameObjects.Text
  // Открыто подтверждение новой партии: отмена возвращает фокус на
  // «Продолжить» — повторный Enter продолжает, а не спрашивает снова.
  private confirmOpen = false
  // Где стоял курсор, когда фокус последний раз поставили не мышью
  // (перестройка блока, закрытие модалки, стрелки): плашка, оказавшаяся под
  // неподвижной мышью, получает pointerover (в том числе от синтетического
  // движения на месте), но фокус не забирает — его переносит только
  // настоящее движение мыши. Иначе Enter на «Итоге» открывал уровень,
  // всплывший под курсором при перестройке меню (ITGAME-19).
  private restingPointer?: { x: number; y: number }

  // Координаты экрана, а не игры: прокрутка страницы двигает холст под
  // неподвижным курсором, и то же место экрана указывает в другую точку игры.
  private pinPointer() {
    if (!this.input) return
    this.restingPointer = screenPos(this.input.activePointer)
  }

  constructor() {
    super({ key: 'menu', cameras: HIRES_CAMERA })
  }

  // Меню знает свой сейв: ключа нет, или сводка пришла / не дождалась.
  // Часть itd.state().menuReady — агент кликает по тому же экрану, что
  // видит игрок, а не по промежуточному «загружаю сводку…».
  get saveSettled(): boolean {
    return !this.hadSave || this.summary !== undefined
  }

  create() {
    this.started = false
    this.menuUI = []
    this.mainUI = []
    this.focusId = ''
    this.summary = undefined
    this.hadSave = hasSavedSession()
    this.closeModal()
    this.bg = this.add.rectangle(0, 0, GAME_W, GAME_H, 0x1a1c2c).setOrigin(0)
    this.menuUI.push(this.bg)
    this.buildMain()

    // Факты сейва (ITGAME-19): ключ сессии есть только у клиента, день и
    // баланс — у сервера. Меню рисуется сразу, сводка дорисовывает блок.
    if (this.hadSave) {
      const token = ++this.peekToken
      peekSave(sessionId()).then((s) => {
        if (token !== this.peekToken || this.started || !this.scene.isActive()) return
        this.summary = s
        this.buildMain()
      })
    }

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
      .text(449, 665, 'Масштаб:', { fontFamily: 'monospace', fontSize: '12px', color: DIM })
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

  private saveView(): SaveView {
    if (!this.hadSave) return 'none'
    const s = this.summary
    if (s === undefined) return 'loading'
    if (s === null) return 'unknown'
    if (!s.exists) return 'none'
    return s.alive ? 'alive' : 'ended'
  }

  // Основной блок, центрированный по вертикали над нижней панелью
  // (ITGAME-19: контент был прижат к верху, ~60% экрана пустовало).
  private buildMain() {
    const old = new Set(this.mainUI)
    this.mainUI.forEach((o) => o.destroy())
    this.menuUI = this.menuUI.filter((o) => !old.has(o))
    this.mainUI = []
    this.focusItems = []
    const ui = this.mainUI

    const view = this.saveView()
    const withCard = view !== 'none'
    const TITLE_H = 48
    const CARD_H = 64
    const LVL_H = 76
    const LVL_GAP = 12
    const SUB_H = 18
    const HINT_H = 16
    const levelsH = LEVELS.length * LVL_H + (LEVELS.length - 1) * LVL_GAP
    const total = TITLE_H + 28 + (withCard ? CARD_H + 20 : 0) + SUB_H + 12 + levelsH + 20 + HINT_H
    let y = Math.max(24, Math.round((BOTTOM_TOP - total) / 2))

    ui.push(this.add
      .text(CX, y + TITLE_H / 2, 'IT DIRECTOR', { fontFamily: 'monospace', fontSize: '42px', color: '#ffcd75' })
      .setOrigin(0.5))
    y += TITLE_H + 28

    // «Продолжить» (ITGAME-8): на сервере живёт сейв сессии — возвращаем
    // игрока в его партию (сложность игнорируется, конфиг в сейве).
    // Партия, кончившаяся офлайн, — не «продолжить», а её итог (ITGAME-19).
    if (withCard) {
      const s = this.summary
      const ended = view === 'ended' && s
      const color = ended ? 0xffcd75 : 0x38b764
      const label = !ended
        ? 'ПРОДОЛЖИТЬ'
        : s.outcome === 'won'
          ? 'ИТОГ: ПОБЕДА'
          : `ИТОГ: ${(LOSE_REASON[s.reason] ?? 'поражение').toUpperCase()}`
      let desc = 'сохранённая партия · загружаю сводку…'
      if (view === 'unknown') desc = 'сохранённая партия (сервер не дал сводку)'
      if (view === 'alive' && s) desc = saveFacts(s)
      if (ended) desc = `пока вас не было · ${saveFacts(s)}`
      const cardBg = tag(
        this.add.rectangle(CX - 260, y, 520, CARD_H, ended ? 0x3d3626 : 0x253d2a)
          .setOrigin(0).setStrokeStyle(2, color).setInteractive({ useHandCursor: true }),
        'menu.continue',
      )
      const cardTxt = this.add.text(CX - 240, y + 12, label, {
        fontFamily: 'monospace', fontSize: '20px', color: '#' + color.toString(16).padStart(6, '0'),
      })
      const cardDesc = this.add.text(CX - 240, y + 40, desc, {
        fontFamily: 'monospace', fontSize: '14px', color: '#f4f4f4',
      })
      const cardKey = this.add.text(CX + 240, y + 14, '[Enter]', {
        fontFamily: 'monospace', fontSize: '13px', color: DIM,
      }).setOrigin(1, 0)
      this.addFocusItem({
        id: 'menu.continue', bg: cardBg, y: y + CARD_H / 2,
        stroke: color, focus: ended ? 0xf4f4f4 : 0xffcd75,
        activate: () => this.onContinueClick(),
      })
      ui.push(cardBg, cardTxt, cardDesc, cardKey)
      y += CARD_H + 20
    }

    ui.push(this.add
      .text(CX, y + SUB_H / 2, withCard ? 'или начните новую:' : 'Выберите сложность', {
        fontFamily: 'monospace', fontSize: withCard ? '14px' : '16px', color: withCard ? DIM : '#f4f4f4',
      })
      .setOrigin(0.5))
    y += SUB_H + 12

    LEVELS.forEach((lvl, i) => {
      const hex = '#' + lvl.color.toString(16).padStart(6, '0')
      const diffBg = tag(
        this.add.rectangle(CX - 260, y, 520, LVL_H, 0x232640)
          .setOrigin(0).setStrokeStyle(2, BASE_STROKE).setInteractive({ useHandCursor: true }),
        `menu.diff.${lvl.id}`,
      )
      const diffLbl = this.add.text(CX - 240, y + 12, lvl.label, { fontFamily: 'monospace', fontSize: '20px', color: hex })
      const diffDesc = this.add.text(CX - 240, y + 44, lvl.desc, { fontFamily: 'monospace', fontSize: '13px', color: DIM })
      const diffGoal = this.add.text(CX + 240, y + 14, `Цель: ${lvl.goal}`, { fontFamily: 'monospace', fontSize: '14px', color: '#f4f4f4' }).setOrigin(1, 0)
      const diffKey = this.add.text(CX + 240, y + 46, `[${i + 1}]`, { fontFamily: 'monospace', fontSize: '13px', color: DIM }).setOrigin(1, 0)
      this.addFocusItem({
        id: `menu.diff.${lvl.id}`, bg: diffBg, y: y + LVL_H / 2,
        stroke: BASE_STROKE, focus: lvl.color,
        activate: () => this.requestNewGame(lvl.id),
      })
      ui.push(diffBg, diffLbl, diffDesc, diffGoal, diffKey)
      y += LVL_H + LVL_GAP
    })
    y += 20 - LVL_GAP

    ui.push(this.add
      .text(CX, y + HINT_H / 2, '1–4 — новая партия · ↑↓ — выбор · Enter — открыть выбранное', {
        fontFamily: 'monospace', fontSize: '13px', color: DIM,
      })
      .setOrigin(0.5))

    this.focusMarker = this.add.text(CX - 272, 0, '▶', { fontFamily: 'monospace', fontSize: '18px', color: '#f4f4f4' })
      .setOrigin(1, 0.5)
    ui.push(this.focusMarker)

    // Фокус по умолчанию: «Продолжить», если есть, иначе НОРМА; пережил
    // перестройку — остаётся где был.
    const keep = this.focusItems.some((f) => f.id === this.focusId)
    this.setFocus(keep ? this.focusId : withCard ? 'menu.continue' : 'menu.diff.normal')

    this.pinPointer()

    // Перестройка при открытой модалке: блок появится, когда её закроют.
    if (this.modalUI.length > 0) ui.forEach((o) => o.setVisible(false))
    this.menuUI.push(...ui)
  }

  private addFocusItem(item: FocusItem) {
    item.bg.on('pointerover', (p: Phaser.Input.Pointer) => {
      const rest = this.restingPointer
      const at = screenPos(p)
      if (rest && at.x === rest.x && at.y === rest.y) return
      this.restingPointer = undefined
      this.setFocus(item.id)
    })
    item.bg.on('pointerdown', () => {
      this.setFocus(item.id)
      item.activate()
    })
    this.focusItems.push(item)
  }

  // Видимый фокус (ITGAME-19): толстая рамка цвета пункта и маркер ▶;
  // для itd.ids() — active у сфокусированной плашки.
  private setFocus(id: string) {
    const item = this.focusItems.find((f) => f.id === id)
    if (!item) return
    this.focusId = id
    for (const f of this.focusItems) {
      const on = f === item
      f.bg.setStrokeStyle(on ? 3 : 2, on ? f.focus : f.stroke)
      markActive(f.bg, on)
    }
    this.focusMarker?.setY(item.y).setColor('#' + item.focus.toString(16).padStart(6, '0'))
  }

  private moveFocus(step: number) {
    const n = this.focusItems.length
    if (n === 0) return
    const i = this.focusItems.findIndex((f) => f.id === this.focusId)
    this.setFocus(this.focusItems[(Math.max(i, 0) + step + n) % n].id)
    this.pinPointer()
  }

  // Новая партия при живом сейве (ITGAME-19): раньше старт молча затирал
  // партию — теперь спрашиваем. Сводка ещё не пришла или сервер не ответил —
  // сейв считаем живым: лишний вопрос дешевле потерянной партии.
  private needsConfirm(): boolean {
    const v = this.saveView()
    return v === 'alive' || v === 'loading' || v === 'unknown'
  }

  private requestNewGame(d: DifficultyId) {
    if (this.started) return
    if (this.needsConfirm()) this.showConfirmNewModal(d)
    else this.startGame(d, true)
  }

  private closeModal() {
    if (this.modalUI.length > 0) this.pinPointer()
    this.modalUI.forEach((o) => o.destroy())
    this.modalUI = []
    this.menuUI.forEach((o) => o.setVisible(true))
    if (this.confirmOpen) {
      this.confirmOpen = false
      this.setFocus('menu.continue')
    }
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
  // сигнал «клавишу реально отработали» для itd.trace (ITGAME-37): шлём только после guard'ов
  private acted(key: string, action: string) {
    emitUi({ type: 'key', key, scene: this.scene.key, action })
  }

  private registerKeys() {
    const kb = this.input.keyboard
    if (!kb) return
    const digit = (key: string, d: DifficultyId) => {
      if (this.modalUI.length > 0 || this.started) return
      this.acted(key, `${this.needsConfirm() ? 'confirm' : 'start'}_${d}`)
      this.requestNewGame(d)
    }
    kb.on('keydown-ONE', () => digit('ONE', 'easy'))
    kb.on('keydown-TWO', () => digit('TWO', 'normal'))
    kb.on('keydown-THREE', () => digit('THREE', 'hard'))
    kb.on('keydown-FOUR', () => digit('FOUR', 'hardcore'))
    kb.on('keydown-UP', () => {
      if (this.modalUI.length > 0 || this.started) return
      this.moveFocus(-1)
      this.acted('UP', 'focus')
    })
    kb.on('keydown-DOWN', () => {
      if (this.modalUI.length > 0 || this.started) return
      this.moveFocus(1)
      this.acted('DOWN', 'focus')
    })
    // Enter открывает пункт в фокусе: по умолчанию это «Продолжить» при
    // сейве и НОРМА без него — как было до фокуса (ITGAME-24).
    kb.on('keydown-ENTER', () => {
      if (this.modalUI.length === 0) {
        const item = this.focusItems.find((f) => f.id === this.focusId)
        if (!item) return
        if (item.id === 'menu.continue') {
          if (!this.started && !this.checkingNeighbor) this.acted('ENTER', 'continue')
        } else if (!this.started) {
          const d = item.id.slice('menu.diff.'.length)
          this.acted('ENTER', `${this.needsConfirm() ? 'confirm' : 'start'}_${d}`)
        }
        item.activate()
      } else {
        // Если модалка открыта, Enter безопасно закрывает её (отмена).
        // Деструктивные действия (перехват сессии, затирание партии) —
        // только по клику.
        this.acted('ENTER', 'close_modal')
        this.closeModal()
      }
    })
    kb.on('keydown-ESC', () => {
      const had = this.modalUI.length > 0
      this.closeModal()
      if (had) this.acted('ESC', 'close_modal')
    })
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

  // Подтверждение новой партии при живом сейве (ITGAME-19).
  private showConfirmNewModal(d: DifficultyId) {
    this.closeModal()
    this.menuUI.forEach((o) => {
      if (o !== this.bg) o.setVisible(false)
    })
    const pw = 640
    const ph = 250
    const { frameUI, topY } = this.createModalFrame(pw, ph, '⚠️ НАЧАТЬ ЗАНОВО?', 0xffcd75, false)
    const s = this.summary
    const current = s && s.exists && s.alive ? `Текущая партия (${saveFacts(s)})` : 'Текущая сохранённая партия'
    const body = this.add.text(CX, topY + 66, [
      `Новая партия: ${levelLabel(d)}.`,
      `${current} будет потеряна —`,
      '«Продолжить» её больше не вернёт.',
    ].join('\n'), {
      fontFamily: 'monospace', fontSize: '14px', color: '#f4f4f4', align: 'center', lineSpacing: 6,
    }).setOrigin(0.5, 0).setDepth(82)
    // Действие клавиатуры названо прямо: Enter и Esc здесь — отмена.
    const keysHint = this.add.text(CX, topY + ph - 84, 'Enter / Esc — отмена', {
      fontFamily: 'monospace', fontSize: '13px', color: DIM,
    }).setOrigin(0.5).setDepth(82)

    const btnY = topY + ph - 42
    // «Отмена» — действие по умолчанию: подсвечена рамкой фокуса.
    const btnCancelBg = tag(
      this.add.rectangle(CX - 120, btnY, 180, 36, 0x232640)
        .setStrokeStyle(3, 0x41a6f6).setDepth(82).setInteractive({ useHandCursor: true }),
      'modal.btn.cancel',
    )
    const btnCancelTxt = this.add.text(CX - 120, btnY, 'Отмена', {
      fontFamily: 'monospace', fontSize: '14px', color: '#f4f4f4',
    }).setOrigin(0.5).setDepth(83)
    btnCancelBg.on('pointerdown', () => this.closeModal())
    btnCancelBg.on('pointerover', () => btnCancelBg.setFillStyle(0x2e335a))
    btnCancelBg.on('pointerout', () => btnCancelBg.setFillStyle(0x232640))

    const btnConfirmBg = tag(
      this.add.rectangle(CX + 120, btnY, 200, 36, 0xb13e53)
        .setDepth(82).setInteractive({ useHandCursor: true }),
      'modal.btn.confirm',
    )
    const btnConfirmTxt = this.add.text(CX + 120, btnY, 'Начать заново', {
      fontFamily: 'monospace', fontSize: '14px', color: '#f4f4f4',
    }).setOrigin(0.5).setDepth(83)
    btnConfirmBg.on('pointerdown', () => {
      this.closeModal()
      this.startGame(d, true)
    })
    btnConfirmBg.on('pointerover', () => btnConfirmBg.setFillStyle(0xef7d57))
    btnConfirmBg.on('pointerout', () => btnConfirmBg.setFillStyle(0xb13e53))

    this.modalUI = [...frameUI, body, keysHint, btnCancelBg, btnCancelTxt, btnConfirmBg, btnConfirmTxt]
    this.confirmOpen = true
  }

  // fresh=true — игрок ЯВНО выбрал новую партию (кнопка сложности, 1-4):
  // явный агентский sid чтим, наше зеркало/общий ключ — забываем, партия
  // начинается с новым sid. fresh=false — «Продолжить»/Enter: текущий sid,
  // сервер восстановит сейв (волна B: «НОРМА» молча открывала чужой сейв).
  // fresh также сбрасывает состояние партии (resetForNewGame, ITGAME-47).
  private startGame(d: DifficultyId, fresh = false) {
    if (this.started) return
    // Флаг — только после фактического старта (ITGAME-24): ошибка старта
    // раньше молча залипала меню, кнопки переставали отвечать.
    try {
      if (fresh) {
        prepareNewGame()
        resetForNewGame()
      }
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
