import Phaser from 'phaser'
import { fmtMoney } from '../format'
import { GAME_H, GAME_W, HUD_H, NAV_W } from '../layout'
import { client } from '../net'
import { nav } from '../rooms'
import type { CommandType, EmployeeInfo, OfficeInfo, StateMessage } from '../protocol'
import { drawDebugFrames } from '../debug'
import { markDisabled, tag } from '../debug/agentApi'
import { partyModals, type ModalButton } from '../ui/modal'
import { ACTION_COL_CX, ActionBar, actionColY, type ActionButton } from '../ui/actionButton'
import { coreFree, routerGain } from '../network-preview'
import { playSfx } from '../audio'
import { addSprite } from '../pixelart'
import { SPRITES } from '../assets/manifest'
import { FONT, HIRES_CAMERA } from '../render'

// cols — зеркало Config.OfficeCols сервера: по этой сетке вирус ищет соседей
// места (ITGAME-103); TestOfficeColsMirrorsClientGrid сверяет их.
const GRID = { cols: 4, startX: 260, startY: 220, stepX: 270, stepY: 170 }
// ITGAME-92: у занятого рабочего места ОДНА зона клика office.slot.i —
// прямоугольник объединения bounds сотрудника и стола, а пока ПК сломан или
// заражён — ещё и метки «✖ чинить k/N» / «☣ вирус k/3» над ними (ITGAME-75:
// клик «по значку поломки» — это клик по месту). У места одно состояние за
// раз (ITGAME-103): сломан > заражён > в порядке — сломанное заражённое
// показывает поломку, после ремонта место снова заражено. ЛКМ выбирает
// действие по состоянию: repair_click, virus_click, иначе motivate; ПКМ
// («Уволить сотрудника?») и тултип общие. Пока место сломано, зона мигает
// красным, заражено — зелёным (подсветка = кликабельная область, владелец
// 10.10); у здорового места заливка прозрачная (fillAlpha 0, alpha 1 —
// иначе Phaser не считает объект целью ввода). Спрайт сотрудника и метки —
// картинки без ввода; их id office.worker.i, office.repair.i и
// office.virus.i оставлены для itd.click/itd.hover и узлов itd.nodes():
// события с них переадресуются зоне. Явный depth — над столом и
// сотрудником при любом порядке create().
// Рабочее место (ITGAME-135): у каждого стола с живым ПК — подпись уровня
// office.pc.i («ЭЛТ» / «ЖК» / «2×ЖК»); клик по ней открывает окно места, а
// наведение и правый клик она отдаёт зоне. ПК «требуется замена» — серый
// desk_pc_broken, метка office.dead.i «✖ замена» и кнопка office.replace.i;
// ЛКМ по такому месту открывает то же окно (чинить и мотивировать нечего).
const SLOT_ZONE_DEPTH = 5

// Цвета состояния места: поломка — красный, вирус — зелёный (sweetie16).
const BROKEN_COLOR = 0xb13e53
const VIRUS_COLOR = 0xa7f070
// ПК «требуется замена» (ITGAME-135): заливка мигающей зоны и тон стола — серые.
const DEAD_COLOR = 0x94b0c2
const DEAD_TINT = 0x5d7275
// Подпись уровня ПК: цвет по уровню; оранжевый — износ на пределе, следующая поломка убьёт ПК.
const PC_LEVEL_COLORS = ['#94b0c2', '#41a6f6', '#38b764']
const PC_WORN_COLOR = '#ef7d57'

// Верх колонки действий офиса (ITGAME-94): под слотом начальника (бокс до y 362).
const ACTIONS_TOP = 384

// Тултип — поверх сцены, но под окнами (подложка модалки — depth 70).
const TOOLTIP_DEPTH = 40

// Метки причин отсутствия сети над столом (итерация 11).
const OFFLINE_LABELS: Record<string, string> = {
  no_router: '✗ роутер',
  no_core: '✗ core',
  no_server: 'без стойки',
}

// Прибавка выработки за уровень, $/тик — зеркало EmployeeLevelBonus
// конфига (только для строки тултипа; сервер считает сам).
const LEVEL_BONUS: Record<number, number> = { 1: 1, 2: 2, 3: 2 }

// Геометрия оверлеев/бейджей рабочего места относительно центра (x,y)
// слота. Два варианта — под HD 128px спрайты (desk_pc + worker поверх,
// контент прижат к низу кадра) и под легаси 64px worker.png (стол/кресло
// запечены в сам спрайт, контент занимает почти весь кадр). Раньше была
// одна раскладка под старый «залитый» квадрат 64×64 — на HD-спрайтах она
// вешала бейджи в воздухе над пустой верхней частью кадра.
//
// HD-числа — bbox непрозрачных пикселей в мировых px, world = (px−64)/2
// (см. client/scripts/qa-office-slots.mjs; проверено pngjs по самим PNG):
//   desk_pc.png (128×128): x −25..+25, y −16..+32 — столешница+монитор+системник
//   worker.png  (128×128): x  −9..+13, y  −3..+30 — сотрудник+кресло поверх стола
// Верх монитора ≈ y −14; правый верхний угол столешницы ≈ (+25, 0);
// левый угол столешницы ≈ (−24, +5).
//
// ВАЖНО (регрессия itd.overlaps(), см. client/src/debug/lint.ts): хитбокс
// office.worker.i — это ВЕСЬ отмасштабированный кадр спрайта (addSprite
// тянет 128px-текстуру к SPRITE_TARGET.person=64px), а не тесный alpha-bbox
// артворка выше — т.е. интерактивный/лейаут-бокс сотрудника это ПОЛНЫЙ
// квадрат x −32..+32, y −32..+32 от центра слота. Линтер (findInteractiveOverlaps)
// считает находкой только ЧАСТИЧНОЕ пересечение интерактива/текста с другим
// интерактивом или текстом — полная вложенность (insideRect) в порядке
// вещей. А вот для пары «текст-текст» одного depth (findOverlaps, кейс
// kind:'text') исключения для вложенности НЕТ ВООБЩЕ — там нельзя
// пересекаться даже частично. Поэтому каждый элемент ниже держим либо
// ЦЕЛИКОМ внутри бокса сотрудника (±32 по обеим осям), либо ЦЕЛИКОМ
// снаружи — без «почти» с одной стороны на пару-тройку px.
// Реальные ширины (Phaser Text.getBounds(), шрифт FONT — Departure Mono +
// ITD Symbols, ITGAME-48; см. client/scripts/qa-office-slots.mjs-style замер):
// OFFLINE_LABELS при 9px — «✗ роутер» 45px, «✗ core» 34px, «без стойки» 58px
// (самая длинная); «✖ чинить k/N» при 11px — 88×14px при N ≤ 9 и до 102×14px
// при N 10..15 (ITGAME-93: «0/15» 95px, «10/15» 102px); «☣ вирус k/3» —
// та же строка (repairText), уже «✖ чинить» на символ. Самая широкая теперь
// неначатая метка «✖ чинить · 1 очко» (ITGAME-127): ≈17 глифов × ~7.2px ≈ 123px.
const SLOT_LAYOUT_HD = {
  // У правого верхнего угла стола, ниже и левее монитора. Кружок 8px —
  // не текст и не интерактив, линтер его не видит; важно лишь не вылезти
  // из кадра (visual only).
  networkDot: { x: 24, y: -8 },
  // Щит подписки на антивирус (ITGAME-137) — под точкой сети, у правого края
  // стола; фигура 8×9, не текст и не интерактив, целиком внутри бокса.
  shield: { x: 24, y: 6 },
  // ЦЕЛИКОМ ВНУТРИ бокса сотрудника, над монитором (монитор начинается с
  // y −14, низ метки на y −19 — запас 5px). Самая широкая метка «без
  // стойки» — 58px, т.е. ±29 от центра: центрируем по x (не по
  // networkDot/правому краю, как раньше) — на x+24 «без стойки» вылезала
  // бы до x+53, далеко за край бокса (x+32). При x=0 запас ±3px до
  // краёв бокса на самой длинной метке; шрифт свой (ITGAME-48), между
  // машинами ширина не плывёт.
  offlineLabel: { x: 0, y: -24 },
  // У левого края столешницы — маленький кружок, целиком внутри бокса.
  motivationBadge: { x: -24, y: -6 },
  // Над бейджем мотивации — текст «★» (9×17px), целиком внутри бокса.
  star: { x: -24, y: -20 },
  // Зоны клика в раскладке нет (ITGAME-75/92): она — объединение bounds
  // сотрудника, стола и (при поломке) метки ниже, считается в render().
  // ЦЕЛИКОМ СНАРУЖИ бокса сотрудника (сверху): «✖ чинить · 1 очко» шириной
  // ≈123px (k/N — 88–102px) при 11px в бокс ±32 не поместится ни при каком
  // центрировании; зона колонки 3 доходит до x ≈ 1132, колонка действий — с
  // 1142, запас ~10px —
  // выносим целиком за верхний край. Высота строки 14px (±7): при
  // y=−42 нижний край −35, что выше верхнего края бокса (−32) на 3px
  // запаса — не частичное пересечение, а полное разделение.
  repairText: { y: -42 },
  // Целиком снаружи бокса снизу (кнопка 22px высотой → y+35..y+57,
  // бокс кончается на y+32) — соседних слотов/подписей не задевает:
  // ближайшие ряды разнесены на GRID.stepY=170px.
  masterButton: { y: 46 },
  // Подпись уровня ПК (ITGAME-135): ЦЕЛИКОМ ВНУТРИ бокса ±32 — «2×ЖК» при 9px ≈ 24px, с
  // подложкой (padding 2/1) ≈ 28×13 → x ±14, y +15..+29; у нижнего края под креслом других
  // текстов нет; «обед» (y+40, 12px) начинается ниже +32.
  pcLabel: { x: 0, y: 22 },
}

