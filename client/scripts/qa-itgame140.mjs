// qa-itgame140 — версия сборки и совместимость сейва (ITGAME-140, ITGAME-169), `npm run qa:version`:
//   V1  /api/version отдаёт version год.мес.день.час.мин; она же в itd.version.version и в строке
//       «версия X» меню (menu.version, внутри поля)
//   V2  партия → «Сохранить и выйти»: файл сейва несёт version сервера и game.format, меню — «ПРОДОЛЖИТЬ»
//   V3  сервер перезапущен на том же каталоге, version в файле — 2000.01.01.00.00 (деплой новой сборки
//       того же формата): «ПРОДОЛЖИТЬ» с $4,321, карточки menu.stale нет; «Продолжить» поднимает партию
//       с $4321, её сейв снова с version сервера
//   V4  сейв без version (до ITGAME-140) — тоже «ПРОДОЛЖИТЬ» с $4,321
//   V5  game.format в файле на 1 меньше серверного (сейв старого формата): «ПРОДОЛЖИТЬ» нет, карточка
//       menu.stale «СЕЙВ НЕСОВМЕСТИМ», «начните новую партию:», overlaps/offscreen пусты; строка карточки —
//       фраза владельца «Сохранение от прошлой версии игры — продолжить его нельзя.» (ITGAME-149): без
//       версий и форматов (ни один текст меню, кроме угла, их не несёт), оба текста внутри рамки,
//       угол — «версия X»
//   V6  game.format на 1 больше (сейв новой сборки на старой) — то же
//   V7  настоящий клик мышью по «НОРМА» с карточки: без вопроса «Начать заново?», новая партия (новый
//       sid, как всякая новая партия из меню), день 1, не $4321; её сейв — с version и форматом сервера,
//       старый файл не тронут
//   V8  нет pageerror
//
// Self-serve на своём каталоге сейвов (не 'tmp': тот удаляется на stop, а сервер надо поднять
// заново на тех же файлах — стор держит сейвы в памяти, правка файла на живом сервере не видна).
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

  // V5/V6 сейв другого формата — старше и новее: карточка вместо «ПРОДОЛЖИТЬ»
  for (const [name, format] of [['V5 старше', FORMAT - 1], ['V6 новее', FORMAT + 1]]) {
    await restartWith((d) => { d.game.format = format; d.version = OLD })
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

  check('V8 ошибок на странице нет', pageErrors.length === 0, `errors=${pageErrors.length} ${pageErrors.join(' | ')}`)
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
