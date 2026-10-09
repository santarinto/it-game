import Phaser from 'phaser'
import { GAME_H, GAME_W, HUD_H, NAV_W, layoutColumn, layoutRow } from '../layout'
import { client } from '../net'
import type { DayReportMessage, GameOverMessage, OfflineReportMessage, ServerErrorCode, StateMessage, VictoryMessage } from '../protocol'
import { fmtMoney } from '../format'
import { nav } from '../rooms'
import { onPartyReset, partyChange } from '../party'
import { debug, drawDebugFrames, setDebug } from '../debug'
import { markActive, rejectClick, tag } from '../debug/agentApi'
import { showModal } from '../ui/modal'
import { playSfx } from '../audio'
import { emitUi } from '../uibus'
import { activeZoom, applyZoom, ZOOM_OPTIONS, zoomLabel } from '../uiscale'
import { HIRES_CAMERA } from '../render'
import {
  checkAchievements,
  getAchievementsSummary,
  recordGameOver,
  recordVictory,
  updateOngoingStats,
} from '../meta'
import type { AchievementDef } from '../meta'

const CX = GAME_W / 2 // центр поля — якорь модалок и тостов
const SPEED_BEFORE_REPORT_KEY = 'itd.speedBeforeReport'
const REPORT_KEYS = [Phaser.Input.Keyboard.KeyCodes.ENTER, Phaser.Input.Keyboard.KeyCodes.SPACE]

// Record<ServerErrorCode, string> — tsc требует запись под каждый код
// (ITGAME-39): забытый код в этом словаре ловится сборкой, а не молчаливым
// фолбэком на сырой код в тосте.
const ERROR_TEXTS: Record<ServerErrorCode, string> = {
  not_enough_money: 'Не хватает денег',
  no_free_office_slot: 'В офисе нет свободных мест',
  no_free_pc: 'Нет свободного ПК — купите ПК',
  no_free_rack_slot: 'У офиса нет свободных стоек',
  router_maxed: 'Роутер уже максимального тира',
  unknown_command: 'Неизвестная команда',
  wrong_phase: 'Сейчас нельзя — дождитесь начала дня',
  staff_limit: 'Наймите начальника — он откроет ещё 3 места',
  office_locked: 'Этот офис ещё не куплен',
  boss_already: 'Начальник уже нанят',
  offices_maxed: 'Все офисы уже куплены',
  gateway_already: 'Шлюз уже установлен',
  bad_office: 'Нет такого офиса',
  equipment_already: 'Уже установлено в этом офисе',
  bad_speed: 'Нет такой скорости',
  bad_slot: 'Нет такой стойки',
  server_maxed: 'Серверная стойка уже максимального уровня',
  core_maxed: 'Стойка роутеров уже максимального уровня',
  motivate_cooldown: 'Мотивация ещё не готова',
  not_broken: 'ПК не сломан',
  no_event: 'Событие уже закрыто',
  bad_option: 'Нет такого варианта',
}

interface Button {
  setLabel(s: string): void
  setEnabled(enabled: boolean, tooltip?: string): void
  isEnabled(): boolean
}

export class HUDScene extends Phaser.Scene {
  private moneyText!: Phaser.GameObjects.Text
  private incomeText!: Phaser.GameObjects.Text
  private netText!: Phaser.GameObjects.Text
  private payrollText!: Phaser.GameObjects.Text
  private dayText!: Phaser.GameObjects.Text
  private goalText!: Phaser.GameObjects.Text
  private dayProfitText!: Phaser.GameObjects.Text
  private marketText!: Phaser.GameObjects.Text
  private debtText!: Phaser.GameObjects.Text
  private pcBtn!: Button
  private hireBtn!: Button
  private bossBtn!: Button
  private gatewayBtn!: Button
  private buttonTooltip!: Phaser.GameObjects.Container
  private buttonTooltipBg!: Phaser.GameObjects.Rectangle
  private buttonTooltipText!: Phaser.GameObjects.Text
  private hoveredButtonId!: string | null
  private navItems!: { bg: Phaser.GameObjects.Rectangle; label: Phaser.GameObjects.Text; sub: Phaser.GameObjects.Text }[]
  private currentRoom!: 'office' | 'serverRoom'
  private reportUI!: Phaser.GameObjects.GameObject[]
  private eventUI!: Phaser.GameObjects.GameObject[]
  private gameOverUI!: Phaser.GameObjects.GameObject[]
  private victoryUI!: Phaser.GameObjects.GameObject[]
  private switching!: boolean
  private get skipReports(): boolean {
    return localStorage.getItem('itd.skipReports') === '1'
  }
  private set skipReports(v: boolean) {
    if (v) {
      localStorage.setItem('itd.skipReports', '1')
    } else {
      localStorage.removeItem('itd.skipReports')
    }
  }
  private currentSpeed!: number
  private get speedBeforeReport(): number | null {
    const v = sessionStorage.getItem(SPEED_BEFORE_REPORT_KEY)
    if (!v) return null
    const n = parseInt(v, 10)
    return n >= 1 && n <= 3 ? n : null
  }
  private set speedBeforeReport(n: number | null) {
    if (n === null) {
      sessionStorage.removeItem(SPEED_BEFORE_REPORT_KEY)
    } else {
      sessionStorage.setItem(SPEED_BEFORE_REPORT_KEY, String(n))
    }
  }
  private reportPauseSeq!: number
  private speedBtns!: { bg: Phaser.GameObjects.Rectangle; speed: number }[]
  private hudInteractive!: Phaser.GameObjects.GameObject[]
  private debugFrames!: Phaser.GameObjects.GameObject[]
  private reconnectUI!: Phaser.GameObjects.GameObject[]
  private offlineUI!: Phaser.GameObjects.GameObject[]
  // Закрывалка окна «Выйти в меню?» (ITGAME-64): resetParty() гасит окно новой партии.
  private exitModalClose!: (() => void) | null
  // Стек тостов (ITGAME-16): якорь сверху/снизу — свой список, не больше 3
  // штук одновременно. Сцена переживает рестарт (client.subscribe/restart),
  // поэтому сбрасывается явно в create(), а не инициализатором поля.
  private toasts!: Record<'top' | 'bottom', Phaser.GameObjects.Text[]>

  constructor() {
    super({ key: 'hud', cameras: HIRES_CAMERA })
  }

