import Phaser from 'phaser'
import { fmtMoney } from '../format'
import { GAME_H, GAME_W, HUD_H, NAV_W } from '../layout'
import { client } from '../net'
import { drawDebugFrames } from '../debug'
import { showModal } from '../ui/modal'
import type { StateMessage } from '../protocol'

const SCALE = 4 // 9 стоек + core + шлюз — мельче, чем прежние три

export class ServerRoomScene extends Phaser.Scene {
  private objects: Phaser.GameObjects.GameObject[] = []

  constructor() {
    super('serverRoom')
  }

  create() {
    // сцены перезапускаются при переключении комнат — сбрасываем ссылки прошлого цикла
    this.objects = []
    // пол серверной справа от панели навигации — статичен, рисуем один раз
    this.add.rectangle(NAV_W, HUD_H, GAME_W - NAV_W, GAME_H - HUD_H, 0x1f2233).setOrigin(0)
    this.add.text(GAME_W / 2, HUD_H + 20, 'СЕРВЕРНАЯ', {
      fontFamily: 'monospace', fontSize: '16px', color: '#5d7275',
    }).setOrigin(0.5)

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
      this.add.text(cx, cy - 60, 'стойка роутеров', { fontFamily: 'monospace', fontSize: '12px', color: '#5d7275' }).setOrigin(0.5),
    )
    const coreZone = this.add.rectangle(cx, cy, 92, 92, 0x000000, 0.001).setInteractive({ useHandCursor: true })
    coreZone.on('pointerdown', () => this.openCoreModal(s))
    this.objects.push(coreZone)
    if (s.core.level > 0) {
      this.objects.push(
        this.add.image(cx, cy, 'rack_server').setScale(SCALE),
        this.add.text(cx, cy + 58, `ур.${s.core.level} · ${s.core.connected}/${s.core.capacity} мест`, {
          fontFamily: 'monospace', fontSize: '11px', color: '#41a6f6',
        }).setOrigin(0.5),
      )
    } else {
      this.objects.push(this.add.text(cx, cy, 'нет', { fontFamily: 'monospace', fontSize: '11px', color: '#5d7275' }).setOrigin(0.5))
    }

    // Стойки по офисам: ряд на офис, стойки закрытых офисов затемнены.
    s.offices.forEach((o, oi) => {
      const gy = 220 + oi * 155
      this.objects.push(
        this.add.text(330, gy, `О${oi + 1}`, {
          fontFamily: 'monospace', fontSize: '14px', color: o.unlocked ? '#f4f4f4' : '#5d7275',
        }).setOrigin(0.5),
      )
      for (let sl = 0; sl < o.serverSlots; sl++) {
        const x = 430 + sl * 150
        const srv = o.servers[sl]
        const img = this.add.image(x, gy, srv ? 'rack_server' : 'rack_empty').setScale(SCALE)
        this.objects.push(img)
        if (!o.unlocked) {
          img.setAlpha(0.3)
          continue
        }
        img.setInteractive({ useHandCursor: true })
        img.on('pointerdown', () => this.openServerModal(s, oi, sl))
        if (srv) {
          this.objects.push(this.add.text(x, gy + 44, `ур.${srv.level} ×${srv.mult.toFixed(1)}`, {
            fontFamily: 'monospace', fontSize: '11px', color: '#41a6f6',
          }).setOrigin(0.5))
        }
      }
    })

    // слот шлюза
    const gx = GAME_W - 150
    const gy = 380
    this.objects.push(
      this.add.rectangle(gx, gy, 84, 84, 0x232640).setStrokeStyle(2, 0x5d7275),
      this.add.text(gx, gy - 56, 'шлюз', { fontFamily: 'monospace', fontSize: '12px', color: '#5d7275' }).setOrigin(0.5),
    )
    if (s.gateway) {
      this.objects.push(
        this.add.image(gx, gy, 'router').setScale(4),
        this.add.text(gx, gy + 52, 'интернет ×1.2', { fontFamily: 'monospace', fontSize: '11px', color: '#38b764' }).setOrigin(0.5),
      )
    } else {
      this.objects.push(this.add.text(gx, gy, 'нет', { fontFamily: 'monospace', fontSize: '11px', color: '#5d7275' }).setOrigin(0.5))
    }

    // строка статуса
    const totalServers = s.offices.reduce((n, o) => n + o.servers.length, 0)
    this.objects.push(
      this.add.text(GAME_W / 2, GAME_H - 40,
        `роутеры ${s.core.connected}/${s.core.capacity} · стоек ${totalServers}${s.gateway ? ' · интернет' : ''}`, {
          fontFamily: 'monospace', fontSize: '15px', color: '#41a6f6',
        }).setOrigin(0.5),
    )

    this.objects.push(...drawDebugFrames(this, this.objects))
  }

  private openServerModal(s: StateMessage, oi: number, sl: number) {
    const srv = s.offices[oi].servers[sl]
    if (!srv) {
      // buy_server ставит в первую пустую стойку; пустые стойки неотличимы,
      // поэтому неважно, по которой из них кликнули.
      const lvl1 = s.prices.serverLevels[0]
      showModal(this, `Стойка ${sl + 1} — офис ${oi + 1}`, [
        'Пустая стойка.',
        `Сервер ур.1 даёт ×${lvl1.mult.toFixed(1)}`,
        'четырём работникам офиса.',
      ], [{ label: `Купить ${fmtMoney(lvl1.price)}`, onClick: () => client.send('buy_server', oi) }],
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
    showModal(this, `Серверная стойка ${sl + 1} — офис ${oi + 1}`, lines, buttons,
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
    if (c.maxed) lines.push('Уровень максимальный')
    const buttons = c.maxed
      ? []
      : [{
          label: c.level === 0 ? `Купить ${fmtMoney(c.nextPrice)}` : `Апгрейд ${fmtMoney(c.nextPrice)}`,
          onClick: () => client.send('upgrade_core'),
        }]
    // level/5 от 24U: ур.1 = 5U, ур.2 = 10U, ур.3 = 14U, ур.4 = 19U, ур.5 = 24U
    showModal(this, 'Серверная стойка роутеров', lines, buttons,
      { filled: Math.round(c.level / 5 * 24), total: 24 })
  }
}
