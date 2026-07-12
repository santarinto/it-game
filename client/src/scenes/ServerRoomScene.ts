import Phaser from 'phaser'
import { GAME_H, GAME_W, HUD_H, NAV_W } from '../layout'
import { client } from '../net'
import type { StateMessage } from '../protocol'

const SCALE = 6 // стойки крупнее столов

export class ServerRoomScene extends Phaser.Scene {
  private objects: Phaser.GameObjects.GameObject[] = []

  constructor() {
    super('serverRoom')
  }

  create() {
    // сцены перезапускаются при переключении комнат — сбрасываем ссылки прошлого цикла
    this.objects = []
    this.add.rectangle(0, HUD_H, GAME_W, GAME_H - HUD_H, 0x1f2233).setOrigin(0) // сумрак серверной
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

    // пол серверной справа от навигации
    this.add.rectangle(NAV_W, HUD_H, GAME_W - NAV_W, GAME_H - HUD_H, 0x1f2233).setOrigin(0)

    for (let i = 0; i < s.rackSlots; i++) {
      const x = GAME_W / 2 - 180 + i * 180
      const y = 390
      this.objects.push(this.add.image(x, y, i < s.servers ? 'rack_server' : 'rack_empty').setScale(SCALE))
    }

    // слот шлюза
    const gx = GAME_W - 160
    const gy = 300
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

    // строка статуса со шлюзом
    this.objects.push(
      this.add.text(GAME_W / 2, GAME_H - 80, `Серверов: ${s.servers} · множитель ×${s.multiplier.toFixed(1)}${s.gateway ? ' · интернет' : ''}`, {
        fontFamily: 'monospace', fontSize: '15px', color: '#41a6f6',
      }).setOrigin(0.5),
    )
  }
}
