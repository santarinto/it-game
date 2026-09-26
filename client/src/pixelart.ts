import Phaser from 'phaser'
import { spriteKey } from './assets/manifest'

// Палитра в духе Sweetie-16. Точка — прозрачный пиксель.
const PALETTE: Record<string, string> = {
  k: '#1a1c2c', // чёрный
  w: '#f4f4f4', // белый
  g: '#5d7275', // серый металл
  b: '#3b5dc9', // синий (одежда)
  s: '#41a6f6', // голубой (экраны)
  d: '#8b5e3c', // дерево
  y: '#ffcd75', // кожа/жёлтый
  r: '#b13e53', // красный
  e: '#38b764', // зелёный (диоды)
}

// Спрайты 16×16: 16 строк по 16 символов из PALETTE.
const SPRITES: Record<string, string[]> = {
  desk_empty: [
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '..dddddddddddd..',
    '..dddddddddddd..',
    '..dd........dd..',
    '..dd........dd..',
    '..dd........dd..',
    '..dd........dd..',
    '................',
  ],
  desk_pc: [
    '................',
    '................',
    '....kkkkkkkk....',
    '....kssssssk....',
    '....kssssssk....',
    '....kssswssk....',
    '....kkkkkkkk....',
    '.......kk.......',
    '......kkkk......',
    '..dddddddddddd..',
    '..dddddddddddd..',
    '..dd........dd..',
    '..dd........dd..',
    '..dd........dd..',
    '..dd........dd..',
    '................',
  ],
  worker: [
    '................',
    '.....yyyyy......',
    '....yyyyyyy.....',
    '....yykykyy.....',
    '....yyyyyyy.....',
    '.....yyyy.......',
    '....bbbbbb......',
    '...bbbbbbbb.....',
    '...b.bbbb.b.....',
    '...y.bbbb.y.....',
    '.....bbbb.......',
    '.....b..b.......',
    '.....b..b.......',
    '.....k..k.......',
    '................',
    '................',
  ],
  router: [
    '................',
    '................',
    '................',
    '......k..k......',
    '......k..k......',
    '......k..k......',
    '...kkkkkkkkkk...',
    '...kwkkkkkkek...',
    '...kkkkkkkkkk...',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
  ],
  rack_empty: [
    '...gggggggggg...',
    '...g........g...',
    '...g........g...',
    '...g........g...',
    '...g........g...',
    '...g........g...',
    '...g........g...',
    '...g........g...',
    '...g........g...',
    '...g........g...',
    '...g........g...',
    '...g........g...',
    '...g........g...',
    '...g........g...',
    '...gggggggggg...',
    '................',
  ],
  rack_server: [
    '...gggggggggg...',
    '...gkkkkkkkkg...',
    '...gke....wkg...',
    '...gkkkkkkkkg...',
    '...gke....wkg...',
    '...gkkkkkkkkg...',
    '...gke....wkg...',
    '...gkkkkkkkkg...',
    '...gke....wkg...',
    '...gkkkkkkkkg...',
    '...gke....wkg...',
    '...gkkkkkkkkg...',
    '...g........g...',
    '...g........g...',
    '...gggggggggg...',
    '................',
  ],
  cooler: [
    '................',
    '.....wwwww......',
    '.....wsssw......',
    '.....wsssw......',
    '.....wsssw......',
    '.....wwwww......',
    '....wwwwwww.....',
    '....w.....w.....',
    '....w..s..w.....',
    '....w.....w.....',
    '....w.....w.....',
    '....w.....w.....',
    '....w.....w.....',
    '....wwwwwww.....',
    '.....k...k......',
    '................',
  ],
  fridge: [
    '................',
    '....wwwwwwww....',
    '....w......w....',
    '....w.....gw....',
    '....w......w....',
    '....wwwwwwww....',
    '....w......w....',
    '....w.....gw....',
    '....w......w....',
    '....w......w....',
    '....w......w....',
    '....w......w....',
    '....w......w....',
    '....wwwwwwww....',
    '.....k....k.....',
    '................',
  ],
  coffee_machine: [
    '................',
    '................',
    '................',
    '....kkkkkkkk....',
    '....kkkkkkkk....',
    '....kk.rr.kk....',
    '....kkkkkkkk....',
    '....kk......k...',
    '....kk.ww...k...',
    '....kk.ww...k...',
    '....kkkkkkkkk...',
    '....kkkkkkkkk...',
    '................',
    '................',
    '................',
    '................',
  ],
}

