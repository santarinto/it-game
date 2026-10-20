// sprite-job-core — задание minipc из спеки в репо (ITGAME-182, docs/design/sprite-pipeline.md,
// «Задание»): класс — из таблицы классов graphics.md и манифеста, профиль — снимок
// graphics.md и sprites.json (≤ 4000 знаков, лимит письма 4123), проверки полей — те же,
// что у minipc, чтобы отказ всплыл до POST. Без ввода-вывода: файлы, git, браузер и сеть —
// в scripts/sprite-job.mjs.
import { createHash } from 'node:crypto'

export const PROFILE_MAX_CHARS = 4000 // письмо 4123; исходник minipc держит 20000 байт — берём строже
export const BRIEF_MAX_BYTES = 500 // minipc: items.N.brief до 500 байт UTF-8
const ABOUT_RE = /^[A-Za-z0-9][A-Za-z0-9.-]*$/
const KEY_RE = /^[a-z0-9][a-z0-9_-]*$/

const sha256 = (s) => createHash('sha256').update(s).digest('hex')
const bytes = (s) => Buffer.byteLength(s)

/**
 * Класс из таблицы «Класс | На экране | Исходник | Палитра» graphics.md, сверенный с
 * манифестом: у каждого спрайта класса size = исходник и та же палитра. render — из
 * спеки, иначе общий у спрайтов класса (smooth или pixel); смешанный — отказ.
 * @returns {{ name, screenPx, sourcePx, palette, colors: string[], render: 'smooth' | 'pixel' }}
 */
export function classFromDocs(graphicsMd, manifest, name, render) {
  const row = graphicsMd.split('\n').find((l) => l.startsWith('|') && l.split('|')[1]?.split(',').some((c) => c.trim() === `\`${name}\``))
  if (!row) throw new Error(`класса ${name} нет в таблице классов docs/design/graphics.md`)
  const [, , screen, source, palette] = row.split('|').map((c) => c.trim())
  const cls = { name, screenPx: Number(screen), sourcePx: Number(source), palette }
  if (!Number.isInteger(cls.screenPx) || !Number.isInteger(cls.sourcePx)) throw new Error(`строка класса ${name} в graphics.md не разобрана: ${row}`)
  const colors = manifest.palettes?.[palette]
  if (!Array.isArray(colors) || !colors.length) throw new Error(`палитры ${palette} класса ${name} нет в sprites.json → palettes`)
  const members = Object.entries(manifest.sprites).filter(([, s]) => s.class === name)
  for (const [key, s] of members) {
    if (s.size !== cls.sourcePx || s.palette !== palette) {
      throw new Error(`класс ${name}: ${key} в sprites.json — ${s.size} px ${s.palette}, а graphics.md — ${cls.sourcePx} px ${palette}`)
    }
  }
  let r = render
  if (r === undefined) {
    const kinds = new Set(members.map(([, s]) => (s.render === 'smooth' ? 'smooth' : 'pixel')))
    if (kinds.size > 1) throw new Error(`у класса ${name} в sprites.json и smooth, и pixel — задайте render в спеке задания`)
    r = kinds.has('smooth') ? 'smooth' : 'pixel'
  }
  if (r !== 'smooth' && r !== 'pixel') throw new Error(`render — smooth или pixel, получено ${JSON.stringify(r)}`)
  return { ...cls, colors, render: r }
}

function section(md, from, to) {
  const a = md.indexOf(from)
  const b = a < 0 ? -1 : md.indexOf(to, a + from.length)
  if (a < 0 || b < 0) throw new Error(`в graphics.md нет раздела «${from}» … «${to}» — профиль не собрать`)
  return md.slice(a, b).trim()
}

/**
 * Профиль задания: снимок graphics.md под класс. pixel — жёсткие правила (§1), палитры,
 * рендер и размеры, строка класса; smooth — рендер, строка класса и решения пилота (§3),
 * как у задания-репетиции 3. Дальше — контракт файла и общая часть задания (common).
 * version — graphics@<коммит graphics.md>, sha256 — от текста.
 */
export function buildProfile(graphicsMd, cls, { version, about, common }) {
  const header = `| Класс | На экране, px | Исходник, px | Палитра | Сейчас в игре |`
  const row = graphicsMd.split('\n').find((l) => l.startsWith('|') && l.split('|')[1]?.split(',').some((c) => c.trim() === `\`${cls.name}\``))
  const render = section(graphicsMd, '### Рендер и размеры', header)
  const parts = [`Профиль генерации it-game: класс ${cls.name} (render: ${cls.render}), палитра ${cls.palette}. Снимок docs/design/graphics.md и client/src/assets/sprites.json.`]
  if (cls.render === 'pixel') {
    parts.push(section(graphicsMd, '## 1. Что уже жёстко задано кодом', '### Палитры'), section(graphicsMd, '### Палитры', '### Рендер и размеры'))
  }
  parts.push(render, `${header}\n|---|---|---|---|---|\n${row}`)
  if (cls.render === 'smooth') parts.push(section(graphicsMd, '**Пилот кубка', 'Пока не зафиксировано.'))
  parts.push(`Контракт файла: PNG RGBA ${cls.sourcePx}×${cls.sourcePx}, 1 кадр, на экране ${cls.screenPx} px; палитра ${cls.palette}: ${cls.colors.join(' ')}${cls.render === 'smooth' ? ' (у render: smooth — ориентир по тону, не контракт)' : ''}.`)
  if (common) parts.push(`## Задание ${about}\n\n${common.trim()}`)
  const text = parts.join('\n\n')
  if (text.length > PROFILE_MAX_CHARS) throw new Error(`профиль ${text.length} знаков > ${PROFILE_MAX_CHARS} (письмо 4123) — сократите common задания`)
  return { version, sha256: sha256(text), text }
}

