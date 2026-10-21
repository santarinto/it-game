// qa-itgame140 — версия сборки и совместимость сейва (ITGAME-140, ITGAME-169), `npm run qa:version`:
//   V1  /api/version отдаёт version год.мес.день.час.мин; она же в itd.version.version и в строке
//       «версия X» меню (menu.version, внутри поля)
//   V2  партия → «Сохранить и выйти»: файл сейва несёт version сервера и game.format, меню — «ПРОДОЛЖИТЬ»
//   V3  сервер перезапущен на том же каталоге, version в файле — 2000.01.01.00.00 (деплой новой сборки
//       того же формата): «ПРОДОЛЖИТЬ» с $4,321, карточки menu.stale нет; «Продолжить» поднимает партию
//       с $4321, её сейв снова с version сервера
//   V4  сейв без version (до ITGAME-140) — тоже «ПРОДОЛЖИТЬ» с $4,321
//   V5  itd.staleSave({sid}) из меню (без {sid} вне песочницы — отказ owner_sid, файл не тронут): game.format на 1 меньше, маршрутом
//       POST /api/debug/format без перезапуска (ITGAME-154): {sid, was, format, live:false}, в файле
//       изменился только game.format, savedAt тот же. Сейв старого формата: «ПРОДОЛЖИТЬ» нет, карточка
//       menu.stale «СЕЙВ НЕСОВМЕСТИМ», «начните новую партию:», overlaps/offscreen пусты; строка карточки —
//       фраза владельца «Сохранение от прошлой версии игры — продолжить его нельзя.» (ITGAME-149): без
//       версий и форматов (ни один текст меню, кроме угла, их не несёт), оба текста внутри рамки,
//       угол — «версия X»
//   V6  то же на 1 больше (сейв новой сборки на старой), сырым POST из node (как curl координатора)
//   V7  настоящий клик мышью по «НОРМА» с карточки: без вопроса «Начать заново?», новая партия (новый
//       sid, как всякая новая партия из меню), день 1, не $4321; её сейв — с version и форматом сервера,
//       старый файл не тронут
//   V8  живая партия (продолжение партии V7) помечена: itd.staleSave → live:true, файл сразу формата
//       FORMAT+1 с версией сервера; itd.away(1) → not_resumed, новая партия дня 1 под тем же sid, файл
//       снова формата сервера, карточки меню нет, а в игре окно (ITGAME-174, владелец 21.10): кнопка
//       modal.incompatible.ok, текст «Сейв несовместим с новой версией — начата новая партия», внутри
//       рамки, overlaps/offscreen пусты; настоящий клик мышью по «ОК» закрывает его, партия — новая,
//       день 1 под тем же sid, темп окном не тронут
//   V9  метка живой партии (формат по умолчанию), «Сохранить и выйти» → карточка «СЕЙВ НЕСОВМЕСТИМ»
//   V10 нет pageerror
//
// Self-serve на своём каталоге сейвов (не 'tmp': тот удаляется на stop, а сервер надо поднять
// заново на тех же файлах — версию сборки ставит только правка файла, а стор держит сейвы в памяти,
// правка файла на живом сервере не видна; формат ставит маршрут, перезапуск ему не нужен).
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import puppeteer from 'puppeteer-core'
import { chromePath } from './lib/chrome.mjs'
import { selfServe } from './lib/selfserve.mjs'

const PORT = Number(process.env.QA_PORT) || 4189
const BASE = `http://127.0.0.1:${PORT}`
const VERSION_RE = /^\d{4}\.\d{2}\.\d{2}\.\d{2}\.\d{2}$/
const OLD = '2000.01.01.00.00'
// ITGAME-149 (владелец 18.10): строка карточки — без версий и форматов; на 14px она шире
// карточки, поэтому две строки с переносом после «—» — склеенные пробелом, это она.
const STALE_LINE = 'Сохранение от прошлой версии игры — продолжить его нельзя.'
// Что не должно попасть ни в один текст меню, кроме угла «версия X»: номер сборки, старая
// строка карточки (ITGAME-140) и формат сейва.
const LEAK_RE = /\d{4}\.\d{2}\.\d{2}\.\d{2}\.\d{2}|от версии|от старой версии|, игра |формат/

