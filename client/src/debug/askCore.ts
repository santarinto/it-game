// itd.ask (ITGAME-152): чистая логика формы опроса добивки человеком —
// валидация аргументов, расчёт dock/where, сериализация для sessionStorage,
// состояние ответов. Без Phaser и DOM (node:test запускает напрямую).
// DOM-часть — client/src/debug/ask.ts.

export const ASK_KEY = 'itd.ask'
export const ASK_BOX_ID = 'itd-ask'
export const ASK_ITEMS_MAX = 20
export const ASK_TEXT_MAX = 500
export const ASK_CHOICES_MAX = 10
export const ASK_CHOICE_MAX = 50
export const ASK_COMMENT_MAX = 1000

export type AskKind = 'check' | 'value'
export type AskDock = 'auto' | 'bottom' | 'right' | 'overlay'
export type AskWhere = 'bottom' | 'right' | 'overlay'

export interface AskItem {
  /** Номер пункта (1..N). */
  n: number
  /** Текст вопроса или задания. */
  text: string
  /** 'check' (кнопки «корректно / нет / непонятно», по умолчанию) или 'value' (кнопки choices или свой ввод). */
  kind?: AskKind
  /** Варианты ответов для kind: 'value'. */
  choices?: string[]
  /** id цели в игре («нажми сам»): если задана, «корректно» валидируется с хит-тестом/claim. */
  target?: string
}

export interface AskOptions {
  /** Размещение: 'auto' (снизу если >=220px, справа если >=320px, иначе оверлей), 'bottom', 'right', 'overlay'. */
  dock?: AskDock
}

export interface AskAnswer {
  n: number
  status: string | null
  comment: string
  target?: string
  hit?: boolean | null
}

export interface AskResult {
  /** Время отправки ответа (Date.now()). */
  at: number
  /** sha сборки игры (itd.version.sha). */
  sha: string
  /** Масштаб интерфейса (itd.uiScale). */
  ui: string | null
  /** innerWidth вкладки в момент отправки. */
  iw: number
  /** innerHeight вкладки в момент отправки. */
  ih: number
  /** devicePixelRatio вкладки. */
  dpr: number
  /** Заголовок вкладки. */
  title: string
  /** Массив ответов по пунктам. */
  answers: AskAnswer[]
}

export interface AskRefusal {
  ok: false
  code: 'bad_args' | 'no_ask'
  error: string
}

export interface AskStartResult {
  ok: true
  n: number
  where: AskWhere
}

export interface AskRecord {
  items: AskItem[]
  answers: Record<number, { status: string | null; comment: string }>
  dock: AskDock
  where: AskWhere
  collapsed: boolean
  submitted: boolean
  result: AskResult | null
}

export function refuseAsk(code: AskRefusal['code'], error: string): AskRefusal {
  return { ok: false, code, error }
}

export function checkAskItems(raw: unknown): AskRefusal | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > ASK_ITEMS_MAX) {
    return refuseAsk('bad_args', `items: непустой массив от 1 до ${ASK_ITEMS_MAX} пунктов`)
  }
  const seenN = new Set<number>()
  for (let i = 0; i < raw.length; i++) {
    const it = raw[i]
    if (!it || typeof it !== 'object') {
      return refuseAsk('bad_args', `items[${i}]: пункт должен быть объектом {n, text, kind?, choices?, target?}`)
    }
    const { n, text, kind, choices, target } = it as Partial<AskItem>
    if (!Number.isInteger(n) || (n as number) < 1) {
      return refuseAsk('bad_args', `items[${i}].n: целое положительное число (1..N)`)
    }
    if (seenN.has(n as number)) {
      return refuseAsk('bad_args', `items[${i}].n: дубликат номера пункта ${n}`)
    }
    seenN.add(n as number)
    if (typeof text !== 'string' || text.trim() === '' || text.length > ASK_TEXT_MAX) {
      return refuseAsk('bad_args', `items[${i}].text: непустая строка до ${ASK_TEXT_MAX} символов`)
    }
    if (kind !== undefined && kind !== 'check' && kind !== 'value') {
      return refuseAsk('bad_args', `items[${i}].kind: 'check' или 'value'`)
    }
    if (choices !== undefined) {
      if (!Array.isArray(choices) || choices.length === 0 || choices.length > ASK_CHOICES_MAX) {
        return refuseAsk('bad_args', `items[${i}].choices: массив строк от 1 до ${ASK_CHOICES_MAX}`)
      }
      for (let c = 0; c < choices.length; c++) {
        const ch = choices[c]
        if (typeof ch !== 'string' || ch.trim() === '' || ch.length > ASK_CHOICE_MAX) {
          return refuseAsk('bad_args', `items[${i}].choices[${c}]: непустая строка до ${ASK_CHOICE_MAX} символов`)
        }
      }
    }
    if (target !== undefined && (typeof target !== 'string' || target.trim() === '')) {
      return refuseAsk('bad_args', `items[${i}].target: непустая строка id объекта Phaser`)
    }
  }
  return null
}

