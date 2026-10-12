import Phaser from 'phaser'
import { fmtMoney } from '../format'
import { GAME_H, GAME_W, HUD_H, NAV_W } from '../layout'
import { client } from '../net'
import { drawDebugFrames } from '../debug'
import { tag } from '../debug/agentApi'
import { partyModals } from '../ui/modal'
import { ACTION_COL_CX, ActionBar, type ActionButton } from '../ui/actionButton'
import { playSfx } from '../audio'
import { coreGain, serverGain } from '../network-preview'
import { addSprite } from '../pixelart'
import { FONT, HIRES_CAMERA } from '../render'
import type { StateMessage } from '../protocol'

export class ServerRoomScene extends Phaser.Scene {
  private objects!: Phaser.GameObjects.GameObject[]
  // Окна стоек и core: закрываются при смене партии (ITGAME-69).
  private modal!: ReturnType<typeof partyModals>
  // Колонка действий серверной (ITGAME-94): «Шлюз» переехал сюда из шапки HUD.
  private actions!: ActionBar
  private gatewayBtn!: ActionButton

  constructor() {
    super({ key: 'serverRoom', cameras: HIRES_CAMERA })
  }

  create() {
    // сцены перезапускаются при переключении комнат — сбрасываем ссылки прошлого цикла
    this.objects = []
    const openModal = partyModals(this)
    this.modal = (...args) => {
      this.actions.hideTooltip()
      return openModal(...args)
    }
    // пол серверной справа от панели навигации — статичен, рисуем один раз
    this.add.rectangle(NAV_W, HUD_H, GAME_W - NAV_W, GAME_H - HUD_H, 0x1f2233).setOrigin(0)
    this.add.text(GAME_W / 2, HUD_H + 20, 'СЕРВЕРНАЯ', {
      fontFamily: FONT, fontSize: '16px', color: '#5d7275',
    }).setOrigin(0.5)

    // Тултип кнопки — под окнами (подложка модалки — depth 70); при открытом
    // окне не показывается (как в офисе, ITGAME-89).
    this.actions = new ActionBar(this, {
      depth: 40,
      blocked: () => this.children.list.some((o) => {
        const g = o as Phaser.GameObjects.GameObject & { depth?: number }
        return (g.depth ?? 0) > 40 && g.input?.enabled === true
      }),
    })
    // Под слотом шлюза (бокс до y 422, подпись «интернет ×1.2» до ~439).
    this.gatewayBtn = this.actions.add(452, 'btn.gateway', () => {
      playSfx(this, 'select')
      client.send('buy_gateway')
    })

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

    // Core-коммутатор слева: без него роутеры не достают до серверов.
    const cx = NAV_W + 130
    const cy = 380
    this.objects.push(
      this.add.rectangle(cx, cy, 92, 92, 0x232640).setStrokeStyle(2, 0x5d7275),
      this.add.text(cx, cy - 60, 'стойка роутеров', { fontFamily: FONT, fontSize: '12px', color: '#5d7275' }).setOrigin(0.5),
    )
    const coreZone = tag(
      this.add.rectangle(cx, cy, 92, 92, 0x000000, 0.001).setInteractive({ useHandCursor: true }),
      'room.core',
    )
    coreZone.on('pointerdown', () => this.openCoreModal(s))
    this.objects.push(coreZone)
    if (s.core.level > 0) {
      this.objects.push(
        addSprite(this, cx, cy, 'rack_server', 'rack'),
        this.add.text(cx, cy + 58, `ур.${s.core.level} · ${s.core.connected}/${s.core.capacity} мест`, {
          fontFamily: FONT, fontSize: '11px', color: '#41a6f6',
        }).setOrigin(0.5),
      )
    } else {
      this.objects.push(this.add.text(cx, cy, 'нет', { fontFamily: FONT, fontSize: '11px', color: '#5d7275' }).setOrigin(0.5))
    }

    // Стойки по офисам: ряд на офис, стойки закрытых офисов затемнены.
    s.offices.forEach((o, oi) => {
      const gy = 220 + oi * 155
      this.objects.push(
        this.add.text(330, gy, `О${oi + 1}`, {
          fontFamily: FONT, fontSize: '14px', color: o.unlocked ? '#f4f4f4' : '#5d7275',
        }).setOrigin(0.5),
      )
      let firstEmpty = true // первая пустая стойка — куда встанет покупка
      for (let sl = 0; sl < o.serverSlots; sl++) {
        const x = 430 + sl * 150
        const srv = o.servers[sl]
        const img = addSprite(this, x, gy, srv ? 'rack_server' : 'rack_empty', 'rack')
        this.objects.push(img)
        if (!o.unlocked) {
          img.setAlpha(0.3)
          continue
        }
        img.setInteractive({ useHandCursor: true })
        tag(img, `room.rack.${oi}.${sl}`)
        img.on('pointerdown', () => this.openServerModal(s, oi, sl))
        if (srv) {
          this.objects.push(this.add.text(x, gy + 44, `ур.${srv.level} ×${srv.mult.toFixed(1)}`, {
            fontFamily: FONT, fontSize: '11px', color: '#41a6f6',
          }).setOrigin(0.5))
        } else {
          // Пустые стойки неотличимы — нумеруем и подсвечиваем ту,
          // куда buy_server реально поставит сервер (итерация 11).
          this.objects.push(this.add.text(x, gy + 44, `стойка ${sl + 1}`, {
            fontFamily: FONT, fontSize: '11px', color: firstEmpty ? '#38b764' : '#5d7275',
          }).setOrigin(0.5))
          if (firstEmpty) {
            img.setTint(0x9be3ba)
            this.objects.push(this.add.text(x, gy - 44, 'сервер сюда', {
              fontFamily: FONT, fontSize: '10px', color: '#38b764',
            }).setOrigin(0.5))
            firstEmpty = false
          }
        }
      }
    })

    // слот шлюза — по центру колонки действий, над кнопкой «Шлюз» (ITGAME-94)
    const gx = ACTION_COL_CX
    const gy = 380
    this.objects.push(
      this.add.rectangle(gx, gy, 84, 84, 0x232640).setStrokeStyle(2, 0x5d7275),
      this.add.text(gx, gy - 56, 'шлюз', { fontFamily: FONT, fontSize: '12px', color: '#5d7275' }).setOrigin(0.5),
    )
    if (s.gateway) {
      this.objects.push(
        // Слот шлюза раньше рисовал текстуру 'router', хотя
        // gateway.png давно грузится и не используется — теперь свой спрайт
        // (fallback на router через spriteKey, если gateway вдруг не загрузится).
        addSprite(this, gx, gy, 'gateway', 'rack'),
        this.add.text(gx, gy + 52, 'интернет ×1.2', { fontFamily: FONT, fontSize: '11px', color: '#38b764' }).setOrigin(0.5),
      )
    } else {
      this.objects.push(this.add.text(gx, gy, 'нет', { fontFamily: FONT, fontSize: '11px', color: '#5d7275' }).setOrigin(0.5))
    }

    // строка статуса
    const totalServers = s.offices.reduce((n, o) => n + o.servers.length, 0)
    this.objects.push(
      // y 604: между подписями стоек (≈ 580) и журналом событий HUD (с y 620, ITGAME-21)
      this.add.text(GAME_W / 2, 604,
        `роутеры ${s.core.connected}/${s.core.capacity} · стоек ${totalServers}${s.gateway ? ' · интернет' : ''}`, {
          fontFamily: FONT, fontSize: '15px', color: '#41a6f6',
        }).setOrigin(0.5),
    )

    this.refreshActions(s)
    this.objects.push(...drawDebugFrames(this, [...this.objects, ...this.actions.interactive]))
  }

