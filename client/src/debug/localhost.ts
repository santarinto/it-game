// Локальный ли хост страницы (ITGAME-194): чит денег ставится только тут. Та же
// граница, что у сервера (localRequest в server/internal/ws/cheat.go); сервер всё
// равно проверяет сам — это лишь не показывать cheat там, где он откажет.
export function isLocalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost')
}
