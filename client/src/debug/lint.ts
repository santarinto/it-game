import Phaser from 'phaser'
import { GAME_H, GAME_W } from '../layout'

// Линтер вёрстки (ITGAME-25): баги раскладки вида ITGAME-16 («Сотрудники…»
// наезжала на «+/день») ловятся геометрией, без пикселей и скриншотов.
// Все функции получают игру и смотрят только живые (активные) сцены.

// ITGAME-38: 'text' — тексты одного depth наезжают друг на друга; 'occlusion'
// — текст закрыт непрозрачной плашкой выше по depth/display list; 'interactive'
// — интерактивный контейнер/спрайт/чекбокс частично перекрыт другим
// интерактивом или текстом (JSON-контракт для агента/моста — ITGAME-39).
export type OverlapKind = 'text' | 'occlusion' | 'interactive'

// Опции itd.overlaps() (ITGAME-38 п.5).
export interface OverlapOptions {
  minAreaRatio?: number // 0..1: пара — находка при ratio ≥ minAreaRatio; задан — заменяет пороги всех kind (0 — строгий режим), не задан — DEFAULT_MIN_AREA_RATIO
}

// Пороги по умолчанию — поведение overlaps() без опций НЕ меняется:
// text/interactive — любое пересечение >1px по обеим осям; occlusion —
// 0.25 по площади И прежнее правило «>50% текста по каждой оси».
export const DEFAULT_MIN_AREA_RATIO: Readonly<Record<OverlapKind, number>> = {
  text: 0,
  occlusion: 0.25,
  interactive: 0,
}

export interface OverlapEntry {
  scene: string
  kind: OverlapKind
  a: string // сниппет текста или id
  b: string
  overlap: { w: number; h: number }
  at: { x: number; y: number }
  ratio: number // доля перекрытия 0..1: площадь пересечения / площадь меньшего из пары (occlusion — / площадь текста), 3 знака
  threshold: number // порог, с которым сравнили ratio: minAreaRatio из вызова или DEFAULT_MIN_AREA_RATIO[kind]
}

export interface OffscreenEntry {
  scene: string
  type: string
  id: string | null
  text: string | null
  bounds: { x: number; y: number; w: number; h: number }
  out: { left: number; right: number; top: number; bottom: number } // на сколько вылез, px
}

export interface ContrastEntry {
  scene: string
  id: string | null
  text: string // сниппет
  fg: string
  bg: string
  ratio: number
}

export interface TinyEntry {
  scene: string
  id: string | null
  text: string
  size: number
}

interface Node0 {
  type?: string
  visible?: boolean
  alpha?: number
  depth?: number
  getData?(k: string): unknown
  getBounds(): Phaser.Geom.Rectangle
}

function textObjs(scene: Phaser.Scene): Phaser.GameObjects.Text[] {
  return scene.children.list.filter(
    (o) => (o as unknown as { type?: string }).type === 'Text',
  ) as unknown as Phaser.GameObjects.Text[]
}

function nameOf(o: Node0): string {
  const id = o.getData?.('id')
  if (typeof id === 'string') return id
  const text = (o as unknown as { text?: string }).text
  if (text) return text.slice(0, 24).replace(/\n/g, ' ')
  const oObj = o as unknown as { type?: string; width?: number; height?: number }
  if (oObj.type) return `${oObj.type}(${Math.round(oObj.width || 0)}x${Math.round(oObj.height || 0)})`
  return ''
}

