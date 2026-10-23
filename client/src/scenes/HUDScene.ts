import Phaser from 'phaser'
import { GAME_H, GAME_W, HUD_H, NAV_W, layoutColumn, layoutRow } from '../layout'
import { client, offlineShown } from '../net'
import { localStore, sessionStore } from '../storage'
import type { DayReportMessage, GameOverMessage, OfflineReportMessage, ServerErrorCode, StateMessage, VictoryMessage } from '../protocol'
import { adminsReportLines, bankruptLines, fmtMoney, virusReportLines } from '../format'
import { nav } from '../rooms'
import { onPartyReset, partyChange } from '../party'
import { debug, drawDebugFrames, setDebug } from '../debug'
import { markActive, markDim, markTitle, rejectClick, tag } from '../debug/agentApi'
import { showModal, type ModalButton } from '../ui/modal'
import { hideActionTooltips } from '../ui/actionButton'
import { attachIcon } from '../ui/iconText'
import { playSfx } from '../audio'
import { emitUi } from '../uibus'
import { activeZoom, applyZoom, ZOOM_OPTIONS, zoomLabel } from '../uiscale'
import { FONT, HIRES_CAMERA } from '../render'
import { ONBOARD_STEPS, onboardStep } from '../onboarding'
import { LOG_LINES, diffEvents, newDayLine, takeDayLog, wrapHanging } from '../eventlog'
import type { DayLogCursor } from '../eventlog'
import { WORKDAY, dayShare, hourShare } from '../workday'
import {
  checkAchievements,
  getAchievementsSummary,
  recordGameOver,
  recordVictory,
  updateOngoingStats,
} from '../meta'
import type { AchievementDef } from '../meta'

// Комнаты партии — сцены за панелью навигации.
type Room = 'office' | 'serverRoom' | 'adminDept'
const CX = GAME_W / 2 // центр поля — якорь модалок и тостов
const SPEED_BEFORE_REPORT_KEY = 'itd.speedBeforeReport'
const REPORT_KEYS = [Phaser.Input.Keyboard.KeyCodes.ENTER, Phaser.Input.Keyboard.KeyCodes.SPACE]
// Отчёт дня (ITGAME-141): поля текста внутри рамки по x и зазор панели до края поля по y.
const REPORT_PAD_X = 24
const REPORT_MARGIN_Y = 16

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
  not_infected: 'На этом ПК нет вируса',
  no_event: 'Событие уже закрыто',
  bad_option: 'Нет такого варианта',
  need_cooler: 'Сначала купите кулер',
  bad_tier: 'Нет такого тарифа',
  antivirus_already: 'Этот тариф уже подключён',
  admin_already: 'Админ в этом офисе уже есть',
  no_admin: 'В этом офисе нет админа',
  admin_dept_already: 'Отдел админов уже куплен',
  admin_dept_locked: 'Сначала купите отдел админов',
  pc_dead: 'ПК выработал ресурс — только замена',
  pc_fresh: 'ПК новый — менять нечего',
  pc_max_level: 'Рабочее место уже максимального уровня',
  no_action_points: 'Очки действий кончились — мастер или админ; утром очки восполнятся',
}

// Правый край левого блока панели (ITGAME-16): правая колонка (цель/день/рынок)
// начинается не левее x 848. До ITGAME-94 середину шапки занимали кнопки
// покупки (x 420..840) и левый блок сжимался к 416; кнопки переехали в комнаты —
// длинные строки («Сотрудники: 15 · в сети 15/15  Расходы …») больше не жмутся.
const PANEL_LEFT_MAX = 832

// Полосы правой колонки шапки (ITGAME-21): дорожка на всю колонку, x 884..1264
// (правее карточки события x ≤ 880).
const BAR_X = 884
const BAR_W = 380

// Плашка «До банкротства N дней» (ITGAME-118): низ — у якоря нижних тостов, над журналом.
const DOOM_BOTTOM = 614
const DOOM_H = 40
const DOOM_PAD = 14
const DOOM_GAP = 16
const DOOM_BTN_W = 104

function daysWord(n: number): string {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return 'день'
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'дня'
  return 'дней'
}

const doomLine = (n: number) => `До банкротства ${n} ${daysWord(n)}`

