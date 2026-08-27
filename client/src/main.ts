import Phaser from 'phaser'
import { GAME_H, GAME_W } from './layout'
import { BootScene } from './scenes/BootScene'
import { MenuScene } from './scenes/MenuScene'
import { HUDScene } from './scenes/HUDScene'
import { OfficeScene } from './scenes/OfficeScene'
import { ServerRoomScene } from './scenes/ServerRoomScene'

const game = new Phaser.Game({
  type: Phaser.AUTO,
  width: GAME_W,
  height: GAME_H,
  parent: 'app',
  pixelArt: true, // чёткие пиксели без сглаживания
  backgroundColor: '#1a1c2c',
  scene: [BootScene, MenuScene, OfficeScene, ServerRoomScene, HUDScene],
})

// Хук смоук-теста/отладки (client/scripts/smoke-ui.mjs ждёт старта menu):
// без него на странице нет DOM-следа того, что игра жива (инцидент ITGAME-11).
;(window as unknown as { __itd: Phaser.Game }).__itd = game
