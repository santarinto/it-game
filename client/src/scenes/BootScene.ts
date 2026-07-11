import Phaser from 'phaser'
import { registerTextures } from '../pixelart'

export class BootScene extends Phaser.Scene {
  constructor() {
    super('boot')
  }

  create() {
    registerTextures(this)
    this.scene.start('office')
    this.scene.launch('hud') // HUD живёт поверх комнат
  }
}