// registerTextures рисует все спрайты в canvas-текстуры Phaser.
// Вызывать один раз в BootScene до старта комнат.
export function registerTextures(scene: Phaser.Scene): void {
  for (const [key, rows] of Object.entries(SPRITES)) {
    // Сторож по КАЖДОМУ ключу, а не по одному «worker»: набор не должен
    // разъезжаться, если часть ключей уже занята (инцидент ITGAME-11).
    if (scene.textures.exists(key)) continue
    try {
      const canvas = scene.textures.createCanvas(key, 16, 16)
      if (!canvas) continue // текстура уже зарегистрирована
      const ctx = canvas.context
      rows.forEach((row, y) => {
        ;[...row].forEach((ch, x) => {
          const color = PALETTE[ch]
          if (color) {
            ctx.fillStyle = color
            ctx.fillRect(x, y, 1, 1)
          }
        })
      })
      canvas.refresh()
    } catch (e) {
      console.error(`пиксель-арт ${key}: кодоген не удался`, e)
    }
  }
}

// Целевые размеры спрайтов на экране, px (инцидент ITGAME-12): масштаб
// считается от РЕАЛЬНОГО размера текстуры, а не магическим множителем —
// 16px-плейсхолдер и 64px-PNG дают одну и ту же картинку, следующая
// смена разрешения арта ничего не сдвинет.
export const SPRITE_TARGET = {
  desk: 64, // стол в слоте 80×64
  person: 64, // сотрудник и начальник: ровно ×1 для 64px (sweetie16) и ×0.5 для HD 128px (hd32)
  rack: 64, // стойки, core, роутер, шлюз
  amenity: 48, // быт-устройства на полке
  icon: 32, // мелкие UI-иконки (icon_money, icon_network) — пока нигде не рисуются
  tile: 64, // плитка пола (office_floor_tile) — пока нигде не рисуется
} as const

// spriteScale — множитель для add.image(...).setScale(...): во сколько
// раз текстуру растянуть до targetPx на экране. Считаем от ширины кадра 0
// (а не всей текстуры!) — иначе будущий спрайтшит (frames>1 в манифесте)
// отмасштабируется так, будто все кадры — один широкий спрайт.
export function spriteScale(scene: Phaser.Scene, key: string, targetPx: number): number {
  if (!scene.textures.exists(key)) return 1 // неизвестная текстура — как есть
  const tex = scene.textures.get(key)
  const frame = tex.has('0') ? tex.get('0') : tex.get()
  return frame.width > 0 ? targetPx / frame.width : 1
}

// addSprite — единая точка входа для AI-спрайтов в сценах офиса/серверной:
// резолвит fallback через spriteKey() (manifest — aliases/fallback, пока
// не найдётся существующая в сцене текстура), берёт кадр 0 и сразу ставит
// масштаб под целевой класс. Id/tag/интерактивность — за вызывающим кодом,
// addSprite отдаёт обычный Image, с ним можно делать что угодно дальше.
export function addSprite(
  scene: Phaser.Scene,
  x: number,
  y: number,
  key: string,
  cls: keyof typeof SPRITE_TARGET,
): Phaser.GameObjects.Image {
  const resolved = spriteKey(scene, key)
  return scene.add.image(x, y, resolved).setScale(spriteScale(scene, resolved, SPRITE_TARGET[cls]))
}
