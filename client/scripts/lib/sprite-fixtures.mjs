// sprite-fixtures — тестовые PNG для прогонов конвейера спрайтов против заглушки minipc
// (ITGAME-157): квадрат с обводкой посреди прозрачного поля. По умолчанию цвета из
// sweetie16 (подмножество hd32), так что ревизия чиста по контракту любого ключа;
// fill вне палитры даёт «брак», другой size — bad_size.
import { createHash } from 'node:crypto'
import { PNG } from 'pngjs'

/**
 * @param {{ size: number, frames?: number, fill?: string, outline?: string }} opts — цвета hex без '#'
 * @returns {Buffer}
 */
export function makePng({ size, frames = 1, fill = '41a6f6', outline = '1a1c2c' }) {
  const png = new PNG({ width: size * frames, height: size })
  const rgb = (hex) => [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16))
  const [fr, fg, fb] = rgb(fill)
  const [or, og, ob] = rgb(outline)
  const lo = Math.round(size / 4)
  const hi = size - lo - 1
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size * frames; x++) {
      const fx = x % size
      const i = (y * size * frames + x) * 4
      const inside = fx >= lo && fx <= hi && y >= lo && y <= hi
      const edge = inside && (fx === lo || fx === hi || y === lo || y === hi)
      // Прозрачный пиксель — 0,0,0,0: canvas хранит альфу premultiplied и цвет под
      // нулевой альфой всё равно обнулит, а сверка пикселей должна сойтись байт в байт.
      const [r, g, b] = !inside ? [0, 0, 0] : edge ? [or, og, ob] : [fr, fg, fb]
      png.data[i] = r
      png.data[i + 1] = g
      png.data[i + 2] = b
      png.data[i + 3] = inside ? 255 : 0
    }
  }
  return PNG.sync.write(png)
}

/** sha256 RGBA-пикселей PNG — сверка «текстура во вкладке байт в байт та же». */
export function rgbaSha(buf) {
  return createHash('sha256').update(PNG.sync.read(buf).data).digest('hex')
}

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