const results = []
const check = (name, pass, fact) => {
  results.push({ name, pass, fact })
  console.log(`${pass ? 'PASS' : 'FAIL'}: ${name} — ${fact}`)
}

const savesDir = mkdtempSync(join(tmpdir(), 'qa-itgame140-'))
const saveOf = (sid) => join(savesDir, `${sid}.json`)
let sid = null // sid первой партии — её сейв правим между перезапусками
let stopServer = null
const start = async () => {
  ;({ stop: stopServer } = await selfServe({ port: PORT, saves: savesDir, label: 'QA-ITGAME140' }))
}
const restartWith = async (edit) => {
  await stopServer()
  stopServer = null
  const env = JSON.parse(readFileSync(saveOf(sid), 'utf8'))
  edit(env.data)
  writeFileSync(saveOf(sid), JSON.stringify(env))
  await start()
}
const fileData = (s = sid) => JSON.parse(readFileSync(saveOf(s), 'utf8')).data
const fileVersion = (s = sid) => fileData(s).version
const fileFormat = (s = sid) => fileData(s).game?.format
const fileEnv = (s = sid) => JSON.parse(readFileSync(saveOf(s), 'utf8'))
// Ключи по алфавиту рекурсивно: маршрут пишет сейв с ключами в порядке сортировки.
const canon = (v) => (Array.isArray(v) ? v.map(canon)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v)
// Конверты равны, кроме data.game.format (ITGAME-154): savedAt, version, деньги, сид — те же.
const sameButFormat = (a, b) => {
  const strip = (e) => { const d = canon(e.data); d.game.format = null; return JSON.stringify(d) }
  return Date.parse(a.savedAt) === Date.parse(b.savedAt) && strip(a) === strip(b)
}
let FORMAT = null // формат сейва этой сборки — из файла V2

