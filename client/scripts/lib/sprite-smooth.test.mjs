import assert from 'node:assert/strict'
import { test } from 'node:test'
import { smoothFit } from './sprite-smooth.mjs'

// w×h, всё прозрачно (RGB белый — проверка, что прозрачное не подмешивается в цвет)
function blank(w, h) {
  const data = new Uint8Array(w * h * 4)
  for (let i = 0; i < data.length; i += 4) data.set([255, 255, 255, 0], i)
  return { width: w, height: h, data }
}
function fill(img, x0, y0, x1, y1, rgba) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) img.data.set(rgba, (y * img.width + x) * 4)
}
const px = (img, x, y) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)]
function bbox(img) {
  let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (px(img, x, y)[3] >= 26) {
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y)
      }
    }
  }
  return { x0, y0, x1, y1 }
}

test('сплошной квадрат с нецелым шагом 2.5 — весь холст того же цвета, альфа 255', () => {
  const src = blank(40, 40)
  fill(src, 10, 10, 30, 30, [200, 50, 20, 255])
  const { png, scale } = smoothFit(src, { size: 8, margin: 0 })
  assert.equal(scale, 2.5)
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) assert.deepEqual(px(png, x, y), [200, 50, 20, 255])
})

test('прозрачные пиксели не подмешивают свой RGB: край — тот же цвет, полутон альфы', () => {
  const src = blank(4, 2)
  fill(src, 0, 0, 1, 2, [200, 50, 20, 255]) // столбец 0 — красный, столбцы 1..3 — прозрачный белый
  fill(src, 3, 0, 4, 2, [200, 50, 20, 255]) // столбец 3 — красный (bbox 4×2)
  const { png } = smoothFit(src, { size: 2, margin: 0, alpha: 128 })
  // квадрат 4×4 вокруг bbox 4×2 прижат к низу: верхняя строка пустая, нижняя — смесь
  const [r, g, b, a] = px(png, 0, 1)
  assert.deepEqual([r, g, b], [200, 50, 20])
  assert.equal(a, 128)
})

test('высокий предмет — по центру X, прижат к низу с полем margin', () => {
  const src = blank(30, 30)
  fill(src, 5, 0, 15, 20, [10, 200, 10, 255]) // bbox 10×20
  const { png } = smoothFit(src, { size: 24, margin: 2 })
  const bb = bbox(png)
  assert.equal(bb.y1, 24 - 2 - 1) // низ на поле
  assert.equal(bb.y0, 2) // высота заняла весь inner
  assert.equal(bb.x0 + bb.x1, 23) // симметрично по X
})

test('хромакей: маджента вокруг предмета вырезается до прозрачности', () => {
  const src = blank(20, 20)
  fill(src, 0, 0, 20, 20, [255, 0, 255, 255])
  fill(src, 5, 5, 15, 15, [250, 200, 80, 255])
  const { png } = smoothFit(src, { size: 10, margin: 0, chroma: 'ff00ff' })
  assert.deepEqual(px(png, 5, 5), [250, 200, 80, 255])
  const noMagenta = [...Array(100).keys()].every((i) => {
    const [r, g, b, a] = px(png, i % 10, Math.floor(i / 10))
    return a < 26 || !(r > 200 && g < 60 && b > 200)
  })
  assert.ok(noMagenta)
})

test('почти прозрачное (альфа < 26) обнуляется целиком — контракт считает это фоном', () => {
  const src = blank(10, 10)
  fill(src, 0, 0, 10, 10, [255, 255, 255, 10])
  fill(src, 2, 2, 8, 8, [0, 0, 0, 255])
  const { png } = smoothFit(src, { size: 6, margin: 0 })
  for (let i = 0; i < png.data.length; i += 4) {
    if (png.data[i + 3] < 26) assert.deepEqual([...png.data.subarray(i, i + 4)], [0, 0, 0, 0])
  }
})

test('пустой вход — ошибка с причиной', () => {
  assert.throws(() => smoothFit(blank(8, 8), { size: 16 }), /ни одного пикселя с альфой >= 128/)
})

test("chroma 'auto': фон берётся по углам, шум JPEG в пределах допуска вырезается", () => {
  const src = blank(40, 40)
  fill(src, 0, 0, 40, 40, [40, 45, 61, 255])
  fill(src, 0, 0, 3, 3, [46, 41, 66, 255]) // шум в одном углу — в пределах tol
  fill(src, 10, 10, 30, 30, [60, 180, 250, 255])
  const { png, chroma } = smoothFit(src, { size: 8, margin: 0, chroma: 'auto' })
  assert.match(chroma, /^[0-9a-f]{6}$/)
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) assert.deepEqual(px(png, x, y), [60, 180, 250, 255])
})

test("chroma 'auto' на входе с прозрачными углами — ключ не нужен, chroma: null", () => {
  const src = blank(40, 40)
  fill(src, 15, 15, 25, 25, [10, 10, 10, 255]) // тёмный предмет не должен вырезаться
  const { png, chroma } = smoothFit(src, { size: 10, margin: 0, chroma: 'auto' })
  assert.equal(chroma, null)
  assert.deepEqual(px(png, 5, 5), [10, 10, 10, 255])
})

test("chroma 'auto': углы разного цвета — отказ, а не вырезка наугад", () => {
  const src = blank(40, 40)
  fill(src, 0, 0, 40, 20, [255, 0, 255, 255])
  fill(src, 0, 20, 40, 40, [255, 255, 255, 255])
  assert.throws(() => smoothFit(src, { size: 8, margin: 0, chroma: 'auto' }), /углы/)
})

test("chroma 'auto': часть углов прозрачна, часть нет — отказ", () => {
  const src = blank(40, 40)
  fill(src, 0, 0, 40, 20, [255, 0, 255, 255])
  assert.throws(() => smoothFit(src, { size: 8, margin: 0, chroma: 'auto' }), /углы/)
})

test("chroma 'auto': светлая полоса шва по краю кадра не мешает углам и не раздувает bbox", () => {
  const src = blank(64, 64)
  fill(src, 0, 0, 64, 64, [40, 45, 61, 255])
  fill(src, 0, 0, 1, 64, [125, 128, 147, 255]) // шов по левому краю
  fill(src, 0, 0, 64, 2, [100, 104, 122, 255]) // и по верхнему
  fill(src, 16, 16, 48, 48, [60, 180, 250, 255])
  const { png, bbox } = smoothFit(src, { size: 8, margin: 0, chroma: 'auto' })
  assert.deepEqual(bbox, { x: 16, y: 16, w: 32, h: 32 })
  assert.deepEqual(px(png, 0, 0), [60, 180, 250, 255])
})

test("chroma 'auto': допуск по шуму фона — тёмный контур рядом с цветом фона не вырезается", () => {
  const src = blank(64, 64)
  fill(src, 0, 0, 64, 64, [48, 48, 60, 255])
  for (let i = 0; i < 64; i += 2) fill(src, i, 0, i + 1, 64, [52, 50, 66, 255]) // шум фона ~7
  fill(src, 16, 16, 48, 48, [22, 23, 29, 255]) // контур: ~48 от фона
  fill(src, 20, 20, 44, 44, [240, 220, 190, 255])
  const { png, chromaTol } = smoothFit(src, { size: 8, margin: 0, chroma: 'auto' })
  assert.ok(chromaTol >= 12 && chromaTol < 30, `chromaTol=${chromaTol}`)
  assert.deepEqual(px(png, 0, 0), [22, 23, 29, 255]) // угол предмета — контур, не дыра
})
