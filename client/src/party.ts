import { nav } from './rooms'
import { resetOngoingStatsThrottle } from './meta'

// Единственная точка сброса клиентского состояния ПАРТИИ (ITGAME-47). Зовётся
// в трёх местах:
//  1. MenuScene.startGame — новая партия (fresh), не «Продолжить»;
//  2. net.ts — первый снапшот сокета с resumed: false: сервер не нашёл сейв и
//     начал новую партию под тем же sid («Продолжить» на истёкшем/удалённом, ITGAME-54);
//  3. itd.scenario() в agentApi.ts — отладочная партия, пересозданная фикстурой (ITGAME-55).
// Поля сцен сюда не входят — их инициализирует create() каждой сцены.
// Намеренно НЕ сбрасываются: sid (prepareNewGame() в net.ts), масштаб UI,
// хинты, skipReports, мета-статистика и достижения (это игрок/вкладка, не партия).
export function resetForNewGame(): void {
  nav.activeOffice = 0 // ITGAME-41: новая партия открывалась в закрытом О2/О3
  resetOngoingStatsThrottle()
}