let browser = null
try {
  await start()
  browser = await puppeteer.launch({ executablePath: chromePath(), headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const page = await browser.newPage()
  await page.setViewport({ width: 1920, height: 1080 })
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  await page.evaluateOnNewDocument(() => localStorage.setItem('itd.uiScale', '1'))

  const menu = async () => {
    await page.goto(`${BASE}/?debug=1`, { waitUntil: 'domcontentloaded' })
    return page.evaluate(async () => {
      await window.itd.wait((s) => s.menuReady === true, 8000)
      const t = (id) => window.itd.text().find((n) => n.id === id) ?? null
      const texts = window.itd.text().filter((n) => n.scene === 'menu').map((n) => n.text)
      return {
        ids: window.itd.ids().map((x) => x.id),
        version: t('menu.version'),
        texts,
        overlaps: window.itd.overlaps(),
        offscreen: window.itd.offscreen(),
        nodes: window.itd.text().filter((n) => n.scene === 'menu' && n.visible)
          .map((n) => ({ id: n.id, text: n.text, cx: n.cx, cy: n.cy, w: n.w, h: n.h })),
        card: (() => {
          const n = window.itd.nodes().find((x) => x.id === 'menu.stale')
          return n ? { cx: n.cx, cy: n.cy, w: n.w, h: n.h } : null
        })(),
      }
    })
  }
  const exitToMenu = () => page.evaluate(async () => {
    window.itd.click('btn.menu')
    await window.itd.wait(() => window.itd.ids().some((x) => x.id === 'modal.btn.0'), 5000)
    window.itd.click('modal.btn.0')
    await window.itd.wait((s) => s.menuReady === true, 8000)
  })

  // V1 версия: /api/version = itd.version = строка меню
  const api = await (await fetch(`${BASE}/api/version`)).json()
  const m1 = await menu()
  const tabVersion = await page.evaluate(() => window.itd.version.version)
  const v = m1.version
  check('V1 /api/version — год.мес.день.час.мин, = itd.version.version, = «версия X» в меню',
    VERSION_RE.test(api.version ?? '') && tabVersion === api.version && v?.text === `версия ${api.version}`
      && v.visible && v.cx + v.w / 2 <= 1280 && v.cy + v.h / 2 <= 720,
    JSON.stringify({ api, tabVersion, label: v && { text: v.text, cx: v.cx, cy: v.cy, w: v.w, h: v.h } }))

  // V2 партия → «Сохранить и выйти»: сейв с версией и форматом сервера, «ПРОДОЛЖИТЬ»
  sid = await page.evaluate(async () => {
    window.itd.click('menu.diff.normal')
    await window.itd.wait((s) => s.connected === true, 8000)
    await window.itd.set({ money: 4321 })
    return window.itd.server().sid
  })
  await exitToMenu()
  const m2 = await menu()
  FORMAT = fileFormat()
  check('V2 сейв несёт version и format сервера, в меню «ПРОДОЛЖИТЬ»',
    fileVersion() === api.version && Number.isInteger(FORMAT) && FORMAT >= 1
      && m2.ids.includes('menu.continue') && !m2.ids.includes('menu.stale'),
    JSON.stringify({ file: fileVersion(), format: FORMAT, continue: m2.ids.includes('menu.continue') }))

  const hasMoney = (m) => m.texts.some((t) => t.includes('$4,321'))
  const staleCard = (m) => !m.ids.includes('menu.continue') && m.ids.includes('menu.stale')
    && m.texts.includes('СЕЙВ НЕСОВМЕСТИМ') && m.texts.includes('начните новую партию:')
  const box = (n) => ({ l: n.cx - n.w / 2, r: n.cx + n.w / 2, t: n.cy - n.h / 2, b: n.cy + n.h / 2 })
  // Карточка «СЕЙВ НЕСОВМЕСТИМ» (ITGAME-149): заголовок, под ним строка владельца (1–2 строки),
  // оба текста внутри рамки (≥16 px слева/справа, ≥8 px сверху/снизу), «начните новую партию:»
  // ниже карточки, ни один текст меню, кроме угла, не несёт версию или формат; угол — «версия X».
  const staleCardLine = (m, version) => {
    const card = m.card && box(m.card)
    const find = (pred) => m.nodes.find(pred) ?? null
    const title = find((n) => n.text === 'СЕЙВ НЕСОВМЕСТИМ')
    const line = find((n) => n.text.replace(/\n/g, ' ') === STALE_LINE)
    const sub = find((n) => n.text === 'начните новую партию:')
    const leaks = m.nodes.filter((n) => n.id !== 'menu.version' && LEAK_RE.test(n.text)).map((n) => n.text)
    const inside = (n) => {
      if (!card || !n) return false
      const b = box(n)
      return b.l - card.l >= 16 && card.r - b.r >= 16 && b.t - card.t >= 8 && card.b - b.b >= 8
    }
    const pass = !!card && !!title && !!line && !!sub
      && line.text.split('\n').length <= 2 && inside(title) && inside(line)
      && box(title).b <= box(line).t && box(sub).t >= card.b
      && leaks.length === 0 && m.version?.text === `версия ${version}`
    return {
      pass,
      fact: JSON.stringify({
        card, title: title && box(title), line: line && { text: line.text, ...box(line) },
        sub: sub && box(sub), leaks, corner: m.version?.text ?? null,
      }),
    }
  }

  // V3 «деплой новой сборки того же формата»: тот же файл, чужая версия — партия продолжается
  await restartWith((d) => { d.version = OLD })
  const m3 = await menu()
  check('V3 сейв другой версии того же формата: «ПРОДОЛЖИТЬ» с $4,321, карточки нет',
    m3.ids.includes('menu.continue') && !m3.ids.includes('menu.stale') && !m3.texts.includes('СЕЙВ НЕСОВМЕСТИМ') && hasMoney(m3),
    JSON.stringify({ ids: m3.ids.filter((i) => /^menu\.(continue|stale)$/.test(i)), texts: m3.texts.filter((t) => /\$|СЕЙВ/.test(t)) }))
  const p3 = await page.evaluate(async () => {
    window.itd.click('menu.continue')
    await window.itd.wait((s) => s.connected === true, 8000)
    const st = window.itd.state()
    return { day: st.day, money: st.balance, sid: window.itd.server().sid }
  })
  await exitToMenu()
  // $4321 и больше: партия уже пошла, тик успевает добавить дохода; новая начинается с $600
  check('V3 «Продолжить»: та же партия с $4321 (и тиками сверху), её сейв снова с version сервера',
    p3.sid === sid && p3.money >= 4321 && fileVersion() === api.version && fileFormat() === FORMAT,
    JSON.stringify({ ...p3, file: fileVersion(), format: fileFormat() }))

  // V4 сейв до ITGAME-140 — без version: тоже продолжается
  await restartWith((d) => { delete d.version })
  const m4 = await menu()
  check('V4 сейв без version: «ПРОДОЛЖИТЬ» с $4,321, карточки нет',
    m4.ids.includes('menu.continue') && !m4.ids.includes('menu.stale') && hasMoney(m4),
    JSON.stringify(m4.texts.filter((t) => /\$|СЕЙВ/.test(t))))

  // V5/V6 сейв другого формата — старше и новее, маршрутом без перезапуска (ITGAME-154): карточка
  // вместо «ПРОДОЛЖИТЬ». Версию маршрут не трогает (после V4 её в файле нет) — это пинует sameButFormat.
  // Без {sid} из меню вне песочницы — общий ключ владельца: отказ owner_sid, сейв не тронут
  const refused = await page.evaluate(() => window.itd.staleSave().then(() => null, (e) => String(e.message)))
  check('V5 itd.staleSave() без {sid} из меню вне песочницы — отказ owner_sid, формат сейва не тронут',
    /owner_sid/.test(refused ?? '') && fileFormat() === FORMAT, JSON.stringify({ refused, file: fileFormat() }))
  for (const [name, format, via] of [['V5 старше', FORMAT - 1, 'itd'], ['V6 новее', FORMAT + 1, 'http']]) {
    const before = fileEnv()
    const was = fileFormat()
    const r = via === 'itd'
      ? await page.evaluate(([f, s]) => window.itd.staleSave({ format: f, sid: s }), [format, sid])
      : await (await fetch(`${BASE}/api/debug/format`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sid, format }),
      })).json()
    check(`${name}: маршрут ${via === 'itd' ? 'itd.staleSave' : 'POST /api/debug/format'} → {sid, was, format, live:false}, в файле изменился только game.format, savedAt тот же`,
      r.sid === sid && r.was === was && r.format === format && r.live === false
        && fileFormat() === format && sameButFormat(before, fileEnv()),
      JSON.stringify({ r, was, file: fileFormat() }))
    const m = await menu()
    check(`${name}: сейв формата ${format} (сервер ${FORMAT}) — «ПРОДОЛЖИТЬ» нет, карточка «СЕЙВ НЕСОВМЕСТИМ», «начните новую партию:»`,
      staleCard(m), JSON.stringify({ ids: m.ids.filter((i) => /^menu\.(continue|stale)$/.test(i)), texts: m.texts.filter((t) => /СЕЙВ|новую/.test(t)) }))
    check(`${name}: меню без находок линтера`, m.overlaps.length === 0 && m.offscreen.length === 0,
      JSON.stringify({ overlaps: m.overlaps, offscreen: m.offscreen }).slice(0, 300))
    const line = staleCardLine(m, api.version)
    check(`${name}: строка карточки — «Сохранение от прошлой версии игры — продолжить его нельзя.», без версий и форматов, внутри рамки; угол «версия X»`,
      line.pass, line.fact)
  }

  // V7 настоящий клик по уровню с карточки (файл формата FORMAT+1): без вопроса, новая партия
  const lvl = await page.evaluate(() => window.itd.nodes().find((n) => n.id === 'menu.diff.normal'))
  await page.mouse.click(...await page.evaluate((n) => {
    const r = document.querySelector('canvas').getBoundingClientRect()
    return [r.left + (n.cx / 1280) * r.width, r.top + (n.cy / 720) * r.height]
  }, lvl))
  const p7 = await page.evaluate(async () => {
    const asked = window.itd.text().some((n) => /НАЧАТЬ ЗАНОВО/i.test(n.text ?? ''))
    await window.itd.wait((s) => s.connected === true, 8000).catch(() => null)
    const st = window.itd.state()
    return { asked, connected: st.connected, day: st.day, money: st.balance, sid: window.itd.server().sid }
  })
  await exitToMenu()
  check('V7 клик по «НОРМА»: без вопроса, новый sid, день 1, не $4321; её сейв с version и форматом сервера, старый не тронут',
    !p7.asked && p7.connected && p7.sid !== sid && p7.day === 1 && p7.money !== 4321
      && fileVersion(p7.sid) === api.version && fileFormat(p7.sid) === FORMAT && fileFormat() === FORMAT + 1,
    JSON.stringify({ ...p7, file: fileVersion(p7.sid), format: fileFormat(p7.sid), old: fileFormat(), files: readdirSync(savesDir) }))

  // V8 живая партия (ITGAME-174, владелец 20.10: «порча до переподключения»): метку держит актор,
  // переподключение начинает новую партию под тем же sid и говорит об этом окном (ITGAME-174).
  await menu()
  const p8 = await page.evaluate(async (F) => {
    window.itd.click('menu.continue')
    await window.itd.wait((s) => s.connected === true, 8000)
    await window.itd.set({ money: 4321 })
    const sid8 = window.itd.server().liveSid
    const mark = await window.itd.staleSave({ format: F + 1 })
    return { sid8, mark }
  }, FORMAT)
  const sid8 = p8.sid8
  check('V8 метка живой партии: live:true, файл сразу формата FORMAT+1 с версией сервера и $4321',
    p8.mark.live === true && p8.mark.sid === sid8 && p8.mark.was === FORMAT && p8.mark.format === FORMAT + 1
      && fileFormat(sid8) === FORMAT + 1 && fileVersion(sid8) === api.version && fileData(sid8).game.money === 4321,
    JSON.stringify({ mark: p8.mark, file: fileFormat(sid8), version: fileVersion(sid8), money: fileData(sid8).game.money }))
  const a8 = await page.evaluate(async () => {
    const r = await window.itd.away(1)
    await window.itd.wait((s) => s.connected === true, 8000).catch(() => null)
    await window.itd.wait(() => window.itd.ids().some((x) => x.id === 'modal.incompatible.ok'), 3000).catch(() => null)
    const st = window.itd.state()
    // окно: заголовок и строка — две части одной фразы (перенос после «—», как в карточке меню)
    const parts = window.itd.text().filter((n) => n.visible && n.scene === 'hud' && /несовместим|начата новая/.test(n.text))
      .map((n) => ({ text: n.text, cx: n.cx, cy: n.cy, w: n.w, h: n.h }))
    const btn = window.itd.nodes().find((n) => n.id === 'modal.incompatible.ok') ?? null
    return {
      r, day: st.day, balance: st.balance, connected: st.connected, liveSid: window.itd.server().liveSid,
      stale: window.itd.ids().some((x) => x.id === 'menu.stale'), speed: st.speed,
      parts, btn: btn && { cx: btn.cx, cy: btn.cy, w: btn.w, h: btn.h },
      title: window.itd.screen().meta?.title ?? null,
      overlaps: window.itd.overlaps(), offscreen: window.itd.offscreen(),
    }
  })
  // фраза владельца (21.10, вариант Б) — одна: «Сейв несовместим с новой версией — начата новая партия»
  const NOTICE = 'Сейв несовместим с новой версией — начата новая партия'
  const noticeText = a8.parts.map((n) => n.text).join(' ')
  // панель showModal — 460 px по центру сцены: тексты внутри с полем ≥16 px
  const inPanel = a8.parts.length > 0 && a8.parts.every((n) => n.cx - n.w / 2 >= 640 - 230 + 16 && n.cx + n.w / 2 <= 640 + 230 - 16)
  check('V8 itd.away(1): not_resumed, новая партия дня 1 под тем же sid; файл снова формата сервера',
    a8.r.code === 'not_resumed' && a8.r.resumed === false && a8.r.sid === sid8 && a8.liveSid === sid8
      && a8.connected && a8.day === 1 && a8.balance !== 4321 && !a8.stale
      && fileFormat(sid8) === FORMAT && fileData(sid8).game.money !== 4321,
    JSON.stringify({ ...a8, parts: undefined, overlaps: undefined, offscreen: undefined, file: fileFormat(sid8), money: fileData(sid8).game.money }))
  check('V8 окно на экране: modal.incompatible.ok в itd.screen(), текст ровно фразой владельца, внутри рамки, overlaps/offscreen пусты',
    !!a8.btn && noticeText === NOTICE && a8.title === 'Сейв несовместим с новой версией —' && inPanel
      && a8.overlaps.length === 0 && a8.offscreen.length === 0,
    JSON.stringify({ text: noticeText, title: a8.title, parts: a8.parts, btn: a8.btn, overlaps: a8.overlaps, offscreen: a8.offscreen }).slice(0, 600))
  // настоящий клик мышью по «ОК»: окно закрывается, партия та же новая (день 1, тот же sid), темп не тронут
  await page.mouse.click(...await page.evaluate((n) => {
    const r = document.querySelector('canvas').getBoundingClientRect()
    return [r.left + (n.cx / 1280) * r.width, r.top + (n.cy / 720) * r.height]
  }, a8.btn))
  const c8 = await page.evaluate(async () => {
    await window.itd.wait(() => !window.itd.ids().some((x) => x.id === 'modal.incompatible.ok'), 3000).catch(() => null)
    const st = window.itd.state()
    return {
      open: window.itd.ids().some((x) => x.id === 'modal.incompatible.ok'), day: st.day, speed: st.speed,
      liveSid: window.itd.server().liveSid, blocker: window.itd.blocker() ?? null,
    }
  })
  check('V8 клик мышью по «ОК»: окно закрыто, партия — новая, день 1 под тем же sid, темп не менялся окном',
    !c8.open && c8.day === 1 && c8.liveSid === sid8 && c8.speed === a8.speed && !c8.blocker,
    JSON.stringify({ c8, speedBefore: a8.speed }))

  // V9 метка живой партии и «Сохранить и выйти»: карточка (рецепт агента из навыка приёмки)
  const p9 = await page.evaluate(() => window.itd.staleSave())
  await exitToMenu()
  const m9 = await menu()
  check('V9 метка живой партии, «Сохранить и выйти»: карточка «СЕЙВ НЕСОВМЕСТИМ»',
    p9.live === true && p9.sid === sid8 && p9.was === FORMAT && p9.format === FORMAT + 1
      && fileFormat(sid8) === FORMAT + 1 && staleCard(m9),
    JSON.stringify({ p9, file: fileFormat(sid8), ids: m9.ids.filter((i) => /^menu\.(continue|stale)$/.test(i)) }))

  check('V10 ошибок на странице нет', pageErrors.length === 0, `errors=${pageErrors.length} ${pageErrors.join(' | ')}`)
} catch (e) {
  check('сценарий выполнен без исключений', false, e instanceof Error ? e.stack : String(e))
} finally {
  if (browser) await browser.close()
  if (stopServer) await stopServer()
  rmSync(savesDir, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.pass)
console.log(`\nИтог QA-ITGAME140: ${results.length - failed.length}/${results.length} проверок прошло`)
if (failed.length > 0) {
  console.error(`Провалено: ${failed.map((f) => f.name).join(', ')}`)
  process.exit(1)
}
