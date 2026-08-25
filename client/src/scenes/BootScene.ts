import Phaser from 'phaser'
import { registerTextures } from '../pixelart'
import { preloadSfx } from '../audio'

export class BootScene extends Phaser.Scene {
  constructor() {
    super('boot')
  }

  preload() {
    preloadSfx(this)
  }

  create() {
    registerTextures(this)
    this.scene.start('menu')
  }
}
