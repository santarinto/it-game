// browser:install (ITGAME-48) — ставит закреплённый Chrome for Testing
// (версия — CHROME_BUILD в scripts/lib/chrome.mjs) в кэш вне репо.
// Повторный запуск при уже установленной версии — no-op.
//
//   npm run browser:install            # в $XDG_CACHE_HOME/it-game/browsers
//   CHROME_CACHE_DIR=… npm run browser:install
import { existsSync } from 'node:fs'
import { install } from '@puppeteer/browsers'
import { CHROME_BROWSER, CHROME_BUILD, chromeCacheDir, pinnedChromePath } from './lib/chrome.mjs'

const cacheDir = chromeCacheDir()
const exe = pinnedChromePath()
if (exe && existsSync(exe)) {
  console.log(`browser:install: Chrome for Testing ${CHROME_BUILD} уже есть — ${exe}`)
  process.exit(0)
}
console.log(`browser:install: качаю Chrome for Testing ${CHROME_BUILD} в ${cacheDir}…`)
let last = -1
const installed = await install({
  browser: CHROME_BROWSER,
  buildId: CHROME_BUILD,
  cacheDir,
  downloadProgressCallback: (done, total) => {
    const pct = total ? Math.floor((done / total) * 10) * 10 : 0
    if (pct !== last) {
      last = pct
      process.stdout.write(`  ${pct}%\n`)
    }
  },
})
console.log(`browser:install: OK — ${installed.executablePath}`)
