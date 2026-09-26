import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import puppeteer from 'puppeteer-core'

const CLIENT_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const BASE = process.env.QA_BASE || 'http://localhost:4173'

function chromePath() {
  const cands = [
    process.env.CHROME_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable',
  ].filter((p) => !!p)
  const found = cands.find((p) => existsSync(p))
  if (!found) throw new Error('chromium не найден — задайте CHROME_PATH')
  return found
}

let preview = null
async function selfServe() {
  preview = spawn('npx', ['vite', 'preview', '--port', '4173', '--strictPort'], {
    cwd: CLIENT_DIR,
    stdio: 'ignore',
    detached: true,
  })
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE)
      if (r.ok) return
    } catch {}
    await delay(500)
  }
  throw new Error('vite preview не поднялся')
}

const results = []
const check = (name, pass, fact) => {
  results.push({ name, pass, fact })
  console.log(`${pass ? 'PASS' : 'FAIL'}: ${name} — ${fact}`)
}

if (!process.env.QA_BASE) {
  await selfServe()
}

const browser = await puppeteer.launch({
  executablePath: chromePath(),
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1920, height: 1080 })
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('PAGE ERROR:', msg.text())
  })

  await page.goto(`${BASE}/?debug=1`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction('window.__itd && window.__itd.scene.isActive("menu")', { timeout: 10000 })

  // 1. Проверяем itd.meta() и сброс мета-прогресса
  const metaInit = await page.evaluate(() => {
    window.itd.resetMeta()
    return window.itd.meta()
  })
  check('Начальная статистика: 0 побед', metaInit.stats.totalWins === 0, `wins=${metaInit.stats.totalWins}`)
  check('Всего 12 достижений', metaInit.achievements.totalCount === 12, `total=${metaInit.achievements.totalCount}`)
  check('Все 12 изначально закрыты', metaInit.achievements.unlockedCount === 0, `unlocked=${metaInit.achievements.unlockedCount}`)

  // 2. Кнопки в меню присутствуют
  const ids = await page.evaluate(() => window.itd.ids().map((x) => x.id))
  check('Кнопка menu.stats есть', ids.includes('menu.stats'), `ids=${ids.filter((i) => i.includes('stats'))}`)
  check('Кнопка menu.achievements есть', ids.includes('menu.achievements'), `ids=${ids.filter((i) => i.includes('achieve'))}`)

  // 3. Открытие модалки статистики
  await page.evaluate(() => window.itd.click('menu.stats'))
  await delay(100)
  const statsModalOpen = await page.evaluate(() => {
    const texts = window.itd.text().map((t) => t.text)
    const hasTitle = texts.some((t) => t && t.includes('СТАТИСТИКА ПРОГОНОВ'))
    const overlaps = window.itd.overlaps()
    console.log('STATS OVERLAPS DETAILS:', JSON.stringify(overlaps))
    return { hasTitle, overlaps, overlapsCount: overlaps.length }
  })
  if (statsModalOpen.overlaps.length > 0) {
    console.log('Stats overlaps:', statsModalOpen.overlaps)
  }
  check('Модалка статистики открылась', statsModalOpen.hasTitle, 'заголовок найден')
  check('Нет оверлапов в модалке статистики', statsModalOpen.overlapsCount === 0, `overlaps=${statsModalOpen.overlapsCount}`)

  // Закрытие по ESC
  await page.evaluate(() => window.itd.key('escape'))
  await delay(100)
  const statsModalClosed = await page.evaluate(() => {
    return !window.itd.text().some((t) => t.text && t.text.includes('СТАТИСТИКА ПРОГОНОВ'))
  })
  check('Модалка статистики закрылась по ESC', statsModalClosed, `closed=${statsModalClosed}`)

  // 4. Открытие модалки достижений
  await page.evaluate(() => window.itd.click('menu.achievements'))
  await delay(100)
  const achModalOpen = await page.evaluate(() => {
    const texts = window.itd.text().map((t) => t.text)
    const hasTitle = texts.some((t) => t && t.includes('ДОСТИЖЕНИЯ'))
    const hasFirstMillion = texts.some((t) => t && t.includes('Первый миллион'))
    const hasFullStaff = texts.some((t) => t && t.includes('Полный штат'))
    const hasNetwork36 = texts.some((t) => t && t.includes('36/36 в сети'))
    const hasCleanWin = texts.some((t) => t && t.includes('Победа без аменити'))
    const hasSurvivor10 = texts.some((t) => t && t.includes('10 дней без банкротства'))
    const overlaps = window.itd.overlaps()
    return { hasTitle, hasFirstMillion, hasFullStaff, hasNetwork36, hasCleanWin, hasSurvivor10, overlapsCount: overlaps.length }
  })
  check('Модалка достижений открылась', achModalOpen.hasTitle, 'заголовок найден')
  check('Достижение «Первый миллион» отображено', achModalOpen.hasFirstMillion, 'найдено')
  check('Достижение «Полный штат» отображено', achModalOpen.hasFullStaff, 'найдено')
  check('Достижение «36/36 в сети» отображено', achModalOpen.hasNetwork36, 'найдено')
  check('Достижение «Победа без аменити» отображено', achModalOpen.hasCleanWin, 'найдено')
  check('Достижение «10 дней без банкротства» отображено', achModalOpen.hasSurvivor10, 'найдено')
  check('Нет оверлапов в модалке достижений', achModalOpen.overlapsCount === 0, `overlaps=${achModalOpen.overlapsCount}`)

  // Закрытие по клику на modal.btn.close
  await page.evaluate(() => window.itd.click('modal.btn.close'))
  await delay(100)
  const achModalClosed = await page.evaluate(() => {
    return !window.itd.text().some((t) => t.text && t.text.includes('ДОСТИЖЕНИЯ ('))
  })
  check('Модалка достижений закрылась по кнопке «Закрыть»', achModalClosed, `closed=${achModalClosed}`)

  // 5. Тестирование разблокировки ачивки программно и обработка ошибок
  const unknownRes = await page.evaluate(() => window.itd.unlockAchievement('unknown_achievement_xyz'))
  check('Неизвестная ачивка отдаёт unknown_achievement', !unknownRes.ok && unknownRes.code === 'unknown_achievement', `code=${unknownRes.code}`)

  const unlockRes = await page.evaluate(() => {
    const res = window.itd.unlockAchievement('first_hire')
    const meta = window.itd.meta()
    return { res, unlockedCount: meta.achievements.unlockedCount }
  })
  check('Разблокировка first_hire успешна', unlockRes.res.ok, `title=${unlockRes.res.achievement?.title}`)
  check('Счётчик достижений увеличился до 1', unlockRes.unlockedCount === 1, `count=${unlockRes.unlockedCount}`)

  // Повторная попытка разблокировать то же достижение возвращает ok: false, code: already_unlocked
  const unlockDuplicate = await page.evaluate(() => window.itd.unlockAchievement('first_hire'))
  check('Повторная разблокировка отдаёт already_unlocked', !unlockDuplicate.ok && unlockDuplicate.code === 'already_unlocked', `code=${unlockDuplicate.code}`)

  // Проверка устойчивости к битому JSON (примитивы '42', 'true')
  const corruptRes = await page.evaluate(() => {
    localStorage.setItem('itd.meta_achievements', '42')
    localStorage.setItem('itd.meta_stats', '"primitive_string"')
    const meta = window.itd.meta()
    return {
      totalRuns: meta.stats.totalRuns,
      unlockedCount: meta.achievements.unlockedCount,
    }
  })
  check('Примитив в localStorage не роняет систему', corruptRes.totalRuns === 0 && corruptRes.unlockedCount === 0, 'дефолты возвращены')

  // Восстанавливаем first_hire для следующего теста
  await page.evaluate(() => window.itd.unlockAchievement('first_hire'))

  // 6. Проверка персистентности после перезагрузки страницы
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction('window.__itd && window.__itd.scene.isActive("menu")', { timeout: 10000 })
  const metaAfterReload = await page.evaluate(() => window.itd.meta())
  check('Достижение сохранилось после перезагрузки', metaAfterReload.achievements.unlockedCount === 1, `unlocked=${metaAfterReload.achievements.unlockedCount}`)
  const achItem = metaAfterReload.achievements.list.find((a) => a.id === 'first_hire')
  check('first_hire отмечен как unlocked', achItem?.unlocked === true, `status=${achItem?.unlocked}`)

  // 7. Проверка обновления и отображения статистики прогонов
  await page.evaluate(() => {
    const raw = localStorage.getItem('itd.meta_stats')
    let stats
    try {
      stats = JSON.parse(raw)
      if (!stats || typeof stats !== 'object' || Array.isArray(stats)) throw 0
    } catch {
      stats = { totalRuns: 0, totalWins: 0, totalLosses: 0, peakBalance: 0, peakDay: 0, byDifficulty: {} }
    }
    stats.totalRuns = 3
    stats.totalWins = 2
    stats.totalLosses = 1
    stats.peakBalance = 520000
    stats.peakDay = 18
    stats.byDifficulty = stats.byDifficulty || {}
    stats.byDifficulty.normal = { runs: 3, wins: 2, bankruptcies: 1, timeUps: 0, bestDay: 18, bestWinDay: 14, bestBalance: 520000 }
    localStorage.setItem('itd.meta_stats', JSON.stringify(stats))
  })
  await page.evaluate(() => window.itd.click('menu.stats'))
  await delay(100)
  const statsContent = await page.evaluate(() => {
    const texts = window.itd.text().map((t) => t.text)
    const hasTotal = texts.some((t) => t && t.includes('Всего игр: 3'))
    const hasWins = texts.some((t) => t && t.includes('Побед: 2'))
    const hasRecord = texts.some((t) => t && t.includes('Рекорд: $520,000'))
    const overlaps = window.itd.overlaps()
    return { hasTotal, hasWins, hasRecord, overlapsCount: overlaps.length }
  })
  check('Статистика отображает число игр (Всего игр: 3)', statsContent.hasTotal, 'найдено')
  check('Статистика отображает число побед (Побед: 2)', statsContent.hasWins, 'найдено')
  check('Статистика отображает рекордный баланс ($520,000)', statsContent.hasRecord, 'найдено')
  check('Нет оверлапов при заполненной статистике', statsContent.overlapsCount === 0, `overlaps=${statsContent.overlapsCount}`)
  await page.evaluate(() => window.itd.key('escape'))

  // Скриншот меню с мета-прогрессом
  await page.screenshot({ path: join(CLIENT_DIR, 'smoke-menu-meta.png') })
  check('Скриншот сохранён', true, 'smoke-menu-meta.png')

  check('Ошибок страницы нет', pageErrors.length === 0, `errors=${pageErrors.join(', ')}`)
} finally {
  await browser.close()
  if (preview?.pid) {
    try { process.kill(-preview.pid, 'SIGTERM') } catch {}
    try { preview.kill('SIGTERM') } catch {}
  }
}

const failed = results.filter((r) => !r.pass)
if (failed.length > 0) {
  console.error(`\nFAILED ${failed.length} / ${results.length} checks:`)
  failed.forEach((f) => console.error(`  ${f.name}: ${f.fact}`))
  process.exit(1)
} else {
  console.log(`\nALL ${results.length} CHECKS PASSED!`)
}