  // Доступность и подпись «Шлюза» (ITGAME-17, до ITGAME-94 — в HUDScene.refresh).
  private refreshActions(s: StateMessage) {
    const gwPrice = s.prices.gateway
    if (s.gateway) {
      this.gatewayBtn.setLabel('Шлюз ✓')
      this.gatewayBtn.setEnabled(false, 'Интернет-шлюз уже подключён')
    } else if (s.money < gwPrice) {
      this.gatewayBtn.setLabel(`Шлюз\n${fmtMoney(gwPrice)}`)
      this.gatewayBtn.setEnabled(false, `не хватает ${fmtMoney(gwPrice - s.money)}`)
    } else {
      this.gatewayBtn.setLabel(`Шлюз\n${fmtMoney(gwPrice)}`)
      this.gatewayBtn.setEnabled(true)
    }
  }

  private openServerModal(s: StateMessage, oi: number, sl: number) {
    const o = s.offices[oi]
    const srv = o.servers[sl]
    if (!srv) {
      // buy_server ставит в первую пустую стойку; пустые стойки неотличимы,
      // поэтому неважно, по которой из них кликнули.
      const lvl1 = s.prices.serverLevels[0]
      const gain = serverGain(o)
      const lines = [
        'Пустая стойка.',
        `Сервер ур.1 даёт ×${lvl1.mult.toFixed(1)}`,
        'четырём работникам офиса.',
        ...(gain > 0 ? [`≈ +${gain} в сеть после покупки`] : ['Ждущих обслуживания нет — наймите людей']),
      ]
      this.modal(`Стойка ${sl + 1} — офис ${oi + 1}`, lines, [{ label: `Купить ${fmtMoney(lvl1.price)}`, onClick: () => client.send('buy_server', oi) }],
        { filled: 0, total: 24 })
      return
    }
    const lines = [
      `Уровень ${srv.level} · множитель ×${srv.mult.toFixed(1)}`,
      `Обслуживает работников ${srv.servedFrom}–${srv.servedTo}`,
    ]
    if (srv.maxed) lines.push('Уровень максимальный')
    const buttons = srv.maxed
      ? []
      : [{ label: `Апгрейд ${fmtMoney(srv.nextPrice)}`, onClick: () => client.send('upgrade_server', oi, { slot: sl }) }]
    // level/3 от 24U: ур.1 = 8U, ур.2 = 16U, ур.3 = 24U
    this.modal(`Серверная стойка ${sl + 1} — офис ${oi + 1}`, lines, buttons,
      { filled: srv.level * 8, total: 24 })
  }

