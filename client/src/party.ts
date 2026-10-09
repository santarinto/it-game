import { nav } from './rooms'
import { resetOngoingStatsThrottle } from './meta'

// Единственная точка сброса клиентского состояния ПАРТИИ (ITGAME-47): зовётся
// из MenuScene.startGame только на новой партии (fresh), не на «Продолжить».
// Поля сцен сюда не входят — их инициализирует create() каждой сцены.
// Намеренно НЕ сбрасываются: sid (prepareNewGame() в net.ts), масштаб UI,
// хинты, skipReports, мета-статистика и достижения (это игрок/вкладка, не партия).
export function resetForNewGame(): void {
  nav.activeOffice = 0 // ITGAME-41: новая партия открывалась в закрытом О2/О3
  resetOngoingStatsThrottle()
}