// Пересечения видимых текстов одной сцены на одном depth, а также закрытие
// текста непрозрачным узлом (Rectangle/Image), отрисованным выше по depth или display list.
export function findOverlaps(game: Phaser.Game, rawOpts?: OverlapOptions | null): OverlapEntry[] {
  const opts = normalizeOverlapOptions(rawOpts)
  const out: OverlapEntry[] = []
  for (const scene of game.scene.getScenes(true)) {
    const list = scene.children.list
    const texts = textObjs(scene).filter((t) => t.visible && t.alpha > 0.5)
    for (let i = 0; i < texts.length; i++) {
      for (let j = i + 1; j < texts.length; j++) {
        const a = texts[i] as unknown as Node0
        const b = texts[j] as unknown as Node0
        if (a.depth !== b.depth) continue
        const ra = a.getBounds()
        const rb = b.getBounds()
        const w = Math.min(ra.right, rb.right) - Math.max(ra.x, rb.x)
        const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.y, rb.y)
        const ratio = ratioOf(w, h, Math.min(areaOf(ra), areaOf(rb)))
        const threshold = thresholdOf('text', opts)
        if (w > 1 && h > 1 && ratio >= threshold) {
          out.push({
            scene: scene.scene.key,
            kind: 'text',
            a: nameOf(a),
            b: nameOf(b),
            overlap: { w: Math.round(w), h: Math.round(h) },
            at: { x: Math.round(Math.max(ra.x, rb.x)), y: Math.round(Math.max(ra.y, rb.y)) },
            ratio: round3(ratio),
            threshold,
          })
        }
      }

      // Проверка: не закрыт ли видимый текст непрозрачным объектом (например, плашкой модала).
      const t = texts[i]
      const tIdx = list.indexOf(t)
      const tDepth = t.depth ?? 0
      const rt = t.getBounds()
      if (rt.width <= 0 || rt.height <= 0) continue

      for (let k = 0; k < list.length; k++) {
        const o = list[k] as unknown as Node0 & { fillAlpha?: number; isFilled?: boolean }
        if (o === (t as unknown) || !o.visible || (o.alpha ?? 1) < 0.9) continue
        if (o.type !== 'Rectangle' && o.type !== 'Image') continue
        if (o.type === 'Rectangle' && (o.isFilled === false || (o.fillAlpha ?? 1) < 0.9)) continue

        const oDepth = o.depth ?? 0
        if (oDepth >= 90) continue // технические слои отладочных рамок
        const isAbove = oDepth > tDepth || (oDepth === tDepth && k > tIdx)
        if (!isAbove) continue

        const ro = o.getBounds()
        const w = Math.min(rt.right, ro.right) - Math.max(rt.x, ro.x)
        const h = Math.min(rt.bottom, ro.bottom) - Math.max(rt.y, ro.y)
        const threshold = thresholdOf('occlusion', opts)
        const ratio = ratioOf(w, h, areaOf(rt))
        const hit =
          opts.minAreaRatio === undefined
            ? w > rt.width * 0.5 && h > rt.height * 0.5 // прежнее правило — дефолт не меняется
            : w > 1 && h > 1 && ratio >= threshold
        if (hit) {
          out.push({
            scene: scene.scene.key,
            kind: 'occlusion',
            a: nameOf(t as unknown as Node0),
            b: nameOf(o),
            overlap: { w: Math.round(w), h: Math.round(h) },
            at: { x: Math.round(Math.max(rt.x, ro.x)), y: Math.round(Math.max(rt.y, ro.y)) },
            ratio: round3(ratio),
            threshold,
          })
        }
      }
    }

    out.push(...findInteractiveOverlaps(scene, opts))
  }
  return out
}

// ── Интерактивы: контейнеры и спрайты (ITGAME-38) ──────────────────────────
// Раньше линтер смотрел только Text верхнего уровня — наезд кнопки или
// спрайта на соседний интерактив или на текст (чекбокс «пропускать отчёты» на
// строку событий отчёта) не ловился. Обход рекурсивный (контейнеры),
// видимость — с учётом родителей: getBounds() ребёнка не знает, что его
// контейнер скрыт.

interface WalkNode extends Node0 {
  input?: { enabled?: boolean } | null
  text?: string
  parentContainer?: (Phaser.GameObjects.GameObject & { visible?: boolean }) | null
}

function collectAll(list: Phaser.GameObjects.GameObject[], out: Phaser.GameObjects.GameObject[]): void {
  for (const o of list) {
    out.push(o)
    const withList = o as unknown as { list?: Phaser.GameObjects.GameObject[] }
    if (withList.list) collectAll(withList.list, out)
  }
}

