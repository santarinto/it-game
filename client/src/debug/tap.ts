import type Phaser from 'phaser'
import { client } from '../net'
import type { WireEntry } from '../net'
import { goneObj, inItdCall, makeGotCatcher } from './trace'
import type { PointerProbe, TraceSent, TraceTarget } from './trace'

// itd.tap (ITGAME-153): клик по id синтетическим MouseEvent на канвас — третий класс ввода между
// настоящим (CDP-клик по координатам: рамка снимка, снимок, клик, трасса — 2–4 вызова) и itd.click
// (мимо хит-теста и input-слоя). mousedown/mouseup проходят настоящий хит-тест Phaser: InputManager
// разбирает их в DOM-обработчике синхронно, так что got/sent — то, что игра сделала с событием.
// isTrusted у них false: itd.claim считает такое нажатие synthetic, не чужим (claim.ts: onDown).
// Слушает Phaser именно MouseEvent — PointerEvent этой сборке неинтересен (проба 24.10: pointer и sent пусты).
// Вызывать с await, по одному: параллельные tap (Promise.all) делят зажатую кнопку, claim склеит их down
// в один synthetic (< 50 мс), а sent первого поймает команды второго.

export const TAP_HOLD_MS = 40 // между mousedown и mouseup по умолчанию — как у быстрого настоящего клика
export const TAP_HOLD_MAX_MS = 2000
export const TAP_SETTLE_MS = 60 // после up ждём отправку обработчика (> GROUP_MS claim: два tap подряд — два synthetic)

export interface TapOptions {
  /** 0 — левая (по умолчанию), 2 — правая (увольнение в офисе); buttons у down 1 | 2, у up 0. */
  button?: 0 | 2
  /** Мс между mousedown и mouseup, 0..2000, по умолчанию 40. */
  holdMs?: number
}

export type TapCode = 'no_node' | 'hidden' | 'no_hit' | 'covered' | 'bad_args'

export interface TapResult {
  ok: boolean
  /** no_node — нет такого id; hidden — узел невидим; covered — хит-тест в центре отдаёт клик другому (wins), событие не слали; no_hit — точку не берёт никто (нет hitArea); bad_args — button не 0|2, holdMs не число 0..2000. */
  code?: TapCode
  error?: string
  /** Всегда true: события с isTrusted false (itd.claim считает их synthetic), не настоящий клик и не itd.click. */
  synthetic: true
  id: string | null
  /** Центр объекта, мировые 1280×720 (= nodes().cx/cy); null — узла нет. */
  at: { x: number; y: number } | null
  /** Куда пришло событие, CSS px окна: обратное преобразование Phaser (canvasBounds и displayScale ScaleManager, как у transformX/Y), так что down попадает в at, даже если холст сдвинули, а Phaser границы ещё не перечитал; null — события не было. */
  client: { x: number; y: number } | null
  /** Победитель хит-теста Phaser в точке до события — метка, как itd.trace pointer[].wins (safe id или тип без id); null — никто. */
  wins: string | null
  /** До кого Phaser довёл down и up (GAMEOBJECT_POINTER_DOWN/UP): safe id или тип без id; [] — до объектов не дошло. Кнопка, удалившая себя в pointerdown, в down есть, в up её нет. */
  got: { down: string[]; up: string[] }
  /** Получившие down и снятые до up (уничтожены, без input, скрыты, сцена не идёт), как itd.trace pointer[].gone: пустой up с gone [цель] — «клик принят, цель ушла» (menu.diff.*, ✕ окна), не «не дошёл». */
  gone: string[]
  /** Команды, ушедшие на сервер от down до TAP_SETTLE_MS (60 мс) после up, как itd.trace sent: src 'itd' у ушедших синхронно внутри dispatchEvent (обработчик down/up), 'ui' у ушедших позже (tween, delayedCall, реакция UI на снапшот). */
  sent: TraceSent[]
}

