// sprite-smooth — приведение произвольной картинки (генерация модели, 512…1024 px, без
// сетки) к холсту size×size для спрайта render: 'smooth' (ITGAME-83). Без node:* — чистая
// функция над RGBA-буфером, как sprite-check-core.
//
// Шаги:
//   1. (опционально) хромакей: пиксели ближе chromaTol к цвету chroma — прозрачные
//      (фон диффузии, которая не умеет альфу: #ff00ff в промте);
//   2. bbox по альфе >= alpha — полупрозрачный ореол вырезки рамку не раздувает;
//   3. квадрат со стороной max(bbox) вокруг bbox: по X по центру, по Y прижат к низу —
//      общая базовая линия набора; вписывается в size − 2·margin;
//   4. площадная выборка: каждый пиксель холста — среднее по своему прямоугольнику
//      исходника с дробными краями (шаг нецелый: 610/56 ≈ 10.9), цвет взвешен альфой —
//      прозрачный белый с вырезки не осветляет край;
//   5. альфа < 26 обнуляется вместе с RGB: контракт считает её фоном.
// Палитра и порог альфы НЕ применяются — полутоны и есть смысл smooth.

const BG_ALPHA = 26 // как в sprite-check-core: ниже — прозрачный пиксель

/**
 * @param {{width:number, height:number, data:Uint8Array|Buffer}} src RGBA
 * @param {{size:number, margin?:number, alpha?:number, chroma?:string, chromaTol?:number}} opts
 * @returns {{png:{width:number,height:number,data:Uint8Array}, bbox:{x:number,y:number,w:number,h:number}, scale:number}}
 */
export function smoothFit(src, opts) {
  const { size } = opts
  const margin = opts.margin ?? 4
  const alpha = opts.alpha ?? 128
  const inner = size - 2 * margin
  if (!(inner > 0)) throw new Error(`margin ${margin} не оставляет места в холсте ${size}`)
  const { width: W, height: H } = src
  const data = Uint8Array.from(src.data)

  if (opts.chroma) {
    const [cr, cg, cb] = [0, 2, 4].map((i) => parseInt(opts.chroma.slice(i, i + 2), 16))
    const tol2 = (opts.chromaTol ?? 48) ** 2
    for (let i = 0; i < data.length; i += 4) {
      const dr = data[i] - cr
      const dg = data[i + 1] - cg
      const db = data[i + 2] - cb
      if (dr * dr + dg * dg + db * db <= tol2) data[i + 3] = 0
    }
  }

  let x0 = W
  let y0 = H
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (data[(y * W + x) * 4 + 3] >= alpha) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  if (x1 < 0) throw new Error(`ни одного пикселя с альфой >= ${alpha} — вход пуст или весь вырезан хромакеем`)
  const bw = x1 - x0 + 1
  const bh = y1 - y0 + 1
  const side = Math.max(bw, bh)
  const k = side / inner
  const ox = x0 - (side - bw) / 2
  const oy = y0 - (side - bh)

  const out = new Uint8Array(size * size * 4)
  const area = k * k
  for (let Y = 0; Y < inner; Y++) {
    const sy0 = oy + Y * k
    const sy1 = sy0 + k
    for (let X = 0; X < inner; X++) {
      const sx0 = ox + X * k
      const sx1 = sx0 + k
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = Math.max(0, Math.floor(sy0)); sy < Math.min(H, Math.ceil(sy1)); sy++) {
        const cy = Math.min(sy + 1, sy1) - Math.max(sy, sy0)
        for (let sx = Math.max(0, Math.floor(sx0)); sx < Math.min(W, Math.ceil(sx1)); sx++) {
          const cov = cy * (Math.min(sx + 1, sx1) - Math.max(sx, sx0))
          const i = (sy * W + sx) * 4
          const wa = (data[i + 3] / 255) * cov
          r += data[i] * wa
          g += data[i + 1] * wa
          b += data[i + 2] * wa
          a += wa
        }
      }
      const A = Math.round((a / area) * 255)
      if (A < BG_ALPHA) continue
      const di = ((Y + margin) * size + X + margin) * 4
      out[di] = Math.round(r / a)
      out[di + 1] = Math.round(g / a)
      out[di + 2] = Math.round(b / a)
      out[di + 3] = A
    }
  }
  return { png: { width: size, height: size, data: out }, bbox: { x: x0, y: y0, w: bw, h: bh }, scale: k }
}