// Видимость с учётом родителей: невидимый контейнер прячет всё содержимое,
// даже если у самого объекта visible === true.
function isWorldVisible(o: Phaser.GameObjects.GameObject): boolean {
  let p: (Phaser.GameObjects.GameObject & { visible?: boolean; parentContainer?: unknown }) | null =
    o as unknown as Phaser.GameObjects.GameObject & { visible?: boolean; parentContainer?: unknown }
  while (p) {
    if (p.visible === false) return false
    p = (p.parentContainer as typeof p) ?? null
  }
  return true
}

function safeBounds(o: Phaser.GameObjects.GameObject): Phaser.Geom.Rectangle | null {
  try {
    return (o as unknown as Node0).getBounds()
  } catch {
    return null
  }
}

function overlapWH(ra: Phaser.Geom.Rectangle, rb: Phaser.Geom.Rectangle): { w: number; h: number } {
  return {
    w: Math.min(ra.right, rb.right) - Math.max(ra.x, rb.x),
    h: Math.min(ra.bottom, rb.bottom) - Math.max(ra.y, rb.y),
  }
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000
const areaOf = (r: Phaser.Geom.Rectangle): number => r.width * r.height
function ratioOf(w: number, h: number, base: number): number {
  return base > 0 && w > 0 && h > 0 ? Math.min(1, (w * h) / base) : 0
}
function normalizeOverlapOptions(opts: OverlapOptions | null | undefined): OverlapOptions {
  const m = opts?.minAreaRatio
  if (m === undefined) return {}
  if (typeof m !== 'number' || !Number.isFinite(m) || m < 0 || m > 1) {
    throw new RangeError(`itd.overlaps: minAreaRatio — число 0..1, получено ${String(m)}`)
  }
  return { minAreaRatio: m }
}
const thresholdOf = (kind: OverlapKind, opts: OverlapOptions): number =>
  opts.minAreaRatio ?? DEFAULT_MIN_AREA_RATIO[kind]

// Прямоугольник a целиком внутри b (+1px допуск на округление) — вложенность,
// не находка (иконка внутри своей кнопки и т.п.).
function insideRect(a: Phaser.Geom.Rectangle, b: Phaser.Geom.Rectangle): boolean {
  return a.x >= b.x - 1 && a.y >= b.y - 1 && a.right <= b.right + 1 && a.bottom <= b.bottom + 1
}

// Пара двух Text верхнего уровня одного depth уже поймана циклом текст-текст
// (kind 'text') — не дублируем её как 'interactive'.
function sameTextPair(a: WalkNode, b: WalkNode): boolean {
  return (
    a.type === 'Text' && b.type === 'Text' && !a.parentContainer && !b.parentContainer &&
    (a.depth ?? 0) === (b.depth ?? 0)
  )
}

function findInteractiveOverlaps(scene: Phaser.Scene, opts: OverlapOptions): OverlapEntry[] {
  const out: OverlapEntry[] = []
  const all: Phaser.GameObjects.GameObject[] = []
  collectAll(scene.children.list, all)

  const interactives = all.filter((o) => {
    const n = o as unknown as WalkNode
    return n.input?.enabled === true && isWorldVisible(o) && (n.alpha ?? 1) > 0 && (n.depth ?? 0) < 90
  })
  // Не интерактивные тексты: интерактивный Text (чекбокс, modal.close) уже
  // виден циклу текст-текст выше (kind 'text') — не дублируем его здесь.
  const plainTexts = all.filter((o) => {
    const n = o as unknown as WalkNode
    return (
      n.type === 'Text' &&
      n.input?.enabled !== true &&
      isWorldVisible(o) &&
      (n.alpha ?? 1) > 0.5 &&
      (n.depth ?? 0) < 90 &&
      !!n.text
    )
  })

  for (let i = 0; i < interactives.length; i++) {
    for (let j = i + 1; j < interactives.length; j++) {
      const a = interactives[i]
      const b = interactives[j]
      const ra = safeBounds(a)
      const rb = safeBounds(b)
      if (!ra || !rb) continue
      const na = a as unknown as WalkNode
      const nb = b as unknown as WalkNode
      if (sameTextPair(na, nb)) continue
      const { w, h } = overlapWH(ra, rb)
      if (w <= 1 || h <= 1) continue
      if (insideRect(ra, rb) || insideRect(rb, ra)) continue
      const ratio = ratioOf(w, h, Math.min(areaOf(ra), areaOf(rb)))
      const threshold = thresholdOf('interactive', opts)
      if (ratio < threshold) continue
      out.push({
        scene: scene.scene.key,
        kind: 'interactive',
        a: nameOf(a as unknown as Node0),
        b: nameOf(b as unknown as Node0),
        overlap: { w: Math.round(w), h: Math.round(h) },
        at: { x: Math.round(Math.max(ra.x, rb.x)), y: Math.round(Math.max(ra.y, rb.y)) },
        ratio: round3(ratio),
        threshold,
      })
    }
  }

  for (const a of interactives) {
    const na = a as unknown as WalkNode
    for (const t of plainTexts) {
      const nt = t as unknown as WalkNode
      if (sameTextPair(na, nt)) continue
      const ra = safeBounds(a)
      const rt = safeBounds(t)
      if (!ra || !rt || rt.width <= 0 || rt.height <= 0) continue
      const { w, h } = overlapWH(ra, rt)
      if (w <= 1 || h <= 1) continue
      if (insideRect(ra, rt) || insideRect(rt, ra)) continue
      const ratio = ratioOf(w, h, Math.min(areaOf(ra), areaOf(rt)))
      const threshold = thresholdOf('interactive', opts)
      if (ratio < threshold) continue
      out.push({
        scene: scene.scene.key,
        kind: 'interactive',
        a: nameOf(na),
        b: nameOf(nt),
        overlap: { w: Math.round(w), h: Math.round(h) },
        at: { x: Math.round(Math.max(ra.x, rt.x)), y: Math.round(Math.max(ra.y, rt.y)) },
        ratio: round3(ratio),
        threshold,
      })
    }
  }
  return out
}

// Вылезание за канвас 1280×720 (bounds учитывают масштаб объекта).
export function findOffscreen(game: Phaser.Game): OffscreenEntry[] {
  const out: OffscreenEntry[] = []
  for (const scene of game.scene.getScenes(true)) {
    for (const obj of scene.children.list) {
      const o = obj as unknown as Node0 & { width?: number; height?: number }
      if (o.visible === false || o.alpha === 0) continue
      let b: Phaser.Geom.Rectangle
      try {
        b = o.getBounds()
      } catch {
        continue
      }
      if (b.width === 0 && b.height === 0) continue
      const left = Math.max(0, -b.x)
      const right = Math.max(0, b.right - GAME_W)
      const top = Math.max(0, -b.y)
      const bottom = Math.max(0, b.bottom - GAME_H)
      if (left === 0 && right === 0 && top === 0 && bottom === 0) continue
      const id = o.getData?.('id')
      out.push({
        scene: scene.scene.key,
        type: o.type ?? 'unknown',
        id: typeof id === 'string' ? id : null,
        text: typeof (o as unknown as { text?: string }).text === 'string'
          ? ((o as unknown as { text: string }).text).slice(0, 24)
          : null,
        bounds: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) },
        out: {
          left: Math.round(left), right: Math.round(right),
          top: Math.round(top), bottom: Math.round(bottom),
        },
      })
    }
  }
  return out
}

