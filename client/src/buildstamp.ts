import { client } from './net'

// Штамп сборки вкладки и метка «устарело, обнови» (ITGAME-78). Ретро 10.10:
// вкладка владельца жила на старом JS после перезапуска стенда, и расхождение
// с агентом искали 12 вызовами — глазом оно видно за секунду.
//
// С чем сверяем: со сборкой, которую стенд отдаст при перезагрузке, — sha из
// <meta name="build"> его index.html (vite.config.ts, ITGAME-28). Это ровно
// вопрос «поможет ли F5». sha бинаря сервера (GET /api/version) — справочно и
// запасная опора, когда meta нет; в vite dev (meta нет, JS и так горячий) не
// сверяем вовсе. 'dev'/'unknown' — сборка без git (git archive, go run): сверить
// не с чем, stale null.

export const CLIENT_SHA: string = __BUILD_SHA__

export interface StaleInfo {
  client: string // sha JS этой вкладки (= itd.version.sha)
  server: string | null // sha бинаря сервера (GET /api/version); null — неизвестен
  dist: string | null // sha сборки, которую стенд отдаст при перезагрузке (<meta name="build"> его index.html)
  stale: boolean | null // вкладка на старом JS (client ≠ dist, без dist — ≠ server); null — сверить не с чем
  at: number // epoch ms проверки
}

let last: StaleInfo | null = null
const listeners = new Set<(info: StaleInfo) => void>()

const known = (sha: unknown): string | null =>
  typeof sha === 'string' && sha !== '' && sha !== 'dev' && sha !== 'unknown' ? sha : null

// Короткий sha git может удлинить (неоднозначный префикс) — сверяем по префиксу.
const sameSha = (a: string, b: string): boolean => a.startsWith(b) || b.startsWith(a)

async function serverSha(): Promise<string | null> {
  try {
    const res = await fetch('/api/version', { cache: 'no-store' })
    if (!res.ok) return null
    // прод-nginx отдаёт на /api/* index.html (SPA-фолбэк) — json() упадёт, это «неизвестен»
    return known(((await res.json()) as { sha?: unknown }).sha)
  } catch {
    return null
  }
}

async function distSha(): Promise<string | null> {
  try {
    const res = await fetch('/', { cache: 'no-store' })
    if (!res.ok) return null
    return known(/<meta name="build" content="([^"\s]+)/.exec(await res.text())?.[1])
  } catch {
    return null
  }
}

export function lastStale(): StaleInfo | null {
  return last
}

export async function checkStale(): Promise<StaleInfo> {
  const [server, dist] = await Promise.all([serverSha(), distSha()])
  const ref = dist ?? (import.meta.env.DEV ? null : server)
  const mine = known(CLIENT_SHA)
  last = { client: CLIENT_SHA, server, dist, stale: mine && ref ? !sameSha(mine, ref) : null, at: Date.now() }
  for (const fn of listeners) fn(last)
  return last
}

// Фоновые проверки для метки: при загрузке, при возврате на вкладку, после
// реконнекта сокета (рестарт стенда рвёт WS) и раз в минуту, пока вкладка видна.
export function watchStale(onChange: (info: StaleInfo) => void): void {
  listeners.add(onChange)
  let reconnects = client.stats.reconnects
  let lastAt = 0
  const run = (): void => {
    lastAt = Date.now()
    void checkStale()
  }
  run()
  setInterval(() => {
    if (document.visibilityState !== 'visible') return
    if (client.stats.reconnects !== reconnects && client.socketStatus() === 'open') {
      reconnects = client.stats.reconnects
      run()
    } else if (Date.now() - lastAt >= 60_000) run()
  }, 5000)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastAt >= 10_000) run()
  })
}
