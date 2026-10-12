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

// Глубина, на которой объект рисуется в своей сцене: у вложенного в контейнер —
// глубина корневого контейнера (как stackTarget/interactiveIn в debug/agentApi.ts).
function drawDepth(o: Phaser.GameObjects.GameObject): number {
  let root: Phaser.GameObjects.GameObject = o
  while (root.parentContainer) root = root.parentContainer
  const d = (root as unknown as { depth?: number }).depth
  return typeof d === 'number' ? d : 0
}

// Красные рамки вокруг интерактивных объектов — границы кликабельных зон.
// ITGAME-84: рамка лежит сразу над своим объектом — его depth + 0.5, а не на общем
// depth 90. Слои игры целые (событие 40-42, отчёт 50-53, офлайн 55-57, финал 60-62,
// окна modal.ts 70-73, реконнект 90-91, тосты 100), так что рамка ниже следующего
// слоя: окно, открытое поверх, накрывает рамки кнопок под своей подложкой вместе с
// кнопками (видны затемнёнными), рамки кнопок самого окна — над подложкой. Перерисовки
// на открытие/закрытие окна не нужно. data 'debugFrame' — объект рамки (qa:slots
// сверяет глубины через window.__itd).
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
      scene.add.rectangle(b.x, b.y, b.width, b.height).setOrigin(0).setStrokeStyle(2, 0xff0000)
        .setDepth(drawDepth(o) + 0.5).setData('debugFrame', o),
    )
  }
  return frames
}