// Легаси (includesDesk=true): старый 64px worker.png уже содержит
// стол/кресло/монитор, контент занимает почти весь кадр 64×64 — раскладка
// держится у углов квадрата ±32. Числа не менялись — сохраняем прежний
// вид на случай отката на старые PNG.
const SLOT_LAYOUT_LEGACY = {
  networkDot: { x: 30, y: -30 },
  shield: { x: 30, y: -16 },
  offlineLabel: { x: 30, y: -44 },
  motivationBadge: { x: -28, y: -36 },
  star: { x: -28, y: -58 },
  repairText: { y: -48 },
  masterButton: { y: 46 },
  pcLabel: { x: 0, y: 22 },
}

export class OfficeScene extends Phaser.Scene {
  private objects!: Phaser.GameObjects.GameObject[]
  private tooltip!: Phaser.GameObjects.Container
  private tooltipText!: Phaser.GameObjects.Text
  private tooltipBg!: Phaser.GameObjects.Rectangle
  // Слот под курсором: перерисовка идёт каждую секунду, и без этого
  // тултип гас бы на каждом снапшоте.
  private hoveredSlot!: number
  // Окна устройств/увольнения: закрываются при смене партии (ITGAME-69).
  private modal!: ReturnType<typeof partyModals>
  // Колонка действий офиса (ITGAME-94): «Купить ПК», «Нанять», «Начальник» —
  // переехали сюда из шапки HUD, шлют команду в активный офис.
  private actions!: ActionBar
  private pcBtn!: ActionButton
  private hireBtn!: ActionButton
  private bossBtn!: ActionButton

  constructor() {
    super({ key: 'office', cameras: HIRES_CAMERA })
  }

