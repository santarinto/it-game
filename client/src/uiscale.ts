import Phaser from 'phaser'
import { GAME_H, GAME_W } from './layout'

// Масштаб UI (ITGAME-15, ревью веб-агента): канвас жёстко 1280×720 CSS-пикселей
// и на больших мониторах крошечный. Зумим канвас целиком (CSS-масштаб при
// pixelArt читается нормально — проверено агентом живьём; честный путь с
// перерисовкой текстов в нативном разрешении отдельным шагом, если приёмка
// покажет мыло). Центрирование — CSS-флекс #app (index.html), autoCenter Phaser
// не используется: он работает через margin и конфликтует с flex-родителем.
export const ZOOM_KEY = 'itd.uiScale'
export const FIT = 'fit' // «по окну»: зум = min(w/1280, h/720), живой resize
export type ZoomValue = 1 | 1.4 | 2 | typeof FIT

export const ZOOM_OPTIONS: { value: ZoomValue; label: string }[] = [
  { value: 1, label: '1×' },
  { value: 1.4, label: '1.4×' },
  { value: 2, label: '2×' },
  { value: FIT, label: 'по окну' },
]

const DEFAULT_ZOOM: ZoomValue = 1.4

export function activeZoom(): ZoomValue {
  const raw = localStorage.getItem(ZOOM_KEY)
  if (raw === FIT) return FIT
  const n = Number(raw)
  if (n === 1 || n === 1.4 || n === 2) return n
  return DEFAULT_ZOOM
}

// «По окну»: вписать канвас во вьюпорт. Над #app висит topbar — резервируем
// его фактическую высоту + паддинг #app и запас.
export function fitZoom(): number {
  const topbar = document.getElementById('topbar')
  const reserveY = (topbar?.offsetHeight ?? 34) + 16
  return Math.max(Math.min((innerWidth - 8) / GAME_W, (innerHeight - reserveY) / GAME_H), 0.5)
}

export function zoomNumber(): number {
  const v = activeZoom()
  return v === FIT ? fitZoom() : v
}

export function applyZoom(game: Phaser.Game, v: ZoomValue): void {
  localStorage.setItem(ZOOM_KEY, String(v))
  game.scale.setZoom(v === FIT ? fitZoom() : v)
}

export function zoomLabel(v: ZoomValue): string {
  return ZOOM_OPTIONS.find((o) => o.value === v)?.label ?? '1.4×'
}

// Живой resize в режиме «по окну»: один слушатель на время жизни игры.
export function watchFit(game: Phaser.Game): void {
  if (watched) return
  watched = game
  addEventListener('resize', () => {
    if (activeZoom() === FIT) game.scale.setZoom(fitZoom())
  })
}

let watched: Phaser.Game | null = null
