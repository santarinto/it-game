import Phaser from 'phaser'
import { GAME_H, GAME_W } from './layout'

// Рендер 2× (подготовка к HD-спрайтам 128px в слоты 64 мировых px, и чёткий
// текст при CSS-зуме): канвас растёт в RENDER_SCALE раз относительно мира
// (1280×720, GAME_W/GAME_H не меняются — itd-координаты остаются мировыми),
// а камера сцены масштабирует её обратно на весь канвас. ?rs=1 — A/B и
// слабые машины (старое поведение, канвас 1:1 с миром).
//
// Проверено на Phaser 3.90.0: рабочий вариант камеры
// — конфиг сцены `{ zoom: RENDER_SCALE, roundPixels: true, scrollX:
// -GAME_W*(RENDER_SCALE-1)/2, scrollY: -GAME_H*(RENDER_SCALE-1)/2 }` даёт
// worldView (0,0,GAME_W,GAME_H); `cameras.main.setZoom(RS).setOrigin(0,0)`
// после create() зумит верно, но worldView остаётся неверным. Ловушка:
// CameraManager.fromJSON всегда сбрасывает roundPixels в false, если он не
// указан явно в конфиге — дефолт из game.config.roundPixels туда не доходит.
export const RENDER_SCALE = new URLSearchParams(location.search).get('rs') === '1' ? 1 : 2

export const CANVAS_W = GAME_W * RENDER_SCALE
export const CANVAS_H = GAME_H * RENDER_SCALE

// Конфиг камеры сцены (Phaser.Types.Cameras.Scene2D.CameraConfig): передать
// сценам как `super({ key: '<key>', cameras: HIRES_CAMERA })`. Общий объект
// безопасно шарить — fromJSON читает поля, не хранит ссылку.
export const HIRES_CAMERA: Phaser.Types.Cameras.Scene2D.CameraConfig = {
  zoom: RENDER_SCALE,
  roundPixels: true,
  scrollX: -GAME_W * (RENDER_SCALE - 1) / 2,
  scrollY: -GAME_H * (RENDER_SCALE - 1) / 2,
}

let hiResTextInstalled = false

// Текст без явного resolution растеризуется в разрешении 1 (Text.js: `if
// (this.style.resolution === 0) this.style.resolution = 1`) — при зуме
// камеры/CSS это мылит шрифт. Патчим фабрику `this.add.text(...)` один раз
// до создания игры: остаётся единственным местом создания текстов в
// кодовой базе (проверено — ни `this.make.text`, ни `new
// Phaser.GameObjects.Text`, ни BitmapText в client/src не используются).
// setStyle/setText не трогают resolution — патч на create() достаточен.
export function installHiResText(): void {
  if (hiResTextInstalled) return
  hiResTextInstalled = true
  const proto = Phaser.GameObjects.GameObjectFactory.prototype
  const orig = proto.text
  proto.text = function (
    this: Phaser.GameObjects.GameObjectFactory,
    x: number,
    y: number,
    text: string | string[],
    style?: Phaser.Types.GameObjects.Text.TextStyle,
  ) {
    return orig.call(this, x, y, text, { resolution: RENDER_SCALE, ...(style ?? {}) })
  }
}

// Даунскейл канваса при CSS-зуме < RENDER_SCALE рвёт штрихи на nearest
// ('pixelated'): переключаем на bilinear ('auto'). cssZoom — то же число, что показывает
// переключатель зума (CSS px на мировой px), см. uiscale.ts.
export function applyCanvasFilter(game: Phaser.Game, cssZoom: number): void {
  const ratio = (cssZoom * devicePixelRatio) / RENDER_SCALE
  game.canvas.style.imageRendering = ratio < 1 ? 'auto' : 'pixelated'
}
