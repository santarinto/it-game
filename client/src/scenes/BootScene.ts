import Phaser from 'phaser'

export class BootScene extends Phaser.Scene {
  constructor() {
    super('boot')
  }

  create() {
    // Комнаты появятся в задачах 10–11; пока стартуем только HUD.
    this.scene.start('hud')
  }
}
