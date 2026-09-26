import Phaser from 'phaser'
import manifestData from './sprites.json'

// Единый манифест ассетов: один источник правды для BootScene
// (что грузить), check-sprites.mjs (что проверять) и сцен (во что
// масштабировать, на что упасть при отсутствии текстуры). JSON, а не .ts —
// его же читает check-sprites.mjs (Node, вне сборки Vite).

// Классы спрайтов — целевые размеры на экране см. SPRITE_TARGET в
// ../pixelart.ts (сопоставление 1:1 с ключами там).
export type SpriteClass = 'desk' | 'person' | 'rack' | 'amenity' | 'tile' | 'icon'

export type PaletteName = 'sweetie16' | 'hd32'

// Спецификация одного спрайта: только то, что реально используется —
// поля из чек-листа check-sprites.mjs (ITGAME-28) перенесены сюда, чтобы
// пороги жили рядом с самим ключом, а не в отдельных константах скрипта.
export interface SpriteSpec {
  size: number // сторона кадра, px (контракт ITGAME-12: PNG размером size·frames × size)
  frames: number // кол-во кадров в спрайтшите; 1 — обычная картинка
  palette: PaletteName
  class: SpriteClass
  // Спрайт сотрудника уже содержит свой стол/кресло/монитор — слот рисует
  // только его, без отдельного desk_pc под ним.
  includesDesk?: boolean
  // Ключ-подстраховка: spriteKey() берёт его, если текстуры key нет в сцене.
  fallback?: string
  // Порог «шума» (компонент площадью ≤ 4·(size/64)²): по умолчанию 0,
  // переопределяется только там, где арт реально шумит (запечённая
  // шахматка превью) — сам арт не трогаем, спрайт остаётся фолбэком.
  maxSpecks?: number
  // Порог доли #f4f4f4 (детектор запечённого чекерборда/белой заливки);
  // по умолчанию 40 — см. MAX_WHITE_PCT в check-sprites.mjs.
  maxWhitePct?: number
  // Почему порог выше нуля/дефолта — коротко, по-русски, для ревью.
  note?: string
}

export interface Manifest {
  palettes: Record<PaletteName, string[]>
  sprites: Record<string, SpriteSpec>
  aliases: Record<string, string>
}

// JSON-импорт типизирован явно: sprites.json не содержит своей схемы.
const manifest = manifestData as Manifest

export const SPRITES: Record<string, SpriteSpec> = manifest.sprites
export const PALETTES: Record<PaletteName, string[]> = manifest.palettes
export const ALIASES: Record<string, string> = manifest.aliases

// AI_SPRITES — список ключей для BootScene.preload()/checkAssetContract();
// раньше был литеральным массивом в BootScene.ts, теперь — из манифеста.
export const AI_SPRITES: string[] = Object.keys(manifest.sprites)

// SWEETIE16 — Set с '#', как ждёт существующий код agentApi.ts
// (сравнение с '#rrggbb' из canvas ImageData). Формат в JSON — без '#',
// чтобы совпадать с манифестом check-sprites.mjs/палитрой remap.sh.
export const SWEETIE16: ReadonlySet<string> = new Set(manifest.palettes.sweetie16.map((h) => `#${h}`))

// spriteKey — резолвит ключ спрайта в реально существующую в сцене
// текстуру: сам ключ → aliases[key] → sprites[key].fallback → … Ключ,
// для которого ничего не нашлось, возвращается как есть (пусть
// add.image упадёт на '__MISSING' — так было и раньше без манифеста).
export function spriteKey(scene: Phaser.Scene, key: string): string {
  let cur = key
  // Предохранитель от случайного цикла aliases/fallback длиной > 8 звеньев.
  for (let i = 0; i < 8; i++) {
    if (scene.textures.exists(cur)) return cur
    const next = ALIASES[cur] ?? SPRITES[cur]?.fallback
    if (!next || next === cur) break
    cur = next
  }
  return cur
}