  create() {
    // Сцена hud переживает рестарт (returnToMenu → scene.start('menu') →
    // MenuScene.startGame → launch('hud') на том же экземпляре): коллекции
    // прошлой партии держат уничтоженные объекты — refresh() падал на
    // s.offices[4], active скоростей/навигации врал (ITGAME-38). Поэтому ВСЕ
    // поля состояния сцены задаются здесь, а не инициализаторами полей.
    // Стек тостов (ITGAME-16): якорь сверху/снизу — свой список, не больше 3.
    this.toasts = { top: [], bottom: [] }
    this.navItems = []
    this.speedBtns = []
    this.hudInteractive = []
    this.reportUI = []
    this.eventUI = []
    this.gameOverUI = []
    this.victoryUI = []
    this.offlineUI = []
    this.exitModalClose = null
    this.reconnectUI = []
    this.debugFrames = []
    this.hoveredButtonId = null
    this.lastEventId = ''
    this.currentSpeed = 1
    this.reportPauseSeq = 0
    this.currentRoom = 'office' // MenuScene.startGame стартует сцену 'office'
    // ITGAME-42: таймер дребезга switchRoom (delayedCall 250 мс) гибнет в
    // Clock.shutdown(), если HUD закрыли раньше — флаг залипал на синглтоне,
    // навигация новой партии мертва.
    this.switching = false
    // Верхняя панель.
    this.add.rectangle(0, 0, GAME_W, HUD_H, 0x14162b).setOrigin(0)
    this.moneyText = tag(this.add.text(16, 10, '$…', {
      fontFamily: 'monospace', fontSize: '26px', color: '#ffcd75',
    }), 'hud.money')
    this.incomeText = tag(this.add.text(16, 44, '', {
      fontFamily: 'monospace', fontSize: '15px', color: '#38b764',
    }), 'hud.income')
    this.netText = tag(this.add.text(16, 66, '', {
      fontFamily: 'monospace', fontSize: '15px', color: '#41a6f6',
    }), 'hud.net')
    this.payrollText = tag(this.add.text(200, 44, '', {
      fontFamily: 'monospace', fontSize: '15px', color: '#5d7275',
    }), 'hud.payroll')
    this.dayText = tag(
      this.add
        .text(GAME_W - 16, 70, '', { fontFamily: 'monospace', fontSize: '13px', color: '#5d7275' })
        .setOrigin(1, 0),
      'hud.day',
    )
    this.goalText = tag(
      this.add
        .text(GAME_W - 16, 52, '', { fontFamily: 'monospace', fontSize: '13px', color: '#ffcd75' })
        .setOrigin(1, 0),
      'hud.goal',
    )
    // Рынок дня (сложность 2.0): сегодня и завтра, тренд виден заранее.
    this.marketText = tag(
      this.add
        .text(GAME_W - 16, 86, '', { fontFamily: 'monospace', fontSize: '12px', color: '#5d7275' })
        .setOrigin(1, 0),
      'hud.market',
    )
    // Долг по кредиту (сложность 2.0): виден только в минусе. Строки нижних
    // рядов раскладываются по ширинам в layoutPanel() (ITGAME-16) — стартовые
    // x/y здесь косметические, до первого layoutPanel().
    this.debtText = tag(this.add.text(170, 84, '', {
      fontFamily: 'monospace', fontSize: '12px', color: '#b13e53',
    }), 'hud.debt')
    // Темп дня одним взглядом: прибыль дня (= «Прибыль» отчёта), считает
    // сервер (dayProfit, ITGAME-53).
    this.dayProfitText = tag(this.add.text(16, 84, '', {
      fontFamily: 'monospace', fontSize: '15px', color: '#38b764',
    }), 'hud.dayProfit')
    this.layoutPanel()

    this.pcBtn = this.makeButton(420, 10, 'btn.pc', () => {
      playSfx(this, 'select')
      client.send('buy_pc', nav.activeOffice)
    })
    this.hireBtn = this.makeButton(420, 52, 'btn.hire', () => {
      playSfx(this, 'select')
      client.send('hire', nav.activeOffice)
    })
    this.bossBtn = this.makeButton(640, 10, 'btn.boss', () => {
      playSfx(this, 'select')
      client.send('hire_boss', nav.activeOffice)
    })
    this.gatewayBtn = this.makeButton(640, 52, 'btn.gateway', () => {
      playSfx(this, 'select')
      client.send('buy_gateway')
    })

    this.buttonTooltipText = tag(
      this.add.text(10, 7, '', {
        fontFamily: 'monospace',
        fontSize: '12px',
        color: '#ffcd75',
        align: 'center',
      }).setOrigin(0, 0).setVisible(false),
      'hud.tooltip.text',
    )
    this.buttonTooltipBg = tag(
      this.add.rectangle(0, 0, 10, 10, 0x14162b, 0.95)
        .setOrigin(0, 0)
        .setStrokeStyle(1, 0x41a6f6)
        .setVisible(false),
      'hud.tooltip.bg',
    )
    this.buttonTooltip = this.add.container(0, 0, [this.buttonTooltipBg, this.buttonTooltipText])
      .setDepth(70)
      .setVisible(false)

    // Темп времени: пауза и множители. Активная кнопка подсвечивается по speed
    // из снапшота — сервер источник истины.
    const speeds = [
      { s: 0, label: '⏸' }, { s: 1, label: '1x' }, { s: 2, label: '2x' }, { s: 3, label: '3x' },
    ]
    speeds.forEach((sp, i) => {
      const x = GAME_W - 176 + i * 40
      const bg = tag(
        this.add.rectangle(x, 10, 36, 28, 0x232640)
          .setOrigin(0).setStrokeStyle(2, 0x3a3f5c).setInteractive({ useHandCursor: true }),
        `btn.speed.${sp.s}`,
      )
      this.add.text(x + 18, 24, sp.label, { fontFamily: 'monospace', fontSize: '13px', color: '#f4f4f4' }).setOrigin(0.5)
      bg.on('pointerdown', () => client.send('set_speed', 0, { speed: sp.s }))
      this.speedBtns.push({ bg, speed: sp.s })
      this.hudInteractive.push(bg)
    })
    // Выход в меню из игры (анти-софтлок + «сдаться»): с подтверждением.
    const menuBg = tag(
      this.add.rectangle(GAME_W - 220, 10, 36, 28, 0x232640)
        .setOrigin(0).setStrokeStyle(2, 0x3a3f5c).setInteractive({ useHandCursor: true }),
      'btn.menu',
    )
    this.add.text(GAME_W - 202, 24, '⌂', { fontFamily: 'monospace', fontSize: '14px', color: '#f4f4f4' }).setOrigin(0.5)
    menuBg.on('pointerdown', () => this.confirmExitToMenu())
    menuBg.on('pointerover', () => menuBg.setStrokeStyle(2, 0xb13e53))
    menuBg.on('pointerout', () => menuBg.setStrokeStyle(2, 0x3a3f5c))
    this.hudInteractive.push(menuBg)
    // Масштаб UI (ITGAME-15): компактный циклический переключатель рядом с
    // кнопками скорости. Полный ряд — на стартовом экране; здесь панель тесная,
    // переключатель остаётся компактным.
    this.add
      .text(922, 24, 'масштаб', { fontFamily: 'monospace', fontSize: '11px', color: '#5d7275' })
      .setOrigin(1, 0.5)
    const zoomBg = tag(
      this.add.rectangle(928, 10, 64, 28, 0x232640)
        .setOrigin(0).setStrokeStyle(2, 0x41a6f6).setInteractive({ useHandCursor: true }),
      'btn.zoom',
    )
    const zoomTxt = this.add
      .text(960, 24, zoomLabel(activeZoom()), { fontFamily: 'monospace', fontSize: '12px', color: '#f4f4f4' })
      .setOrigin(0.5)
    zoomBg.on('pointerdown', () => {
      const order = ZOOM_OPTIONS.map((o) => o.value)
      applyZoom(this.game, order[(order.indexOf(activeZoom()) + 1) % order.length])
      zoomTxt.setText(zoomLabel(activeZoom()))
    })
    this.hudInteractive.push(zoomBg)
    // ITGAME-22: только при ?debug=1; короткая подпись — «debug off» наезжала на ⌂
    if (debug.enabled) {
      const dbg = markActive(
        tag(
          this.add
            .text(GAME_W - 280, 17, this.debugLabel(), { fontFamily: 'monospace', fontSize: '12px', color: '#5d7275' })
            .setInteractive({ useHandCursor: true }),
          'btn.debug',
        ),
        debug.enabled,
      )
      dbg.on('pointerdown', () => {
        setDebug(!debug.enabled)
        dbg.setText(this.debugLabel())
        markActive(dbg, debug.enabled)
        client.reemit() // сцены перерисуются по последнему снапшоту
      })
      this.hudInteractive.push(dbg)
    }

    this.createNavPanel()

    const unsub = client.subscribe({
      onState: (s) => this.refresh(s),
      onError: (code) => {
        playSfx(this, 'error')
        this.toast((ERROR_TEXTS as Record<string, string>)[code] ?? code)
      },
      onDisconnect: (reason) => this.showDisconnect(reason),
      onDayReport: (r) => this.onDayReport(r),
      onGameOver: (o) => this.showGameOver(o),
      onVictory: (v) => this.showVictory(v),
      onOfflineReport: (r) => this.showOfflineReport(r),
      onReconnecting: (n) => this.showReconnecting(n),
    })
    // ITGAME-64: HUD живёт между партиями — сброс партии (itd.scenario(), «Продолжить» на
    // истёкшем сейве) чистит его оверлеи через party.ts.
    const offReset = onPartyReset(() => this.resetParty())
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.hideButtonTooltip()
      unsub()
      offReset()
    })

    // Клавиатура отчёта дня (ITGAME-18, ITGAME-24): Enter/Space/Esc — следующий день,
    // пока отчёт открыт. itd.key('enter') дергает те же обработчики.
    const kb = this.input.keyboard
    if (kb) {
      for (const name of ['ENTER', 'SPACE', 'ESC'] as const) {
        kb.on(`keydown-${name}`, () => {
          if (this.proceedNextDay()) emitUi({ type: 'key', key: name, scene: this.scene.key, action: 'next_day' })
        })
      }
      this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
        kb.removeCapture(REPORT_KEYS)
        kb.removeAllListeners()
      })
    }
  }

  // Баннер реконнекта: деплой/сеть рвут WS — клиент возвращается сам,
  // сервер продолжает сессию по sid (ITGAME-8). Прячется первым снапшотом.
  private showReconnecting(attempt: number) {
    this.hideButtonTooltip()
    this.reconnectUI.forEach((o) => o.destroy())
    this.reconnectUI = []
    const bg = this.add.rectangle(CX, 130, 360, 30, 0x14162b).setStrokeStyle(2, 0xffcd75).setDepth(90)
    const txt = this.add
      .text(CX, 130, `Переподключение… (попытка ${attempt})`, {
        fontFamily: 'monospace', fontSize: '13px', color: '#ffcd75',
      })
      .setOrigin(0.5).setDepth(91)
    this.reconnectUI.push(bg, txt)
  }

  private showDisconnect(reason?: string) {
    this.hideButtonTooltip()
    this.reconnectUI.forEach((o) => o.destroy())
    this.reconnectUI = []
    const taken = reason === 'session_taken'
    this.add.rectangle(0, 0, GAME_W, GAME_H, 0x1a1c2c, 0.85).setOrigin(0).setDepth(100)
    this.add
      .text(CX, 300, taken ? 'Игра открыта в другой вкладке' : 'Соединение потеряно', {
        fontFamily: 'monospace', fontSize: '26px', color: '#b13e53',
      })
      .setOrigin(0.5)
      .setDepth(101)
    this.add
      .text(CX, 344, taken
        ? 'Сессия обслуживает одно окно. Обновите страницу, чтобы забрать её сюда'
        : 'Обновите страницу — сохранённая игра продолжится с того же места', {
        fontFamily: 'monospace', fontSize: '15px', color: '#f4f4f4',
      })
      .setOrigin(0.5)
      .setDepth(101)
  }

  // «Пока вас не было»: итог офлайн-догона после реконнекта (ITGAME-8).
  // Финал офлайн (банкротство/победа) не дублируется обычными экранами —
  // его закрывает кнопка «В меню» прямо отсюда.
  private showOfflineReport(r: OfflineReportMessage) {
    this.hideButtonTooltip()
    playSfx(this, r.gameOver ? 'glitch' : r.victory ? 'confirmation' : 'bong')
    this.offlineUI.forEach((o) => o.destroy())
    const bankrupt = r.gameOver
    const s = client.latest
    const currentDay = s ? s.day : r.days
    let offlineAchs: AchievementDef[] = []

    if (r.victory && s) {
      offlineAchs = recordVictory(
        { type: 'victory', difficulty: s.difficulty, day: currentDay, balance: r.balance },
        s,
      ).newAchievements
    } else if (bankrupt && s) {
      offlineAchs = recordGameOver(
        { type: 'game_over', daysSurvived: currentDay, balance: r.balance, peakIncomePerTick: 0, reason: r.reason ?? 'bankrupt' },
        s.difficulty,
        s,
      ).newAchievements
    }
    const finalLine = bankrupt
      ? r.reason === 'time_up'
        ? 'Срок вышел: цель не достигнута.'
        : r.reason === 'deadlock'
          ? 'Тупик: компанию уже не спасти.'
          : 'Компания обанкротилась.'
      : r.victory
        ? 'Цель достигнута — победа!'
        : ''
    const body = [
      `Прошло дней: ${r.days}`,
      `Заработано: ${fmtMoney(r.income)}`,
      `Расходы:    ${r.payroll > 0 ? '−' : ''}${fmtMoney(r.payroll)}`,
      `Баланс:      ${fmtMoney(r.balance)}`,
      ...(finalLine ? ['', finalLine] : []),
      ...(offlineAchs.length > 0 ? ['', `🏆 Достижение: ${offlineAchs.map((a) => `${a.icon} ${a.title}`).join(', ')}`] : []),
    ].join('\n')
    const overlay = this.add.rectangle(0, 0, GAME_W, GAME_H, 0x1a1c2c, 0.75).setOrigin(0).setDepth(55).setInteractive()
    const panel = this.add.rectangle(CX, 300, 460, 320, 0x14162b).setStrokeStyle(2, 0xffcd75).setDepth(56)
    const title = this.add
      .text(CX, 170, 'Пока вас не было', { fontFamily: 'monospace', fontSize: '22px', color: '#ffcd75' })
      .setOrigin(0.5).setDepth(56)
    const bodyText = this.add
      .text(CX, 275, body, { fontFamily: 'monospace', fontSize: '15px', color: '#f4f4f4', lineSpacing: 7, align: 'center' })
      .setOrigin(0.5).setDepth(56)
    const final = r.gameOver || r.victory
    this.offlineUI = [overlay, panel, title, bodyText]
    if (final) {
      const btnBg = tag(
        this.add
          .rectangle(CX - 100, 392, 200, 34, 0x3b5dc9).setOrigin(0, 0).setDepth(56)
          .setInteractive({ useHandCursor: true }),
        'btn.offline.menu',
      )
      const btnText = this.add
        .text(CX, 409, 'В меню', { fontFamily: 'monospace', fontSize: '14px', color: '#f4f4f4' })
        .setOrigin(0.5).setDepth(57)
      btnBg.on('pointerdown', () => {
        this.closeOfflineReport()
        this.returnToMenu()
      })
      btnBg.on('pointerover', () => btnBg.setFillStyle(0x41a6f6))
      btnBg.on('pointerout', () => btnBg.setFillStyle(0x3b5dc9))
      this.offlineUI.push(btnBg, btnText)
    } else {
      const btnBg = tag(
        this.add
          .rectangle(CX - 100, 392, 200, 34, 0x3b5dc9).setOrigin(0, 0).setDepth(56)
          .setInteractive({ useHandCursor: true }),
        'btn.offline.continue',
      )
      const btnText = this.add
        .text(CX, 409, 'Продолжить →', { fontFamily: 'monospace', fontSize: '14px', color: '#f4f4f4' })
        .setOrigin(0.5).setDepth(57)
      btnBg.on('pointerdown', () => this.closeOfflineReport())
      btnBg.on('pointerover', () => btnBg.setFillStyle(0x41a6f6))
      btnBg.on('pointerout', () => btnBg.setFillStyle(0x3b5dc9))
      this.offlineUI.push(btnBg, btnText)
    }
  }

  private closeOfflineReport() {
    this.offlineUI.forEach((o) => o.destroy())
    this.offlineUI = []
  }

  // Панель навигации: значки офисов и серверной в колонке слева.
  private createNavPanel() {
    this.add.rectangle(0, HUD_H, NAV_W, GAME_H - HUD_H, 0x14162b).setOrigin(0)
    const rooms: { key: 'office' | 'serverRoom'; office: number; label: string }[] = [
      { key: 'office', office: 0, label: 'О1' },
      { key: 'office', office: 1, label: 'О2' },
      { key: 'office', office: 2, label: 'О3' },
      { key: 'serverRoom', office: -1, label: 'СРВ' },
    ]
    rooms.forEach((r, idx) => {
      const y = HUD_H + 24 + idx * 76
      const bg = tag(
        this.add.rectangle(8, y, NAV_W - 16, 48, 0x232640)
          .setOrigin(0).setStrokeStyle(2, 0x3a3f5c).setInteractive({ useHandCursor: true }),
        r.key === 'office' ? `nav.office${r.office}` : 'nav.serverRoom',
      )
      const label = this.add
        .text(NAV_W / 2, y + 18, r.label, { fontFamily: 'monospace', fontSize: '13px', color: '#f4f4f4' })
        .setOrigin(0.5)
      const sub = this.add
        .text(NAV_W / 2, y + 36, '', { fontFamily: 'monospace', fontSize: '8px', color: '#5d7275' })
        .setOrigin(0.5)
      bg.on('pointerdown', () => this.switchRoom(r.key, r.office))
      this.navItems.push({ bg, label, sub })
      this.hudInteractive.push(bg)
    })
  }

  private switchRoom(key: 'office' | 'serverRoom', office: number) {
    // Дребезг: два быстрых клика до завершения stop/launch дублируют сцену.
    if (this.switching) {
      rejectClick('debounced')
      return
    }
    this.switching = true
    this.time.delayedCall(250, () => (this.switching = false))
    this.hideButtonTooltip()
    if (office >= 0) nav.activeOffice = office
    if (client.latest) this.refresh(client.latest)
    this.scene.stop(this.currentRoom)
    if (key === this.currentRoom && key === 'office') {
      this.scene.launch('office') // рестарт сцены офиса на новый activeOffice
    } else {
      this.scene.launch(key)
    }
    this.currentRoom = key
    this.highlightNav()
  }

  private highlightNav() {
    this.navItems.forEach((item, idx) => {
      const active = this.currentRoom === 'serverRoom' ? idx === 3 : idx === nav.activeOffice
      item.bg.setStrokeStyle(2, active ? 0x41a6f6 : 0x3a3f5c)
      markActive(item.bg, active)
    })
  }

  // Раскладка верхней панели (ITGAME-16): столбец слева (money/income+payroll/
  // net/dayProfit+debt) и столбец справа (goal/day/market) кладутся по
  // фактическим высотам строк — при 0/1/9/15 сотрудниках и длинных суммах
  // ни одна строка не пересекает соседнюю и не уходит за HUD_H. Горизонталь
  // внутри строк — layoutRow (x-старт/gap/maxRight из прежней раскладки).
  private layoutPanel() {
    layoutColumn(4, [[this.moneyText], [this.incomeText, this.payrollText], [this.netText], [this.dayProfitText, this.debtText]], 0, HUD_H)
    layoutRow(16, 16, [this.incomeText, this.payrollText], 416)
    layoutRow(16, 12, [this.dayProfitText, this.debtText], 416)
    layoutColumn(44, [[this.goalText], [this.dayText], [this.marketText]], 2, HUD_H)
  }

  // Цель уровня (сложность 2.0): деньги + комбо (штат/сеть) + дедлайн дней.
  private goalLabel(s: StateMessage): string {
    let goal = `Цель: ${fmtMoney(s.winTarget)}`
    if (s.winStaff > 0) goal += ` + ${s.winStaff} чел.`
    if (s.winCore > 0) goal += ` + core ур.${s.winCore}`
    if (s.winDayLimit > 0) goal += ` до дня ${s.winDayLimit}`
    return goal
  }

  private refresh(s: StateMessage) {
    if (s.phase === 'running') {
      try {
        updateOngoingStats(s)
        const newAchs = checkAchievements(s)
        if (newAchs.length > 0) {
          playSfx(this, 'confirmation')
          const msg = newAchs.length === 1
            ? `🏆 Достижение: ${newAchs[0].icon} «${newAchs[0].title}»!`
            : `🏆 Достижения: ${newAchs.map((a) => `${a.icon} ${a.title}`).join(', ')}`
          this.toast(msg, 4000, { bg: '#2a6b3f' })
        }
      } catch (err) {
        console.error('Ошибка обновления мета-прогресса в HUD:', err)
      }
    }

    // Живой снапшот = соединение восстановлено: баннер реконнекта долой.
    this.reconnectUI.forEach((o) => o.destroy())
    this.reconnectUI = []
    if (this.speedBeforeReport === null && s.speed > 0) {
      this.currentSpeed = s.speed
    }
    if (s.phase === 'running') {
      if (this.reportUI.length > 0) {
        this.closeReport()
      }
      // ITGAME-64: пуш новой партии от itd.scenario() приходит раньше ответа — учёт паузы
      // старой партии обнулит resetParty(), а не «возврат скорости» в новую.
      if (this.speedBeforeReport !== null && !partyChange.pending) {
        // Реконнект/догон в running-фазу с открытым модалом (ITGAME-18):
        // восстанавливаем скорость, только если 0 был нашей паузой модала
        // (никто другой не отправлял set_speed после неё).
        if (s.speed === 0 && (this.reportPauseSeq === 0 || client.speedSeq === this.reportPauseSeq)) {
          const restore = this.speedBeforeReport
          if (client.send('set_speed', 0, { speed: restore })) {
            this.speedBeforeReport = null
          }
        } else {
          this.speedBeforeReport = null
        }
      }
      this.closeGameOver()
      this.closeVictory()
    }
    const employees = s.offices.flatMap((o) => o.employees)
    const active = s.offices[nav.activeOffice]
    this.moneyText.setText(fmtMoney(s.money))
    this.moneyText.setColor(s.money < 0 ? '#b13e53' : '#ffcd75')
    this.incomeText.setText(`+${fmtMoney(s.incomePerTick)}/сек`)
    this.payrollText.setText(`Расходы ${fmtMoney(s.payrollPerDay)}/день`)
    // Прогноз считает сервер: клиент не знает про обеденные тики.
    this.payrollText.setColor(s.forecastEndOfDay < 0 ? '#b13e53' : '#5d7275')
    this.dayText.setText(`День ${s.day} · ${s.clock}${s.isLunch ? ' · обед' : ''}`)
    this.goalText.setText(this.goalLabel(s))
    // Рынок (сложность 2.0): качели выработки ±%, завтра виден заранее.
    if (s.marketToday !== 0 || s.marketTomorrow !== 0) {
      const pct = (v: number) => (v > 0 ? `+${v}` : `${v}`)
      this.marketText.setText(`Рынок ${pct(s.marketToday)}% · завтра ${pct(s.marketTomorrow)}%`)
      this.marketText.setColor(s.marketToday < 0 ? '#b13e53' : s.marketToday > 0 ? '#38b764' : '#5d7275')
    } else {
      this.marketText.setText('')
    }
    // Долг: минус в кредитных уровнях — не приговор, но проценты капают.
    if (s.money < 0 && s.creditLimit > 0) {
      this.debtText.setText(`Долг ${fmtMoney(s.money)} из ${fmtMoney(-s.creditLimit)} · ${s.creditRatePct}%/день`)
    } else {
      this.debtText.setText('')
    }
    // Прибыль дня — как «Прибыль» в отчёте, с прогнозом до вечера; считает
    // сервер (dayProfit, ITGAME-53): доход с утра + деньги исходов событий +
    // остаток дохода − вечерний ФОТ − объявленный штраф аудита. Исход события
    // двигает строку в момент, когда случился (выбор, дедлайн в 17:00), а
    // штраф аудита — с тоста; в 18:00 он из прогноза уходит в деньги событий,
    // и строка не скачет. Найм и покупка ПК двигают её через будущий доход и
    // ФОТ; цена покупки, в том числе найма звезды, в прибыль не входит.
    const dayProfit = s.dayProfit
    this.dayProfitText.setText(`${dayProfit >= 0 ? '+' : ''}${fmtMoney(dayProfit)}/день`)
    this.dayProfitText.setColor(dayProfit >= 0 ? '#38b764' : '#b13e53')
    this.netText.setText(`Сотрудники: ${employees.length} · в сети ${s.core.connected}/${employees.length}`)
    // Раскладка панели по фактическим ширинам/высотам (ITGAME-16): длинные
    // строки («Сотрудники: 15 · в сети 15/15», «$1,234,567») не помещались
    // в стартовые x/y и наезжали друг на друга или на HUD_H.
    this.layoutPanel()

    // Состояние кнопок покупки (ITGAME-17): доступность, затемнение, тултипы
    // 1. Кнопка ПК
    const staffCap = active.boss !== '' ? s.officeSlots : s.staffLimit
    if (active.nextPC === 0 || active.pcs >= s.officeSlots) {
      this.pcBtn.setLabel('Купить ПК — мест нет')
      this.pcBtn.setEnabled(false, 'В офисе нет свободных мест')
    } else if (active.pcs >= staffCap) {
      this.pcBtn.setLabel(`Купить ПК  ${fmtMoney(active.nextPC)}`)
      this.pcBtn.setEnabled(false, `Нужен начальник для расширения свыше ${s.staffLimit} мест`)
    } else if (s.money < active.nextPC) {
      this.pcBtn.setLabel(`Купить ПК  ${fmtMoney(active.nextPC)}`)
      this.pcBtn.setEnabled(false, `не хватает ${fmtMoney(active.nextPC - s.money)}`)
    } else {
      this.pcBtn.setLabel(`Купить ПК  ${fmtMoney(active.nextPC)}`)
      this.pcBtn.setEnabled(true)
    }

    // 2. Кнопка найма сотрудника
    const hirePrice = s.prices.hire
    if (active.employees.length >= staffCap) {
      this.hireBtn.setLabel(`Нанять  ${fmtMoney(hirePrice)}`)
      const reason = active.boss === '' && active.employees.length >= s.staffLimit
        ? `Нужен начальник для найма свыше ${s.staffLimit} сотрудников`
        : 'Штат офиса укомплектован'
      this.hireBtn.setEnabled(false, reason)
    } else if (active.employees.length >= active.pcs) {
      this.hireBtn.setLabel(`Нанять  ${fmtMoney(hirePrice)}`)
      this.hireBtn.setEnabled(false, 'Нет свободного ПК — сначала купите ПК')
    } else if (s.money < hirePrice) {
      this.hireBtn.setLabel(`Нанять  ${fmtMoney(hirePrice)}`)
      this.hireBtn.setEnabled(false, `не хватает ${fmtMoney(hirePrice - s.money)}`)
    } else {
      this.hireBtn.setLabel(`Нанять  ${fmtMoney(hirePrice)}`)
      this.hireBtn.setEnabled(true)
    }

    // 3. Кнопка найма начальника
    const bossPrice = s.prices.boss
    if (active.boss !== '') {
      this.bossBtn.setLabel('Начальник ✓')
      this.bossBtn.setEnabled(false, `Начальник уже нанят: ${active.boss}`)
    } else if (s.money < bossPrice) {
      this.bossBtn.setLabel(`Начальник  ${fmtMoney(bossPrice)}`)
      this.bossBtn.setEnabled(false, `не хватает ${fmtMoney(bossPrice - s.money)}`)
    } else {
      this.bossBtn.setLabel(`Начальник  ${fmtMoney(bossPrice)}`)
      this.bossBtn.setEnabled(true)
    }

    // 4. Кнопка интернет-шлюза
    const gwPrice = s.prices.gateway
    if (s.gateway) {
      this.gatewayBtn.setLabel('Шлюз ✓')
      this.gatewayBtn.setEnabled(false, 'Интернет-шлюз уже подключён')
    } else if (s.money < gwPrice) {
      this.gatewayBtn.setLabel(`Шлюз  ${fmtMoney(gwPrice)}`)
      this.gatewayBtn.setEnabled(false, `не хватает ${fmtMoney(gwPrice - s.money)}`)
    } else {
      this.gatewayBtn.setLabel(`Шлюз  ${fmtMoney(gwPrice)}`)
      this.gatewayBtn.setEnabled(true)
    }
    this.navItems.forEach((item, idx) => {
      if (idx === 3) return
      const o = s.offices[idx]
      item.sub.setText(o.unlocked ? `${o.employees.length}/${s.officeSlots}` : fmtMoney(o.price))
    })
    this.highlightNav()
    this.speedBtns.forEach((b) => {
      const on = b.speed === s.speed
      b.bg.setStrokeStyle(2, on ? 0x41a6f6 : 0x3a3f5c)
      markActive(b.bg, on)
    })
    if (s.activeEvent && s.phase === 'running') {
      this.showEvent(s.activeEvent)
    } else {
      this.closeEvent() // отчёт дня/победа/банкротство глушат панель
    }
    this.checkHints(s)
    this.debugFrames.forEach((f) => f.destroy())
    this.debugFrames = drawDebugFrames(this, this.hudInteractive)
  }

  // Панель события Unseen Forces: не модальная — игра идёт дальше,
  // пока игрок думает (цифры обновляются с каждым снапшотом).
  private lastEventId!: string

  private showEvent(ev: NonNullable<StateMessage['activeEvent']>) {
    this.hideButtonTooltip()
    if (ev.id !== this.lastEventId) {
      this.lastEventId = ev.id
      playSfx(this, 'question')
    }
    this.closeEvent()
    const panel = this.add.rectangle(CX, 148, 480, 176, 0x14162b).setStrokeStyle(2, 0xffcd75).setDepth(40)
    const title = this.add
      .text(CX, 84, ev.title, { fontFamily: 'monospace', fontSize: '18px', color: '#ffcd75' })
      .setOrigin(0.5).setDepth(41)
    const body = this.add
      .text(CX, 148, ev.text, {
        fontFamily: 'monospace', fontSize: '13px', color: '#f4f4f4',
        align: 'center', wordWrap: { width: 440 }, lineSpacing: 4,
      })
      .setOrigin(0.5).setDepth(41)
    this.eventUI = [panel, title, body]
    const n = ev.options.length
    ev.options.forEach((label, i) => {
      const w = n > 1 ? 226 : 300
      const x = n > 1 ? CX - 232 + i * 238 : CX - w / 2
      const bg = tag(
        this.add.rectangle(x, 196, w, 32, 0x3b5dc9).setOrigin(0, 0)
          .setDepth(41).setInteractive({ useHandCursor: true }),
        `btn.event.${i}`,
      )
      const txt = this.add
        .text(x + w / 2, 212, label, { fontFamily: 'monospace', fontSize: '13px', color: '#f4f4f4' })
        .setOrigin(0.5).setDepth(42)
      bg.on('pointerdown', () => client.send('event_choice', 0, { slot: i }))
      bg.on('pointerover', () => bg.setFillStyle(0x41a6f6))
      bg.on('pointerout', () => bg.setFillStyle(0x3b5dc9))
      this.eventUI.push(bg, txt)
    })
  }

  private closeEvent() {
    this.eventUI.forEach((o) => o.destroy())
    this.eventUI = []
  }

  private makeButton(x: number, y: number, id: string, onClick: () => void): Button {
    let enabled = true
    let tooltipText: string | undefined
    let isShaking = false

    const bg = tag(
      this.add
        .rectangle(x, y, 200, 34, 0x3b5dc9)
        .setOrigin(0, 0)
        .setInteractive({ useHandCursor: true }),
      id,
    )
    const txt = this.add
      .text(x + 100, y + 17, '…', { fontFamily: 'monospace', fontSize: '14px', color: '#f4f4f4' })
      .setOrigin(0.5)

    const applyState = () => {
      if (enabled) {
        const isHovered = this.hoveredButtonId === id
        bg.setFillStyle(isHovered ? 0x41a6f6 : 0x3b5dc9)
        bg.setStrokeStyle(0)
        bg.setAlpha(1)
        txt.setAlpha(1)
      } else {
        bg.setFillStyle(0x232640)
        bg.setStrokeStyle(2, 0x3a3f5c)
        bg.setAlpha(0.45)
        txt.setAlpha(0.45)
      }
    }

    const shake = () => {
      if (isShaking) return
      isShaking = true
      const origX = x
      this.tweens.addCounter({
        from: 0,
        to: Math.PI * 4,
        duration: 180,
        onUpdate: (tween) => {
          if (!bg.scene) return
          const v = tween.getValue() ?? 0
          const offset = Math.sin(v) * 5
          bg.x = origX + offset
          txt.x = origX + 100 + offset
        },
        onComplete: () => {
          if (bg.scene) {
            bg.x = origX
            txt.x = origX + 100
          }
          isShaking = false
        },
      })
    }

    bg.on('pointerdown', () => {
      if (!enabled) {
        playSfx(this, 'error')
        shake()
        return
      }
      onClick()
    })

    bg.on('pointerover', () => {
      this.hoveredButtonId = id
      if (enabled) {
        bg.setFillStyle(0x41a6f6)
      } else {
        bg.setFillStyle(0x232640)
        if (tooltipText) {
          this.showButtonTooltip(tooltipText, x, y)
        }
      }
    })

    bg.on('pointerout', () => {
      if (this.hoveredButtonId === id) {
        this.hoveredButtonId = null
        this.hideButtonTooltip()
      }
      applyState()
    })

    this.hudInteractive.push(bg)

    return {
      setLabel: (s: string) => txt.setText(s),
      setEnabled: (e: boolean, tooltip?: string) => {
        enabled = e
        tooltipText = tooltip
        applyState()
        if (this.hoveredButtonId === id) {
          if (!enabled && tooltipText) {
            this.showButtonTooltip(tooltipText, x, y)
          } else {
            this.hideButtonTooltip()
          }
        }
      },
      isEnabled: () => enabled,
    }
  }

  private showButtonTooltip(text: string, x: number, y: number) {
    if (!text) {
      this.hideButtonTooltip()
      return
    }
    this.buttonTooltipText.setText(text).setVisible(true)
    this.buttonTooltipBg.setSize(this.buttonTooltipText.width + 20, this.buttonTooltipText.height + 14).setVisible(true)
    const tx = Phaser.Math.Clamp(x + 100 - this.buttonTooltipBg.width / 2, 8, GAME_W - this.buttonTooltipBg.width - 8)
    const ty = y + 38
    this.buttonTooltip.setPosition(tx, ty).setVisible(true)
  }

  private hideButtonTooltip() {
    this.hoveredButtonId = null
    if (this.buttonTooltip) {
      this.buttonTooltip.setVisible(false)
      this.buttonTooltipText.setVisible(false)
      this.buttonTooltipBg.setVisible(false)
    }
  }

  // Тосты (ITGAME-16): якорь сверху/снизу держит СВОЙ стек, максимум 3 —
  // одновременная ошибка+ачивка+хинт раньше ложились друг на друга (все
  // рождались в одной точке и ехали к одной endY). Теперь новый тост
  // рождается у якоря, старые той же стороны отодвигаются от него
  // (layoutToasts), а гаснет тост только альфой — дрейф по y убран, иначе
  // своя и чужие анимации конфликтовали бы кадр в кадр.
  private toast(text: string, ms = 1500, opts?: { top?: boolean; bg?: string }) {
    const where: 'top' | 'bottom' = opts?.top ? 'top' : 'bottom'
    const bg = opts?.bg ?? '#b13e53'
    emitUi({ type: 'toast', text, where, ms, bg, scene: this.scene.key })
    const startY = where === 'top' ? 175 : GAME_H - 40 // косметика до первой layoutToasts()
    const t = tag(
      this.add
        .text(CX, startY, text, {
          fontFamily: 'monospace', fontSize: '18px', color: '#f4f4f4',
          backgroundColor: bg, padding: { x: 12, y: 6 },
          wordWrap: { width: 900, useAdvancedWrap: true }, align: 'center',
        })
        .setOrigin(0.5).setDepth(100),
      'toast',
    )
    const stack = this.toasts[where]
    stack.push(t)
    if (stack.length > 3) {
      // 4-й тост на якорь: самый старый долой без анимации — его уже не видно.
      const old = stack.shift()
      if (old) {
        this.tweens.killTweensOf(old)
        old.destroy()
      }
    }
    this.layoutToasts(where)
    this.tweens.add({
      targets: t,
      alpha: 0,
      duration: ms,
      delay: ms * 2,
      onComplete: () => this.dropToast(where, t),
    })
  }

  // Раскладка стека одного якоря: от новых тостов к старым — новый у кромки
  // якоря, каждый следующий (старее) дальше от неё. Пересчитывается с нуля
  // на каждое добавление/удаление — дрейфа не накапливается.
  private layoutToasts(where: 'top' | 'bottom') {
    const stack = this.toasts[where]
    let edge = where === 'top' ? 158 : 697
    for (let i = stack.length - 1; i >= 0; i--) {
      const h = stack[i].height
      if (where === 'top') {
        stack[i].setY(edge + h / 2)
        edge += h + 6
      } else {
        stack[i].setY(edge - h / 2)
        edge -= h + 6
      }
    }
  }

  // onComplete угасшего твина: снять тост со стека и с экрана. Безопасен при
  // повторном вызове (тост уже выкинут переполнением стека — idx===-1) и
  // если сцена к этому моменту уже остановлена/уничтожена.
  private dropToast(where: 'top' | 'bottom', t: Phaser.GameObjects.Text) {
    try {
      const stack = this.toasts[where]
      const idx = stack.indexOf(t)
      if (idx === -1) return
      stack.splice(idx, 1)
      t.destroy()
      this.layoutToasts(where)
    } catch {
      // сцена ушла между планированием onComplete и его срабатыванием
    }
  }

  // Онбординг-хинты (итерация 11): одноразовые тосты по триггерам.
  // Один хинт за снапшот — очередь не копится, следующий придёт своим ходом.
  private checkHints(s: StateMessage) {
    if (s.phase !== 'running') return
    const office = s.offices[nav.activeOffice]
    const emps = office.employees
    const anyEmp = s.offices.some((o) => o.employees.length > 0)
    const clockH = parseInt(s.clock.slice(0, 2), 10)
    const hints: { id: string; when: boolean; text: string }[] = [
      {
        id: 'master', when: s.offices.some((o) => o.employees.some((e) => e.pcBroken)),
        text: 'ПК сломан: доход места 0. Чините кликами по столу или мастером',
      },
      {
        id: 'router', when: emps.some((e) => e.offlineReason === 'no_router'),
        text: 'Сотрудник вне сети: роутер офиса ведёт к серверам (×1.2+). Купите роутер',
      },
      {
        id: 'core', when: emps.some((e) => e.offlineReason === 'no_core'),
        text: 'Мест в стойке роутеров (core) не хватило — расширьте её в серверной',
      },
      {
        id: 'server', when: emps.some((e) => e.offlineReason === 'no_server'),
        text: 'Core есть, но стойка не обслуживает сотрудника — купите серверную стойку',
      },
      {
        id: 'cooler', when: anyEmp && !office.cooler && clockH >= 12,
        text: 'Жажда −10% с 12:00 — кулер снимает дебафф',
      },
      {
        id: 'fridge', when: anyEmp && !office.fridge && clockH >= 15,
        text: 'Голод −10% после обеда — холодильник снимает дебафф',
      },
      {
        id: 'motivate', when: anyEmp && clockH >= 11,
        text: 'Клик по сотруднику мотивирует: +25% на 3 часа',
      },
      {
        id: 'softlock',
        when: !anyEmp && s.money < s.prices.hire,
        text: 'Нанять не на что, а дохода нет — сдаться и начать заново: кнопка ⌂',
      },
    ]
    const hint = hints.find((h) => h.when && !localStorage.getItem('itd.hint:' + h.id))
    if (hint) {
      localStorage.setItem('itd.hint:' + hint.id, '1')
      this.toast(hint.text, 2200)
    }
  }

  private onDayReport(r: DayReportMessage) {
    playSfx(this, r.profit >= 0 ? 'bong' : 'drop')
    if (this.skipReports) {
      client.send('next_day')
      const toastBg = r.profit > 0 ? '#257179' : r.profit === 0 ? '#333c57' : '#b13e53'
      this.toast(
        `День ${r.day}: прибыль ${fmtMoney(r.profit)} · баланс ${fmtMoney(r.balance)}`,
        2500,
        { top: true, bg: toastBg },
      )
      return
    }
    // Серверная пауза (ITGAME-18): запоминаем скорость в sessionStorage
    // (переживает перезагрузку F5 во время отчёта) и замораживаем темп.
    if (this.speedBeforeReport === null) {
      this.speedBeforeReport = this.currentSpeed
    }
    client.send('set_speed', 0, { speed: 0 })
    this.reportPauseSeq = client.speedSeq
    this.showReport(r)
  }

  private showReport(r: DayReportMessage) {
    this.hideButtonTooltip()
    this.closeReport()
    if (this.input.keyboard) {
      this.input.keyboard.addCapture(REPORT_KEYS)
    }
    const body = [
      `Доход:     ${fmtMoney(r.income)}`,
      `Зарплата: -${fmtMoney(r.payroll)}`,
      ...(r.gatewayOpex > 0 ? [`Интернет: -${fmtMoney(r.gatewayOpex)}`] : []),
      // Деньги исходов событий входят в прибыль (ITGAME-53); расшифровка —
      // в журнале ниже.
      ...(r.eventMoney ? [`События:  ${r.eventMoney > 0 ? '+' : ''}${fmtMoney(r.eventMoney)}`] : []),
      `Прибыль:   ${fmtMoney(r.profit)}`,
      `Баланс:    ${fmtMoney(r.balance)}`,
      ...(r.incidents > 0 ? [`Поломки:   ${r.incidents} (−${fmtMoney(r.lostIncome)})`] : []),
      ...(r.events?.length ? ['', 'Журнал событий:', ...r.events.map((e) => `· ${e}`)] : []),
    ].join('\n')

    // Подложка interactive: глушит клики по кнопкам HUD под модалкой (depth 50).
    const overlay = this.add.rectangle(0, 0, GAME_W, GAME_H, 0x1a1c2c, 0.75).setOrigin(0).setDepth(50).setInteractive()
    // Плашка модала (depth 51) создаётся ДО текстов и кнопок (depth 52..53),
    // чтобы display list и depth гарантированно держали фон ПОЗАДИ контента.
    const panel = this.add.rectangle(CX, 300, 440, 320, 0x14162b).setStrokeStyle(2, 0x41a6f6).setDepth(51)

    const title = this.add
      .text(CX, 0, `День ${r.day} завершён`, { fontFamily: 'monospace', fontSize: '22px', color: '#ffcd75' })
      .setOrigin(0.5, 0).setDepth(52)
    const bodyText = this.add
      .text(CX, 0, body, { fontFamily: 'monospace', fontSize: '16px', color: '#f4f4f4', lineSpacing: 8 })
      .setOrigin(0.5, 0).setDepth(52)
    const checkbox = markActive(
      tag(
        this.add
          .text(CX, 0, this.checkboxLabel(), { fontFamily: 'monospace', fontSize: '14px', color: '#5d7275' })
          .setOrigin(0.5, 0).setDepth(52).setInteractive({ useHandCursor: true }),
        'btn.skip_reports',
      ),
      this.skipReports,
    )
    checkbox.on('pointerdown', () => {
      this.skipReports = !this.skipReports
      checkbox.setText(this.checkboxLabel())
      markActive(checkbox, this.skipReports)
    })
    const btnBg = tag(
      this.add
        .rectangle(CX - 100, 0, 200, 34, 0x3b5dc9).setOrigin(0, 0).setDepth(52)
        .setInteractive({ useHandCursor: true }),
      'btn.next_day',
    )
    const btnText = this.add
      .text(CX, 0, 'Следующий день →', { fontFamily: 'monospace', fontSize: '14px', color: '#f4f4f4' })
      .setOrigin(0.5, 0.5).setDepth(53)
    btnBg.on('pointerdown', () => this.proceedNextDay())
    btnBg.on('pointerover', () => btnBg.setFillStyle(0x41a6f6))
    btnBg.on('pointerout', () => btnBg.setFillStyle(0x3b5dc9))

    // Динамический расчёт высоты панели: исключает наложение чекбокса на события (ITGAME-18).
    const padY = 24
    const gapTitle = 16
    const gapBody = 18
    const gapCheck = 16
    const btnH = 34
    const contentH = title.height + gapTitle + bodyText.height + gapBody + checkbox.height + gapCheck + btnH
    const panelH = padY * 2 + contentH
    const panelW = 440
    const panelY = Math.round((GAME_H - panelH) / 2)

    panel.setSize(panelW, panelH)
    panel.setPosition(CX, panelY + panelH / 2)

    let curY = panelY + padY
    title.setY(curY)
    curY += title.height + gapTitle
    bodyText.setY(curY)
    curY += bodyText.height + gapBody
    checkbox.setY(curY)
    curY += checkbox.height + gapCheck
    btnBg.setY(curY)
    btnText.setY(curY + btnH / 2)

    this.reportUI = [overlay, panel, title, bodyText, checkbox, btnBg, btnText]
    this.reportUI.push(...drawDebugFrames(this, this.reportUI))
  }

  private proceedNextDay(): boolean {
    if (this.reportUI.length === 0) return false
    if (this.speedBeforeReport !== null) {
      // Восстанавливаем скорость, только если во время отчёта не было внешних
      // изменений скорости (например, itd.pause(), itd.speed(0) или клик по HUD).
      if (this.reportPauseSeq === 0 || client.speedSeq === this.reportPauseSeq) {
        client.send('set_speed', 0, { speed: this.speedBeforeReport })
      }
      this.speedBeforeReport = null
    }
    client.send('next_day')
    this.closeReport()
    return true
  }

  private checkboxLabel(): string {
    return `[${this.skipReports ? 'x' : ' '}] пропускать отчёты`
  }

  private debugLabel(): string {
    return `dbg ${debug.enabled ? 'on' : 'off'}`
  }

  private closeReport() {
    if (this.input.keyboard) {
      this.input.keyboard.removeCapture(REPORT_KEYS)
    }
    this.reportUI.forEach((o) => o.destroy())
    this.reportUI = []
  }

  private showGameOver(o: GameOverMessage) {
    this.hideButtonTooltip()
    playSfx(this, 'glitch')
    this.closeReport()
    this.closeGameOver()
    const diff = client.latest?.difficulty ?? 'normal'
    const { newAchievements } = recordGameOver(o, diff, client.latest ?? undefined)
    const { unlockedCount, totalCount } = getAchievementsSummary()

    const isDeadlock = o.reason === 'deadlock'
    const timeUp = o.reason === 'time_up' // дедлайн уровня (сложность 2.0)
    const overlay = this.add.rectangle(0, 0, GAME_W, GAME_H, 0x1a1c2c, 0.9).setOrigin(0).setDepth(60).setInteractive()
    const titleText = isDeadlock ? 'ТУПИК' : timeUp ? 'ВРЕМЯ ВЫШЛО' : 'БАНКРОТСТВО'
    const title = this.add
      .text(CX, 200, titleText, { fontFamily: 'monospace', fontSize: '32px', color: '#b13e53' })
      .setOrigin(0.5).setDepth(61)

    const lines = isDeadlock ? [
      'Штат пуст, денег на развитие нет:',
      'компанию уже не спасти.',
      `Прожито дней: ${o.daysSurvived}`,
      `Баланс: ${fmtMoney(o.balance)}`,
    ] : timeUp ? [
      'Инвесторы потеряли терпение:',
      'цель не достигнута к концу срока.',
      `Дней дано: ${o.daysSurvived}`,
      `Баланс: ${fmtMoney(o.balance)}`,
    ] : [
      `Прожито дней: ${o.daysSurvived}`,
      `Пик дохода: ${fmtMoney(o.peakIncomePerTick)}/сек`,
      `На зарплаты не хватило: ${fmtMoney(-o.balance)}`,
    ]
    if (newAchievements.length > 0) {
      const names = newAchievements.map((a) => `${a.icon} ${a.title}`).join(', ')
      lines.push(`🏆 Новое достижение: ${names}`)
    }
    lines.push(`Всего достижений: ${unlockedCount}/${totalCount}`)

    const body = this.add
      .text(CX, 290, lines.join('\n'), { fontFamily: 'monospace', fontSize: '15px', color: '#f4f4f4', lineSpacing: 6, align: 'center' })
      .setOrigin(0.5).setDepth(61)
    const btnBg = tag(
      this.add
        .rectangle(CX - 100, 380, 200, 34, 0x3b5dc9).setOrigin(0, 0).setDepth(61)
        .setInteractive({ useHandCursor: true }),
      'btn.gameover.menu',
    )
    const btnText = this.add
      .text(CX, 397, 'В меню', { fontFamily: 'monospace', fontSize: '14px', color: '#f4f4f4' })
      .setOrigin(0.5).setDepth(62)
    btnBg.on('pointerdown', () => this.returnToMenu())
    btnBg.on('pointerover', () => btnBg.setFillStyle(0x41a6f6))
    btnBg.on('pointerout', () => btnBg.setFillStyle(0x3b5dc9))
    this.gameOverUI = [overlay, title, body, btnBg, btnText]
    this.gameOverUI.push(...drawDebugFrames(this, this.gameOverUI))
  }

  private closeGameOver() {
    this.gameOverUI.forEach((o) => o.destroy())
    this.gameOverUI = []
  }

  private static DIFF_LABELS: Record<string, string> = {
    easy: 'Легко', normal: 'Норма', hard: 'Сложно', hardcore: 'Хардкор',
  }

  private showVictory(v: VictoryMessage) {
    this.hideButtonTooltip()
    playSfx(this, 'confirmation')
    this.closeReport()
    this.closeVictory()
    const { newAchievements, isRecord } = recordVictory(v, client.latest ?? undefined)
    const { unlockedCount, totalCount } = getAchievementsSummary()

    const overlay = this.add.rectangle(0, 0, GAME_W, GAME_H, 0x1a1c2c, 0.9).setOrigin(0).setDepth(60).setInteractive()
    const title = this.add
      .text(CX, 200, 'ПОБЕДА!', { fontFamily: 'monospace', fontSize: '32px', color: '#38b764' })
      .setOrigin(0.5).setDepth(61)

    const lines = [
      `Сложность: ${HUDScene.DIFF_LABELS[v.difficulty] ?? v.difficulty}`,
      `Дней прошло: ${v.day}`,
      `Баланс: ${fmtMoney(v.balance)}`,
    ]
    if (isRecord) {
      lines.push('⭐ Новый рекорд баланса!')
    }
    if (newAchievements.length > 0) {
      const names = newAchievements.map((a) => `${a.icon} ${a.title}`).join(', ')
      lines.push(`🏆 Новое достижение: ${names}`)
    }
    lines.push(`Всего достижений: ${unlockedCount}/${totalCount}`)

    const body = this.add
      .text(CX, 290, lines.join('\n'), { fontFamily: 'monospace', fontSize: '15px', color: '#f4f4f4', lineSpacing: 6, align: 'center' })
      .setOrigin(0.5).setDepth(61)
    const btnBg = tag(
      this.add
        .rectangle(CX - 100, 380, 200, 34, 0x3b5dc9).setOrigin(0, 0).setDepth(61)
        .setInteractive({ useHandCursor: true }),
      'btn.victory.menu',
    )
    const btnText = this.add
      .text(CX, 397, 'В меню', { fontFamily: 'monospace', fontSize: '14px', color: '#f4f4f4' })
      .setOrigin(0.5).setDepth(62)
    btnBg.on('pointerdown', () => this.returnToMenu())
    btnBg.on('pointerover', () => btnBg.setFillStyle(0x41a6f6))
    btnBg.on('pointerout', () => btnBg.setFillStyle(0x3b5dc9))
    this.victoryUI = [overlay, title, body, btnBg, btnText]
    this.victoryUI.push(...drawDebugFrames(this, this.victoryUI))
  }

  private closeVictory() {
    this.victoryUI.forEach((o) => o.destroy())
    this.victoryUI = []
  }

  // Возврат в меню: намеренный разрыв WS (новая игра = новое подключение).
  // Сейв живёт на сервере — с меню можно вернуться («Продолжить»).
  private returnToMenu() {
    this.speedBeforeReport = null
    client.disconnect()
    this.scene.stop('office')
    this.scene.stop('serverRoom')
    this.scene.start('menu') // start глушит hud
  }

  // Новая партия в той же сцене (itd.scenario(), «Продолжить» на истёкшем сейве, ITGAME-64):
  // оверлеи и учёт паузы отчёта прошлой партии долой. Тосты, навигацию и скорость не трогаем.
  private resetParty() {
    this.closeReport() // заодно снимает перехват Enter/Space
    this.closeEvent()
    this.closeOfflineReport()
    this.closeGameOver()
    this.closeVictory()
    this.exitModalClose?.()
    this.exitModalClose = null
    this.speedBeforeReport = null
    this.reportPauseSeq = 0
    this.lastEventId = ''
  }

  // Выход в меню с сейвами (ITGAME-8): выход сохраняет прогресс, сдаться —
  // осознанное удаление сейва. Случайный клик по ⌂ не должен стоить партию.
  private confirmExitToMenu() {
    this.hideButtonTooltip()
    this.exitModalClose = showModal(this, 'Выйти в меню?', ['Прогресс сохранится — продолжите', 'с главного меню в любое время.'], [
      { label: 'Сохранить и выйти', onClick: () => this.returnToMenu() },
      { label: 'Сдаться (удалить сейв)', onClick: () => { client.abandon(); this.returnToMenu() } },
      { label: 'Отмена', onClick: () => {} },
    ])
  }
}
