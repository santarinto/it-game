// chrome — закреплённый браузер для smoke-ui, qa:* и visreg (ITGAME-48).
//
// Раньше каждый скрипт искал Chromium сам: CHROME_PATH, иначе системный
// /usr/bin/chromium… Версия плыла вместе с ОС (Arch обновляет chromium
// раз в неделю, раннер CI — свой Google Chrome), и эталоны visreg
// расходились на 0.7–1.3% без единой правки UI. Теперь браузер — Chrome for
// Testing фиксированной версии из @puppeteer/browsers, версия задана здесь
// (CHROME_BUILD) и только здесь: её ставит `npm run browser:install` (локально
// и в CI), её же находит chromePath().
//
// Порядок поиска:
//  1. CHROME_PATH — явное переопределение, берётся как есть (без проверки
//     версии): отладка на другом браузере, нестандартный образ;
//  2. закреплённый Chrome for Testing в кэше (CHROME_CACHE_DIR, по умолчанию
//     $XDG_CACHE_HOME/it-game/browsers, вне репо — один на все worktree);
//  3. системный Chromium/Chrome — с предупреждением: прогон пройдёт, но
//     пиксели visreg с эталонами могут не совпасть.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Browser, computeExecutablePath, detectBrowserPlatform } from '@puppeteer/browsers'

// Ревизия Chrome, с которой выпущен puppeteer-core из package-lock
// (node_modules/puppeteer-core/lib/puppeteer/revisions.js) — CDP заведомо
// совместим. Обновлять вместе с puppeteer-core; после смены — пересобрать
// эталоны visreg (npm run visreg -- --update).
export const CHROME_BUILD = '152.0.7977.54'
export const CHROME_BROWSER = Browser.CHROME

const SYSTEM_CANDIDATES = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable']

export function chromeCacheDir() {
  if (process.env.CHROME_CACHE_DIR) return process.env.CHROME_CACHE_DIR
  const base = process.env.XDG_CACHE_HOME || join(homedir(), '.cache')
  return join(base, 'it-game', 'browsers')
}

/** Путь к закреплённому Chrome for Testing в кэше (может не существовать). */
export function pinnedChromePath() {
  const platform = detectBrowserPlatform()
  if (!platform) return null
  return computeExecutablePath({ browser: CHROME_BROWSER, buildId: CHROME_BUILD, cacheDir: chromeCacheDir(), platform })
}

let warned = false

/**
 * Браузер для puppeteer.launch({ executablePath }). Если не нашлось ничего —
 * бросает Error, а не process.exit: у вызывающих launch стоит в try/finally,
 * который гасит self-serve сервер.
 */
export function chromePath() {
  if (process.env.CHROME_PATH) {
    if (!existsSync(process.env.CHROME_PATH)) {
      throw new Error(`CHROME_PATH=${process.env.CHROME_PATH} не существует`)
    }
    return process.env.CHROME_PATH
  }
  const pinned = pinnedChromePath()
  if (pinned && existsSync(pinned)) return pinned
  const sys = SYSTEM_CANDIDATES.find((p) => existsSync(p))
  if (!sys) {
    throw new Error(
      `браузер не найден: нет закреплённого Chrome ${CHROME_BUILD} (npm run browser:install) и системного Chromium — задайте CHROME_PATH`,
    )
  }
  if (!warned) {
    warned = true
    console.warn(
      `WARN: закреплённый Chrome for Testing ${CHROME_BUILD} не установлен (npm run browser:install) — беру системный ${sys}; пиксели visreg с эталонами могут не совпасть`,
    )
  }
  return sys
}