// ── Контраст ──────────────────────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  let s = m[1]
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2]
  const n = parseInt(s, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function luminance(rgb: [number, number, number]): number {
  const lin = rgb.map((c) => {
    const v = c / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
}

function contrastRatio(fg: string, bg: string): number | null {
  const f = hexToRgb(fg)
  const b = hexToRgb(bg)
  if (!f || !b) return null
  const l1 = luminance(f)
  const l2 = luminance(b)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

interface Fillable extends Node0 {
  isFilled?: boolean
  fillColor?: number
  fillAlpha?: number
}

// Порядок отрисовки: сначала depth, внутри — порядок в children.list.
function renderOrder(scene: Phaser.Scene): Phaser.GameObjects.GameObject[] {
  return [...scene.children.list].sort((a, b) => {
    const da = (a as unknown as { depth?: number }).depth ?? 0
    const db = (b as unknown as { depth?: number }).depth ?? 0
    return da !== db ? da - db : scene.children.list.indexOf(a) - scene.children.list.indexOf(b)
  })
}

function colorOf(obj: Phaser.GameObjects.GameObject): string | null {
  const o = obj as unknown as Fillable
  if (o.type !== 'Rectangle' && o.type !== 'Ellipse' && o.type !== 'Arc' && o.type !== 'Polygon') return null
  if (!o.isFilled || o.fillColor === undefined || o.fillColor === null) return null
  if ((o.fillAlpha ?? 1) < 0.5) return null
  return '#' + o.fillColor.toString(16).padStart(6, '0')
}

// Цвет фона под текстом: верхний залитый примитив НИЖЕ текста в порядке
// отрисовки, накрывающий центр текста. Нет такого — фон канваса.
function bgUnder(scene: Phaser.Scene, order: Phaser.GameObjects.GameObject[], text: Phaser.GameObjects.Text): string | null {
  const b = (text as unknown as Node0).getBounds()
  const cx = b.x + b.width / 2
  const cy = b.y + b.height / 2
  let bg: string | null = null
  for (const obj of order) {
    if (obj === (text as unknown as Phaser.GameObjects.GameObject)) break // дошли до текста
    const o = obj as unknown as Node0
    if (o.visible === false) continue
    let rb: Phaser.Geom.Rectangle
    try {
      rb = o.getBounds()
    } catch {
      continue
    }
    if (cx < rb.x || cx > rb.right || cy < rb.y || cy > rb.bottom) continue
    const c = colorOf(obj)
    if (c) bg = c
  }
  return bg
}

const GAME_BG = '#1a1c2c'

// Тексты с контрастом ниже 3:1 к фону под ними (WCAG-порог крупного UI-текста).
export function findLowContrast(game: Phaser.Game, threshold = 3): ContrastEntry[] {
  const out: ContrastEntry[] = []
  for (const scene of game.scene.getScenes(true)) {
    const order = renderOrder(scene)
    for (const t of textObjs(scene)) {
      if (!t.visible || t.alpha < 0.5) continue
      const fg = t.style.color
      if (typeof fg !== 'string') continue
      const bg = bgUnder(scene, order, t) ?? GAME_BG
      const ratio = contrastRatio(fg, bg)
      if (ratio === null) continue
      if (ratio < threshold) {
        const id = (t as unknown as Node0).getData?.('id')
        out.push({
          scene: scene.scene.key,
          id: typeof id === 'string' ? id : null,
          text: t.text.slice(0, 24).replace(/\n/g, ' '),
          fg,
          bg,
          ratio: Math.round(ratio * 100) / 100,
        })
      }
    }
  }
  return out
}

// Шрифт мельче 12px (читаемость на зуме и мелких экранах).
export function findTiny(game: Phaser.Game, min = 12): TinyEntry[] {
  const out: TinyEntry[] = []
  for (const scene of game.scene.getScenes(true)) {
    for (const t of textObjs(scene)) {
      if (!t.visible) continue
      const size = parseFloat(String(t.style.fontSize))
      if (Number.isNaN(size) || size >= min) continue
      const id = (t as unknown as Node0).getData?.('id')
      out.push({
        scene: scene.scene.key,
        id: typeof id === 'string' ? id : null,
        text: t.text.slice(0, 24).replace(/\n/g, ' '),
        size,
      })
    }
  }
  return out
}
