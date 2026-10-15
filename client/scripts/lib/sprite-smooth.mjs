// sprite-smooth — приведение произвольной картинки (генерация модели, 512…1024 px, без
// сетки) к холсту size×size для спрайта render: 'smooth' (ITGAME-83). Без node:* — чистая
// функция над RGBA-буфером, как sprite-check-core.
//
// Шаги:
//   1. (опционально) хромакей: пиксели ближе chromaTol к цвету chroma — прозрачные
//      (фон диффузии, которая не умеет альфу: #ff00ff в промте); chroma 'auto' берёт
//      цвет по углам (в EDGE px от края) и снимает рамку EDGE со швом генератора,
//      а на входе с прозрачными углами ключ пропускает;
//   2. bbox по альфе >= alpha — полупрозрачный ореол вырезки рамку не раздувает;
//   3. квадрат со стороной max(bbox) вокруг bbox: по X по центру, по Y прижат к низу —
//      общая базовая линия набора; вписывается в size − 2·margin;
//   4. площадная выборка: каждый пиксель холста — среднее по своему прямоугольнику
//      исходника с дробными краями (шаг нецелый: 610/56 ≈ 10.9), цвет взвешен альфой —
//      прозрачный белый с вырезки не осветляет край;
//   5. альфа < 26 обнуляется вместе с RGB: контракт считает её фоном.
// Палитра и порог альфы НЕ применяются — полутоны и есть смысл smooth.

const BG_ALPHA = 26 // как в sprite-check-core: ниже — прозрачный пиксель
const EDGE = 4 // chroma 'auto': отступ углов от края и снимаемая рамка (шов генератора)

/**
 * @param {{width:number, height:number, data:Uint8Array|Buffer}} src RGBA
 * @param {{size:number, margin?:number, alpha?:number, chroma?:string|'auto', chromaTol?:number}} opts
 * @returns {{png:{width:number,height:number,data:Uint8Array}, bbox:{x:number,y:number,w:number,h:number}, scale:number, chroma:string|null}}
 */
export function smoothFit(src, opts) {
  const { size } = opts
  const margin = opts.margin ?? 4
  const alpha = opts.alpha ?? 128
  const inner = size - 2 * margin
  if (!(inner > 0)) throw new Error(`margin ${margin} не оставляет места в холсте ${size}`)
  const { width: W, height: H } = src
  const data = Uint8Array.from(src.data)

  const tol = opts.chromaTol ?? 48
  const chroma = opts.chroma === 'auto' ? cornerChroma(src, tol) : (opts.chroma ?? null)
  if (chroma && opts.chroma === 'auto') {
    // шов генератора: светлая полоса в 1–2 px по краю непрозрачного кадра — рамку EDGE снимаем
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (x < EDGE || y < EDGE || x >= W - EDGE || y >= H - EDGE) data[(y * W + x) * 4 + 3] = 0
      }
    }
  }
  if (chroma) {
    const [cr, cg, cb] = [0, 2, 4].map((i) => parseInt(chroma.slice(i, i + 2), 16))
    const tol2 = tol ** 2
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
  return { png: { width: size, height: size, data: out }, bbox: { x: x0, y: y0, w: bw, h: bh }, scale: k, chroma }
}

// chroma 'auto': цвет фона — среднее по четырём угловым квадратам (сторона 1/32 меньшей
// стороны, не меньше 4 px) с отступом EDGE от края: у JPEG grok по краю кадра идёт
// светлая полоса шва, сам фон за ней ровный. Все углы прозрачны — вход уже с альфой, ключ не нужен (null).
// Угол пёстрый, углы разного цвета или прозрачны не все — отказ: резать наугад хуже,
// чем назвать --chroma руками.
function cornerChroma(src, tol) {
  const { width: W, height: H, data } = src
  const n = Math.max(4, Math.round(Math.min(W, H) / 32))
  const corners = [[EDGE, EDGE], [W - n - EDGE, EDGE], [EDGE, H - n - EDGE], [W - n - EDGE, H - n - EDGE]].map(([cx, cy]) => {
    const px = []
    for (let y = cy; y < cy + n; y++) for (let x = cx; x < cx + n; x++) px.push(data.subarray((y * W + x) * 4, (y * W + x) * 4 + 4))
    const clear = px.filter((p) => p[3] < BG_ALPHA).length
    if (clear === px.length) return null
    if (clear > 0) throw new Error('chroma auto: угол наполовину прозрачен — укажите --chroma RRGGBB')
    const mean = [0, 1, 2].map((c) => px.reduce((s, p) => s + p[c], 0) / px.length)
    if (px.some((p) => dist(p, mean) > tol)) throw new Error('chroma auto: угол пёстрый, фон не однотонный — укажите --chroma RRGGBB')
    return mean
  })
  const solid = corners.filter(Boolean)
  if (solid.length === 0) return null
  if (solid.length < 4) throw new Error('chroma auto: углы прозрачны не все — укажите --chroma RRGGBB')
  const mean = [0, 1, 2].map((c) => solid.reduce((s, m) => s + m[c], 0) / 4)
  if (solid.some((m) => dist(m, mean) > tol / 2)) throw new Error('chroma auto: углы разного цвета — укажите --chroma RRGGBB')
  return mean.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
}

function dist(p, q) {
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
}
