import Phaser from 'phaser'

// Debug-режим — чисто клиентский: живёт в query-строке (?debug=1),
// переживает перезагрузку и шарится ссылкой. Сервер про него не знает.
export const debug = {
  enabled: new URLSearchParams(location.search).get('debug') === '1',
}

export function setDebug(on: boolean): void {
  debug.enabled = on
  const url = new URL(location.href)
  if (on) url.searchParams.set('debug', '1')
  else url.searchParams.delete('debug')
  history.replaceState(null, '', url)
}

// Красные рамки вокруг интерактивных объектов — границы кликабельных зон.
// Возвращает созданные рамки: сцена уничтожает их вместе с объектами перерисовки.
export function drawDebugFrames(
  scene: Phaser.Scene,
  objects: Phaser.GameObjects.GameObject[],
): Phaser.GameObjects.GameObject[] {
  if (!debug.enabled) return []
  const frames: Phaser.GameObjects.GameObject[] = []
  for (const o of objects) {
    if (!o.input?.enabled) continue
    const b = (o as unknown as { getBounds(): Phaser.Geom.Rectangle }).getBounds()
    frames.push(
      scene.add.rectangle(b.x, b.y, b.width, b.height).setOrigin(0).setStrokeStyle(2, 0xff0000).setDepth(90),
    )
  }
  return frames
}