export function checkAskOptions(opts: unknown): AskRefusal | null {
  if (opts === undefined || opts === null) return null
  if (typeof opts !== 'object') {
    return refuseAsk('bad_args', 'opts: объект {dock?: "auto" | "bottom" | "right" | "overlay"}')
  }
  const dock = (opts as AskOptions).dock
  if (dock !== undefined && dock !== 'auto' && dock !== 'bottom' && dock !== 'right' && dock !== 'overlay') {
    return refuseAsk('bad_args', 'opts.dock: "auto", "bottom", "right" или "overlay"')
  }
  return null
}

export function calcDockWhere(
  dock: AskDock,
  canvasRect: { bottom: number; right: number },
  viewport: { iw: number; ih: number },
): AskWhere {
  if (dock === 'bottom') return 'bottom'
  if (dock === 'right') return 'right'
  if (dock === 'overlay') return 'overlay'
  // dock === 'auto'
  const freeBottom = viewport.ih - canvasRect.bottom
  const freeRight = viewport.iw - canvasRect.right
  if (freeBottom >= 220) return 'bottom'
  if (freeRight >= 320) return 'right'
  return 'overlay'
}

export function newAskRecord(items: AskItem[], dock: AskDock, where: AskWhere): AskRecord {
  const answers: Record<number, { status: string | null; comment: string }> = {}
  for (const it of items) {
    answers[it.n] = { status: null, comment: '' }
  }
  return {
    items: items.map((it) => ({
      n: it.n,
      text: it.text,
      kind: it.kind ?? 'check',
      choices: it.choices ? [...it.choices] : undefined,
      target: it.target,
    })),
    answers,
    dock,
    where,
    collapsed: false,
    submitted: false,
    result: null,
  }
}

export function serializeAskRecord(rec: AskRecord): string {
  return JSON.stringify(rec)
}

export function parseAskRecord(json: string): AskRecord | null {
  try {
    const parsed = JSON.parse(json)
    if (!parsed || typeof parsed !== 'object') return null
    if (checkAskItems(parsed.items) !== null) return null
    if (!parsed.answers || typeof parsed.answers !== 'object' || Array.isArray(parsed.answers)) return null
    const validDock = ['auto', 'bottom', 'right', 'overlay'].includes(parsed.dock) ? parsed.dock : 'auto'
    const validWhere = ['bottom', 'right', 'overlay'].includes(parsed.where) ? parsed.where : 'overlay'
    return {
      items: parsed.items,
      answers: parsed.answers ?? {},
      dock: validDock,
      where: validWhere,
      collapsed: Boolean(parsed.collapsed),
      submitted: Boolean(parsed.submitted),
      result: parsed.result ?? null,
    }
  } catch {
    return null
  }
}

export interface BoxDimensions {
  left: string
  top: string
  width: string
  maxHeight: string
  boxShadow: string
}

export function calcDockBoxStyle(
  where: AskWhere,
  canvasRect: { left: number; top: number; right: number; bottom: number; width: number; height: number },
  viewport: { iw: number; ih: number },
  collapsed: boolean,
): BoxDimensions {
  if (collapsed) {
    // В свернутом состоянии — только шапка (высота ~44px)
    if (where === 'bottom') {
      return {
        left: `${canvasRect.left}px`,
        top: `${canvasRect.bottom + 8}px`,
        width: `${canvasRect.width}px`,
        maxHeight: '48px',
        boxShadow: 'none',
      }
    }
    if (where === 'right') {
      return {
        left: `${canvasRect.right + 8}px`,
        top: `${canvasRect.top}px`,
        width: `${Math.max(260, viewport.iw - canvasRect.right - 16)}px`,
        maxHeight: '48px',
        boxShadow: 'none',
      }
    }
    return {
      left: `${Math.max(10, viewport.iw - 380)}px`,
      top: `${Math.max(48, canvasRect.top + 8)}px`,
      width: `${Math.min(360, viewport.iw - 20)}px`,
      maxHeight: '48px',
      boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
    }
  }

  if (where === 'bottom') {
    const freeBottom = viewport.ih - canvasRect.bottom
    return {
      left: `${canvasRect.left}px`,
      top: `${canvasRect.bottom + 8}px`,
      width: `${canvasRect.width}px`,
      maxHeight: `${Math.max(120, freeBottom - 16)}px`,
      boxShadow: 'none',
    }
  }

  if (where === 'right') {
    const freeRight = viewport.iw - canvasRect.right
    return {
      left: `${canvasRect.right + 8}px`,
      top: `${canvasRect.top}px`,
      width: `${Math.max(260, freeRight - 16)}px`,
      maxHeight: `${canvasRect.height}px`,
      boxShadow: 'none',
    }
  }

  // overlay
  return {
    left: `${Math.max(10, viewport.iw - 380)}px`,
    top: `${Math.max(48, canvasRect.top + 8)}px`,
    width: `${Math.min(360, viewport.iw - 20)}px`,
    maxHeight: `${Math.max(120, canvasRect.height * 0.9)}px`,
    boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
  }
}
