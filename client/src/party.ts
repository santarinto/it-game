import { nav } from './rooms'
import { resetOngoingStatsThrottle } from './meta'

// Единственная точка сброса клиентского состояния ПАРТИИ (ITGAME-47). Зовётся
// в трёх местах:
//  1. MenuScene.startGame — новая партия (fresh), не «Продолжить»;
//  2. net.ts — первый снапшот сокета с resumed: false: сервер не нашёл сейв и
//     начал новую партию под тем же sid («Продолжить» на истёкшем/удалённом, ITGAME-54);
//  3. itd.scenario() в agentApi.ts — отладочная партия, пересозданная фикстурой (ITGAME-55).
// Поля сцен сюда не входят — их инициализирует create() каждой сцены. Сцены, что живут
// между партиями (HUD), подписываются через onPartyReset и сбрасывают себя сами: оверлеи
// отчёта, события, «Пока вас не было», финала, окно выхода и учёт паузы отчёта (ITGAME-64).
// Намеренно НЕ сбрасываются: sid (prepareNewGame() в net.ts), масштаб UI,
// хинты, skipReports, мета-статистика и достижения (это игрок/вкладка, не партия).
export function resetForNewGame(): void {
  nav.activeOffice = 0 // ITGAME-41: новая партия открывалась в закрытом О2/О3
  resetOngoingStatsThrottle()
  // Слушатель не должен ломать вызывающего: net.ts зовёт сброс до раздачи снапшота.
  for (const fn of resetListeners) {
    try {
      fn()
    } catch (e) {
      console.error('[party] reset', e)
    }
  }
}

const resetListeners = new Set<() => void>()

// Подписка на сброс партии (ITGAME-64). Возвращает функцию отписки.
export function onPartyReset(fn: () => void): () => void {
  resetListeners.add(fn)
  return () => {
    resetListeners.delete(fn)
  }
}

// Ставится только itd.scenario() на время POST (ITGAME-64): сервер присылает снапшот
// новой партии РАНЬШЕ ответа на HTTP-вызов, и HUD не должен «вернуть» на нём скорость
// из учёта паузы отчёта старой партии. Полный сброс HUD идёт сразу после ответа.
export const partyChange = { pending: false }
