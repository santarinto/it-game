// Шина UI-событий: листовой модуль без импортов. Несёт звук, тосты (ITGAME-38)
// и сигнал 'key' — факт, что сцена реально отработала клавишу (ITGAME-37), и итог загрузки шрифтов 'font' (ITGAME-48).
// audio.ts и сцены эмитят, telemetry.ts подписывается и кладёт в кольцевой
// буфер itd.log(); itd.trace берёт отсюда звук/тосты/'key', а команды и
// входящие читает через tapWire, не через эту шину.
// JSON-контракт (ITGAME-39) держит типы экспортируемыми TS-типами.

export type UiEvent =
  | { type: 'sound'; key: string; name: string; volume: number; scene: string; ok: boolean }
  | { type: 'toast'; text: string; where: 'top' | 'bottom'; ms: number; bg: string; scene: string }
  // сцена реально отработала клавишу (обработчик прошёл свои guard'ы); key — имя
  // Phaser (ENTER/SPACE/ESC/ONE…), action — что сделано
  | { type: 'key'; key: string; scene: string; action: string }
  // загрузка шрифтов в BootScene (ITGAME-48): ok:false — таймаут/ошибка, font — итоговый стек
  | { type: 'font'; ok: boolean; ms: number; faces: string[]; font: string; reason?: string }

const listeners = new Set<(e: UiEvent) => void>()

export function onUi(fn: (e: UiEvent) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function emitUi(e: UiEvent): void {
  for (const fn of listeners) {
    try {
      fn(e)
    } catch (err) {
      // слушатель не должен ронять эмиттера (звук/тост уже случились)
      console.error('[uibus] слушатель упал:', err)
    }
  }
}
