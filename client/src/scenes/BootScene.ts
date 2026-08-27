import Phaser from 'phaser'
import { registerTextures } from '../pixelart'
import { preloadSfx } from '../audio'
import { GAME_W } from '../layout'

// AI-спрайты (ITGAME-6): 64×64 PNG в public/assets/sprites, генерятся
// scripts/gen-sprites.sh (PixelLab + Sweetie-16). Загружаем ПОСЛЕ
// кодогена: при наличии PNG ключ текстуры перезатирается — кодоген
// остаётся фолбэком для всего, что ещё не перегенерено.
const AI_SPRITES = [
  'desk_pc', 'desk_empty', 'worker', 'boss',
  'router', 'rack_server', 'rack_empty', 'gateway',
  'cooler', 'fridge', 'coffee_machine',
  'office_floor_tile', 'icon_money', 'icon_network',
]

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
    try {
      registerTextures(this)
    } catch (e) {
      // Дальше стартовать бессмысленно — комнаты лягут так же. Но и
      // молчать нельзя: рисуем причину на канвасе.
      this.bootFail(e)
      return
    }
    // Поверх кодогена: у кого PNG есть — тот живёт картинкой.
    // Правила инцидента ITGAME-11:
    //   • ключ освобождается ДО добавления — занятый ключ add* не
    //     перезаписывает, а молча возвращает null;
    //   • источник — HTMLImageElement, поэтому addImage, а не addCanvas
    //     (CanvasTexture зовёт canvas.getContext, которого у <img> нет);
    //   • каждый ключ в своём try — один битый PNG не хоронит игру,
    //     плейсхолдер на то и плейсхолдер.
    for (const key of AI_SPRITES) {
      try {
        if (!this.textures.exists('ai:' + key)) continue
        const img = this.textures.get('ai:' + key).getSourceImage()
        if (this.textures.exists(key)) this.textures.remove(key)
        this.textures.addImage(key, img as HTMLImageElement)
      } catch (e) {
        console.error(`спрайт ${key}: PNG не подменён, остаётся плейсхолдер`, e)
      }
    }
    this.scene.start('menu')
  }

  // Падение boot без этого выглядит как «ещё грузится» — молчаливый
  // чёрный экран стоил нескольких дней тишины (инцидент ITGAME-11).
  private bootFail(e: unknown) {
    this.add.text(24, 24, [
      'IT DIRECTOR: игра не загрузилась',
      '',
      String(e),
      '',
      'Обновите страницу (Ctrl+R).',
      'Повторится — сообщите разработчику.',
    ].join('\n'), {
      fontFamily: 'monospace', fontSize: '15px', color: '#b13e53',
      backgroundColor: '#1a1c2c', padding: { x: 16, y: 16 },
      wordWrap: { width: GAME_W - 96 }, lineSpacing: 6,
    })
  }
}
