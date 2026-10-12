import Phaser from 'phaser'
import { GAME_H, GAME_W, HUD_H, NAV_W, layoutColumn, layoutRow } from '../layout'
import { client, offlineShown } from '../net'
import { localStore, sessionStore } from '../storage'
import type { DayReportMessage, GameOverMessage, OfflineReportMessage, ServerErrorCode, StateMessage, VictoryMessage } from '../protocol'
import { fmtMoney } from '../format'
import { nav } from '../rooms'
import { onPartyReset, partyChange } from '../party'
import { debug, drawDebugFrames, setDebug } from '../debug'
import { markActive, markDim, markTitle, rejectClick, tag } from '../debug/agentApi'
import { showModal, type ModalButton } from '../ui/modal'
import { hideActionTooltips } from '../ui/actionButton'
import { playSfx } from '../audio'
import { emitUi } from '../uibus'
import { activeZoom, applyZoom, ZOOM_OPTIONS, zoomLabel } from '../uiscale'
import { FONT, HIRES_CAMERA } from '../render'
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

// Правый край левого блока панели (ITGAME-16): правая колонка (цель/день/рынок)
// начинается не левее x 848. До ITGAME-94 середину шапки занимали кнопки
// покупки (x 420..840) и левый блок сжимался к 416; кнопки переехали в комнаты —
// длинные строки («Сотрудники: 15 · в сети 15/15  Расходы …») больше не жмутся.
const PANEL_LEFT_MAX = 832

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
  private navItems!: { bg: Phaser.GameObjects.Rectangle; label: Phaser.GameObjects.Text; sub: Phaser.GameObjects.Text }[]
  private currentRoom!: 'office' | 'serverRoom'
  private reportUI!: Phaser.GameObjects.GameObject[]
  private eventUI!: Phaser.GameObjects.GameObject[]
  private gameOverUI!: Phaser.GameObjects.GameObject[]
  private victoryUI!: Phaser.GameObjects.GameObject[]
  private switching!: boolean
  private get skipReports(): boolean {
    return localStore.get('itd.skipReports') === '1'
  }
  private set skipReports(v: boolean) {
    if (v) {
      localStore.set('itd.skipReports', '1')
    } else {
      localStore.remove('itd.skipReports')
    }
  }
  private currentSpeed!: number
  private get speedBeforeReport(): number | null {
    const v = sessionStore.get(SPEED_BEFORE_REPORT_KEY)
    if (!v) return null
    const n = parseInt(v, 10)
    return n >= 1 && n <= 3 ? n : null
  }
  private set speedBeforeReport(n: number | null) {
    if (n === null) {
      sessionStore.remove(SPEED_BEFORE_REPORT_KEY)
    } else {
      sessionStore.set(SPEED_BEFORE_REPORT_KEY, String(n))
    }
  }
  private reportPauseSeq!: number
  // Пауза диалога «Выйти в меню?» (ITGAME-65): с какой скорости он поставил паузу
  // (0 — не ставил) и speedSeq после неё — «Отмена» вернёт скорость, только если
  // темп после паузы никто не трогал (как reportPauseSeq у отчёта).
  private exitPauseFrom!: number
  private exitPauseSeq!: number
  // Пауза окна «Пока вас не было» (приёмка 10.10, решение владельца): то же правило,
  // что у окна выхода — «Продолжить →» вернёт скорость, если темп никто не трогал.
  private offlinePauseFrom!: number
  private offlinePauseSeq!: number
  private speedBtns!: { bg: Phaser.GameObjects.Rectangle; label: Phaser.GameObjects.Text; speed: number }[]
  private hudInteractive!: Phaser.GameObjects.GameObject[]
  private debugFrames!: Phaser.GameObjects.GameObject[]
  private reconnectUI!: Phaser.GameObjects.GameObject[]
  private offlineUI!: Phaser.GameObjects.GameObject[]
  // Закрывалка окна «Выйти в меню?» (ITGAME-64): resetParty() гасит окно новой партии.
  // Цепочка выхода держит одно окно: сам диалог, «Удалить партию навсегда?» (ITGAME-86),
  // «Нет связи» и ожидание связи (ITGAME-85) — kind говорит, какое открыто.
  private exitModalClose!: (() => void) | null
  private exitModalKind!: 'exit' | 'surrender' | 'nolink' | 'wait' | null
  // «Подождать» без связи (ITGAME-85): скорость возврата для exit, который уйдёт с первым
  // снапшотом нового сокета; null — не ждём.
  private exitWaitResume!: number | null
  // Тост «нет связи» уже показан в этой серии обрыва (ITGAME-90); снимает его первый снапшот.
  private noLinkToasted!: boolean
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
    this.exitModalKind = null
    this.exitWaitResume = null
    this.noLinkToasted = false
    this.reconnectUI = []
    this.debugFrames = []
    this.lastEventId = ''
    this.currentSpeed = 1
    this.reportPauseSeq = 0
    this.exitPauseFrom = 0
    this.exitPauseSeq = 0
    this.offlinePauseFrom = 0
    this.offlinePauseSeq = 0
    this.currentRoom = 'office' // MenuScene.startGame стартует сцену 'office'
    // ITGAME-42: таймер дребезга switchRoom (delayedCall 250 мс) гибнет в
    // Clock.shutdown(), если HUD закрыли раньше — флаг залипал на синглтоне,
    // навигация новой партии мертва.
    this.switching = false
    // Верхняя панель.
    this.add.rectangle(0, 0, GAME_W, HUD_H, 0x14162b).setOrigin(0)
    this.moneyText = tag(this.add.text(16, 10, '$…', {
      fontFamily: FONT, fontSize: '26px', color: '#ffcd75',
    }), 'hud.money')
    this.incomeText = tag(this.add.text(16, 44, '', {
      fontFamily: FONT, fontSize: '15px', color: '#38b764',
    }), 'hud.income')
    this.netText = tag(this.add.text(16, 66, '', {
      fontFamily: FONT, fontSize: '15px', color: '#41a6f6',
    }), 'hud.net')
    this.payrollText = tag(this.add.text(200, 44, '', {
      fontFamily: FONT, fontSize: '15px', color: '#5d7275',
    }), 'hud.payroll')
    this.dayText = tag(
      this.add
        .text(GAME_W - 16, 70, '', { fontFamily: FONT, fontSize: '13px', color: '#5d7275' })
        .setOrigin(1, 0),
      'hud.day',
    )
    this.goalText = tag(
      this.add
        .text(GAME_W - 16, 52, '', { fontFamily: FONT, fontSize: '13px', color: '#ffcd75' })
        .setOrigin(1, 0),
      'hud.goal',
    )
    // Рынок дня (сложность 2.0): сегодня и завтра, тренд виден заранее.
    this.marketText = tag(
      this.add
        .text(GAME_W - 16, 86, '', { fontFamily: FONT, fontSize: '12px', color: '#5d7275' })
        .setOrigin(1, 0),
      'hud.market',
    )
    // Долг по кредиту (сложность 2.0): виден только в минусе. Строки нижних
    // рядов раскладываются по ширинам в layoutPanel() (ITGAME-16) — стартовые
    // x/y здесь косметические, до первого layoutPanel().
    this.debtText = tag(this.add.text(170, 84, '', {
      fontFamily: FONT, fontSize: '12px', color: '#b13e53',
    }), 'hud.debt')
    // Темп дня одним взглядом: прибыль дня (= «Прибыль» отчёта), считает
    // сервер (dayProfit, ITGAME-53).
    this.dayProfitText = tag(this.add.text(16, 84, '', {
      fontFamily: FONT, fontSize: '15px', color: '#38b764',
    }), 'hud.dayProfit')
    this.layoutPanel()

    // Кнопки покупки (btn.pc/hire/boss/gateway) — в комнатах с ITGAME-94:
    // OfficeScene/ServerRoomScene, механика — ui/actionButton.ts.

    // Темп времени: пауза и множители. Активная кнопка подсвечивается по speed
    // из снапшота — сервер источник истины.
    // На паузе ⏸ — сплошная янтарная плашка (ITGAME-62): пауза видна без часов.
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
      const label = this.add.text(x + 18, 24, sp.label, { fontFamily: FONT, fontSize: '13px', color: '#f4f4f4' }).setOrigin(0.5)
      bg.on('pointerdown', () => client.send('set_speed', 0, { speed: sp.s }))
      this.speedBtns.push({ bg, label, speed: sp.s })
      this.hudInteractive.push(bg)
    })
    // Выход в меню из игры (анти-софтлок + «сдаться»): с подтверждением.
    const menuBg = tag(
      this.add.rectangle(GAME_W - 220, 10, 36, 28, 0x232640)
        .setOrigin(0).setStrokeStyle(2, 0x3a3f5c).setInteractive({ useHandCursor: true }),
      'btn.menu',
    )
    this.add.text(GAME_W - 202, 24, '⌂', { fontFamily: FONT, fontSize: '14px', color: '#f4f4f4' }).setOrigin(0.5)
    menuBg.on('pointerdown', () => this.confirmExitToMenu())
    menuBg.on('pointerover', () => menuBg.setStrokeStyle(2, 0xb13e53))
    menuBg.on('pointerout', () => menuBg.setStrokeStyle(2, 0x3a3f5c))
    this.hudInteractive.push(menuBg)
    // Масштаб UI (ITGAME-15): компактный циклический переключатель рядом с
    // кнопками скорости. Полный ряд — на стартовом экране; здесь панель тесная,
    // переключатель остаётся компактным.
    this.add
      .text(922, 24, 'масштаб', { fontFamily: FONT, fontSize: '11px', color: '#5d7275' })
      .setOrigin(1, 0.5)
    const zoomBg = tag(
      this.add.rectangle(928, 10, 64, 28, 0x232640)
        .setOrigin(0).setStrokeStyle(2, 0x41a6f6).setInteractive({ useHandCursor: true }),
      'btn.zoom',
    )
    const zoomTxt = this.add
      .text(960, 24, zoomLabel(activeZoom()), { fontFamily: FONT, fontSize: '12px', color: '#f4f4f4' })
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
            .text(GAME_W - 280, 17, this.debugLabel(), { fontFamily: FONT, fontSize: '12px', color: '#5d7275' })
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
      onState: (s) => {
        this.noLinkToasted = false // снапшот пришёл — связь есть, следующий обрыв — новая серия
        this.refresh(s)
        // «Подождать» (ITGAME-85): связь вернулась — exit уходит с первым снапшотом.
        if (this.exitWaitResume !== null) this.trySendExit(this.exitWaitResume)
      },
      onError: (code) => {
        playSfx(this, 'error')
        this.toast((ERROR_TEXTS as Record<string, string>)[code] ?? code)
      },
      // ITGAME-90: команда не ушла (сокет не открыт) — звук отказа на каждый клик,
      // тост один на серию обрыва, без спама.
      onNotConnected: () => {
        playSfx(this, 'error')
        if (this.noLinkToasted) return
        this.noLinkToasted = true
        this.toast('Нет связи — действие не отправлено')
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
          // Диалог выхода сверху (ITGAME-65): Esc = «Отмена», Enter/Space под ним отчёт не листают.
          // В «Удалить партию навсегда?» (ITGAME-86) фокус на «Отмена»: Enter/Space — тоже отмена.
          if (this.exitModalClose) {
            const cancels = name === 'ESC' || this.exitModalKind === 'surrender'
            if (cancels && this.cancelExit()) emitUi({ type: 'key', key: name, scene: this.scene.key, action: 'close_modal' })
            return
          }
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
        fontFamily: FONT, fontSize: '13px', color: '#ffcd75',
      })
      .setOrigin(0.5).setDepth(91)
    this.reconnectUI.push(bg, txt)
  }

  private showDisconnect(reason?: string) {
    this.hideButtonTooltip()
    // Связь не вернётся сама (session_taken): окно выхода и ожидание связи долой —
    // экран обрыва говорит, что делать.
    this.exitWaitResume = null
    this.exitModalClose?.()
    this.exitModalClose = null
    this.exitModalKind = null
    this.reconnectUI.forEach((o) => o.destroy())
    this.reconnectUI = []
    const taken = reason === 'session_taken'
    markDim(this.add.rectangle(0, 0, GAME_W, GAME_H, 0x1a1c2c, 0.85).setOrigin(0).setDepth(100),
      taken ? 'Игра открыта в другой вкладке' : 'Соединение потеряно') // ITGAME-72
    this.add
      .text(CX, 300, taken ? 'Игра открыта в другой вкладке' : 'Соединение потеряно', {
        fontFamily: FONT, fontSize: '26px', color: '#b13e53',
      })
      .setOrigin(0.5)
      .setDepth(101)
    this.add
      .text(CX, 344, taken
        ? 'Сессия обслуживает одно окно. Обновите страницу, чтобы забрать её сюда'
        : 'Обновите страницу — сохранённая игра продолжится с того же места', {
        fontFamily: FONT, fontSize: '15px', color: '#f4f4f4',
      })
      .setOrigin(0.5)
      .setDepth(101)
  }

  // «Пока вас не было»: итог офлайн-догона после реконнекта (ITGAME-8).
  // Финал офлайн (банкротство/победа) не дублируется обычными экранами —
  // его закрывает кнопка «В меню» прямо отсюда.
  private showOfflineReport(r: OfflineReportMessage) {
    if (!offlineShown(r)) return // догон внутри дня — тихий (itd.offline() его видит)
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
    const overlay = markDim(this.add.rectangle(0, 0, GAME_W, GAME_H, 0x1a1c2c, 0.75).setOrigin(0).setDepth(55).setInteractive(), 'Пока вас не было')
    const panel = this.add.rectangle(CX, 300, 460, 320, 0x14162b).setStrokeStyle(2, 0xffcd75).setDepth(56)
    const title = this.add
      .text(CX, 170, 'Пока вас не было', { fontFamily: FONT, fontSize: '22px', color: '#ffcd75' })
      .setOrigin(0.5).setDepth(56)
    const bodyText = this.add
      .text(CX, 275, body, { fontFamily: FONT, fontSize: '15px', color: '#f4f4f4', lineSpacing: 7, align: 'center' })
      .setOrigin(0.5).setDepth(56)
    const final = r.gameOver || r.victory
    // Итог читают на паузе: партия не идёт под окном. Повторный отчёт (окно уже
    // открыто) паузу не перезаписывает — иначе «Продолжить» вернул бы 0.
    if (!final && this.offlinePauseFrom === 0) {
      const live = client.latest?.speed ?? 0
      if (live > 0 && client.send('set_speed', 0, { speed: 0 })) {
        this.offlinePauseFrom = live
        this.offlinePauseSeq = client.speedSeq
      }
    }
    this.offlineUI = [overlay, panel, title, bodyText]
    if (final) {
      const btnBg = tag(
        this.add
          .rectangle(CX - 100, 392, 200, 34, 0x3b5dc9).setOrigin(0, 0).setDepth(56)
          .setInteractive({ useHandCursor: true }),
        'btn.offline.menu',
      )
      const btnText = this.add
        .text(CX, 409, 'В меню', { fontFamily: FONT, fontSize: '14px', color: '#f4f4f4' })
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
        .text(CX, 409, 'Продолжить →', { fontFamily: FONT, fontSize: '14px', color: '#f4f4f4' })
        .setOrigin(0.5).setDepth(57)
      btnBg.on('pointerdown', () => this.continueAfterOffline())
      btnBg.on('pointerover', () => btnBg.setFillStyle(0x41a6f6))
      btnBg.on('pointerout', () => btnBg.setFillStyle(0x3b5dc9))
      this.offlineUI.push(btnBg, btnText)
    }
  }

  private closeOfflineReport() {
    this.offlineUI.forEach((o) => o.destroy())
    this.offlineUI = []
  }

  // «Продолжить →»: снять окно и вернуть скорость до него, если после паузы окна
  // темп никто не менял (⏸/1x, itd.speed) — правило speedSeq окна выхода.
  private continueAfterOffline() {
    const prev = this.offlinePauseFrom
    this.offlinePauseFrom = 0
    this.closeOfflineReport()
    if (prev > 0 && client.speedSeq === this.offlinePauseSeq) client.send('set_speed', 0, { speed: prev })
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
        .text(NAV_W / 2, y + 18, r.label, { fontFamily: FONT, fontSize: '13px', color: '#f4f4f4' })
        .setOrigin(0.5)
      const sub = this.add
        .text(NAV_W / 2, y + 36, '', { fontFamily: FONT, fontSize: '8px', color: '#5d7275' })
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
    layoutRow(16, 16, [this.incomeText, this.payrollText], PANEL_LEFT_MAX)
    layoutRow(16, 12, [this.dayProfitText, this.debtText], PANEL_LEFT_MAX)
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

    this.navItems.forEach((item, idx) => {
      if (idx === 3) return
      const o = s.offices[idx]
      item.sub.setText(o.unlocked ? `${o.employees.length}/${s.officeSlots}` : fmtMoney(o.price))
    })
    this.highlightNav()
    this.speedBtns.forEach((b) => {
      const on = b.speed === s.speed
      // ITGAME-62: включённая пауза — янтарная плашка с тёмной подписью,
      // иначе обычный вид; клик по ⏸ по-прежнему шлёт set_speed 0.
      const paused = on && b.speed === 0
      b.bg.setFillStyle(paused ? 0xffcd75 : 0x232640)
      b.bg.setStrokeStyle(2, paused ? 0xffcd75 : on ? 0x41a6f6 : 0x3a3f5c)
      b.label.setColor(paused ? '#1a1c2c' : '#f4f4f4')
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
    // Панель события не модальная и встаёт сверху по центру — кнопки комнат
    // (ITGAME-94, колонка у правого края) она не накрывает: тултип гасим только
    // на новое событие, а не на каждый снапшот.
    if (ev.id !== this.lastEventId) {
      this.lastEventId = ev.id
      this.hideButtonTooltip()
      playSfx(this, 'question')
    }
    this.closeEvent()
    const panel = markTitle(this.add.rectangle(CX, 148, 480, 176, 0x14162b).setStrokeStyle(2, 0xffcd75).setDepth(40), ev.title)
    const title = this.add
      .text(CX, 84, ev.title, { fontFamily: FONT, fontSize: '18px', color: '#ffcd75' })
      .setOrigin(0.5).setDepth(41)
    const body = this.add
      .text(CX, 148, ev.text, {
        fontFamily: FONT, fontSize: '13px', color: '#f4f4f4',
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
        .text(x + w / 2, 212, label, { fontFamily: FONT, fontSize: '13px', color: '#f4f4f4' })
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

  // Тултипы кнопок комнат (ITGAME-94: кнопки покупки переехали из шапки в
  // OfficeScene/ServerRoomScene) гаснут, когда HUD открывает своё окно.
  private hideButtonTooltip() {
    hideActionTooltips()
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
          fontFamily: FONT, fontSize: '18px', color: '#f4f4f4',
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
    const hint = hints.find((h) => h.when && !localStore.get('itd.hint:' + h.id))
    if (hint) {
      localStore.set('itd.hint:' + hint.id, '1')
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
    const overlay = markDim(this.add.rectangle(0, 0, GAME_W, GAME_H, 0x1a1c2c, 0.75).setOrigin(0).setDepth(50).setInteractive(), `День ${r.day} завершён`)
    // Плашка модала (depth 51) создаётся ДО текстов и кнопок (depth 52..53),
    // чтобы display list и depth гарантированно держали фон ПОЗАДИ контента.
    const panel = this.add.rectangle(CX, 300, 440, 320, 0x14162b).setStrokeStyle(2, 0x41a6f6).setDepth(51)

    const title = this.add
      .text(CX, 0, `День ${r.day} завершён`, { fontFamily: FONT, fontSize: '22px', color: '#ffcd75' })
      .setOrigin(0.5, 0).setDepth(52)
    const bodyText = this.add
      .text(CX, 0, body, { fontFamily: FONT, fontSize: '16px', color: '#f4f4f4', lineSpacing: 8 })
      .setOrigin(0.5, 0).setDepth(52)
    const checkbox = markActive(
      tag(
        this.add
          .text(CX, 0, this.checkboxLabel(), { fontFamily: FONT, fontSize: '14px', color: '#5d7275' })
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
      .text(CX, 0, 'Следующий день →', { fontFamily: FONT, fontSize: '14px', color: '#f4f4f4' })
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
    const titleText = isDeadlock ? 'ТУПИК' : timeUp ? 'ВРЕМЯ ВЫШЛО' : 'БАНКРОТСТВО'
    const overlay = markDim(this.add.rectangle(0, 0, GAME_W, GAME_H, 0x1a1c2c, 0.9).setOrigin(0).setDepth(60).setInteractive(), titleText)
    const title = this.add
      .text(CX, 200, titleText, { fontFamily: FONT, fontSize: '32px', color: '#b13e53' })
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
      .text(CX, 290, lines.join('\n'), { fontFamily: FONT, fontSize: '15px', color: '#f4f4f4', lineSpacing: 6, align: 'center' })
      .setOrigin(0.5).setDepth(61)
    const btnBg = tag(
      this.add
        .rectangle(CX - 100, 380, 200, 34, 0x3b5dc9).setOrigin(0, 0).setDepth(61)
        .setInteractive({ useHandCursor: true }),
      'btn.gameover.menu',
    )
    const btnText = this.add
      .text(CX, 397, 'В меню', { fontFamily: FONT, fontSize: '14px', color: '#f4f4f4' })
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

    const overlay = markDim(this.add.rectangle(0, 0, GAME_W, GAME_H, 0x1a1c2c, 0.9).setOrigin(0).setDepth(60).setInteractive(), 'ПОБЕДА!')
    const title = this.add
      .text(CX, 200, 'ПОБЕДА!', { fontFamily: FONT, fontSize: '32px', color: '#38b764' })
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
      .text(CX, 290, lines.join('\n'), { fontFamily: FONT, fontSize: '15px', color: '#f4f4f4', lineSpacing: 6, align: 'center' })
      .setOrigin(0.5).setDepth(61)
    const btnBg = tag(
      this.add
        .rectangle(CX - 100, 380, 200, 34, 0x3b5dc9).setOrigin(0, 0).setDepth(61)
        .setInteractive({ useHandCursor: true }),
      'btn.victory.menu',
    )
    const btnText = this.add
      .text(CX, 397, 'В меню', { fontFamily: FONT, fontSize: '14px', color: '#f4f4f4' })
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
    this.exitModalKind = null
    this.exitWaitResume = null
    this.exitPauseFrom = 0 // новая партия остаётся на паузе, set_speed отсюда не шлём
    this.offlinePauseFrom = 0
    this.speedBeforeReport = null
    this.reportPauseSeq = 0
    this.lastEventId = ''
  }

  // Выход в меню с сейвами (ITGAME-8): выход сохраняет прогресс, сдаться —
  // осознанное удаление сейва. Случайный клик по ⌂ не должен стоить партию.
  private confirmExitToMenu() {
    this.hideButtonTooltip()
    if (this.exitModalClose) return // уже открыт (itd.click мимо подложки)
    // ITGAME-65: пока диалог открыт, партия на паузе. Пауза отчёта главнее: её
    // set_speed 0 уже стоит, лишний сломал бы reportPauseSeq. Без связи паузу не шлём
    // (ITGAME-90: тост «нет связи» тут лишний — о связи скажет «Сохранить и выйти»).
    this.exitPauseFrom = 0
    const live = client.latest?.speed ?? 0
    if (this.speedBeforeReport === null && live > 0 && client.socketStatus() === 'open' &&
      client.send('set_speed', 0, { speed: 0 })) {
      this.exitPauseFrom = live
      this.exitPauseSeq = client.speedSeq
    }
    this.openExitModal('exit', 'Выйти в меню?', ['Прогресс сохранится — продолжите', 'с главного меню в любое время.'], [
      { label: 'Сохранить и выйти', onClick: () => this.saveAndExit() },
      { label: 'Сдаться (удалить сейв)', onClick: () => this.confirmSurrender() },
      { label: 'Отмена', onClick: () => { this.cancelExit() } },
    ])
  }

  // Окно цепочки выхода: прежнее закрывается молча, закрытие без выбора (✕, подложка)
  // и Esc — cancelExit(). Кнопка закрывает своё окно сама после onClick (showModal).
  private openExitModal(kind: 'exit' | 'surrender' | 'nolink' | 'wait', title: string, lines: string[], buttons: ModalButton[]) {
    this.exitModalClose?.()
    this.exitModalKind = kind
    this.exitModalClose = showModal(this, title, lines, buttons, undefined, () => { this.cancelExit() })
  }

  // «Отмена», Esc, подложка, ✕ (ITGAME-65): закрыть диалог и вернуть скорость, если
  // паузу ставил он и темп после неё не менялся (itd.pause(), отчёт дня). То же для
  // окон «Сдаться», «Нет связи» и ожидания связи: назад в игру, ожидание exit снято.
  private cancelExit(): boolean {
    const close = this.exitModalClose
    if (!close) return false
    this.exitModalClose = null
    this.exitModalKind = null
    this.exitWaitResume = null
    close() // повторный close() из showModal — no-op
    const prev = this.exitPauseFrom
    this.exitPauseFrom = 0
    if (prev > 0 && client.speedSeq === this.exitPauseSeq) client.send('set_speed', 0, { speed: prev })
    return true
  }

  // «Сдаться» (ITGAME-86): необратимо — сперва подтверждение в стиле «Уволить сотрудника?»,
  // по умолчанию «Отмена» (рамка фокуса; Enter/Space/Esc — отмена, назад в игру).
  private confirmSurrender() {
    this.openExitModal('surrender', 'Удалить партию навсегда?', [
      'Сейв удалится — «Продолжить»', 'эту партию больше не вернёт.', 'Enter / Esc — отмена',
    ], [
      { label: 'Удалить', danger: true, onClick: () => this.abandonParty() },
      { label: 'Отмена', focus: true, onClick: () => { this.cancelExit() } },
    ])
  }

  // Удалить сейв и уйти в меню: «Удалить» в подтверждении «Сдаться». Тот же путь у
  // itd.cmd('abandon') — без подтверждения: это команда агента, не клик (ITGAME-86);
  // голая команда мимо клиента переподключала сокет в новую партию (ретро 10.10).
  abandonParty() {
    this.exitModalClose?.() // закрывалка молчит: скорость не возвращает
    this.exitModalClose = null
    this.exitModalKind = null
    this.exitWaitResume = null
    this.exitPauseFrom = 0
    client.abandon()
    this.returnToMenu()
  }

  // «Сохранить и выйти» (ITGAME-65): сервер сохраняет партию на паузе (догона нет) и
  // запоминает скорость возврата — до отчёта дня, до диалога или текущую (0 — была пауза).
  // Без связи exit не уйдёт (sendCmd → 0, disconnect() гасит реконнект), а сервер гонит
  // партию дальше — игрок узнаёт об этом окном «Нет связи» (ITGAME-85, решение владельца).
  private saveAndExit() {
    const ours = this.exitPauseFrom > 0 && client.speedSeq === this.exitPauseSeq
    const resume = this.speedBeforeReport ?? (ours ? this.exitPauseFrom : (client.latest?.speed ?? 0))
    if (this.trySendExit(resume)) return
    // Пауза диалога (если ушла до обрыва) остаётся за cancelExit: «Отмена» вернёт скорость.
    this.openExitModal('nolink', 'Нет связи — сохранение не дойдёт', [
      'Сервер не узнает о выходе: партия', 'продолжит идти без вас до возврата.',
    ], [
      { label: 'Подождать', onClick: () => this.waitAndExit(resume) },
      { label: 'Выйти без сохранения', onClick: () => this.exitUnsaved() },
    ])
  }

  // exit ушёл — только тогда в меню (ITGAME-85): до disconnect(), сервер обработает его
  // до закрытия сокета. Сокет не открыт — false, ничего не тронуто.
  private trySendExit(resume: number): boolean {
    if (client.socketStatus() !== 'open' || !client.send('exit', 0, { speed: resume })) return false
    this.exitModalClose?.()
    this.exitModalClose = null
    this.exitModalKind = null
    this.exitWaitResume = null
    this.exitPauseFrom = 0
    this.returnToMenu()
    return true
  }

  // «Подождать»: таймер переподключения идёт своим ходом (disconnect() не зовём); первый
  // снапшот нового сокета отправит exit и уведёт в меню (onState). Связь уже есть — сразу.
  private waitAndExit(resume: number) {
    if (this.trySendExit(resume)) return
    this.exitWaitResume = resume
    this.openExitModal('wait', 'Ждём связь…', [
      'Сохраним и выйдем в меню,', 'как только связь вернётся.',
    ], [
      { label: 'Выйти без сохранения', onClick: () => this.exitUnsaved() },
      { label: 'Отмена', onClick: () => { this.cancelExit() } },
    ])
  }

  // «Выйти без сохранения»: в меню как раньше — партия идёт на сервере, «Продолжить»
  // покажет догон. Игрок предупреждён окном «Нет связи».
  private exitUnsaved() {
    this.exitModalClose?.()
    this.exitModalClose = null
    this.exitModalKind = null
    this.exitWaitResume = null
    this.exitPauseFrom = 0
    this.returnToMenu()
  }
}
