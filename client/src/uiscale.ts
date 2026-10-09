import Phaser from 'phaser'
import { GAME_H, GAME_W } from './layout'
import { RENDER_SCALE, applyCanvasFilter } from './render'

// Масштаб UI (ITGAME-15, ревью веб-агента): канвас жёстко 1280×720 CSS-пикселей
// и на больших мониторах крошечный. Зумим канвас целиком (CSS-масштаб при
// pixelArt читается нормально — проверено агентом живьём; честный путь с
// перерисовкой текстов в нативном разрешении отдельным шагом, если приёмка
// покажет мыло). Центрирование — CSS-флекс #app (index.html), autoCenter Phaser
// не используется: он работает через margin и конфликтует с flex-родителем.
// ITGAME-61: 2× убран — на 2× канвас шире окна ноутбука и #app скроллится вбок;
// большие экраны покрывает «по окну».
export const ZOOM_KEY = 'itd.uiScale'
export const FIT = 'fit' // «по окну»: зум = min(w/1280, h/720), живой resize
export type ZoomValue = 1 | 1.4 | typeof FIT

export const ZOOM_OPTIONS: { value: ZoomValue; label: string }[] = [
  { value: 1, label: '1×' },
  { value: 1.4, label: '1.4×' },
  { value: FIT, label: 'по окну' },
]

const DEFAULT_ZOOM: ZoomValue = 1.4

export function activeZoom(): ZoomValue {
  const raw = localStorage.getItem(ZOOM_KEY)
  if (raw === FIT) return FIT
  if (raw === '2') {
    // 2× убран из цикла (ITGAME-61): «по окну» — самый крупный масштаб, что влезает в окно.
    // Переписываем ключ, чтобы миграция была одноразовой.
    // Запись в try/catch: activeZoom() вызывается при старте, а хранилище может быть
    // закрыто на запись или переполнено — миграция не должна ронять загрузку.
    try {
      localStorage.setItem(ZOOM_KEY, FIT)
    } catch {
      // не вышло — вернём FIT всё равно, перепишем при следующем запуске
    }
    return FIT
  }
  const n = Number(raw)
  if (n === 1 || n === 1.4) return n
  return DEFAULT_ZOOM
}

// «По окну»: вписать канвас во вьюпорт. topbar есть только у владельца/в debug
// (ITGAME-22) — если он есть, резервируем его фактическую высоту + паддинг
// #app и запас; иначе только паддинг.
export function fitZoom(): number {
  const topbar = document.getElementById('topbar')
  const reserveY = (topbar?.offsetHeight ?? 0) + 16
  return Math.max(Math.min((innerWidth - 8) / GAME_W, (innerHeight - reserveY) / GAME_H), 0.5)
}

export function zoomNumber(): number {
  const v = activeZoom()
  return v === FIT ? fitZoom() : v
}

// «Зум» всюду в этом модуле — CSS px на мировой (1280×720) px, как в
// подписях переключателя. Канвас — RENDER_SCALE раз больше мира (render.ts),
// поэтому CSS-зум самого канваса (Phaser scale.zoom) — z/RENDER_SCALE; заодно
// пересчитываем image-rendering (нужен bilinear при сильном даунскейле).
export function setCssZoom(game: Phaser.Game, z: number): void {
  game.scale.setZoom(z / RENDER_SCALE)
  applyCanvasFilter(game, z)
}

export function applyZoom(game: Phaser.Game, v: ZoomValue): void {
  localStorage.setItem(ZOOM_KEY, String(v))
  setCssZoom(game, v === FIT ? fitZoom() : v)
}

export function zoomLabel(v: ZoomValue): string {
  return ZOOM_OPTIONS.find((o) => o.value === v)?.label ?? '1.4×'
}

// Живой resize в режиме «по окну»: один слушатель на время жизни игры.
// Ctrl± меняет devicePixelRatio без смены зума из настроек — фильтр канваса
// пересчитываем при любом resize, зум камеры трогаем только в режиме «по окну».
export function watchFit(game: Phaser.Game): void {
  if (watched) return
  watched = game
  addEventListener('resize', () => {
    if (activeZoom() === FIT) setCssZoom(game, fitZoom())
    else applyCanvasFilter(game, zoomNumber())
  })
}

let watched: Phaser.Game | null = null
