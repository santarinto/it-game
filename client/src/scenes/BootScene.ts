import Phaser from 'phaser'
import { registerTextures } from '../pixelart'
import { preloadSfx } from '../audio'
import { GAME_W } from '../layout'
import { HIRES_CAMERA } from '../render'
import { AI_SPRITES, SPRITES } from '../assets/manifest'

// AI-спрайты (ITGAME-6): PNG в public/assets/sprites, генерятся
// scripts/gen-sprites.sh (PixelLab + Sweetie-16). Загружаем ПОСЛЕ
// кодогена: при наличии PNG ключ текстуры перезатирается — кодоген
// остаётся фолбэком для всего, что ещё не перегенерено.
// Список ключей и их размер/кадры/палитра теперь в едином манифесте
// client/src/assets/sprites.json — здесь только
// реэкспорт для обратной совместимости (agentApi.ts и другие импортируют
// AI_SPRITES отсюда же, для itd.assetSet()).
export { AI_SPRITES }

export class BootScene extends Phaser.Scene {
  constructor() {
    super({ key: 'boot', cameras: HIRES_CAMERA })
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
    const substituted: string[] = []
    for (const key of AI_SPRITES) {
      try {
        if (!this.textures.exists('ai:' + key)) continue
        const img = this.textures.get('ai:' + key).getSourceImage()
        if (this.textures.exists(key)) this.textures.remove(key)
        const spec = SPRITES[key]
        if (spec.frames > 1) {
          // Спрайтшит: кадры frameWidth×frameHeight подряд по горизонтали.
          // Сейчас ни у одного ключа frames>1 — ветка на будущее (HD-спрайты
          // с анимацией), поведение для нынешних PNG не меняется.
          this.textures.addSpriteSheet(key, img as HTMLImageElement, {
            frameWidth: spec.size, frameHeight: spec.size,
          })
        } else {
          this.textures.addImage(key, img as HTMLImageElement)
        }
        substituted.push(key)
      } catch (e) {
        console.error(`спрайт ${key}: PNG не подменён, остаётся плейсхолдер`, e)
      }
    }
    this.checkAssetContract(substituted)
    this.scene.start('menu')
  }

  // Контракт арт-пайплайна (инцидент ITGAME-12): подменённый PNG обязан
  // быть ровно size·frames × size (по манифесту ключа) и иметь прозрачные
  // пиксели — иначе арт-пайплайн привёз мусор (запечённый фон, чужой
  // размер), и это ошибка, а не «стол вдруг втрое шире слота».
  // console.error ловит CI-смоук: релиз с битым контрактом до прода не доедет.
  private checkAssetContract(substituted: string[]) {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    for (const key of substituted) {
      const spec = SPRITES[key]
      const w = spec.size * spec.frames
      const h = spec.size
      const img = this.textures.get(key).getSourceImage() as HTMLImageElement
      if (img.width !== w || img.height !== h) {
        console.error(`спрайт ${key}: ${img.width}×${img.height}, контракт — ${w}×${h}`)
        continue
      }
      canvas.width = w
      canvas.height = h
      ctx.clearRect(0, 0, w, h)
      ctx.drawImage(img, 0, 0)
      const data = ctx.getImageData(0, 0, w, h).data
      let hasAlpha = false
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] < 255) {
          hasAlpha = true
          break
        }
      }
      if (!hasAlpha) {
        console.error(`спрайт ${key}: ни одного прозрачного пикселя — фон запечён в PNG`)
      }
    }
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