// Что фасад даёт tap: хит-тест, пересчёт мировой точки в клиентские px, проба события, узел по id.
export interface TapDeps {
  canvas: () => HTMLCanvasElement
  node: (id: string) => { id: string | null; scene: string; visible: boolean; cx: number; cy: number } | null
  /** Победитель хит-теста в мировой точке (как itd.stack). */
  stack: (gx: number, gy: number) => { wins: TraceTarget | null }
  /** Мировая точка → CSS px окна, обратным преобразованием Phaser (transformX/Y); звать после того, как stack() нашёл победителя — активная камера тогда есть. */
  toClient: (gx: number, gy: number) => { x: number; y: number }
  /** Проба по самому событию — тот же путь, что у трассы и claim (pageX → transformX → камера → хит-тест). */
  probe: PointerProbe
  warm: () => void
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const refuse = (code: TapCode, error: string, base: Omit<TapResult, 'ok' | 'code' | 'error'>): TapResult =>
  ({ ok: false, code, error, ...base })

export function makeTap(deps: TapDeps): (id: string, opts?: TapOptions) => Promise<TapResult> {
  return async (rawId, opts = {}) => {
    const base: Omit<TapResult, 'ok' | 'code' | 'error'> = {
      synthetic: true, id: null, at: null, client: null, wins: null, got: { down: [], up: [] }, gone: [], sent: [],
    }
    const button = opts.button ?? 0
    const holdMs = opts.holdMs ?? TAP_HOLD_MS
    if (button !== 0 && button !== 2) return refuse('bad_args', `itd.tap: button — 0 или 2 (получено ${String(opts.button)})`, base)
    if (typeof holdMs !== 'number' || !Number.isFinite(holdMs) || holdMs < 0 || holdMs > TAP_HOLD_MAX_MS) {
      return refuse('bad_args', `itd.tap: holdMs — число 0..${TAP_HOLD_MAX_MS} (получено ${String(opts.holdMs)})`, base)
    }
    deps.warm()
    const n = deps.node(rawId)
    if (!n) return refuse('no_node', `itd.tap: id '${rawId}' не найден — см. itd.ids()`, base)
    base.id = n.id
    base.at = { x: n.cx, y: n.cy }
    if (!n.visible) return refuse('hidden', `itd.tap: '${rawId}' невидим`, base)

    // Тот же хит-тест, что itd.stack(cx, cy): событие шлём только если клик получит сама цель
    const s = deps.stack(n.cx, n.cy)
    base.wins = s.wins ? (s.wins.safe ?? s.wins.type) : null
    if (!s.wins) return refuse('no_hit', `itd.tap: в центре '${rawId}' (${n.cx}, ${n.cy}) хит-тест Phaser никого не находит — у объекта нет hitArea или она не накрывает точку`, base)
    if (s.wins.id !== n.id || s.wins.scene !== n.scene) {
      return refuse('covered', `itd.tap: клик в центр '${rawId}' получит ${base.wins}, не цель — событие не слали (itd.stack)`, base)
    }

    // Мировая точка → клиентские координаты тем же преобразованием, что Phaser применит к событию в обратную сторону
    const cv = deps.canvas()
    const pt = deps.toClient(n.cx, n.cy)
    const clientX = pt.x
    const clientY = pt.y
    base.client = { x: Math.round(clientX * 10) / 10, y: Math.round(clientY * 10) / 10 }

    const sent: TraceSent[] = []
    const t0 = performance.now()
    let inDispatch = false
    const untap = client.tapWire((e: WireEntry, raw: Record<string, unknown>) => {
      if (e.dir === 'out') sent.push({ t: Math.round(performance.now() - t0), ...raw, type: e.type, src: inDispatch ? 'itd' : 'ui' })
    })
    const got = makeGotCatcher()
    const gotDown: string[] = []
    const gotUp: string[] = []
    const downObjs: { obj: Phaser.GameObjects.GameObject; label: string }[] = []
    let gone: string[] = []
    const fire = (type: 'mousedown' | 'mouseup'): void => {
      const down = type === 'mousedown'
      const ev = new MouseEvent(type, {
        bubbles: true, cancelable: true, clientX, clientY, button, buttons: down ? 1 << (button === 2 ? 1 : 0) : 0, view: window,
      })
      // Объекты под событием — по точке самого события (pageX → камера), а не по cx/cy до down: down мог сменить
      // масштаб, камеру или сцену, и up приходит уже в другой мир (menu.zoom.*) — так считает и трасса
      let objs: Phaser.GameObjects.GameObject[] = []
      try {
        objs = deps.probe(ev).objs
      } catch (e) {
        console.error('[tap] pointer probe упал:', e)
      }
      if (!down) gone = downObjs.filter((d) => goneObj(d.obj)).map((d) => d.label) // момент up до Phaser, как в трассе
      got.arm(objs, down, (label, obj) => {
        if (down) downObjs.push({ obj, label })
        ;(down ? gotDown : gotUp).push(label)
      })
      inDispatch = true
      try {
        inItdCall(() => cv.dispatchEvent(ev))
      } finally {
        inDispatch = false
      }
      got.flush() // Phaser разослал событие синхронно — слушатели got свою работу сделали
    }
    let pressed = false
    try {
      try {
        pressed = true
        fire('mousedown')
        await sleep(holdMs)
      } finally {
        if (pressed) fire('mouseup') // кнопка не остаётся зажатой, что бы ни случилось между down и up
      }
      await sleep(TAP_SETTLE_MS)
    } finally {
      untap()
      got.flush()
    }
    return { ok: true, ...base, got: { down: gotDown, up: gotUp }, gone, sent }
  }
}
