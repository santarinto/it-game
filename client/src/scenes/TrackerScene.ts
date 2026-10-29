import Phaser from 'phaser'
import { GAME_H, GAME_W, HUD_H, NAV_W } from '../layout'
import { client } from '../net'
import { drawDebugFrames } from '../debug'
import { tag } from '../debug/agentApi'
import { FONT, HIRES_CAMERA } from '../render'
import type { StateMessage } from '../protocol'

// Трекер задач (ITGAME-201): экран заглушки канбан-доски в едином стиле UI.
// Точка входа — вкладка «ТРК» (nav.tracker) в панели навигации слева.

const CX = NAV_W + Math.round((GAME_W - NAV_W) / 2) // 672
const COL_W = 340
const COL_H = 432
const COL_GAP = 24
const COLS_X0 = CX - Math.round((3 * COL_W + 2 * COL_GAP) / 2) // 138
const COLS_Y = 206

export class TrackerScene extends Phaser.Scene {
  private objects!: Phaser.GameObjects.GameObject[]

  constructor() {
    super({ key: 'tracker', cameras: HIRES_CAMERA })
  }

  create() {
    this.objects = []

    // Фоновая подложка комнаты правее панели навигации
    this.add.rectangle(NAV_W, HUD_H, GAME_W - NAV_W, GAME_H - HUD_H, 0x1f2233).setOrigin(0)

    const unsub = client.subscribe({
      onState: (s) => this.render(s),
      onError: () => {},
      onDisconnect: () => {},
    })
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, unsub)

    if (client.latest) {
      this.render(client.latest)
    }
  }

  private render(_s: StateMessage) {
    this.objects.forEach((o) => o.destroy())
    this.objects = []

    // 1. Шапка экрана
    const title = tag(
      this.add.text(CX, HUD_H + 24, 'ТРЕКЕР ЗАДАЧ', {
        fontFamily: FONT,
        fontSize: '18px',
        color: '#ffcd75',
      }).setOrigin(0.5),
      'tracker.title',
    )

    const badgeBg = tag(
      this.add.rectangle(CX, HUD_H + 54, 150, 22, 0x232640)
        .setStrokeStyle(1, 0x5d7275),
      'tracker.badge',
    )

    const badgeText = this.add.text(CX, HUD_H + 54, 'В РАЗРАБОТКЕ', {
      fontFamily: FONT,
      fontSize: '10px',
      color: '#e5c07b',
    }).setOrigin(0.5)

    const desc = tag(
      this.add.text(CX, HUD_H + 82, 'Проекты компании под роли сотрудников (ITGAME-197), продажи (ITGAME-200) и дедлайн-события', {
        fontFamily: FONT,
        fontSize: '12px',
        color: '#94b0c2',
      }).setOrigin(0.5),
      'tracker.desc',
    )

    this.objects.push(title, badgeBg, badgeText, desc)

    // 2. Колонки канбан-доски (скелетон)
    const columns = [
      {
        title: 'БЭКЛОГ',
        count: '2',
        color: '#5d7275',
        cards: [
          {
            title: 'Оптимизация БД биллинга',
            role: 'разработчик · лид',
            roleColor: '#73eff7',
            meta: 'дедлайн: 3 дня · награда: $2,400',
          },
          {
            title: 'Редизайн мобильного UI',
            role: 'дизайнер · аналитик',
            roleColor: '#ffcd75',
            meta: 'дедлайн: 5 дней · награда: $3,200',
          },
        ],
        emptyText: '+ Новая задача (скоро)',
      },
      {
        title: 'В РАБОТЕ',
        count: '1',
        color: '#41a6f6',
        cards: [
          {
            title: 'Сетевой шлюз и API v2',
            role: 'разработчик · тестировщик',
            roleColor: '#a7f070',
            meta: 'прогресс: 65% · в работе: 2/2',
          },
        ],
        emptyText: 'Слот свободен',
      },
      {
        title: 'ГОТОВО',
        count: '1',
        color: '#38b764',
        cards: [
          {
            title: 'Запуск ядра core ур. 1',
            role: 'выполнено ✓',
            roleColor: '#38b764',
            meta: 'прибыль: +$1,500 · опыт: +120',
          },
        ],
        emptyText: 'История закрытых задач',
      },
    ]

    let cardIdx = 0
    columns.forEach((col, colIdx) => {
      const colX = COLS_X0 + colIdx * (COL_W + COL_GAP)
      const colY = COLS_Y

      // Каркас колонки
      const colBg = tag(
        this.add.rectangle(colX, colY, COL_W, COL_H, 0x161826)
          .setOrigin(0)
          .setStrokeStyle(1, 0x2e334a),
        `tracker.col.${colIdx}`,
      )

      // Заголовок колонки
      const headerBar = this.add.rectangle(colX, colY, COL_W, 36, 0x202438)
        .setOrigin(0)
        .setStrokeStyle(1, 0x2e334a)

      const headerText = this.add.text(colX + 16, colY + 18, col.title, {
        fontFamily: FONT,
        fontSize: '12px',
        color: '#f4f4f4',
      }).setOrigin(0, 0.5)

      const headerCount = this.add.text(colX + COL_W - 16, colY + 18, `[ ${col.count} ]`, {
        fontFamily: FONT,
        fontSize: '10px',
        color: col.color,
      }).setOrigin(1, 0.5)

      this.objects.push(colBg, headerBar, headerText, headerCount)

      // Карточки задач
      let cardY = colY + 36 + 12
      col.cards.forEach((card) => {
        const cardBg = tag(
          this.add.rectangle(colX + 12, cardY, COL_W - 24, 94, 0x1f2338)
            .setOrigin(0)
            .setStrokeStyle(1, 0x2e334a),
          `tracker.card.${cardIdx}`,
        )

        const cardTitle = this.add.text(colX + 24, cardY + 16, card.title, {
          fontFamily: FONT,
          fontSize: '12px',
          color: '#f4f4f4',
        }).setOrigin(0, 0.5)

        const cardRole = this.add.text(colX + 24, cardY + 44, `[ ${card.role} ]`, {
          fontFamily: FONT,
          fontSize: '10px',
          color: card.roleColor,
        }).setOrigin(0, 0.5)

        const cardMeta = this.add.text(colX + 24, cardY + 74, card.meta, {
          fontFamily: FONT,
          fontSize: '10px',
          color: '#5d7275',
        }).setOrigin(0, 0.5)

        this.objects.push(cardBg, cardTitle, cardRole, cardMeta)
        cardY += 94 + 12
        cardIdx++
      })

      // Заглушка пустого слота
      const slotBg = this.add.rectangle(colX + 12, cardY, COL_W - 24, 60, 0x141624)
        .setOrigin(0)
        .setStrokeStyle(1, 0x23273c)

      const slotText = this.add.text(colX + COL_W / 2, cardY + 30, col.emptyText, {
        fontFamily: FONT,
        fontSize: '10px',
        color: '#5d7275',
      }).setOrigin(0.5)

      this.objects.push(slotBg, slotText)
    })

    // 3. Подвал с пояснением
    const footer = tag(
      this.add.text(CX, 660, 'Механика распределения задач появится в следующих обновлениях игры', {
        fontFamily: FONT,
        fontSize: '11px',
        color: '#5d7275',
      }).setOrigin(0.5),
      'tracker.footer',
    )
    this.objects.push(footer)

    this.objects.push(...drawDebugFrames(this, this.objects))
  }
}