  create() {
    // сцены перезапускаются при переключении комнат — сбрасываем ссылки прошлого цикла
    this.objects = []
    this.hoveredSlot = -1
    // ITGAME-89: любое окно сцены (роутер, увольнение) прячет тултип и
    // забывает слот под курсором — иначе следующий снапшот (render) снова
    // показывал тултип рядом с окном: pointerout под подложкой окна не
    // приходит, а itd.hover/itd.click его не шлют вовсе.
    const openModal = partyModals(this)
    this.modal = (...args) => {
      this.hoveredSlot = -1
      this.hideTooltip()
      this.actions.hideTooltip()
      return openModal(...args)
    }
    // Правый клик по сотруднику — увольнение: контекстное меню браузера мешает.
    this.input.mouse?.disableContextMenu()
    this.add.rectangle(NAV_W, HUD_H, GAME_W - NAV_W, GAME_H - HUD_H, 0x2b2f4a).setOrigin(0) // пол офиса

    // Один переиспользуемый тултип поверх всего; наполняется при наведении.
    this.tooltipText = this.add.text(10, 8, '', {
      fontFamily: FONT, fontSize: '13px', color: '#f4f4f4', lineSpacing: 6,
    })
    this.tooltipBg = this.add.rectangle(0, 0, 10, 10, 0x14162b, 0.95).setOrigin(0).setStrokeStyle(1, 0x41a6f6)
    this.tooltip = this.add.container(0, 0, [this.tooltipBg, this.tooltipText]).setDepth(TOOLTIP_DEPTH).setVisible(false)

    // Кнопки создаются один раз (до подписки — первый снапшот приходит сразу),
    // render() только обновляет подписи и доступность.
    this.actions = new ActionBar(this, { depth: TOOLTIP_DEPTH, blocked: () => this.windowOpen() })
    // Колонка — под слотами сети и начальника (бокс начальника кончается на y 362).
    this.pcBtn = this.actions.add(actionColY(ACTIONS_TOP, 0), 'btn.pc', () => {
      playSfx(this, 'select')
      client.send('buy_pc', nav.activeOffice)
    })
    this.hireBtn = this.actions.add(actionColY(ACTIONS_TOP, 1), 'btn.hire', () => {
      playSfx(this, 'select')
      client.send('hire', nav.activeOffice)
    })
    this.bossBtn = this.actions.add(actionColY(ACTIONS_TOP, 2), 'btn.boss', () => {
      playSfx(this, 'select')
      client.send('hire_boss', nav.activeOffice)
    })

    const unsub = client.subscribe({
      onState: (s) => this.render(s),
      onError: () => {},
      onDisconnect: () => {},
    })
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, unsub)
  }

  // Полная перерисовка на каждый снапшот: объектов мало, зато нет
  // рассинхрона между стейтом и картинкой.
  private render(s: StateMessage) {
    const office = s.offices[nav.activeOffice]
    this.hideTooltip() // спрайты пересоздаются — старая цель тултипа мертва
    this.objects.forEach((o) => {
      this.tweens.killTweensOf(o) // мигание поломок не должно переживать перерисовку
      o.destroy()
    })
    this.objects = []

    this.objects.push(
      this.add.text(GAME_W / 2, HUD_H + 20, `ОФИС ${nav.activeOffice + 1}`, {
        fontFamily: FONT, fontSize: '16px', color: '#5d7275',
      }).setOrigin(0.5),
    )

    // Вирус (ITGAME-103): заражённые места офиса и время следующей волны.
    if (office.virusPCs > 0) {
      const wave = s.virusWaveAt ? ` · волна в ${s.virusWaveAt}` : ''
      const plate = this.add.text(GAME_W / 2, HUD_H + 44, `☣ вирус: ${office.virusPCs} из ${office.employees.length} мест${wave}`, {
        fontFamily: FONT, fontSize: '13px', color: '#b13e53',
        backgroundColor: '#14162b', padding: { x: 8, y: 4 },
      }).setOrigin(0.5)
      this.objects.push(plate)
    }

    if (!office.unlocked) {
      this.objects.push(
        this.add.text(GAME_W / 2, 300, `Офис ${nav.activeOffice + 1} закрыт`, {
          fontFamily: FONT, fontSize: '24px', color: '#5d7275',
        }).setOrigin(0.5),
      )
      // Открывать офисы можно только по порядку — если предыдущий ещё
      // не куплен, кнопка неактивна и подсказывает, что делать сначала.
      const canBuy = !(nav.activeOffice > 0 && !s.offices[nav.activeOffice - 1].unlocked)
      const btn = tag(
        this.add.rectangle(GAME_W / 2 - 130, 360, 260, 40, 0x3b5dc9).setOrigin(0, 0),
        'office.buy',
      )
      if (canBuy) btn.setInteractive({ useHandCursor: true })
      const txt = this.add.text(GAME_W / 2, 380, canBuy ? `Купить офис — ${fmtMoney(office.price)}` : 'Сначала купите предыдущий', {
        fontFamily: FONT, fontSize: '14px', color: '#f4f4f4',
      }).setOrigin(0.5)
      if (canBuy) btn.on('pointerdown', () => {
        playSfx(this, 'select')
        client.send('buy_office', nav.activeOffice)
      })
      this.objects.push(btn, txt)
      // В закрытом офисе действовать не над чем — колонки нет, есть «Купить офис».
      this.refreshActions(s, office)
      this.objects.push(...drawDebugFrames(this, this.objects))
      return
    }
    this.refreshActions(s, office)

    // Специальный слот роутера: рабочее место сюда не поставить. Столбец
    // устройств офиса — по центру колонки действий (ITGAME-94).
    const rx = ACTION_COL_CX
    const ry = 170
    const routerZone = tag(
      this.add.rectangle(rx, ry, 84, 84, 0x232640)
        .setStrokeStyle(2, 0x5d7275).setInteractive({ useHandCursor: true }),
      'office.router',
    )
    routerZone.on('pointerdown', () => this.openRouterModal(office, s))
    this.objects.push(
      routerZone,
      this.add.text(rx, ry - 56, 'сеть', { fontFamily: FONT, fontSize: '12px', color: '#5d7275' }).setOrigin(0.5),
    )
    if (office.routerTier > 0) {
      const routerImg = addSprite(this, rx, ry, 'router', 'rack').setInteractive({ useHandCursor: true })
      routerImg.on('pointerdown', () => this.openRouterModal(office, s))
      this.objects.push(
        routerImg,
        // Две строки: одной строкой подпись шириной ~130px заезжала на
        // крайний стол ряда (линтер интерактивов ловит office.worker.3).
        this.add.text(rx, ry + 58, `роутер т${office.routerTier}\n${office.ports} порт.`, {
          fontFamily: FONT, fontSize: '11px', color: '#41a6f6', align: 'center',
        }).setOrigin(0.5),
      )
    } else {
      this.objects.push(
        this.add.text(rx, ry, 'нет\nроутера', {
          fontFamily: FONT, fontSize: '11px', color: '#5d7275', align: 'center',
        }).setOrigin(0.5),
      )
    }

    // Слот начальника — рядом со слотом роутера, но ниже.
    const bx = ACTION_COL_CX
    const by = 320
    this.objects.push(
      this.add.rectangle(bx, by, 84, 84, 0x232640).setStrokeStyle(2, 0x5d7275),
      this.add.text(bx, by - 56, 'начальник', { fontFamily: FONT, fontSize: '12px', color: '#5d7275' }).setOrigin(0.5),
    )
    if (office.boss !== '') {
      // Слот начальника раньше рисовал текстуру 'worker' — теперь свой
      // спрайт boss.png/boss_lunch.png (fallback на worker через
      // spriteKey, если оба вдруг не загрузятся); id office.boss не
      // меняем. На обеде — тот же начальник с кофе и сэндвичем
      // (boss_lunch), как и у сотрудников (s.isLunch, см. deskKey выше);
      // оба спрайта 128px/hd32 с одинаковым --bottom-margin в build-hd.sh —
      // ноги на одной строке, смены обед/работа не «прыгают».
      const bossKey = s.isLunch ? 'boss_lunch' : 'boss'
      const bossImg = tag(
        addSprite(this, bx, by, bossKey, 'person').setInteractive({ useHandCursor: true }),
        'office.boss',
      )
      bossImg.on('pointerover', () => this.showBossTooltip(office, s, bx, by))
      bossImg.on('pointerout', () => this.hideTooltip())
      this.objects.push(bossImg)
    } else {
      this.objects.push(this.add.text(bx, by, 'нет', { fontFamily: FONT, fontSize: '11px', color: '#5d7275' }).setOrigin(0.5))
    }

    // Рабочие места: первые pcs слотов — с ПК, дальше сотрудники из массива;
    // слоты за потолком штата закрыты, а слоты за 9 — до найма начальника.
    const cap = office.boss !== '' ? s.officeSlots : s.staffLimit
    for (let i = 0; i < s.officeSlots; i++) {
      const x = GRID.startX + (i % GRID.cols) * GRID.stepX
      const y = GRID.startY + Math.floor(i / GRID.cols) * GRID.stepY
      if (i >= cap) {
        this.objects.push(
          this.add.rectangle(x, y, 80, 64, 0x232640, 0.5).setStrokeStyle(2, 0x3a3f5c),
          this.add.text(x, y, 'наймите\nначальника', {
            fontFamily: FONT, fontSize: '10px', color: '#5d7275', align: 'center',
          }).setOrigin(0.5),
        )
        continue
      }
      const e = office.employees[i]
      const hasPc = i < office.pcs
      const w = hasPc ? office.workplaces?.[i] : undefined // рабочее место стола (ITGAME-135)
      const dead = !!w?.dead
      // includesDesk=true — старый 64px worker.png уже содержит свой
      // стол/монитор/системник/кресло (легаси-раскладка, живёт для отката
      // на старые PNG): занятое место рисует ТОЛЬКО его, без отдельного
      // desk_pc под ним (иначе два стола в разных ракурсах). includesDesk=
      // false — HD 128px worker без стола: слот всегда рисует отдельный
      // desk_pc/_off/_broken в (x,y), сотрудник — поверх него, В ТОЙ ЖЕ
      // точке (кресло на worker.png нарисовано так, что ложится ровно на
      // кресло desk_pc — выравнивание запечено в PNG, смещений не нужно).
      const workerIncludesDesk = SPRITES.worker?.includesDesk === true
      // Раскладка бейджей/оверлея под текущий вариант спрайтов слота —
      // см. SLOT_LAYOUT_HD/_LEGACY выше.
      const layout = workerIncludesDesk ? SLOT_LAYOUT_LEGACY : SLOT_LAYOUT_HD
      const showWorkerOnly = hasPc && !!e && !s.isLunch && workerIncludesDesk
      // Стол слота: без ПК — desk_empty; на обеде — desk_pc (экран горит,
      // кресло пустое — обед убирает только сотрудника, не стол), сломанный —
      // desk_pc_broken и на обеде (ITGAME-230); ПК куплен, но не нанят —
      // desk_pc_off; сотрудник на месте — desk_pc/_broken по e.pcBroken.
      // Легаси showWorkerOnly стол не рисует вовсе — он запечён в worker.png.
      let deskImg: Phaser.GameObjects.Image | null = null
      if (!showWorkerOnly) {
        const deskKey = !hasPc
          ? 'desk_empty'
          : dead
            ? 'desk_pc_broken' // «требуется замена» (ITGAME-135): серый стол поломки
            : e?.pcBroken
            ? 'desk_pc_broken'
            : s.isLunch
              ? 'desk_pc'
              : !e
                ? 'desk_pc_off'
                : 'desk_pc'
        deskImg = addSprite(this, x, y, deskKey, 'desk')
        if (dead) deskImg.setTint(DEAD_TINT)
        this.objects.push(deskImg)
      }
      // Сломанный ПК: доход места 0; клики по месту чинят, мастер чинит за деньги.
      // Зона места office.slot.i (при поломке мигает и накрывает метку)
      // строится ниже, когда известны bounds сотрудника.
      let repairLabel: Phaser.GameObjects.Text | null = null
      let virusLabel: Phaser.GameObjects.Text | null = null
      let deadLabel: Phaser.GameObjects.Text | null = null
      let repairBounds: Phaser.Geom.Rectangle | null = null
      if (dead) {
        // ПК «требуется замена» (ITGAME-135): доход 0, клики и мастер не чинят — только замена
        // за деньги. Кнопка и метка — на местах «мастера» и «✖ чинить» поломки.
        const replaceBg = tag(
          this.add.rectangle(x, y + layout.masterButton.y, 108, 22, 0x3b5dc9)
            .setOrigin(0.5).setInteractive({ useHandCursor: true }),
          `office.replace.${i}`,
        )
        const replaceTxt = this.add.text(x, y + layout.masterButton.y, `заменить ${fmtMoney(s.prices.pcReplace)}`, {
          fontFamily: FONT, fontSize: '10px', color: '#f4f4f4',
        }).setOrigin(0.5)
        replaceBg.on('pointerdown', () => {
          playSfx(this, 'select')
          client.send('replace_pc', nav.activeOffice, { slot: i })
        })
        deadLabel = this.add.text(x, y + layout.repairText.y, '✖ замена', {
          fontFamily: FONT, fontSize: '11px', color: '#94b0c2',
        }).setOrigin(0.5)
        repairBounds = deadLabel.getBounds()
        this.objects.push(deadLabel, replaceBg, replaceTxt)
        // Свободный стол: зоны места нет — метку не к чему переадресовать.
        if (!e) tag(deadLabel, `office.dead.${i}`)
      } else if (e?.pcBroken) {
        const masterBg = tag(
          this.add.rectangle(x, y + layout.masterButton.y, 108, 22, 0x3b5dc9)
            .setOrigin(0.5).setInteractive({ useHandCursor: true }),
          `office.master.${i}`,
        )
        const masterTxt = this.add.text(x, y + layout.masterButton.y, `мастер ${fmtMoney(s.prices.repair)}`, {
          fontFamily: FONT, fontSize: '10px', color: '#f4f4f4',
        }).setOrigin(0.5)
        masterBg.on('pointerdown', () => {
          playSfx(this, 'select')
          client.send('call_master', nav.activeOffice, { slot: i })
        })
        // ITGAME-93: N роллится при поломке (3..15); старый сервер без поля — 3.
        const need = e.repairNeeded > 0 ? e.repairNeeded : 3
        // Строка «✖ чинить · 1 очко» для зоны мерится ВСЕГДА, и когда ремонт уже
        // начат (метка тогда «k/N»), — зона и подсветка не прыгают после первого
        // клика. Зона берёт bounds самой широкой метки этой поломки («N/N»): между
        // «9/12» и «10/12» зона и подсветка не прыгают на знак.
        repairLabel = this.add.text(x, y + layout.repairText.y, `✖ чинить ${need}/${need}`, {
          fontFamily: FONT, fontSize: '11px', color: '#b13e53',
        }).setOrigin(0.5)
        // Не начатый ремонт стоит очко действий (ITGAME-127): метка называет цену,
        // после первого клика — «k/N». Зона — объединение bounds обеих меток.
        const repairIdle = '✖ чинить · 1 очко'
        repairBounds = repairLabel.getBounds()
        repairLabel.setText(repairIdle)
        repairBounds = Phaser.Geom.Rectangle.Union(repairBounds, repairLabel.getBounds())
        repairLabel.setText(e.repairClicks > 0 ? `✖ чинить ${e.repairClicks}/${need}` : repairIdle)
        this.objects.push(repairLabel, masterBg, masterTxt)
      } else if (e?.infected) {
        // Заражённое место (ITGAME-103): −30% выработки, три клика по месту
        // чистят. Метка — на месте метки поломки, bounds — по «3/3».
        const need = e.virusNeeded > 0 ? e.virusNeeded : 3
        virusLabel = this.add.text(x, y + layout.repairText.y, `☣ вирус ${need}/${need}`, {
          fontFamily: FONT, fontSize: '11px', color: '#a7f070',
        }).setOrigin(0.5)
        const virusIdle = '☣ вирус · 1 очко'
        repairBounds = virusLabel.getBounds()
        virusLabel.setText(virusIdle)
        repairBounds = Phaser.Geom.Rectangle.Union(repairBounds, virusLabel.getBounds())
        virusLabel.setText(e.virusClicks > 0 ? `☣ вирус ${e.virusClicks}/${need}` : virusIdle)
        this.objects.push(virusLabel)
      }
      let slotZone: Phaser.GameObjects.Rectangle | null = null
      if (e) {
        // Слот-картинка занятого места (id office.worker.i, без ввода):
        // на обеде — тот же стол desk_pc/_broken, что уже нарисован выше (без
        // второго стола: сотрудник отошёл, LUNCH_SHIFT убран — стол никуда
        // не двигается); иначе — сотрудник, в позиции стола (includesDesk,
        // легаси) либо поверх отдельного desk_pc в ТОЙ ЖЕ точке (HD).
        let wx: number
        let wy: number
        let slotImg: Phaser.GameObjects.Image
        if (s.isLunch) {
          wx = x
          wy = y
          // deskImg гарантированно создан выше: showWorkerOnly требует
          // !s.isLunch, значит на обеде всегда проходим ветку !showWorkerOnly.
          slotImg = deskImg as Phaser.GameObjects.Image
          // Мёртвое и сломанное место «обеда» не знают: подпись (y+40) легла бы на кнопку
          // «заменить» (ITGAME-135) или «мастер» (ITGAME-184) — обе на y+46.
          if (!dead && !e.pcBroken) {
            this.objects.push(this.add.text(x, y + 40, 'обед', {
              fontFamily: FONT, fontSize: '12px', color: '#94b0c2',
            }).setOrigin(0.5))
          }
        } else if (workerIncludesDesk) {
          wx = x
          wy = y
          slotImg = addSprite(this, wx, wy, 'worker', 'desk')
          if (dead) slotImg.setTint(DEAD_TINT) // легаси: стол запечён в спрайт сотрудника
        } else {
          wx = x
          wy = y
          const workerKey = e.level >= 1 && e.level <= 3 ? `worker_${e.level}` : 'worker'
          slotImg = addSprite(this, wx, wy, workerKey, 'person')
        }
        // Отпущен домой (ITGAME-198): место пустует до вечера — сотрудник
        // бледный; что случилось, говорит тултип («ушёл домой»).
        if (!s.isLunch && e.effects?.some((ef) => ef.token === 'away')) slotImg.setAlpha(0.35)
        // ITGAME-92: одна зона клика на рабочее место (см. SLOT_ZONE_DEPTH).
        // Картинка слота (worker или desk_pc на обеде) — без ввода, но с id
        // office.worker.i: itd.nodes() видит текстуру, а itd.click/itd.hover
        // по нему уходят в зону — так же, как настоящий клик в этой точке.
        tag(slotImg, `office.worker.${i}`)
        // На обеде slotImg === deskImg — тот стол уже в this.objects (пушился
        // при отрисовке стола выше); повторный push задвоил бы объект и
        // вызвал бы двойной destroy()/killTweensOf() на следующей перерисовке.
        if (slotImg !== deskImg) this.objects.push(slotImg)
        const r = Phaser.Geom.Rectangle.Union(slotImg.getBounds(), deskImg?.getBounds() ?? slotImg.getBounds())
        if (repairBounds) Phaser.Geom.Rectangle.Union(r, repairBounds, r)
        const zx = Math.floor(r.x)
        const zy = Math.floor(r.y)
        const flagged = e.pcBroken || e.infected || dead
        const zone = tag(
          this.add.rectangle(zx, zy, Math.ceil(r.right) - zx, Math.ceil(r.bottom) - zy,
            dead ? DEAD_COLOR : e.pcBroken ? BROKEN_COLOR : VIRUS_COLOR, flagged ? 0.3 : 0)
            .setOrigin(0).setInteractive({ useHandCursor: true }).setDepth(SLOT_ZONE_DEPTH),
          `office.slot.${i}`,
        )
        slotZone = zone
        this.objects.push(zone)
        if (flagged) {
          // Твин держит alpha ≥ 0.15 — при alpha 0 Phaser не считает объект
          // целью ввода (willRender).
          this.tweens.add({
            targets: zone, alpha: { from: 0.65, to: 0.15 }, duration: 420, yoyo: true, repeat: -1,
          })
        }
        // ЛКМ: ПК сломан → клик починки, заражён → клик чистки, иначе
        // мотивация (+25% на 3 часа с кулдауном). ПКМ — модалка увольнения
        // (итерация 15).
        zone.on('pointerdown', (p: Phaser.Input.Pointer) => {
          if (p.rightButtonDown()) {
            this.openFireModal(e, i, dead)
            return
          }
          if (dead) { // ПК «требуется замена»: чинить и мотивировать нечего — окно места
            playSfx(this, 'select')
            this.openWorkplaceModal(office, i, s)
            return
          }
          playSfx(this, 'click')
          client.send(e.pcBroken ? 'repair_click' : e.infected ? 'virus_click' : 'motivate', nav.activeOffice, { slot: i })
        })
        zone.on('pointerover', () => {
          if (this.windowOpen()) return // ITGAME-89: под окном тултипа нет
          this.hoveredSlot = i
          this.showTooltip(e, i, s, wx, wy)
        })
        zone.on('pointerout', () => {
          this.hoveredSlot = -1
          this.hideTooltip()
        })
        const forward = (alias: Phaser.GameObjects.GameObject) => {
          for (const ev of ['pointerdown', 'pointerover', 'pointerout']) {
            alias.on(ev, (...a: unknown[]) => zone.emit(ev, ...a))
          }
        }
        forward(slotImg)
        if (repairLabel) forward(tag(repairLabel, `office.repair.${i}`))
        if (virusLabel) forward(tag(virusLabel, `office.virus.${i}`))
        if (deadLabel) forward(tag(deadLabel, `office.dead.${i}`))
        // Спрайт пересоздан — восстанавливаем тултип, но только если курсор
        // реально над зоной: pointerout не срабатывает по уничтоженному
        // объекту, и без этой проверки hoveredSlot «залипает».
        if (this.hoveredSlot === i) {
          const p = this.input.activePointer
          if (zone.getBounds().contains(p.worldX, p.worldY) && !this.windowOpen()) {
            this.showTooltip(e, i, s, wx, wy)
          } else {
            this.hoveredSlot = -1
          }
        }
        if (e.connected && e.serverSlot > 0) {
          this.objects.push(this.add.circle(x + layout.networkDot.x, y + layout.networkDot.y, 4, 0x38b764))
        }
        // Щит: место под подпиской на антивирус — вирус сюда не сядет (ITGAME-137).
        if (e.avCovered) {
          this.objects.push(
            this.add.polygon(x + layout.shield.x, y + layout.shield.y, [0, 0, 8, 0, 8, 5, 4, 9, 0, 5], 0x41a6f6).setOrigin(0.5),
          )
        }
        // Видимость сети (итерация 11): метка-причина над проблемным
        // столом — точка 4px «почему я без бонуса» не объясняла.
        if (e.offlineReason) {
          const label = OFFLINE_LABELS[e.offlineReason] ?? e.offlineReason
          const color = e.offlineReason === 'no_server' ? '#5d7275' : '#b13e53'
          this.objects.push(this.add.text(x + layout.offlineLabel.x, y + layout.offlineLabel.y, label, {
            fontFamily: FONT, fontSize: '9px', color,
          }).setOrigin(0.5))
        }
        // Жёлтый значок-бейдж, пока действует мотивация кликом.
        if (e.effects.some((ef) => ef.token === 'motivated')) {
          this.objects.push(this.add.circle(x + layout.motivationBadge.x, y + layout.motivationBadge.y, 5, 0xffcd75))
        }
        // Золотая звезда найма-рулетки (и кандидата события) — ×1.5 базы.
        if (e.star) {
          this.objects.push(this.add.text(x + layout.star.x, y + layout.star.y, '★', {
            fontFamily: FONT, fontSize: '14px', color: '#ffcd75',
          }).setOrigin(0.5))
        }
      }
      // Подпись уровня ПК (ITGAME-135) — на каждом столе с живым ПК, и на свободном тоже:
      // апгрейд живёт на месте. Лежит над зоной (SLOT_ZONE_DEPTH + 1), чтобы получить свой
      // клик (окно места); наведение и правый клик отдаёт зоне — тултип сотрудника и
      // «Уволить» работают и над подписью. Целиком внутри бокса зоны (линтер: вложенность в порядке).
      if (hasPc && w && !dead) {
        const lvl = s.prices.pcLevels?.[w.level]
        const worn = s.pcWearLimit > 0 && w.wear >= s.pcWearLimit
        const pcLabel = tag(
          this.add.text(x + layout.pcLabel.x, y + layout.pcLabel.y, lvl?.name ?? 'ЭЛТ', {
            fontFamily: FONT, fontSize: '9px',
            color: worn ? PC_WORN_COLOR : PC_LEVEL_COLORS[w.level] ?? PC_LEVEL_COLORS[0],
            backgroundColor: '#14162b', padding: { x: 2, y: 1 },
          }).setOrigin(0.5).setDepth(SLOT_ZONE_DEPTH + 1).setInteractive({ useHandCursor: true }),
          `office.pc.${i}`,
        )
        pcLabel.on('pointerdown', (p: Phaser.Input.Pointer) => {
          if (p.rightButtonDown()) {
            slotZone?.emit('pointerdown', p) // занятое место — «Уволить», свободный стол — ничего
            return
          }
          playSfx(this, 'select')
          this.openWorkplaceModal(office, i, s)
        })
        if (slotZone) {
          const zone = slotZone
          pcLabel.on('pointerover', (...a: unknown[]) => zone.emit('pointerover', ...a))
          pcLabel.on('pointerout', (...a: unknown[]) => zone.emit('pointerout', ...a))
        }
        this.objects.push(pcLabel)
      }
    }

    // Полка быт-устройств: без них сотрудники ловят дебаффы. Кулер — первый:
    // холодильник и кофеварка до него закрыты (ITGAME-102, сервер — need_cooler).
    const amenities: { key: 'cooler' | 'fridge' | 'coffee_machine'; owned: boolean; price: number; cmd: CommandType; label: string; hint: string }[] = [
      { key: 'cooler', owned: office.cooler, price: s.prices.cooler, cmd: 'buy_cooler', label: 'кулер',
        hint: 'Без кулера: жажда −10% с 12:00' },
      { key: 'fridge', owned: office.fridge, price: s.prices.fridge, cmd: 'buy_fridge', label: 'холодильник',
        hint: 'Без холодильника: голод −10% после обеда' },
      { key: 'coffee_machine', owned: office.coffeeMachine, price: s.prices.coffeeMachine, cmd: 'buy_coffee', label: 'кофеварка',
        hint: 'Дважды в день 40% офиса: кофе +15% на час' },
    ]
    amenities.forEach((a, i) => {
      const ax = 220 + i * 130
      const ay = 660
      const locked = !a.owned && a.key !== 'cooler' && !office.cooler
      const box = this.add.rectangle(ax, ay, 72, 72, 0x232640, a.owned ? 1 : locked ? 0.25 : 0.5)
        .setStrokeStyle(2, a.owned ? 0x38b764 : 0x3a3f5c)
        .setInteractive({ useHandCursor: !a.owned && !locked })
      this.objects.push(box)
      if (a.owned) {
        const img = tag(
          addSprite(this, ax, ay, a.key, 'amenity').setInteractive({ useHandCursor: true }),
          `office.amenity.${a.key}`,
        )
        img.on('pointerover', () => this.showTextTooltip(`${a.label}\n${a.hint}`, ax, ay - 40))
        img.on('pointerout', () => this.hideTooltip())
        this.objects.push(img)
      } else if (locked) {
        markDisabled(tag(box, `office.amenity.${a.key}`), true)
        this.objects.push(this.add.text(ax, ay, `${a.label}\n${fmtMoney(a.price)}\nнужен кулер`, {
          fontFamily: FONT, fontSize: '10px', color: '#5d7275', align: 'center',
        }).setOrigin(0.5).setAlpha(0.6))
        box.on('pointerdown', () => playSfx(this, 'error'))
        box.on('pointerover', () => this.showTextTooltip(`${a.label}\nСначала купите кулер`, ax, ay - 40))
        box.on('pointerout', () => this.hideTooltip())
      } else {
        tag(box, `office.amenity.${a.key}`)
        this.objects.push(this.add.text(ax, ay, `${a.label}\n${fmtMoney(a.price)}`, {
          fontFamily: FONT, fontSize: '10px', color: '#5d7275', align: 'center',
        }).setOrigin(0.5))
        box.on('pointerdown', () => {
          playSfx(this, 'select')
          client.send(a.cmd, nav.activeOffice)
        })
      }
    })
    this.objects.push(...drawDebugFrames(this, [...this.objects, ...this.actions.interactive]))
  }

  // Доступность и подписи кнопок колонки (ITGAME-17, до ITGAME-94 — в HUDScene.refresh).
  private refreshActions(s: StateMessage, office: OfficeInfo) {
    const shown = office.unlocked
    for (const b of [this.pcBtn, this.hireBtn, this.bossBtn]) b.setShown(shown)
    if (!shown) return

    // 1. Покупка ПК
    const staffCap = office.boss !== '' ? s.officeSlots : s.staffLimit
    if (office.nextPC === 0 || office.pcs >= s.officeSlots) {
      this.pcBtn.setLabel('Купить ПК\nмест нет')
      this.pcBtn.setEnabled(false, 'В офисе нет свободных мест')
    } else if (office.pcs >= staffCap) {
      this.pcBtn.setLabel(`Купить ПК\n${fmtMoney(office.nextPC)}`)
      this.pcBtn.setEnabled(false, `Нужен начальник для расширения свыше ${s.staffLimit} мест`)
    } else if (s.money < office.nextPC) {
      this.pcBtn.setLabel(`Купить ПК\n${fmtMoney(office.nextPC)}`)
      this.pcBtn.setEnabled(false, `не хватает ${fmtMoney(office.nextPC - s.money)}`)
    } else {
      this.pcBtn.setLabel(`Купить ПК\n${fmtMoney(office.nextPC)}`)
      this.pcBtn.setEnabled(true)
    }

    // 2. Найм сотрудника
    const hirePrice = s.prices.hire
    this.hireBtn.setLabel(`Нанять\n${fmtMoney(hirePrice)}`)
    if (office.employees.length >= staffCap) {
      const reason = office.boss === '' && office.employees.length >= s.staffLimit
        ? `Нужен начальник для найма свыше ${s.staffLimit} сотрудников`
        : 'Штат офиса укомплектован'
      this.hireBtn.setEnabled(false, reason)
    } else if (office.employees.length >= office.pcs) {
      this.hireBtn.setEnabled(false, 'Нет свободного ПК — сначала купите ПК')
    } else if (s.money < hirePrice) {
      this.hireBtn.setEnabled(false, `не хватает ${fmtMoney(hirePrice - s.money)}`)
    } else {
      this.hireBtn.setEnabled(true)
    }

    // 3. Найм начальника
    const bossPrice = s.prices.boss
    if (office.boss !== '') {
      this.bossBtn.setLabel('Начальник ✓')
      this.bossBtn.setEnabled(false, `Начальник уже нанят: ${office.boss}`)
    } else if (s.money < bossPrice) {
      this.bossBtn.setLabel(`Начальник\n${fmtMoney(bossPrice)}`)
      this.bossBtn.setEnabled(false, `не хватает ${fmtMoney(bossPrice - s.money)}`)
    } else {
      this.bossBtn.setLabel(`Начальник\n${fmtMoney(bossPrice)}`)
      this.bossBtn.setEnabled(true)
    }
  }

  private showTooltip(e: EmployeeInfo, slot: number, s: StateMessage, x: number, y: number) {
    if (this.windowOpen()) return // ITGAME-89: тултип не просвечивает рядом с окном
    const office = s.offices[nav.activeOffice]
    const w = office.workplaces?.[slot]
    // Выработка — эффективная (с прибавкой уровня и дебаффами/баффами);
    // база в скобках, когда эффекты её меняют. Повышение (ITGAME-221) живёт в множителе, а
    // выработка тика округлена — прибавка видна только строкой «повышение +N%» под ней.
    const base = (e.incomePerTick + (e.level > 0 ? LEVEL_BONUS[e.level] : 0)) * s.ticksPerHour
    const effective = e.effectiveIncomePerTick * s.ticksPerHour
    const lines = [
      e.name,
      `Выработка: ${fmtMoney(effective)}/час${effective !== base ? ` (база ${fmtMoney(base)})` : ''}`,
      ...(e.raisePct > 0 ? [`повышение +${e.raisePct}%`] : []),
      `Зарплата:  ${fmtMoney(e.salary)}/день${e.unpaidToday ? ' (сегодня без оплаты)' : ''}`,
    ]
    // Опыт/уровень: тенура — актив, а не только ФОТ (итерация 15).
    const lvl = e.level > 0 ? ` (+$${LEVEL_BONUS[e.level]}/тик)` : ''
    lines.push(e.xpNext > 0
      ? `Уровень ${e.level}${lvl}, опыт ${e.xp}/${e.xpNext}`
      : `Уровень ${e.level}${lvl}, опыт MAX`)
    if (e.star) {
      lines.push('★ звезда: выработка ×1.5 при найме')
    }
    lines.push(e.serverSlot > 0 ? `сервер ${e.serverSlot} · ×${e.netMult.toFixed(1)}` : 'без сервера')
    // Рабочее место (ITGAME-135): уровень ПК и износ — или «требуется замена».
    if (w?.dead) {
      lines.push(`ПК ТРЕБУЕТ ЗАМЕНЫ — доход 0; заменить ${fmtMoney(s.prices.pcReplace)}`)
    } else if (w) {
      const lvl = s.prices.pcLevels?.[w.level]
      const atLimit = s.pcWearLimit > 0 && w.wear >= s.pcWearLimit
      lines.push(`ПК: ${lvl?.name ?? 'ЭЛТ'} ×${(lvl?.mult ?? 1).toFixed(1)}${s.pcWearLimit > 0 ? ` · износ ${w.wear}/${s.pcWearLimit}` : ''}${atLimit ? ' — следующая поломка: замена' : ''}`)
    }
    // Подписка (ITGAME-137): защищены первые места компании по тарифу.
    lines.push(e.avCovered
      ? `антивирус: ${s.antivirus.name}`
      : s.antivirus.tier > 0 ? `антивирус: место вне тарифа ${s.antivirus.name}` : 'без антивируса')
    // Причина отсутствия сети — словами, не кодом.
    if (e.offlineReason === 'no_router') {
      lines.push('✗ ВНЕ СЕТИ: роутер офиса не подключает это место')
    } else if (e.offlineReason === 'no_core') {
      lines.push('✗ ВНЕ СЕТИ: нет места в стойке роутеров (core)')
    } else if (e.offlineReason === 'no_server') {
      lines.push('· в core есть, но серверная стойка не обслуживает место')
    }
    if (e.pcBroken) {
      lines.push(`ПК СЛОМАН — доход 0; кликайте по месту: ${e.repairClicks}/${e.repairNeeded > 0 ? e.repairNeeded : 3}`)
      // Первый клик стоит очко действий (ITGAME-127).
      if (e.repairClicks === 0) lines.push('начать ремонт — 1 очко действий')
    }
    // Сломанное заражённое: строка вируса тоже есть, но ЛКМ сначала чинит.
    if (e.infected) {
      lines.push(e.pcBroken
        ? 'ЗАРАЖЁН — после ремонта вирус останется'
        : `ЗАРАЖЁН — выработка −30%; кликайте по месту: ${e.virusClicks}/${e.virusNeeded > 0 ? e.virusNeeded : 3}`)
    }
    if (e.infected && !e.pcBroken && e.virusClicks === 0) lines.push('начать чистку — 1 очко действий')
    // Админ офиса (ITGAME-145) кликает это место сам — его клики растут в той же «k/N».
    if (office.admin !== '' && office.adminSlot === slot) {
      lines.push(office.adminKind === 'repair' ? 'чинит админ' : 'чистит админ')
    }
    // ITGAME-75: пока ПК сломан, ЛКМ по месту — ремонт, мотивации кликом нет;
    // пока заражён — чистка (ITGAME-103).
    lines.push(w?.dead
      ? 'мотивация: после замены ПК'
      : e.pcBroken
      ? 'мотивация: после починки ПК'
      : e.infected
        ? 'мотивация: после чистки'
        : e.effects?.some((ef) => ef.token === 'away')
        ? 'мотивация: ушёл домой'
        : e.motivateReadyAt ? `мотивация: после ${e.motivateReadyAt}` : 'мотивация: готова (клик)')
    lines.push(`уволить: ${fmtMoney(e.firePrice)} (правый клик)`)
    const EFFECT_NAMES: Record<string, string> = { thirst: 'жажда', hunger: 'голоден', coffee: 'выпил кофе', motivated: 'мотивирован', offended: 'обижен', virus: 'вирус', away: 'ушёл домой', overworked: 'через силу', rested: 'отдохнул' }
    // Ремень безопасности: старый сервер мог прислать null вместо [] —
    // краш тултипа обрывал перерисовку всей сцены.
    for (const ef of e.effects ?? []) {
      const sign = ef.percent > 0 ? '+' : ''
      lines.push(`${EFFECT_NAMES[ef.token] ?? ef.token} ${sign}${ef.percent}%${ef.until ? ` (до ${ef.until})` : ''}`)
    }
    this.tooltipText.setText(lines.join('\n'))
    this.tooltipBg.setSize(this.tooltipText.width + 20, this.tooltipText.height + 16)
    // Не выпускаем тултип за правый край поля.
    const tx = Math.min(x + 40, GAME_W - this.tooltipBg.width - 8)
    this.tooltip.setPosition(tx, y - 20).setVisible(true)
  }

  // Универсальный текстовый тултип — для полки устройств и прочих
  // подсказок без структуры сотрудника/офиса.
  private showTextTooltip(text: string, x: number, y: number) {
    if (this.windowOpen()) return
    this.tooltipText.setText(text)
    this.tooltipBg.setSize(this.tooltipText.width + 20, this.tooltipText.height + 16)
    const tx = Math.min(x, GAME_W - this.tooltipBg.width - 8)
    this.tooltip.setPosition(tx, y).setVisible(true)
  }

  // Модалка увольнения (итерация 15): ПК освобождается, опыт теряется.
  // Отдельная от motivate модалка — случайный клик не должен увольнять.
  private openFireModal(e: EmployeeInfo, slot: number, dead: boolean) {
    const lost = [
      e.level > 0 ? `уровень ${e.level} и опыт ${e.xp}` : null,
      e.star ? 'статус звезды ★' : null,
    ].filter(Boolean)
    const lines = [
      `${e.name}`,
      `Компенсация: ${fmtMoney(e.firePrice)}${e.hiredToday ? ' (день найма — испытательный срок)' : ''}`,
      dead ? 'ПК останется в офисе — требует замены.' : 'ПК останется в офисе — свободен для нового найма.',
      lost.length ? `Теряется: ${lost.join(', ')}.` : 'Опыт теряется (его пока нет).',
    ]
    this.modal('Уволить сотрудника?', lines, [
      {
        label: `Уволить (${fmtMoney(e.firePrice)})`,
        onClick: () => client.send('fire', nav.activeOffice, { slot }),
      },
    ])
  }

  // Окно рабочего места (ITGAME-135): уровень ПК, износ, апгрейд и замена. Строки ≤ 40 знаков
  // (панель 460px, шрифт 14px). Свободный стол с ПК апгрейдится так же — уровень живёт на месте.
  private openWorkplaceModal(o: OfficeInfo, slot: number, s: StateMessage) {
    const w = o.workplaces?.[slot]
    if (!w) return
    const levels = s.prices.pcLevels ?? []
    const cur = levels[w.level]
    const next = levels[w.level + 1]
    const base = levels[0]?.name ?? 'ЭЛТ'
    const lines: string[] = []
    if (w.dead) {
      lines.push('ПК выработал ресурс — доход места 0', 'клики и мастер не чинят', `Замена: новый ПК ${base}, износ 0`)
    } else {
      const atLimit = s.pcWearLimit > 0 && w.wear >= s.pcWearLimit
      lines.push(`Монитор: ${cur?.name ?? base} — выработка ×${(cur?.mult ?? 1).toFixed(1)}`)
      lines.push(`Износ: ${w.wear}/${s.pcWearLimit}${atLimit ? ' — следующая поломка: замена' : ''}`)
      if (w.wear > 0) lines.push(`Замена: новый ПК ${base}, уровень теряется`)
      if (w.nextPrice === 0) lines.push('Уровень максимальный')
    }
    const buttons: ModalButton[] = []
    if (!w.dead && w.nextPrice > 0) {
      buttons.push({
        id: 'modal.pc.upgrade',
        label: `Апгрейд до ${next?.name ?? '…'} ${fmtMoney(w.nextPrice)}`,
        disabled: s.money < w.nextPrice,
        onClick: () => client.send('upgrade_pc', nav.activeOffice, { slot }),
      })
    }
    if (w.dead || w.wear > 0) {
      buttons.push({
        id: 'modal.pc.replace',
        label: `Заменить ПК ${fmtMoney(s.prices.pcReplace)}`,
        disabled: s.money < s.prices.pcReplace,
        onClick: () => client.send('replace_pc', nav.activeOffice, { slot }),
      })
    }
    this.modal(`Рабочее место ${slot + 1} — офис ${nav.activeOffice + 1}`, lines, buttons)
  }

  // Модалка роутера: апгрейд переехал сюда из кнопки HUD (заявка И4).
  private openRouterModal(o: OfficeInfo, s: StateMessage) {
    const connected = o.employees.filter((e) => e.connected).length
    const lines = o.routerTier > 0
      ? [`Тир ${o.routerTier} · ${o.ports} портов`, `Подключено ${connected} из ${o.employees.length}`]
      : ['Роутера нет —', 'офис не подключён к сети.']
    // Превью покупки: сколько мест доберётся до сервера (итерация 11).
    const free = coreFree(s)
    const gain = routerGain(o, free)
    if (o.nextRouter > 0) {
      const waiting = o.employees.filter((e) => e.offlineReason === 'no_router').length
      if (gain > 0) {
        lines.push(`≈ +${gain} в сеть после покупки`)
      } else if (free <= 0 && waiting > 0) {
        lines.push('Мест в core нет — сначала стойка роутеров')
      } else if (waiting > 0) {
        lines.push('Ждут порт роутера, но core уже занят')
      }
    }
    if (o.nextRouter === 0) lines.push('Тир максимальный')
    const buttons = o.nextRouter > 0
      ? [{
          label: o.routerTier === 0
            ? `Купить роутер ${fmtMoney(o.nextRouter)}`
            : `Апгрейд до т${o.routerTier + 1} ${fmtMoney(o.nextRouter)}`,
          onClick: () => client.send('buy_router', nav.activeOffice),
        }]
      : []
    this.modal(`Роутер — офис ${nav.activeOffice + 1}`, lines, buttons)
  }

  private showBossTooltip(o: OfficeInfo, s: StateMessage, x: number, y: number) {
    if (this.windowOpen()) return
    this.tooltipText.setText([
      o.boss,
      'Начальник — открывает места 10–12',
      `Зарплата:  ${fmtMoney(s.bossSalaryPerDay)}/день${o.bossUnpaidToday ? ' (сегодня без оплаты)' : ''}`,
    ].join('\n'))
    this.tooltipBg.setSize(this.tooltipText.width + 20, this.tooltipText.height + 16)
    this.tooltip.setPosition(Math.min(x + 40, GAME_W - this.tooltipBg.width - 8), y - 20).setVisible(true)
  }

  private hideTooltip() {
    this.tooltip.setVisible(false)
  }

  // ITGAME-89: открыто окно сцены — над тултипом лежит интерактивная подложка
  // (модалка: depth 70). Без своего флага: окно закрывается и кнопкой, и
  // подложкой, и сменой партии (partyModals) — смотрим на саму сцену.
  private windowOpen(): boolean {
    return this.children.list.some((o) => {
      const g = o as Phaser.GameObjects.GameObject & { depth?: number }
      return g !== this.tooltip && (g.depth ?? 0) > TOOLTIP_DEPTH && g.input?.enabled === true
    })
  }
}
