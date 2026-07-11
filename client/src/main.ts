import Phaser from 'phaser'
import { client } from './net'
import { BootScene } from './scenes/BootScene'
import { HUDScene } from './scenes/HUDScene'
import { OfficeScene } from './scenes/OfficeScene'
import { ServerRoomScene } from './scenes/ServerRoomScene'

client.connect()

new Phaser.Game({
  type: Phaser.AUTO,
  width: 960,
  height: 640,
  parent: 'app',
  pixelArt: true, // чёткие пиксели без сглаживания
  backgroundColor: '#1a1c2c',
  scene: [BootScene, OfficeScene, ServerRoomScene, HUDScene],
})
