import Phaser from 'phaser'
import { GAME_H, GAME_W, HUD_H } from '../layout'
import { client } from '../net'
import type { StateMessage } from '../protocol'

const SCALE = 4 // 16px спрайт → 64px на экране
const GRID = { cols: 3, startX: 280, startY: 220, stepX: 330, stepY: 170 }

export class OfficeScene extends Phaser.Scene {
  private objects: Phaser.GameObjects.GameObject[] = []

  constructor() {
    super('office')
  }

  create() {
    // сцены перезапускаются при переключении комнат — сбрасываем ссылки прошлого цикла
    this.objects = []
    this.add.rectangle(0, HUD_H, GAME_W, GAME_H - HUD_H, 0x2b2f4a).setOrigin(0) // пол офиса
    this.add.text(GAME_W / 2, HUD_H + 20, 'ОФИС', {
      fontFamily: 'monospace', fontSize: '16px', color: '#5d7275',
    }).setOrigin(0.5)

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
    this.objects.forEach((o) => o.destroy())
    this.objects = []

    // Специальный слот роутера: рабочее место сюда не поставить.
    const rx = GAME_W - 130
    const ry = 170
    this.objects.push(
      this.add.rectangle(rx, ry, 84, 84, 0x232640).setStrokeStyle(2, 0x5d7275),
      this.add.text(rx, ry - 56, 'сеть', { fontFamily: 'monospace', fontSize: '12px', color: '#5d7275' }).setOrigin(0.5),
    )
    if (s.routerTier > 0) {
      this.objects.push(
        this.add.image(rx, ry, 'router').setScale(SCALE),
        this.add.text(rx, ry + 52, `роутер т${s.routerTier} · ${s.ports} порт.`, {
          fontFamily: 'monospace', fontSize: '11px', color: '#41a6f6',
        }).setOrigin(0.5),
      )
    } else {
      this.objects.push(
        this.add.text(rx, ry, 'нет\nроутера', {
          fontFamily: 'monospace', fontSize: '11px', color: '#5d7275', align: 'center',
        }).setOrigin(0.5),
      )
    }

    // Рабочие места: первые pcs слотов — с ПК, первые employees — с людьми,
    // первые connected — с зелёным индикатором сети.
    for (let i = 0; i < s.officeSlots; i++) {
      const x = GRID.startX + (i % GRID.cols) * GRID.stepX
      const y = GRID.startY + Math.floor(i / GRID.cols) * GRID.stepY
      this.objects.push(this.add.image(x, y, i < s.pcs ? 'desk_pc' : 'desk_empty').setScale(SCALE))
      if (i < s.employees) {
        this.objects.push(this.add.image(x - 52, y - 6, 'worker').setScale(SCALE))
        if (i < s.connected) {
          this.objects.push(this.add.circle(x + 30, y - 30, 4, 0x38b764))
        }
      }
    }
  }
}
