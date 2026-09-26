// Размер игрового поля — единственное место, где он задан.
// Сцены строят раскладку от этих констант.
export const GAME_W = 1280
export const GAME_H = 720
export const HUD_H = 96
export const NAV_W = 64 // левая панель навигации: офисы и серверная

// Строка верхней панели HUD (ITGAME-16): монопробельные строки непредсказуемой
// длины («Сотрудники: 15 · в сети 15/15»), магические x=16/200 накладывали их
// друг на друга. Раскладывает тексты слева направо от startX по фактическим
// ширинам; возвращает правый край строки.
import type Phaser from 'phaser'

export function layoutRow(
  startX: number,
  gap: number,
  texts: Phaser.GameObjects.Text[],
  maxRight = Infinity,
): number {
  // Правая граница: если с заданным gap строка не влезает, сжимаем gap
  // (не меньше 4px) — строки панели неприличной длины прижимаются, но не
  // наезжают на кнопки.
  const total = texts.reduce((s, t) => s + t.width, 0)
  const gaps = texts.length - 1
  const g = gaps > 0
    ? Math.max(4, Math.min(gap, (maxRight - startX - total) / gaps))
    : gap
  let x = startX
  for (const t of texts) {
    t.setX(x)
    x += t.width + g
  }
  return texts.length > 0 ? x - g : startX
}

// Ряды сверху вниз от startY; высота ряда = max(t.height). Тексты с originY=0.
// Если не влезает в maxBottom — gap сжимается до 0; колонка вверх не сдвигается,
// возвращённый низ последнего ряда тогда > maxBottom (это ловит QA).
export function layoutColumn(startY: number, rows: Phaser.GameObjects.Text[][], gap: number, maxBottom = Infinity): number {
  const hs = rows.map((r) => r.reduce((m, t) => Math.max(m, t.height), 0))
  const total = hs.reduce((s, h) => s + h, 0), gaps = rows.length - 1
  const g = gaps > 0 ? Math.max(0, Math.floor(Math.min(gap, (maxBottom - startY - total) / gaps))) : 0
  let y = startY
  rows.forEach((row, i) => { for (const t of row) t.setY(y); y += hs[i] + g })
  return rows.length ? y - g : startY
}
