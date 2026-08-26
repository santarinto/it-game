import Phaser from 'phaser'
import { registerTextures } from '../pixelart'
import { preloadSfx } from '../audio'

// AI-спрайты (ITGAME-6): 64×64 PNG в public/assets/sprites, генерятся
// scripts/gen-sprites.sh (PixelLab + Sweetie-16). Загружаем ПОСЛЕ
// кодогена: при наличии PNG ключ текстуры перезатирается — кодоген
// остаётся фолбэком для всего, что ещё не перегенерено.
const AI_SPRITES = [
  'desk_pc', 'worker', 'boss',
  'router', 'rack_server', 'rack_empty', 'gateway',
  'cooler', 'fridge', 'coffee_machine',
  'office_floor_tile', 'icon_money', 'icon_network',
]
// desk_empty: генератор упорно рисует технике на «пустом» столе —
// до правки через Gemini-редактирование пользуемся кодогеном.

export class BootScene extends Phaser.Scene {
  constructor() {
    super('boot')
  }

  preload() {
    preloadSfx(this)
    for (const key of AI_SPRITES) {
      this.load.image('ai:' + key, `assets/sprites/${key}.png`)
    }
  }

  create() {
    registerTextures(this)
    // Поверх кодогена: у кого PNG есть — тот живёт картинкой.
    for (const key of AI_SPRITES) {
      if (this.textures.exists('ai:' + key)) {
        this.textures.addCanvas(key, this.textures.get('ai:' + key).getSourceImage() as HTMLCanvasElement)
      }
    }
    this.scene.start('menu')
  }
}
