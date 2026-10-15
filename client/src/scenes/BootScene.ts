import Phaser from 'phaser'
import { registerTextures } from '../pixelart'
import { preloadSfx } from '../audio'
import { GAME_W } from '../layout'
import { FONT, FONT_PRIMARY, FONT_SYMBOLS, FONT_SYMBOLS_TEXT, HIRES_CAMERA, fontFallback } from '../render'
import { emitUi } from '../uibus'
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

// Шрифты (ITGAME-48): Phaser растеризует Text в момент создания и не
// перерисовывает его, когда @font-face догрузится, — первые тексты меню
// застряли бы в фолбэке, а метрики раскладки (layoutRow, ширины кнопок)
// посчитались бы по чужому шрифту. Поэтому boot ждёт оба файла до старта
// меню. Таймаут — не повод не пускать в игру: FONT переключается на голый
// monospace для всей партии, причина — в itd.log() ({type:'font', ok:false})
// и console.warn.
const FONT_TIMEOUT_MS = 4000

async function loadFonts(): Promise<{ ok: boolean; faces: string[]; reason?: string }> {
  if (!document.fonts) return { ok: false, faces: [], reason: 'document.fonts недоступен' }
  let timer = 0
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(`таймаут ${FONT_TIMEOUT_MS} мс`)), FONT_TIMEOUT_MS)
  })
  try {
    // ITD Symbols объявлен с unicode-range: без текста из этого диапазона
    // load() его не тронет и вернёт [] — отсюда второй аргумент.
    const [primary, symbols] = await Promise.race([
      Promise.all([
        document.fonts.load(`15px '${FONT_PRIMARY}'`),
        document.fonts.load(`15px '${FONT_SYMBOLS}'`, FONT_SYMBOLS_TEXT),
      ]),
      timeout,
    ])
    const missing = [primary.length ? null : FONT_PRIMARY, symbols.length ? null : FONT_SYMBOLS].filter(Boolean)
    const faces = [...primary, ...symbols].map((f) => f.family.replace(/["']/g, ''))
    if (missing.length) return { ok: false, faces, reason: `нет @font-face: ${missing.join(', ')}` }
    return { ok: true, faces }
  } catch (e) {
    return { ok: false, faces: [], reason: e instanceof Error ? e.message : String(e) }
  } finally {
    clearTimeout(timer)
  }
}

export class BootScene extends Phaser.Scene {
  private fonts: Promise<void> = Promise.resolve()

  constructor() {
    super({ key: 'boot', cameras: HIRES_CAMERA })
  }

  preload() {
    // Шрифты грузятся параллельно со спрайтами и звуком, create() их дожидается.
    const t0 = performance.now()
    this.fonts = loadFonts().then((r) => {
      const ms = Math.round(performance.now() - t0)
      if (!r.ok) {
        fontFallback()
        console.warn(`шрифт: ${r.reason} — текст игры на системном monospace`)
      }
      emitUi({ type: 'font', ok: r.ok, ms, faces: r.faces, font: FONT, ...(r.reason ? { reason: r.reason } : {}) })
    })
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
        // render: smooth (ITGAME-83): детальный исходник крупнее слота — LINEAR только
        // этой текстуре; pixelArt оставляет всей игре NEAREST.
        if (spec.render === 'smooth') this.textures.get(key).setFilter(Phaser.Textures.FilterMode.LINEAR)
        substituted.push(key)
      } catch (e) {
        console.error(`спрайт ${key}: PNG не подменён, остаётся плейсхолдер`, e)
      }
    }
    this.checkAssetContract(substituted)
    void this.fonts.then(() => this.scene.start('menu'))
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
      fontFamily: FONT, fontSize: '15px', color: '#b13e53',
      backgroundColor: '#1a1c2c', padding: { x: 16, y: 16 },
      wordWrap: { width: GAME_W - 96 }, lineSpacing: 6,
    })
  }
}
