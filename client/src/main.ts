import Phaser from 'phaser'
import { CANVAS_H, CANVAS_W, RENDER_SCALE, applyCanvasFilter, installHiResText } from './render'
import { watchFit, zoomNumber } from './uiscale'
import { BootScene } from './scenes/BootScene'
import { MenuScene } from './scenes/MenuScene'
import { HUDScene } from './scenes/HUDScene'
import { OfficeScene } from './scenes/OfficeScene'
import { ServerRoomScene } from './scenes/ServerRoomScene'
import { installAgentApi } from './debug/agentApi'
import { debug } from './debug'
import { client } from './net'

// «Админка» (ITGAME-22): только владельцу — ?admin=1 запоминает флаг, ?admin=0 снимает; в debug видна всегда.
function adminLinkWanted(): boolean {
  const url = new URL(location.href)
  const q = url.searchParams.get('admin')
  if (q !== null) { url.searchParams.delete('admin'); history.replaceState(history.state, '', url) }
  try {
    if (q === '1') localStorage.setItem('itd.admin', '1')
    else if (q === '0') localStorage.removeItem('itd.admin')
    return debug.enabled || localStorage.getItem('itd.admin') === '1'
  } catch { return debug.enabled || q === '1' }
}
if (adminLinkWanted()) {
  const bar = document.createElement('div'); bar.id = 'topbar'
  const a = document.createElement('a'); a.href = '/admin'; a.target = '_blank'; a.textContent = 'Админка'
  bar.append(a); document.body.prepend(bar)
}

// Рендер 2× (render.ts): патч фабрики текстов должен стоять до создания
// игры/сцен — иначе первые this.add.text() в BootScene/MenuScene создались
// бы ещё с resolution по умолчанию (1).
installHiResText()

const game = new Phaser.Game({
  type: Phaser.AUTO,
  width: CANVAS_W,
  height: CANVAS_H,
  parent: 'app',
  pixelArt: true, // чёткие пиксели без сглаживания
  backgroundColor: '#1a1c2c',
  // Зум канваса (ITGAME-15): NONE — внутренние размеры не трогаем, только
  // CSS-масштаб. «Зум» — CSS px на мировой px; при RENDER_SCALE=2 канвас
  // вдвое больше мира, так что CSS-зум канваса делится на RENDER_SCALE
  // (см. uiscale.setCssZoom). Значение из localStorage, дефолт 1.4.
  scale: {
    mode: Phaser.Scale.NONE,
    zoom: zoomNumber() / RENDER_SCALE,
  },
  scene: [BootScene, MenuScene, OfficeScene, ServerRoomScene, HUDScene],
})
watchFit(game)
applyCanvasFilter(game, zoomNumber())

// Хук смоук-теста/отладки (client/scripts/smoke-ui.mjs ждёт старта menu):
// без него на странице нет DOM-следа того, что игра жива (инцидент ITGAME-11).
;(window as unknown as { __itd: Phaser.Game }).__itd = game

// Агентский фасад window.itd (ITGAME-24): dev всегда, прод — ?debug=1.
installAgentApi(game)

// Кэш «назад/вперёд» (ITGAME-19): уходя в bfcache, страница отпускает сессию
// (client.suspend — иначе партия тикает онлайн без игрока); вернувшись —
// подключается снова, а меню перечитывает сводку сейва: пока страница спала,
// день и баланс ушли вперёд.
addEventListener('pagehide', (e) => {
  if (e.persisted) client.suspend()
})
addEventListener('pageshow', (e) => {
  if (!e.persisted) return
  client.resume()
  if (game.scene.isActive('menu')) game.scene.getScene('menu').scene.restart()
})