  private openCoreModal(s: StateMessage) {
    const c = s.core
    const lines = c.level > 0
      ? [
          `Уровень ${c.level} · мест ${c.capacity}`,
          `Подключено ${c.connected} из ${c.capacity}`,
          ...(c.mult > 1 ? [`Бонус ×${c.mult.toFixed(1)} всем за серверами`] : []),
        ]
      : ['Стойка роутеров пуста — роутеры офисов', 'не достают до серверов.']
    // Схема цепочки: кто сколько мест занимает в каждом звене (итерация 11).
    lines.push('', 'ЦЕПЬ: место → роутер → core → стойка')
    s.offices.forEach((o, oi) => {
      if (!o.unlocked) {
        lines.push(`О${oi + 1}: закрыт`)
        return
      }
      const router = o.routerTier > 0 ? `роутер т${o.routerTier} (${o.ports})` : 'роутера нет'
      lines.push(`О${oi + 1}: ${router} · ${o.employees.length} сотр. · стоек ${o.servers.length}`)
    })
    lines.push(s.gateway ? 'шлюз: интернет ×1.2' : 'шлюза нет')
    if (!c.maxed) {
      const gain = coreGain(s)
      lines.push(gain > 0 ? `≈ +${gain} в сеть после апгрейда` : 'Ждущих места в core нет')
    }
    if (c.maxed) lines.push('Уровень максимальный')
    const buttons = c.maxed
      ? []
      : [{
          label: c.level === 0 ? `Купить ${fmtMoney(c.nextPrice)}` : `Апгрейд ${fmtMoney(c.nextPrice)}`,
          onClick: () => client.send('upgrade_core'),
        }]
    // level/5 от 24U: ур.1 = 5U, ур.2 = 10U, ур.3 = 14U, ур.4 = 19U, ур.5 = 24U
    this.modal('Серверная стойка роутеров', lines, buttons,
      { filled: Math.round(c.level / 5 * 24), total: 24 })
  }
}