/**
 * Спека задания из репо: {about, class, render?, common?, items: [{key, brief, context:
 * {text?, bg?, crop: {fixture, scene, open?, ids: [...], textures?, pad?, scale?}}}]}.
 * Отказ — со всеми нарушениями сразу. fixtures — имена фикстур сервера, scenes — ключи
 * сцен Phaser (как у seenIn в check:sprites).
 */
export function validateSpec(spec, { fixtures, scenes }) {
  const bad = []
  if (typeof spec?.about !== 'string' || !ABOUT_RE.test(spec.about) || bytes(spec.about) > 32) bad.push('about — код задачи трекера, [A-Za-z0-9.-] до 32 байт')
  if (typeof spec?.class !== 'string' || !spec.class) bad.push('class — имя класса из graphics.md')
  if (spec?.common !== undefined && typeof spec.common !== 'string') bad.push('common — строка')
  const items = Array.isArray(spec?.items) ? spec.items : []
  if (!items.length) bad.push('items — хотя бы один ключ')
  const seen = new Set()
  items.forEach((it, i) => {
    const at = `items.${i}${typeof it?.key === 'string' ? ` (${it.key})` : ''}`
    if (typeof it?.key !== 'string' || !KEY_RE.test(it.key) || bytes(it.key) > 64) bad.push(`${at}.key — [a-z0-9][a-z0-9_-]* до 64 байт`)
    else if (seen.has(it.key)) bad.push(`${at}.key повторяется`)
    else seen.add(it.key)
    if (typeof it?.brief !== 'string' || !/^\S/.test(it.brief) || bytes(it.brief) > BRIEF_MAX_BYTES) {
      bad.push(`${at}.brief — непустая строка до ${BRIEF_MAX_BYTES} байт UTF-8 (сейчас ${typeof it?.brief === 'string' ? bytes(it.brief) : 'нет'})`)
    }
    const ctx = it?.context ?? {}
    if (ctx.text !== undefined && (typeof ctx.text !== 'string' || !/^\S/.test(ctx.text) || bytes(ctx.text) > 64)) bad.push(`${at}.context.text — до 64 байт`)
    if (ctx.bg !== undefined && (typeof ctx.bg !== 'string' || !/^[0-9a-fA-F]{6}$/.test(ctx.bg))) bad.push(`${at}.context.bg — 6 hex без #`)
    const c = ctx.crop
    if (c === undefined) return
    if (!fixtures.includes(c?.fixture)) bad.push(`${at}.context.crop.fixture — одна из ${fixtures.join(', ')}`)
    if (!scenes.includes(c?.scene)) bad.push(`${at}.context.crop.scene — одна из ${scenes.join(', ')}`)
    if (c?.open !== undefined && typeof c.open !== 'string') bad.push(`${at}.context.crop.open — id для itd.click`)
    if (!Array.isArray(c?.ids) || !c.ids.length || !c.ids.every((x) => typeof x === 'string' && x)) bad.push(`${at}.context.crop.ids — непустой список id узлов itd.nodes()`)
    if (c?.textures !== undefined) {
      try {
        new RegExp(c.textures)
      } catch {
        bad.push(`${at}.context.crop.textures — RegExp ключа текстуры`)
      }
    }
    if (c?.pad !== undefined && !(Number.isInteger(c.pad) && c.pad >= 0 && c.pad <= 200)) bad.push(`${at}.context.crop.pad — 0..200 мировых px`)
    if (c?.scale !== undefined && !['1', '1.4'].includes(c.scale)) bad.push(`${at}.context.crop.scale — '1' или '1.4'`)
    const extra = Object.keys(c ?? {}).filter((k) => !['fixture', 'scene', 'open', 'ids', 'textures', 'pad', 'scale'].includes(k))
    if (extra.length) bad.push(`${at}.context.crop — лишние поля ${extra.join(', ')}`)
  })
  if (bad.length) throw new Error(`спека задания не годится:\n  - ${bad.join('\n  - ')}`)
  return spec
}

/**
 * Тело POST /jobs: crops — {key: Buffer PNG}. Кроп попадает в context.cropPng base64.
 */
export function jobPayload(spec, cls, profile, crops = {}) {
  return {
    about: spec.about,
    profile,
    class: { name: cls.name, screenPx: cls.screenPx, sourcePx: cls.sourcePx, palette: cls.palette, colors: cls.colors },
    items: spec.items.map((it) => {
      const ctx = {}
      if (it.context?.text !== undefined) ctx.text = it.context.text
      if (it.context?.bg !== undefined) ctx.bg = it.context.bg.toLowerCase()
      if (crops[it.key]) ctx.cropPng = crops[it.key].toString('base64')
      return { key: it.key, brief: it.brief, ...(Object.keys(ctx).length ? { context: ctx } : {}) }
    }),
  }
}

/** То же тело для печати: кроп — размер и sha256, профиль — версия, sha256 и длина. */
export function payloadForPrint(payload) {
  return {
    ...payload,
    profile: { version: payload.profile.version, sha256: payload.profile.sha256, chars: payload.profile.text.length },
    items: payload.items.map((it) => {
      if (!it.context?.cropPng) return it
      const png = Buffer.from(it.context.cropPng, 'base64')
      return { ...it, context: { ...it.context, cropPng: { bytes: png.length, sha256: createHash('sha256').update(png).digest('hex') } } }
    }),
  }
}
