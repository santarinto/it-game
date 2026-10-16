import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import puppeteer from 'puppeteer-core'
import { chromePath } from './lib/chrome.mjs'
import { waitMenuReady } from './lib/menu.mjs'

const CLIENT_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const BASE = process.env.QA_BASE || 'http://localhost:4173'

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

// selfServe и launch внутри try: упавший Chromium (или недождавшийся vite
// preview) не должен оставлять detached-процесс на :4173
let browser = null
try {
  if (!process.env.QA_BASE) {
    await selfServe()
  }
  browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1920, height: 1080 })
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('PAGE ERROR:', msg.text())
  })

  await page.goto(`${BASE}/?debug=1`, { waitUntil: 'domcontentloaded' })
  await waitMenuReady(page)

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
    // ITGAME-83: график — спрайт icon_chart, не эмодзи: 16px у кнопки меню, 24px слева от заголовка
    const menu = window.__itd.scene.getScene('menu')
    const icons = menu.children.list
      .filter((o) => o.texture?.key === 'icon_chart')
      .map((o) => ({ w: Math.round(o.displayWidth), x: o.x, y: o.y, visible: o.visible }))
    const btnText = menu.children.list.find((o) => o.type === 'Text' && o.text === 'Статистика')
    const btnIconFollows = !!btnText && icons.find((i) => i.w === 16)?.visible === btnText.visible
    const titleObj = menu.children.list.find((o) => o.type === 'Text' && String(o.text).includes('СТАТИСТИКА ПРОГОНОВ'))
    const tb = titleObj?.getBounds()
    const titleIcon = icons.find((i) => i.w === 24)
    const titleIconOk = !!tb && !!titleIcon && Math.abs(titleIcon.y - tb.centerY) <= 2 && titleIcon.x < tb.x + 24 + 2 &&
      titleIcon.x > tb.x
    const noEmoji = ![titleObj?.text, btnText?.text].some((t) => !t || t.includes('📊'))
    return { hasTitle, overlaps, overlapsCount: overlaps.length, icons, btnIconFollows, titleIconOk, noEmoji }
  })
  if (statsModalOpen.overlaps.length > 0) {
    console.log('Stats overlaps:', statsModalOpen.overlaps)
  }
  check('Модалка статистики открылась', statsModalOpen.hasTitle, 'заголовок найден')
  check('ITGAME-83: графики — спрайты 16 (кнопка) и 24 (заголовок окна), 📊 в текстах нет',
    statsModalOpen.icons.map((i) => i.w).sort().join(',') === '16,24' && statsModalOpen.noEmoji && statsModalOpen.btnIconFollows, JSON.stringify(statsModalOpen.icons))
  check('ITGAME-83: график заголовка — в поле слева от текста, по центру строки', statsModalOpen.titleIconOk, JSON.stringify(statsModalOpen.icons))
  check('Нет оверлапов в модалке статистики', statsModalOpen.overlapsCount === 0, `overlaps=${statsModalOpen.overlapsCount}`)

  // Закрытие по ESC
  await page.evaluate(() => window.itd.key('escape'))
  await delay(100)
  const statsModalClosed = await page.evaluate(() => {
    return !window.itd.text().some((t) => t.text && t.text.includes('СТАТИСТИКА ПРОГОНОВ'))
  })
  check('Модалка статистики закрылась по ESC', statsModalClosed, `closed=${statsModalClosed}`)

  // ITGAME-83: иконки карточек достижений — спрайты ach_* по 16px слева от названия (ключ
  // из meta.ts), у закрытых — icon_lock 12px слева от «Заблокировано»; эмодзи в текстах окна нет
  const achCardIcons = () => {
    const menu = window.__itd.scene.getScene('menu')
    const list = window.itd.meta().achievements.list
    const imgs = menu.children.list.filter((o) => o.type === 'Image' && o.visible)
    const near = (key, t, px) => {
      const b = t.getBounds()
      return imgs.some((o) => o.texture?.key === key && Math.round(o.displayWidth) === px &&
        o.x > b.x && o.x < b.x + px + 2 && Math.abs(o.y - (b.y + (t.padding.top ?? 0) + (b.height - (t.padding.top ?? 0) - (t.padding.bottom ?? 0)) / 2)) <= 2)
    }
    const texts = menu.children.list.filter((o) => o.type === 'Text')
    const cards = list.map((a) => {
      const name = texts.find((t) => t.text === a.title)
      const img = imgs.find((o) => o.texture?.key === a.icon)
      // приглушение закрытых: alpha 0.6 и ColorMatrix (обесцвечивание) в preFX
      const fx = img?.preFX?.list?.filter((f) => f.constructor?.name === 'ColorMatrix' || 'grayscale' in f).length ?? 0
      return { id: a.id, key: a.icon, unlocked: a.unlocked, icon: !!name && near(a.icon, name, 16), alpha: img ? Math.round(img.alpha * 100) / 100 : null, fx }
    })
    const dimOk = cards.every((c) => (c.unlocked ? c.alpha === 1 && c.fx === 0 : c.alpha === 0.6 && c.fx === 1))
    const badges = texts.filter((t) => t.text === 'Заблокировано')
    const locks = imgs.filter((o) => o.texture?.key === 'icon_lock' && Math.round(o.displayWidth) === 12).length
    const locksPlaced = badges.every((t) => near('icon_lock', t, 12))
    const emoji = texts.map((t) => String(t.text)).filter((t) => /\p{Extended_Pictographic}/u.test(t.replace(/[✓✕]/g, '')))
    return { cards, badges: badges.length, locks, locksPlaced, emoji, dimOk }
  }

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
    // ITGAME-83: кубок — спрайт icon_trophy, не эмодзи: 16px у кнопки меню и 24px слева от
    // заголовка окна, по высоте — на середине строки заголовка, левее текста заголовка
    const menu = window.__itd.scene.getScene('menu')
    // окно прячет интерфейс меню — иконка кнопки прячется вместе со своим текстом
    const icons = menu.children.list
      .filter((o) => o.texture?.key === 'icon_trophy')
      .map((o) => ({ w: Math.round(o.displayWidth), x: o.x, y: o.y, depth: o.depth, visible: o.visible }))
    const btnText = menu.children.list.find((o) => o.type === 'Text' && String(o.text).startsWith('Достижения '))
    const btnIconFollows = icons.find((i) => i.w === 16)?.visible === btnText?.visible
    const titleObj = menu.children.list.find((o) => o.type === 'Text' && String(o.text).startsWith('ДОСТИЖЕНИЯ ('))
    const tb = titleObj?.getBounds()
    const titleIcon = icons.find((i) => i.w === 24)
    const titleIconOk = !!tb && !!titleIcon && Math.abs(titleIcon.y - tb.centerY) <= 2 && titleIcon.x < tb.x + 24 + 2 &&
      titleIcon.x > tb.x
    // карточка достижения с собственной иконкой 🏆 (meta.ts) — набор из 12, он отдельно
    const noEmoji = ![titleObj?.text, btnText?.text].some((t) => !t || t.includes('🏆'))
    return { hasTitle, hasFirstMillion, hasFullStaff, hasNetwork36, hasCleanWin, hasSurvivor10, overlapsCount: overlaps.length, icons, titleIconOk, noEmoji, btnIconFollows }
  })
  const achCards0 = await page.evaluate(achCardIcons)
  check('Модалка достижений открылась', achModalOpen.hasTitle, 'заголовок найден')
  check('ITGAME-83: кубки — спрайты 16 (кнопка) и 24 (заголовок окна), 🏆 в текстах нет',
    achModalOpen.icons.map((i) => i.w).sort().join(',') === '16,24' && achModalOpen.noEmoji && achModalOpen.btnIconFollows, JSON.stringify(achModalOpen.icons))
  check('ITGAME-83: кубок заголовка — в поле слева от текста, по центру строки', achModalOpen.titleIconOk, JSON.stringify(achModalOpen.icons))
  check('ITGAME-83: у 12 карточек — свой спрайт ach_* 16px слева от названия',
    achCards0.cards.length === 12 && achCards0.cards.every((c) => c.icon && c.key.startsWith('ach_')) && new Set(achCards0.cards.map((c) => c.key)).size === 12,
    JSON.stringify(achCards0.cards.filter((c) => !c.icon)))
  check('ITGAME-83: все 12 закрыты — 12 замков icon_lock 12px слева от «Заблокировано», эмодзи в окне нет',
    achCards0.badges === 12 && achCards0.locks === 12 && achCards0.locksPlaced && achCards0.emoji.length === 0,
    JSON.stringify({ badges: achCards0.badges, locks: achCards0.locks, placed: achCards0.locksPlaced, emoji: achCards0.emoji }))
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
  await waitMenuReady(page)
  const metaAfterReload = await page.evaluate(() => window.itd.meta())
  check('Достижение сохранилось после перезагрузки', metaAfterReload.achievements.unlockedCount === 1, `unlocked=${metaAfterReload.achievements.unlockedCount}`)
  const achItem = metaAfterReload.achievements.list.find((a) => a.id === 'first_hire')
  check('first_hire отмечен как unlocked', achItem?.unlocked === true, `status=${achItem?.unlocked}`)

  // ITGAME-83: открытое достижение — без замка, своя иконка остаётся; замков 11
  await page.evaluate(() => window.itd.click('menu.achievements'))
  await delay(100)
  const achCards1 = await page.evaluate(achCardIcons)
  check('ITGAME-83: иконки закрытых приглушены (alpha 0.6 + обесцвечивание), открытая first_hire — нет',
    achCards1.dimOk && achCards0.dimOk, JSON.stringify(achCards1.cards.map((c) => [c.id, c.unlocked, c.alpha, c.fx])))
  check('ITGAME-83: после first_hire — 11 замков, у открытой карточки иконка на месте',
    achCards1.locks === 11 && achCards1.badges === 11 && achCards1.locksPlaced && achCards1.cards.every((c) => c.icon),
    JSON.stringify({ locks: achCards1.locks, badges: achCards1.badges, missing: achCards1.cards.filter((c) => !c.icon) }))
  await page.evaluate(() => window.itd.key('escape'))
  await delay(100)

  // ITGAME-83: окна-предупреждения — icon_warning 24px слева от заголовка, ⚠ в заголовке нет.
  // Оба окна открываются по сценарию партии (конфликт вкладок, новая игра при живом сейве) —
  // здесь вызываем их напрямую, проверяется только рамка
  const warn = await page.evaluate(() => {
    const menu = window.__itd.scene.getScene('menu')
    const probe = (open, title) => {
      open()
      const t = menu.children.list.find((o) => o.type === 'Text' && o.text === title)
      const tb = t?.getBounds()
      const icon = menu.children.list.find((o) => o.texture?.key === 'icon_warning')
      const ok = !!tb && !!icon && Math.round(icon.displayWidth) === 24 && Math.abs(icon.y - tb.centerY) <= 2 &&
        icon.x > tb.x && icon.x < tb.x + 24 + 2
      menu.closeModal()
      const gone = !menu.children.list.some((o) => o.texture?.key === 'icon_warning')
      return { title, found: !!t, ok, gone }
    }
    return [probe(() => menu.showConfirmNewModal('normal'), 'НАЧАТЬ ЗАНОВО?'), probe(() => menu.showSessionConflictModal(3), 'ПАРТИЯ В ДРУГОЙ ВКЛАДКЕ')]
  })
  check('ITGAME-83: «Начать заново?» и «Партия в другой вкладке» — icon_warning 24px слева от заголовка, уходит с окном',
    warn.every((w) => w.found && w.ok && w.gone), JSON.stringify(warn))

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
  if (browser) await browser.close()
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