export class HUDScene extends Phaser.Scene {
  private moneyText!: Phaser.GameObjects.Text
  private pointsText!: Phaser.GameObjects.Text
  private incomeText!: Phaser.GameObjects.Text
  private netText!: Phaser.GameObjects.Text
  private payrollText!: Phaser.GameObjects.Text
  private dayText!: Phaser.GameObjects.Text
  private goalText!: Phaser.GameObjects.Text
  // Полоса цели (ITGAME-21): дорожка под hud.goal, заливка = деньги/цель, метки комбо
  // и засечка дедлайна. Создаются ДО текстов шапки (текст лежит на полосе).
  private goalBar!: Phaser.GameObjects.Rectangle
  private goalFill!: Phaser.GameObjects.Rectangle
  private goalStaff!: Phaser.GameObjects.Rectangle
  private goalCore!: Phaser.GameObjects.Rectangle
  private goalDeadline!: Phaser.GameObjects.Rectangle
  private deadlineX = BAR_X
  // Журнал событий (ITGAME-21): нижняя полоса x 540..1270, y 620..714.
  private logText!: Phaser.GameObjects.Text
  private logLines!: string[]
  private logPrev!: StateMessage | null
  // Отчёт, уже выложенный в журнал («сид:день», ITGAME-150): сервер пересылает отчёт
  // после переподключения в фазе day_report — второй раз его строки в журнал не идут.
  private logReport = ''
  // Сколько строк журнала дня сервера («сид:день») лента уже положила (ITGAME-163): их
  // читают и снапшот (state.dayLog, вживую), и вечерний отчёт — повторов нет.
  private logDay: DayLogCursor = { key: '', shown: 0 }
  // Плашка онбординга (ITGAME-21): текущий шаг цепочки (null — не показываем) и её объекты.
  private coachStep: number | null = null
  private coachBg!: Phaser.GameObjects.Rectangle
  private coachText!: Phaser.GameObjects.Text
  private coachTarget!: Phaser.GameObjects.Rectangle
  // Полоса дня (ITGAME-21): 10:00→19:00, обеденная плашка и засечки 17:00/18:00.
  private dayBar!: Phaser.GameObjects.Rectangle
  private dayFill!: Phaser.GameObjects.Rectangle
  private dayLunch!: Phaser.GameObjects.Rectangle
  private dayMark17!: Phaser.GameObjects.Rectangle
  private dayMark18!: Phaser.GameObjects.Rectangle
  private dayProfitText!: Phaser.GameObjects.Text
  private marketText!: Phaser.GameObjects.Text
  private debtText!: Phaser.GameObjects.Text
  private navItems!: { bg: Phaser.GameObjects.Rectangle; label: Phaser.GameObjects.Text; sub: Phaser.GameObjects.Text; lock?: { body: Phaser.GameObjects.Rectangle; shackle: Phaser.GameObjects.Arc }; virus?: Phaser.GameObjects.Text }[]
  private currentRoom!: Room
  private reportUI!: Phaser.GameObjects.GameObject[]
  private eventUI!: Phaser.GameObjects.GameObject[]
  private doomUI!: Phaser.GameObjects.GameObject[]
  private doomN = 0 // N на показанной плашке «До банкротства N дней» (ITGAME-118)
  private doomDay = 0 // день, когда плашка уже вставала: «×» снимает её до утра
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
  // Окно «Сейв несовместим…» (ITGAME-174): живёт в HUD, который переживает resetForNewGame;
  // скорость партии не трогает — новая партия идёт как обычно.
  private incompatibleClose!: (() => void) | null
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
    this.doomUI = []
    this.doomN = 0
    this.doomDay = 0
    this.gameOverUI = []
    this.victoryUI = []
    this.offlineUI = []
    this.exitModalClose = null
    this.exitModalKind = null
    this.incompatibleClose = null
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
    this.createBars()
    this.moneyText = tag(this.add.text(16, 10, '$…', {
      fontFamily: FONT, fontSize: '26px', color: '#ffcd75',
    }), 'hud.money')
    // Очки действий директора (ITGAME-127): в ряду денег, справа от суммы.
    this.pointsText = tag(this.add.text(200, 14, '', {
      fontFamily: FONT, fontSize: '15px', color: '#f4f4f4',
    }), 'hud.points')
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
        .text(BAR_X + 4, 70, '', { fontFamily: FONT, fontSize: '13px', color: '#f4f4f4' })
        .setOrigin(0, 0),
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
    // Долг (кредит — сложность 2.0, овердрафт — ITGAME-156): виден только в минусе, стоит
    // сразу за «Расходы …/день» — порог овердрафта и есть расходы дня (ITGAME-178). Строки
    // рядов раскладываются по ширинам в layoutPanel() (ITGAME-16) — стартовые
    // x/y здесь косметические, до первого layoutPanel().
    this.debtText = tag(this.add.text(370, 44, '', {
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

    // Журнал событий (ITGAME-21): после навигации — поздно в списке отображения; тосты
    // (depth 100) остаются над ним.
    this.logLines = []
    this.logPrev = null
    this.logReport = ''
    this.logDay = { key: '', shown: 0 }
    tag(this.add.rectangle(540, 620, 730, 94, 0x14162b, 0.9).setOrigin(0).setStrokeStyle(1, 0x3a3f5c), 'hud.log.bg')
    this.logText = tag(this.add.text(548, 624, '', {
      fontFamily: FONT, fontSize: '12px', color: '#94b0c2', lineSpacing: 2,
    }), 'hud.log')

    // Плашка-подсказка цепочки онбординга (ITGAME-21): не тост — без звука, без стека.
    // Рамка цели — только контур (без заливки: мимо occlusion/contrast) и не интерактивна.
    this.coachStep = null
    this.coachBg = tag(
      this.add.rectangle(884, 104, 246, 46, 0x14162b, 0.95).setOrigin(0).setStrokeStyle(2, 0xffcd75).setDepth(30),
      'hud.coach.bg',
    )
    this.coachText = tag(
      this.add.text(892, 110, '', { fontFamily: FONT, fontSize: '12px', color: '#f4f4f4' }).setDepth(30),
      'hud.coach',
    )
    this.coachTarget = tag(
      this.add.rectangle(0, 0, 10, 10).setOrigin(0).setStrokeStyle(2, 0xffcd75).setDepth(30),
      'hud.coach.target',
    )
    this.hideCoach()

    const unsub = client.subscribe({
      onState: (s) => {
        this.noLinkToasted = false // снапшот пришёл — связь есть, следующий обрыв — новая серия
        this.refresh(s)
        // «Подождать» (ITGAME-85): связь вернулась — exit уходит с первым снапшотом.
        if (this.exitWaitResume !== null) this.trySendExit(this.exitWaitResume)
      },
      onError: (code) => {
        // Офис с админом (ITGAME-145): последний клик игрока по месту часто
        // проигрывает тику админа — место уже дочищено или починено, и сервер
        // отвечает not_infected / not_broken. Это не ошибка игрока — молчим.
        if ((code === 'not_infected' || code === 'not_broken') && client.latest?.offices[nav.activeOffice]?.admin) return
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
      // Сервер отверг сейв чужого формата и начал новую партию (ITGAME-174): событие первого
      // снапшота сокета, net.ts уже сделал resetForNewGame — окно поднимается поверх. Разовое
      // (ITGAME-224): пересозданный HUD и reemit его не повторяют.
      onIncompatible: () => this.showIncompatibleNotice(),
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
          // Окно «Сейв несовместим…» (ITGAME-174): одна кнопка, Enter/Space/Esc — «ОК».
          if (this.incompatibleClose) {
            this.incompatibleClose()
            emitUi({ type: 'key', key: name, scene: this.scene.key, action: 'close_modal' })
            return
          }
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
        { type: 'game_over', daysSurvived: currentDay, balance: r.balance, shortfall: 0, peakIncomePerTick: 0, reason: r.reason ?? 'bankrupt' },
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
      ...(offlineAchs.length > 0 ? [''] : []),
    ]
    const trophy = offlineAchs.length > 0 ? `Достижение: ${offlineAchs.map((a) => a.title).join(', ')}` : null
    const overlay = markDim(this.add.rectangle(0, 0, GAME_W, GAME_H, 0x1a1c2c, 0.75).setOrigin(0).setDepth(55).setInteractive(), 'Пока вас не было')
    const panel = this.add.rectangle(CX, 300, 460, 320, 0x14162b).setStrokeStyle(2, 0xffcd75).setDepth(56)
    const title = this.add
      .text(CX, 170, 'Пока вас не было', { fontFamily: FONT, fontSize: '22px', color: '#ffcd75' })
      .setOrigin(0.5).setDepth(56)
    const bodyText = this.bodyWithTrophy(275, body, trophy, { fontFamily: FONT, fontSize: '15px', color: '#f4f4f4', lineSpacing: 7, align: 'center' }, 56)
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
    this.offlineUI = [overlay, panel, title, ...bodyText]
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
    // ITGAME-97: рамки ?debug=1 (подложка 55.5, кнопка 56.5) живут в offlineUI — уходят вместе с окном.
    this.offlineUI.push(...drawDebugFrames(this, this.offlineUI))
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

  // Полосы шапки (ITGAME-21): все прямоугольники — до текстов, на одном depth, иначе
  // lint.ts увидит occlusion (заливка выше текста). Размеры по высоте текста
  // выставляет layoutBars().
  private createBars() {
    const rect = (x: number, y: number, w: number, h: number, color: number, id: string) =>
      tag(this.add.rectangle(x, y, w, h, color).setOrigin(0), id)
    this.goalBar = rect(BAR_X, 43, BAR_W, 16, 0x232640, 'hud.goal.bar').setStrokeStyle(1, 0x3a3f5c)
    this.goalFill = rect(BAR_X, 43, 1, 16, 0x2a6b3f, 'hud.goal.fill')
    this.goalStaff = rect(890, 47, 8, 8, 0x5d7275, 'hud.goal.staff')
    this.goalCore = rect(902, 47, 8, 8, 0x5d7275, 'hud.goal.core')
    this.goalDeadline = rect(BAR_X, 43, 2, 16, 0xb13e53, 'hud.goal.deadline')
    this.goalFill.setVisible(false)
    this.goalStaff.setVisible(false)
    this.goalCore.setVisible(false)
    this.goalDeadline.setVisible(false)
    const dx = (hour: number) => BAR_X + Math.round(BAR_W * hourShare(hour))
    this.dayBar = rect(BAR_X, 61, BAR_W, 16, 0x232640, 'hud.day.bar').setStrokeStyle(1, 0x3a3f5c)
    this.dayFill = rect(BAR_X, 61, 1, 16, 0x3b5dc9, 'hud.day.fill')
    // Альфа 0.35 держит плашку вне occlusion (< 0.9) и вне выбора фона для contrast (< 0.5).
    this.dayLunch = tag(
      this.add.rectangle(dx(WORKDAY.lunchStart), 61, Math.round(BAR_W / (WORKDAY.end - WORKDAY.start)), 16, 0xffcd75, 0.35).setOrigin(0),
      'hud.day.lunch',
    )
    this.dayMark17 = rect(dx(WORKDAY.deadlineHour), 61, 2, 16, 0xffcd75, 'hud.day.mark17')
    this.dayMark18 = rect(dx(WORKDAY.auditHour), 61, 2, 16, 0xb13e53, 'hud.day.mark18')
    this.dayFill.setVisible(false)
  }

  // Полосы идут за фактической высотой и y текстов (после layoutColumn).
  private layoutBars() {
    const gy = this.goalText.y, gh = this.goalText.height
    this.goalBar.setPosition(BAR_X, gy).setSize(BAR_W, gh)
    this.goalFill.setPosition(BAR_X, gy).setSize(this.goalFill.width, gh)
    const markY = gy + Math.round((gh - 8) / 2)
    this.goalStaff.setY(markY)
    this.goalCore.setY(markY)
    this.goalDeadline.setPosition(this.deadlineX, gy).setSize(2, gh)
    const dy = this.dayText.y, dh = this.dayText.height
    for (const r of [this.dayBar, this.dayFill, this.dayLunch, this.dayMark17, this.dayMark18]) r.setY(dy).setSize(r.width, dh)
  }

  private refreshGoalBar(s: StateMessage, staffCount: number) {
    const share = s.winTarget > 0 ? Math.min(1, Math.max(0, s.money / s.winTarget)) : 0
    const w = Math.round(BAR_W * share)
    this.goalFill.setVisible(w > 0)
    if (w > 0) this.goalFill.setSize(w, this.goalText.height)
    // Метки комбо слева на дорожке; если подпись цели доползла до них (ни одна
    // текущая сложность не доходит: самая длинная, hard, начинается у x ≈ 984),
    // прячем обе, чтобы не лежали под текстом.
    const room = this.goalText.getBounds().left >= 914
    this.goalStaff.setVisible(room && s.winStaff > 0)
    this.goalCore.setVisible(room && s.winCore > 0)
    this.goalStaff.setFillStyle(staffCount >= s.winStaff ? 0x38b764 : 0x5d7275)
    this.goalCore.setFillStyle(s.core.level >= s.winCore ? 0x38b764 : 0x5d7275)
    this.goalDeadline.setVisible(s.winDayLimit > 0)
    const dayShare = s.winDayLimit > 0 ? Math.min(1, (s.day - 1) / s.winDayLimit) : 0
    this.deadlineX = BAR_X + Math.min(BAR_W - 2, Math.round(BAR_W * dayShare))
  }

  // Панель навигации: значки офисов, серверной и отдела админов в колонке слева.
  private createNavPanel() {
    this.add.rectangle(0, HUD_H, NAV_W, GAME_H - HUD_H, 0x14162b).setOrigin(0)
    const rooms: { key: Room; office: number; label: string }[] = [
      { key: 'office', office: 0, label: 'О1' },
      { key: 'office', office: 1, label: 'О2' },
      { key: 'office', office: 2, label: 'О3' },
      { key: 'serverRoom', office: -1, label: 'СРВ' },
      // Отдел админов (ITGAME-145): закрыт и покупается, как офис.
      { key: 'adminDept', office: -1, label: 'АДМ' },
    ]
    rooms.forEach((r, idx) => {
      const y = HUD_H + 24 + idx * 76
      const bg = tag(
        this.add.rectangle(8, y, NAV_W - 16, 48, 0x232640)
          .setOrigin(0).setStrokeStyle(2, 0x3a3f5c).setInteractive({ useHandCursor: true }),
        r.key === 'office' ? `nav.office${r.office}` : `nav.${r.key}`,
      )
      const label = this.add
        .text(NAV_W / 2, y + 18, r.label, { fontFamily: FONT, fontSize: '13px', color: '#f4f4f4' })
        .setOrigin(0.5)
      const sub = this.add
        .text(NAV_W / 2, y + 36, '', { fontFamily: FONT, fontSize: '8px', color: '#5d7275' })
        .setOrigin(0.5)
      // Замок закрытого офиса (ITGAME-21) — фигурами, без эмодзи (системный шрифт
      // ломает пиксели): корпус + дужка-полукруг без заливки.
      let lock: { body: Phaser.GameObjects.Rectangle; shackle: Phaser.GameObjects.Arc } | undefined
      if ((r.key === 'office' && r.office > 0) || r.key === 'adminDept') {
        const body = tag(this.add.rectangle(44, y + 6, 10, 8, 0x5d7275).setOrigin(0),
          r.key === 'office' ? 'hud.lock.office' + r.office : 'hud.lock.adminDept')
        const shackle = this.add.arc(49, y + 6, 4, 180, 360, false).setStrokeStyle(2, 0x5d7275)
        lock = { body, shackle }
      }
      // Вирус (ITGAME-103): «☣ k» — заражённые места офиса, вплотную под
      // значком (внутри значка подпись «О1» и «9/12» места не оставляют, а
      // зазор до следующего значка — 28px; «☣ 12» шириной 32px влезает).
      // Тостов на волну нет (решение владельца 16.10) — рост виден здесь, у
      // каждого офиса, в том числе у текущего.
      const virus = r.key === 'office'
        ? tag(this.add.text(NAV_W / 2, y + 50, '', { fontFamily: FONT, fontSize: '10px', color: '#a7f070' })
          .setOrigin(0.5, 0).setVisible(false), 'hud.virus.office' + r.office)
        : undefined
      bg.on('pointerdown', () => this.switchRoom(r.key, r.office))
      this.navItems.push({ bg, label, sub, lock, virus })
      this.hudInteractive.push(bg)
    })
  }

  private switchRoom(key: Room, office: number) {
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
    this.updateCoachFrame() // refresh выше шёл ещё со старой комнатой
  }

  private hideCoach() {
    this.coachStep = null
    this.coachBg.setVisible(false)
    this.coachText.setVisible(false)
    this.coachTarget.setVisible(false)
  }

  // Рамка цели видна только в офисе 0 (кнопки и слот роутера — его).
  private updateCoachFrame() {
    const step = this.coachStep === null ? null : ONBOARD_STEPS[this.coachStep]
    if (!step) {
      this.coachTarget.setVisible(false)
      return
    }
    const t = step.target
    this.coachTarget.setPosition(t.x, t.y).setSize(t.w, t.h)
    this.coachTarget.setVisible(this.currentRoom === 'office' && nav.activeOffice === 0)
  }

  // Цепочка онбординга: hire → второй ПК → роутер. Пройдена — запоминаем в хранилище.
  private refreshCoach(s: StateMessage) {
    if (s.phase !== 'running' || localStore.get('itd.onboard') === 'done') {
      this.hideCoach()
      return
    }
    const i = onboardStep(s)
    if (i === null) {
      localStore.set('itd.onboard', 'done')
      this.hideCoach()
      return
    }
    this.coachStep = i
    this.coachText.setText(ONBOARD_STEPS[i].text)
    this.coachBg.setVisible(true)
    this.coachText.setVisible(true)
    this.updateCoachFrame()
  }

  // Значок отдела админов (ITGAME-145): закрыт — замок и цена, зелёный, если
  // хватает денег; открыт — «k/3», нанято админов.
  private refreshDeptNav(item: (typeof this.navItems)[number], s: StateMessage) {
    const locked = !s.adminDept
    const affordable = locked && s.money >= s.prices.adminDept
    const admins = s.offices.filter((o) => o.admin !== '').length
    item.sub.setText(locked ? fmtMoney(s.prices.adminDept) : `${admins}/${s.offices.length}`)
    item.bg.setFillStyle(affordable ? 0x2a6b3f : 0x232640)
    item.sub.setColor(affordable ? '#f4f4f4' : '#5d7275')
    if (item.lock) {
      const c = affordable ? 0x38b764 : 0x5d7275
      item.lock.body.setVisible(locked).setFillStyle(c)
      item.lock.shackle.setVisible(locked).setStrokeStyle(2, c)
    }
  }

  private highlightNav() {
    this.navItems.forEach((item, idx) => {
      const active = this.currentRoom === 'serverRoom' ? idx === 3
        : this.currentRoom === 'adminDept' ? idx === 4
          : idx === nav.activeOffice
      item.bg.setStrokeStyle(2, active ? 0x41a6f6 : 0x3a3f5c)
      markActive(item.bg, active)
    })
  }

  // Раскладка верхней панели (ITGAME-16): столбец слева (money/income+payroll+debt/
  // net/dayProfit) и столбец справа (goal/day/market) кладутся по
  // фактическим высотам строк — при 0/1/9/15 сотрудниках и длинных суммах
  // ни одна строка не пересекает соседнюю и не уходит за HUD_H. Горизонталь
  // внутри строк — layoutRow (x-старт/gap/maxRight из прежней раскладки).
  // Долг — за «Расходы» (ITGAME-178): худший ряд Кошмара ≈ 630 px < PANEL_LEFT_MAX.
  private layoutPanel() {
    layoutColumn(4, [[this.moneyText, this.pointsText], [this.incomeText, this.payrollText, this.debtText], [this.netText], [this.dayProfitText]], 0, HUD_H)
    layoutRow(16, 16, [this.moneyText, this.pointsText], PANEL_LEFT_MAX)
    // Мелкая строка очков — по низу крупной суммы, а не по верху ряда.
    this.pointsText.setY(this.moneyText.y + this.moneyText.height - this.pointsText.height)
    layoutRow(16, 16, [this.incomeText, this.payrollText, this.debtText], PANEL_LEFT_MAX)
    layoutRow(16, 12, [this.dayProfitText], PANEL_LEFT_MAX)
    layoutColumn(43, [[this.goalText], [this.dayText], [this.marketText]], 2, HUD_H)
    this.layoutBars()
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
    // Лента (ITGAME-163): граница дня, изменения снапшота, итоги событий дня со своим
    // «HH:MM» — в этом порядке, чтобы «Событие: …» вставало раньше своего исхода.
    const newDay = newDayLine(this.logPrev, s)
    if (newDay) this.logLine(newDay.text, newDay.clock ?? undefined)
    if (this.logPrev) for (const l of diffEvents(this.logPrev, s)) this.logLine(l)
    this.putDayLog(`${s.seed}:${s.day}`, s.dayLog)
    this.logPrev = s
    if (s.phase === 'running') {
      try {
        updateOngoingStats(s)
        const newAchs = checkAchievements(s)
        if (newAchs.length > 0) {
          playSfx(this, 'confirmation')
          const msg = newAchs.length === 1
            ? `Достижение: «${newAchs[0].title}»!`
            : `Достижения: ${newAchs.map((a) => a.title).join(', ')}`
          // одно достижение — его собственная иконка, несколько — общий кубок (ITGAME-83)
          this.toast(msg, 4000, { bg: '#2a6b3f', icon: newAchs.length === 1 ? newAchs[0].icon : 'icon_trophy' })
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
    this.pointsText.setText(`Очки: ${s.actionPoints}/${s.actionPointsMax}`)
    this.pointsText.setColor(s.actionPoints > 0 ? '#f4f4f4' : '#b13e53')
    this.incomeText.setText(`+${fmtMoney(s.incomePerTick)}/сек`)
    this.payrollText.setText(`Расходы ${fmtMoney(s.payrollPerDay)}/день`)
    // Прогноз считает сервер: клиент не знает про обеденные тики.
    this.payrollText.setColor(s.forecastEndOfDay < 0 ? '#b13e53' : '#5d7275')
    this.dayText.setText(`День ${s.day} · ${s.clock}${s.isLunch ? ' · обед' : ''}`)
    this.goalText.setText(this.goalLabel(s))
    this.refreshGoalBar(s, employees.length)
    const dayW = Math.round(BAR_W * dayShare(s.tickInDay, s.ticksPerHour))
    this.dayFill.setVisible(dayW > 0)
    if (dayW > 0) this.dayFill.setSize(dayW, this.dayText.height)
    // Рынок (сложность 2.0): качели выработки ±%, завтра виден заранее.
    if (s.marketToday !== 0 || s.marketTomorrow !== 0) {
      const pct = (v: number) => (v > 0 ? `+${v}` : `${v}`)
      this.marketText.setText(`Рынок ${pct(s.marketToday)}% · завтра ${pct(s.marketTomorrow)}%`)
      this.marketText.setColor(s.marketToday < 0 ? '#b13e53' : s.marketToday > 0 ? '#38b764' : '#5d7275')
    } else {
      this.marketText.setText('')
    }
    // Долг: минус на любом уровне — не приговор до порога state.debtLimit (сервер): на
    // кредите капают проценты, на овердрафте (легко, норма) порог — расходы дня (ITGAME-156);
    // формулировка овердрафта — слово владельца на приёмке 18.10 (ITGAME-178).
    if (s.money < 0 && s.debtLimit > 0) {
      this.debtText.setText(s.creditLimit > 0
        ? `Долг ${fmtMoney(s.money)} из ${fmtMoney(-s.debtLimit)} · ${s.creditRatePct}%/день`
        : `Овердрафт ${fmtMoney(s.money)} (мин. лимит ${fmtMoney(-s.debtLimit)})`)
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
      if (idx === 4) {
        this.refreshDeptNav(item, s)
        return
      }
      const o = s.offices[idx]
      item.sub.setText(o.unlocked ? `${o.employees.length}/${s.officeSlots}` : fmtMoney(o.price))
      // Офис, который можно купить сейчас (по порядку — правило OfficeScene — и хватает
      // денег), подсвечен зелёным; обводку не трогаем: ею владеет highlightNav() (активный).
      const locked = !o.unlocked
      const canBuy = idx === 0 || s.offices[idx - 1].unlocked
      const affordable = locked && canBuy && s.money >= o.price
      item.bg.setFillStyle(affordable ? 0x2a6b3f : 0x232640)
      item.sub.setColor(affordable ? '#f4f4f4' : '#5d7275')
      if (item.lock) {
        const c = affordable ? 0x38b764 : 0x5d7275
        item.lock.body.setVisible(locked).setFillStyle(c)
        item.lock.shackle.setVisible(locked).setStrokeStyle(2, c)
      }
      item.virus?.setText(`☣ ${o.virusPCs}`).setVisible(o.virusPCs > 0)
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
    this.updateDoom(s)
    this.refreshCoach(s)
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
      // Длинная опция («Подписка SOHO Edition $12/день», ITGAME-137) не влезает
      // в кнопку 226px — шрифт ужимается до 11px, а не вылезает за кнопку.
      for (let fs = 12; fs >= 11 && txt.width > w - 12; fs--) txt.setFontSize(fs)
      bg.on('pointerdown', () => client.send('event_choice', 0, { slot: i }))
      bg.on('pointerover', () => bg.setFillStyle(0x41a6f6))
      bg.on('pointerout', () => bg.setFillStyle(0x3b5dc9))
      this.eventUI.push(bg, txt)
    })
    // ITGAME-97: рамки ?debug=1 кнопок (41.5) живут в eventUI — closeEvent() сносит их вместе с карточкой.
    this.eventUI.push(...drawDebugFrames(this, this.eventUI))
  }

  private closeEvent() {
    this.eventUI.forEach((o) => o.destroy())
    this.eventUI = []
  }

  // Плашка обречённой партии (ITGAME-118): сервер шлёт state.bankruptInDays > 0, когда
  // баланс в минусе (кредит или овердрафт, ITGAME-156; ни купить, ни уволить), а доход не
  // покрывает расходы до порога. Встаёт раз в день — с первым снапшотом дня, — висит до «×» или «Сдаться»;
  // отчёт дня, финал и сброс партии её снимают. Не модальная: игра идёт. Стоит над журналом,
  // а не сверху — там панель события; нижние тосты поднимаются над ней (layoutToasts).
  private updateDoom(s: StateMessage) {
    const n = s.phase === 'running' ? s.bankruptInDays : 0
    if (n <= 0) {
      this.closeDoom()
      return
    }
    if (s.day !== this.doomDay) {
      this.doomDay = s.day
      this.logLine(doomLine(n))
      this.showDoom(n)
    } else if (this.doomUI.length > 0 && n !== this.doomN) {
      this.showDoom(n)
    }
  }

  private showDoom(n: number) {
    this.closeDoom()
    this.doomN = n
    const y = DOOM_BOTTOM - DOOM_H / 2
    const text = tag(
      this.add.text(0, y, doomLine(n), { fontFamily: FONT, fontSize: '16px', color: '#f4f4f4' })
        .setOrigin(0, 0.5).setDepth(46),
      'hud.doom.text',
    )
    const w = DOOM_PAD + text.width + DOOM_GAP + DOOM_BTN_W + 8 + DOOM_H - 12 + DOOM_PAD
    const left = CX - w / 2
    text.setX(left + DOOM_PAD)
    const panel = markTitle(
      tag(this.add.rectangle(CX, y, w, DOOM_H, 0x14162b).setStrokeStyle(2, 0xb13e53).setDepth(45), 'hud.doom'),
      'До банкротства',
    )
    const sx = left + DOOM_PAD + text.width + DOOM_GAP + DOOM_BTN_W / 2
    const surrender = tag(
      this.add.rectangle(sx, y, DOOM_BTN_W, DOOM_H - 12, 0xb13e53).setDepth(46).setInteractive({ useHandCursor: true }),
      'hud.doom.surrender',
    )
    const surrenderLabel = this.add
      .text(sx, y, 'Сдаться', { fontFamily: FONT, fontSize: '14px', color: '#f4f4f4' })
      .setOrigin(0.5).setDepth(47)
    const cx = sx + DOOM_BTN_W / 2 + 8 + (DOOM_H - 12) / 2
    const close = tag(
      this.add.rectangle(cx, y, DOOM_H - 12, DOOM_H - 12, 0x333c57).setDepth(46).setInteractive({ useHandCursor: true }),
      'hud.doom.close',
    )
    const closeLabel = this.add
      .text(cx, y, '✕', { fontFamily: FONT, fontSize: '14px', color: '#f4f4f4' })
      .setOrigin(0.5).setDepth(47)
    surrender.on('pointerover', () => surrender.setFillStyle(0xef7d57))
    surrender.on('pointerout', () => surrender.setFillStyle(0xb13e53))
    surrender.on('pointerdown', () => this.doomSurrender())
    close.on('pointerover', () => close.setFillStyle(0x566c86))
    close.on('pointerout', () => close.setFillStyle(0x333c57))
    close.on('pointerdown', () => this.closeDoom())
    this.doomUI = [panel, text, surrender, surrenderLabel, close, closeLabel]
    this.doomUI.push(...drawDebugFrames(this, this.doomUI))
    this.layoutToasts('bottom')
  }

  private closeDoom() {
    if (this.doomUI.length === 0) return
    this.doomUI.forEach((o) => o.destroy())
    this.doomUI = []
    this.doomN = 0
    this.layoutToasts('bottom')
  }

  // «Сдаться» с плашки — тот же путь, что ⌂ → «Сдаться (удалить сейв)»: подтверждение
  // «Удалить партию навсегда?» на паузе; «Отмена» возвращает скорость, плашка остаётся.
  private doomSurrender() {
    this.hideButtonTooltip()
    if (this.exitModalClose) return
    this.pauseForExitDialog()
    this.confirmSurrender()
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
  // Строка в журнал событий: время игры + текст в одну строку, последние LOG_LINES.
  // clock — своё время строки (событие дня из журнала сервера), иначе — текущее.
  private logLine(text: string, clock = client.latest?.clock ?? '--:--') {
    // Эмодзи в журнал не берём: системный шрифт широкий и машинозависимый (страховка —
    // с ITGAME-83 в строках клиента эмодзи нет, это держит check:emoji).
    // 76 знаков по 12 px — не шире полосы (730 px), строка не вылезает за x 1270.
    const one = text.replace(/[\u{1F000}-\u{1FFFF}\uFE0F]/gu, '').replace(/\s+/g, ' ').trim()
    const body = one.length > 76 ? one.slice(0, 76) + '…' : one
    this.logLines.push(`${clock} ${body}`)
    if (this.logLines.length > LOG_LINES) this.logLines = this.logLines.slice(-LOG_LINES)
    this.logText.setText(this.logLines.join('\n'))
  }

  // Строки журнала дня сервера, которых лента ещё не видела (ITGAME-163).
  private putDayLog(key: string, log: string[]) {
    const { cursor, lines } = takeDayLog(this.logDay, key, log)
    this.logDay = cursor
    for (const l of lines) this.logLine(l.text, l.clock ?? undefined)
  }

  private toast(text: string, ms = 1500, opts?: { top?: boolean; bg?: string; icon?: string }) {
    const where: 'top' | 'bottom' = opts?.top ? 'top' : 'bottom'
    const bg = opts?.bg ?? '#b13e53'
    emitUi({ type: 'toast', text, where, ms, bg, scene: this.scene.key, ...(opts?.icon ? { icon: opts.icon } : {}) })
    this.logLine(text)
    const startY = where === 'top' ? 175 : 614 - 20 // косметика до первой layoutToasts()
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
    // ITGAME-83: спрайт слева от текста внутри плашки тоста (24px при кегле 18)
    if (opts?.icon) attachIcon(t, opts.icon, { px: 24, gap: 8 })
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
    // Нижний якорь — над журналом событий (полоса с y 620, ITGAME-21); стоит плашка
    // «До банкротства» (ITGAME-118) — над ней.
    let edge = where === 'top' ? 158 : this.doomUI.length > 0 ? DOOM_BOTTOM - DOOM_H - 6 : 614
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
        id: 'virus', when: s.offices.some((o) => o.virusPCs > 0),
        text: 'Вирус: −30% места, раз в 3 часа заражает ещё. Чистка — 3 клика по столу',
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
    // Пока плашка показывает шаг, остальные хинты ждут: хинт router дублировал бы шаг 3, а
    // хинты 11:00/12:00/15:00 засыпали бы новичка на шаге 1. master/virus/softlock предупреждают о
    // сломанной, заражённой или тупиковой партии — они срабатывают всегда.
    const held = this.coachStep !== null
    const urgent = ['master', 'virus', 'softlock']
    const hint = hints.find((h) =>
      h.when && (!held || urgent.includes(h.id)) && !localStore.get('itd.hint:' + h.id))
    if (hint) {
      localStore.set('itd.hint:' + hint.id, '1')
      this.toast(hint.text, 2200)
    }
  }

  private onDayReport(r: DayReportMessage) {
    playSfx(this, r.profit >= 0 ? 'bong' : 'drop')
    if (this.skipReports) {
      client.send('next_day')
      // Без окна отчёта строки дня, которых лента не видела, всё равно ложатся (ITGAME-163).
      this.putDayLog(`${client.latest?.seed ?? ''}:${r.day}`, r.events)
      const toastBg = r.profit > 0 ? '#257179' : r.profit === 0 ? '#333c57' : '#b13e53'
      this.toast(
        `День ${r.day}: прибыль ${fmtMoney(r.profit)} · баланс ${fmtMoney(r.balance)}`,
        2500,
        { top: true, bg: toastBg },
      )
      return
    }
    // Журнал событий: итог дня последним (в ветке skipReports итог кладёт тост). Строки
    // журнала сервера лента уже взяла из снапшотов вживую (ITGAME-163), отчёт докладывает
    // только те, что она не видела, — со своим «HH:MM» (ITGAME-150). Пересланный отчёт
    // того же дня (переподключение в фазе day_report) итог второй раз не кладёт.
    const reportKey = `${client.latest?.seed ?? ''}:${r.day}`
    if (this.logReport !== reportKey) {
      this.logReport = reportKey
      this.putDayLog(reportKey, r.events)
      this.logLine(`День ${r.day}: прибыль ${fmtMoney(r.profit)} · баланс ${fmtMoney(r.balance)}`)
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
    const head = [
      `Доход:     ${fmtMoney(r.income)}`,
      // Без штата зарплата $0 — без минуса, «−$0» читается как ошибка (ITGAME-147).
      `Зарплата: ${r.payroll > 0 ? '−' : ' '}${fmtMoney(r.payroll)}`,
      ...(r.gatewayOpex > 0 ? [`Интернет: −${fmtMoney(r.gatewayOpex)}`] : []),
      // Подписка на антивирус — опекс, как шлюз (ITGAME-137).
      ...(r.antivirus > 0 ? [`Антивирус: −${fmtMoney(r.antivirus)}`] : []),
      // Деньги исходов событий входят в прибыль (ITGAME-53); расшифровка —
      // в журнале ниже.
      ...(r.eventMoney ? [`События:  ${r.eventMoney > 0 ? '+' : ''}${fmtMoney(r.eventMoney)}`] : []),
      `Прибыль:   ${fmtMoney(r.profit)}`,
      `Баланс:    ${fmtMoney(r.balance)}`,
      ...(r.incidents > 0 ? [`Поломки:   ${r.incidents} (−${fmtMoney(r.lostIncome)})`] : []),
      // Вирус (ITGAME-103): новых заражений за день и упущенное из-за −30%. «+k за день» —
      // не путать со строкой журнала «к вечеру заражено m ПК», где и вчерашние (ITGAME-146). Без новых
      // заражений, но с убытком — «новых нет (−$X)», не «+0» (ITGAME-180).
      ...virusReportLines(r.virusPCs, r.virusLost),
      // Админы (ITGAME-101): что починили и вычистили за день — глаголом; обе части — двумя
      // строками, одной в панель 440 не входят (ITGAME-159).
      ...adminsReportLines(r.adminRepairs, r.adminCleaned),
    ]

    // Подложка interactive: глушит клики по кнопкам HUD под модалкой (depth 50).
    const overlay = markDim(this.add.rectangle(0, 0, GAME_W, GAME_H, 0x1a1c2c, 0.75).setOrigin(0).setDepth(50).setInteractive(), `День ${r.day} завершён`)
    // Плашка модала (depth 51) создаётся ДО текстов и кнопок (depth 52..53),
    // чтобы display list и depth гарантированно держали фон ПОЗАДИ контента.
    const panel = this.add.rectangle(CX, 300, 440, 320, 0x14162b).setStrokeStyle(2, 0x41a6f6).setDepth(51)

    const title = this.add
      .text(CX, 0, `День ${r.day} завершён`, { fontFamily: FONT, fontSize: '22px', color: '#ffcd75' })
      .setOrigin(0.5, 0).setDepth(52)
    const bodyText = this.add
      .text(CX, 0, head.join('\n'), { fontFamily: FONT, fontSize: '16px', color: '#f4f4f4', lineSpacing: 8 })
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
    const panelW = 440

    // Журнал событий (ITGAME-141): строки сервера бывают шире панели («вирус: к вечеру заражено
    // k ПК — само не пройдёт»), поэтому каждая переносится по ширине панели с висячим отступом
    // под «·» (шрифт моноширинный — «  » шириной с «· »). Не влезает по высоте — ранние события
    // уступают место строке «… раньше: ещё k»: вечерние итоги важнее утренних.
    const events = (r.events ?? []).map((e) =>
      wrapHanging(`· ${e}`, panelW - REPORT_PAD_X * 2, (s) => bodyText.context.measureText(s).width, '  '))
    const compose = (skip: number) => [
      ...head,
      ...(events.length ? ['', 'Журнал событий:', ...(skip ? [`· … раньше: ещё ${skip}`] : []), ...events.slice(skip).flat()] : []),
    ].join('\n')
    const maxBodyH = GAME_H - REPORT_MARGIN_Y * 2 - padY * 2 - title.height - gapTitle - gapBody - checkbox.height - gapCheck - btnH
    let skip = 0
    bodyText.setText(compose(skip))
    while (bodyText.height > maxBodyH && skip < events.length) bodyText.setText(compose(++skip))

    const contentH = title.height + gapTitle + bodyText.height + gapBody + checkbox.height + gapCheck + btnH
    const panelH = padY * 2 + contentH
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
      ...bankruptLines(o.balance, o.shortfall ?? 0),
    ]
    lines.push(`Всего достижений: ${unlockedCount}/${totalCount}`)
    const trophy = newAchievements.length > 0
      ? `Новое достижение: ${newAchievements.map((a) => a.title).join(', ')}`
      : null

    const body = this.bodyWithTrophy(290, lines, trophy, { fontFamily: FONT, fontSize: '15px', color: '#f4f4f4', lineSpacing: 6, align: 'center' }, 61)
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
    this.gameOverUI = [overlay, title, ...body, btnBg, btnText]
    this.gameOverUI.push(...drawDebugFrames(this, this.gameOverUI))
  }

  // ITGAME-83: блок строк и строка достижения под ним — спрайт кубка в строку Text не
  // встаёт, поэтому строка достижения — свой Text с attachIcon. Пара центрирована по y там
  // же, где стоял прежний единый блок (origin 0.5), зазор между ними — lineSpacing.
  private bodyWithTrophy(
    y: number,
    lines: string[],
    trophy: string | null,
    style: Phaser.Types.GameObjects.Text.TextStyle,
    depth: number,
  ): Phaser.GameObjects.Text[] {
    const body = this.add.text(CX, y, lines.join('\n'), style).setOrigin(0.5, 0).setDepth(depth)
    if (!trophy) {
      body.setY(Math.round(y - body.height / 2))
      return [body]
    }
    const gap = Number(style.lineSpacing ?? 0)
    const ach = this.add.text(CX, y, trophy, style).setOrigin(0.5, 0).setDepth(depth)
    attachIcon(ach, 'icon_trophy', { px: 16 })
    const top = Math.round(y - (body.height + gap + ach.height) / 2)
    body.setY(top)
    ach.setY(top + body.height + gap)
    return [body, ach]
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
      lines.push('★ Новый рекорд баланса!') // ★ — глиф Departure Mono, не эмодзи (ITGAME-83)
    }
    lines.push(`Всего достижений: ${unlockedCount}/${totalCount}`)
    const trophy = newAchievements.length > 0
      ? `Новое достижение: ${newAchievements.map((a) => a.title).join(', ')}`
      : null

    const body = this.bodyWithTrophy(290, lines, trophy, { fontFamily: FONT, fontSize: '15px', color: '#f4f4f4', lineSpacing: 6, align: 'center' }, 61)
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
    this.victoryUI = [overlay, title, ...body, btnBg, btnText]
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
    this.scene.stop('adminDept')
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
    this.closeDoom()
    this.doomDay = 0 // новая партия того же дня покажет плашку заново
    this.incompatibleClose?.()
    this.incompatibleClose = null
    this.exitModalClose?.()
    this.exitModalClose = null
    this.exitModalKind = null
    this.exitWaitResume = null
    this.exitPauseFrom = 0 // новая партия остаётся на паузе, set_speed отсюда не шлём
    this.offlinePauseFrom = 0
    this.speedBeforeReport = null
    this.reportPauseSeq = 0
    this.lastEventId = ''
    this.logPrev = null
    this.logLines = []
    this.logReport = ''
    this.logDay = { key: '', shown: 0 }
    this.logText.setText('')
    this.hideCoach()
  }

  // Живая вкладка вернулась к сейву другого формата (ITGAME-174): сервер начал новую партию под
  // тем же sid — игрок должен об этом узнать, а не обнаружить день 1 и $600. Заголовок и строка —
  // одна фраза владельца (перенос после «—», как в карточке меню); темп не трогаем.
  private showIncompatibleNotice() {
    this.hideButtonTooltip()
    this.incompatibleClose?.()
    const done = () => { this.incompatibleClose = null }
    const close = showModal(this, 'Сейв несовместим с новой версией —', ['начата новая партия'], [
      { label: 'ОК', id: 'modal.incompatible.ok', focus: true, onClick: done },
    ], undefined, done)
    this.incompatibleClose = () => { close(); done() }
  }

  // Выход в меню с сейвами (ITGAME-8): выход сохраняет прогресс, сдаться —
  // осознанное удаление сейва. Случайный клик по ⌂ не должен стоить партию.
  private confirmExitToMenu() {
    this.hideButtonTooltip()
    if (this.exitModalClose) return // уже открыт (itd.click мимо подложки)
    this.pauseForExitDialog()
    this.openExitModal('exit', 'Выйти в меню?', ['Прогресс сохранится — продолжите', 'с главного меню в любое время.'], [
      { label: 'Сохранить и выйти', onClick: () => this.saveAndExit() },
      { label: 'Сдаться (удалить сейв)', onClick: () => this.confirmSurrender() },
      { label: 'Отмена', onClick: () => { this.cancelExit() } },
    ])
  }

  // ITGAME-65: пока диалог выхода открыт, партия на паузе (⌂ и «Сдаться» с плашки
  // ITGAME-118). Пауза отчёта главнее: её set_speed 0 уже стоит, лишний сломал бы
  // reportPauseSeq. Без связи паузу не шлём (ITGAME-90: тост «нет связи» тут лишний).
  private pauseForExitDialog() {
    this.exitPauseFrom = 0
    const live = client.latest?.speed ?? 0
    if (this.speedBeforeReport === null && live > 0 && client.socketStatus() === 'open' &&
      client.send('set_speed', 0, { speed: 0 })) {
      this.exitPauseFrom = live
      this.exitPauseSeq = client.speedSeq
    }
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
    const resume = this.exitResume()
    if (this.trySendExit(resume)) return
    // Пауза диалога (если ушла до обрыва) остаётся за cancelExit: «Отмена» вернёт скорость.
    this.openExitModal('nolink', 'Нет связи — сохранение не дойдёт', [
      'Сервер не узнает о выходе: партия', 'продолжит идти без вас до возврата.',
    ], [
      { label: 'Подождать', onClick: () => this.waitAndExit(resume) },
      { label: 'Выйти без сохранения', onClick: () => this.exitUnsaved() },
    ])
  }

  // Скорость, на которой «Продолжить» вернёт партию: до отчёта дня, до паузы окна выхода или текущая.
  private exitResume(): number {
    const ours = this.exitPauseFrom > 0 && client.speedSeq === this.exitPauseSeq
    return this.speedBeforeReport ?? (ours ? this.exitPauseFrom : (client.latest?.speed ?? 0))
  }

  // itd.exit() (ITGAME-166): «Сохранить и выйти» одним вызовом — тот же exit и уход в меню, открытое
  // окно выхода закрывается. Без связи — false, ничего не тронуто: окно «Нет связи» — выбор игрока,
  // агенту — отказ not_connected.
  exitSaved(): boolean {
    return this.trySendExit(this.exitResume())
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
