// Шина UI-событий (ITGAME-38): листовой модуль без импортов — audio.ts и
// сцены эмитят, telemetry.ts подписывается и кладёт в кольцевой буфер
// itd.log(). Отдельно от itd.trace (ITGAME-37, следующая задача) — та
// переиспользует эту же шину для команд/снапшотов, здесь только звук/тосты.
// JSON-контракт (ITGAME-39) держит типы экспортируемыми TS-типами.

export type UiEvent =
  | { type: 'sound'; key: string; name: string; volume: number; scene: string; ok: boolean }
  | { type: 'toast'; text: string; where: 'top' | 'bottom'; ms: number; bg: string; scene: string }

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
