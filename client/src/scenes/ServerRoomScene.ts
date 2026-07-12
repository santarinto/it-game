import Phaser from 'phaser'
import { GAME_H, GAME_W, HUD_H } from '../layout'
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

    for (let i = 0; i < s.rackSlots; i++) {
      const x = GAME_W / 2 - 180 + i * 180
      const y = 390
      this.objects.push(this.add.image(x, y, i < s.servers ? 'rack_server' : 'rack_empty').setScale(SCALE))
    }

    const note = s.routerTier === 0 && s.servers > 0 ? ' — без роутера серверы не работают!' : ''
    this.objects.push(
      this.add.text(GAME_W / 2, GAME_H - 80, `Серверов: ${s.servers} · множитель сети ×${s.multiplier.toFixed(1)}${note}`, {
        fontFamily: 'monospace', fontSize: '15px', color: s.routerTier === 0 && s.servers > 0 ? '#b13e53' : '#41a6f6',
      }).setOrigin(0.5),
    )
  }
}
