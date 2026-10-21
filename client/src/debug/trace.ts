import Phaser from 'phaser'
import { client } from '../net'
import type { WireEntry } from '../net'
import type { StateMessage } from '../protocol'
import { onUi } from '../uibus'

// itd.trace() (ITGAME-37): живая подписка на окно вокруг одного действия
// игрока — в отличие от itd.log()/itd.net() (срез кольцевого буфера), здесь
// подписки ставятся ДО action и не пропускают события, случившиеся между
// вызовами. Реальный путь игрока без поллинга: клавиши (DOM и itd.key()),
// команды на сервер и не-state ответы, переходы фазы/скорости/дня/сцен,
// тосты и звуки — всё с меткой t (мс от старта, performance.now()).
//
// ITGAME-88: указатель (mousedown/mouseup — то, что слушает Phaser) с мировыми
// координатами и целью по настоящему хит-тесту Phaser (тот же, что itd.stack/hit),
// плюс got — до кого реально дошёл pointerdown/up (GAMEOBJECT_POINTER_DOWN/UP
// самих объектов; ITGAME-112). И открытое окно:
// itd.trace.start() → … настоящий клик другим вызовом инструмента … →
// itd.trace.stop(): фиксированное окно гонялось с кликом, пришедшим позже.
// ITGAME-179: pointer.wins — метка, как got; sent[].src — itd|ui; summary() — окно строками.
// ITGAME-160: peek(id?) — окно на сейчас без закрытия.

// Кто под указателем по хит-тесту Phaser (agentApi: stackAt) — без импорта
// agentApi (он импортирует этот модуль): функцию передаёт фасад.
export interface TraceTarget {
  scene: string
  type: string
  id: string | null
  safe: string | null
  depth: number
  title: string | null
}

// objs — те же interactive под точкой (stackAt.hits), объектами: трассировка
// вешает на них слушателей got ДО Phaser (ITGAME-112).
export type PointerProbe = (ev: MouseEvent) => { x: number; y: number; wins: TraceTarget | null; stack: string[]; objs: Phaser.GameObjects.GameObject[] }

// Запись sent (ITGAME-179): полная команда + src — кто её отправил. Отложенная отправка (tween, delayedCall) после itd.click/itd.key — уже 'ui'.
export interface TraceSent {
  t: number
  type: string
  office?: number
  src: 'itd' | 'ui' // itd — ушла синхронно внутри вызова itd.* (cmd, click, key, pause, resume, speed, step; play — через cmd; отправка, отложенная обработчиком — tween, delayedCall, — уже ui); ui — всё прочее: настоящий клик/клавиша, реакция UI на снапшот
  [k: string]: unknown
}

export interface TracePointer {
  t: number
  type: 'down' | 'up' // mousedown / mouseup (Phaser слушает именно их)
  button: number // 0 — левая, 2 — правая (увольнение в офисе)
  x: number // мировые 1280×720 — как nodes().cx/cy и itd.stack(gx, gy)
  y: number
  onCanvas: boolean // событие пришло в канвас; false — мимо холста (#topbar, поля страницы)
  wins: string | null // ITGAME-179: метка победителя хит-теста Phaser в момент события — та же форма, что got (safe id или тип без id); полная строка — stack[0]; null — ни одна hitArea не накрывает точку
  stack: string[] // все interactive под точкой сверху вниз, как itd.stack().stack
  got: string[] // до кого Phaser реально довёл pointerdown/up в этом событии (GAMEOBJECT_POINTER_DOWN/UP объекта): safe id или тип без id; [] — до объектов не дошло. Кнопка, удалившая себя в pointerdown, в got на down есть, на up её нет — она в gone
  gone: string[] // ITGAME-148: на up — получившие down этого нажатия и снятые до up (уничтожены, без input или input выключен, скрыты сами или контейнером, сцена не идёт): «клик принят, цель ушла»; на down — []; утащенный из-под указателя — не gone
}

export interface TraceResult {
  ok: boolean
  error?: string
  result?: unknown
  t0: number // epoch ms — момент постановки подписок (до action)
  t1: number // epoch ms — момент закрытия окна
  windowMs: number
  actionMs: number // rel() сразу после await action()
  /**
   * handled — в активной сцене есть подписчик keydown-<KEY>/keydown; acted —
   * сцены, реально отработавшие клавишу; [] при handled:true — guard обработчика
   * её отбросил.
   */
  keys: { t: number; key: string; source: 'dom' | 'itd'; repeat: boolean; handled: boolean; scenes: string[]; acted: { scene: string; action: string }[] }[]
  sent: TraceSent[] // полная команда, по порядку отправки; src — откуда (ITGAME-179)
  recv: { t: number; type: string; info: Record<string, unknown> }[] // не-state входящие: error/day_report/game_over/… (у error info.re/rev)
  /** ITGAME-45: снапшоты окна — rev, cause (tick|cmd|debug|start|resume), re — id своей команды-причины. */
  states: { t: number; rev: number; cause: string; re?: number }[]
  transitions: { t: number; kind: 'phase' | 'speed' | 'day' | 'scenes'; from: string | number | null; to: string | number | null }[]
  toasts: { t: number; text: string; where: 'top' | 'bottom'; ms: number; scene: string }[]
  sounds: { t: number; name: string; key: string; volume: number; ok: boolean; scene: string }[]
  /**
   * ITGAME-88: настоящие нажатия указателя в окне (mousedown/mouseup): мировые x/y,
   * wins — метка победителя (как got), stack — хит-тест Phaser в момент события, got — до кого дошёл
   * pointerdown/up (GAMEOBJECT_POINTER_DOWN/UP самих объектов, ITGAME-112:
   * сценовый gameobjectdown терял объект, удаливший себя в обработчике).
   * itd.click() сюда не попадает: он мимо input-слоя.
   * Пусто при «команда не ушла» — клик до страницы не дошёл; есть запись с
   * got [] — дошёл до хит-теста, цели нет; got с целью — до неё дошёл
   * pointerdown/up, обработчик сам решил не слать (или закрыл своё окно: такой
   * объект в got на down есть, а на up его уже нет — удалённый до отпускания
   * не попадает в хит-тест Phaser).
   * ITGAME-148: на up — gone: получившие down и снятые до up; пустой up с gone [цель] — клик
   * принят, цель ушла (menu.diff.*, «Сохранить и выйти», btn.next_day, ✕), не «не дошёл».
   */
  pointer: TracePointer[]
  id?: number // ITGAME-88: открытое окно itd.trace.start() — его id
  cut?: boolean // ITGAME-88: открытое окно закрылось само по maxMs раньше stop()
}

// itd.trace.start() (ITGAME-88): открытое окно.
export interface TraceStartOptions {
  maxMs?: number // окно закроется само через столько мс, если stop() не позвали: 1..600000, по умолчанию 120000
}

export interface TraceStart {
  ok: boolean
  id?: number // ключ для itd.trace.stop(id)
  t0?: number // epoch ms постановки подписок
  maxMs?: number
  open?: number[] // id открытых сейчас окон (с этим)
  code?: 'bad_max' | 'too_many'
  error?: string
}

// Раскладка клавиш → имя (как в событиях Phaser `keydown-<NAME>`): последний
// код в KeyCodes выигрывает — так же строит свой KeyMap сам Phaser
// (input/keyboard/keys/KeyMap.js), имена совпадут 1-в-1.
const KEY_NAME: Record<number, string> = {}
for (const [name, code] of Object.entries(Phaser.Input.Keyboard.KeyCodes)) {
  KEY_NAME[code as number] = name
}

// itd.key() эмитит события на kb сцен мимо DOM (agentApi.ts) — свой канал,
// не связанный с window.addEventListener. Слушатели держатся в общем Set:
// параллельные trace() независимы, каждый добавляет/снимает свой fn.
const itdKeyListeners = new Set<(name: string) => void>()

// ITGAME-179: идёт ли сейчас вызов фасада itd.* — тап эфира метит sent[].src. Счётчик,
// не флаг: вложенные вызовы (play → cmd). client.send → logWire → tapWire синхронны
// (net.ts sendCmd), так что метка честна для команд, ушедших внутри вызова; после await
// (scenario, advanceDays) это уже реакция UI — 'ui'.
let itdDepth = 0
export function inItdCall<T>(fn: () => T): T {
  itdDepth++
  try {
    return fn()
  } finally {
    itdDepth--
  }
}

// Вызывается из agentApi.key() ДО цикла emit по сценам — обработчик клавиши
// может остановить/сменить сцену, и handlerScenes() должен увидеть сцены
// ДО этого, а не после.
export function notifyItdKey(name: string): void {
  for (const fn of itdKeyListeners) {
    try {
      fn(name)
    } catch (e) {
      console.error('[trace] notifyItdKey слушатель упал:', e)
    }
  }
}

// Сцены, у которых есть реальный обработчик клавиши name: активный
// keyboard-плагин сцены и хотя бы один слушатель keydown-<NAME> или общего
// keydown. Порядок и имена методов — Phaser 3.90 (Scene.input.keyboard).
function handlerScenes(game: Phaser.Game, name: string): string[] {
  const scenes: string[] = []
  for (const scene of game.scene.getScenes(true)) {
    const kb = scene.input?.keyboard
    if (!kb || !kb.isActive()) continue
    if (kb.listenerCount(`keydown-${name}`) > 0 || kb.listenerCount('keydown') > 0) {
      scenes.push(scene.scene.key)
    }
  }
  return scenes
}

// Ручной шаг игрового лупа (как warmTicks в agentApi.ts): гонит TimeStep
// вперёд без ожидания RAF — используется перед закрытием окна, чтобы диф
// сцен (POST_STEP) успел сработать на смену, случившуюся у самой границы.
function stepOnce(game: Phaser.Game): void {
  const loop = game.loop as Phaser.Core.TimeStep & { tick(): void }
  loop.tick()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface OpenTrace {
  r: TraceResult
  rel: () => number
  close: () => void
}

// ITGAME-148: объект, получивший down, к up больше не цель ввода Phaser — условия
// InputManager.inputCandidate (Phaser 3.90) плюс уничтожение и сцена: destroy() обнуляет
// scene/input; removeInteractive/disableInteractive — input; скрыт сам или контейнером
// (setVisible(false), alpha 0 — willRender: так меню прячет menu.diff.* под «Начать заново?»);
// сцена остановлена/усыплена/на паузе — не isActive(). Утащенный из-под указателя живой
// объект — не gone.
function goneObj(obj: Phaser.GameObjects.GameObject): boolean {
  if (!obj.scene || !obj.input || !obj.input.enabled) return true
  if (!obj.scene.sys.isActive()) return true
  const cam = obj.scene.cameras?.main
  if (!cam) return false
  if (!obj.willRender(cam)) return true
  for (let p = obj.parentContainer; p; p = p.parentContainer) if (!p.willRender(cam)) return true
  return false
}

// Метка объекта для got/wins: safe id (точки → «:») или тип без id (ITGAME-179).
function labelOf(obj: Phaser.GameObjects.GameObject): string {
  const id = obj.getData?.('id')
  return typeof id === 'string' ? id.replace(/\./g, ':') : obj.type
}

// ITGAME-112/151: слушатели got — кому Phaser довёл pointerdown/up. Ставятся на объекты
// под точкой ДО Phaser (capture-слушатель окна), снимаются, когда Phaser разослал событие:
// следующим arm()/flush() или setTimeout 0 — страховка, если следующего события не будет.
// Общие для itd.trace и itd.claim.
export interface GotCatcher {
  arm: (objs: Phaser.GameObjects.GameObject[], down: boolean, onGot: (label: string, obj: Phaser.GameObjects.GameObject) => void) => void
  flush: () => void
}

export function makeGotCatcher(): GotCatcher {
  let pending: (() => void)[] = []
  const flush = () => {
    const fs = pending
    pending = []
    fs.forEach((f) => f())
  }
  const arm: GotCatcher['arm'] = (objs, down, onGot) => {
    // Для openTrace лишний (он сам flush-ит первым), но нужен itd.claim: нажатия подряд должны
    // снять слушатели прошлого нажатия, прежде чем вешать новые
    flush()
    const evName = down ? Phaser.Input.Events.GAMEOBJECT_POINTER_DOWN : Phaser.Input.Events.GAMEOBJECT_POINTER_UP
    for (const obj of objs) {
      // имя читаем сейчас: после destroy() в обработчике getData/type уже пусты
      const label = labelOf(obj)
      const on = () => onGot(label, obj)
      obj.on(evName, on)
      pending.push(() => obj.off(evName, on))
    }
    setTimeout(flush, 0)
  }
  return { arm, flush }
}

// Подписки окна: ставятся сразу, снимаются close() (один раз).
function openTrace(game: Phaser.Game, probe: PointerProbe, windowMs: number): OpenTrace {
  const t0 = Date.now()
  const startPerf = performance.now()
  const rel = () => performance.now() - startPerf

  const r: TraceResult = {
    ok: true,
    t0,
    t1: 0,
    windowMs,
    actionMs: 0,
    keys: [],
    sent: [],
    recv: [],
    states: [],
    transitions: [],
    toasts: [],
    sounds: [],
    pointer: [],
  }

  const offs: (() => void)[] = []

  // ── keys: itd.key() (мимо DOM) ────────────────────────────────────────
  const onItdKey = (name: string) => {
    const scenes = handlerScenes(game, name)
    r.keys.push({ t: rel(), key: name, source: 'itd', repeat: false, handled: scenes.length > 0, scenes, acted: [] })
  }
  itdKeyListeners.add(onItdKey)
  offs.push(() => itdKeyListeners.delete(onItdKey))

  // ── keys: реальная клавиатура (capture — видит раньше Phaser) ──────────
  const onDomKeydown = (ev: KeyboardEvent) => {
    const name = KEY_NAME[ev.keyCode] ?? ev.code
    const scenes = handlerScenes(game, name)
    r.keys.push({ t: rel(), key: name, source: 'dom', repeat: ev.repeat, handled: scenes.length > 0, scenes, acted: [] })
  }
  window.addEventListener('keydown', onDomKeydown, true)
  offs.push(() => window.removeEventListener('keydown', onDomKeydown, true))

  // ── sent/recv: эфир WS ──────────────────────────────────────────────────
  const untapWire = client.tapWire((e: WireEntry, raw: Record<string, unknown>) => {
    const t = rel()
    if (e.dir === 'out') {
      // src последним: extra.src внутри самой команды его не перекроет
      r.sent.push({ t, ...raw, type: e.type, src: itdDepth > 0 ? 'itd' : 'ui' })
    } else if (e.type === 'state') {
      const st: TraceResult['states'][number] = { t, rev: raw.rev as number, cause: raw.cause as string }
      if (typeof raw.re === 'number') st.re = raw.re
      r.states.push(st)
    } else {
      r.recv.push({ t, type: e.type, info: e.info })
    }
  })
  offs.push(untapWire)

  // ── transitions: фаза/скорость/день из снапшотов state ─────────────────
  type Prev = { phase: StateMessage['phase']; speed: number; day: number } | null
  let prev: Prev = client.latest
    ? { phase: client.latest.phase, speed: client.latest.speed, day: client.latest.day }
    : null
  const unsubState = client.subscribe({
    onState: (s) => {
      const t = rel()
      if (!prev || s.phase !== prev.phase) r.transitions.push({ t, kind: 'phase', from: prev?.phase ?? null, to: s.phase })
      if (!prev || s.speed !== prev.speed) r.transitions.push({ t, kind: 'speed', from: prev?.speed ?? null, to: s.speed })
      if (!prev || s.day !== prev.day) r.transitions.push({ t, kind: 'day', from: prev?.day ?? null, to: s.day })
      prev = { phase: s.phase, speed: s.speed, day: s.day }
    },
    onError: () => {},
    onDisconnect: () => {},
  })
  offs.push(unsubState)

  // ── transitions: набор активных сцен, диф каждый POST_STEP ─────────────
  let prevScenes = game.scene.getScenes(true).map((sc) => sc.scene.key).join(',')
  const onPostStep = () => {
    const now = game.scene.getScenes(true).map((sc) => sc.scene.key).join(',')
    if (now !== prevScenes) {
      r.transitions.push({ t: rel(), kind: 'scenes', from: prevScenes || null, to: now || null })
      prevScenes = now
    }
  }
  game.events.on(Phaser.Core.Events.POST_STEP, onPostStep)
  offs.push(() => game.events.off(Phaser.Core.Events.POST_STEP, onPostStep))

  // ── toasts/sounds: шина UI-событий (ITGAME-38) ──────────────────────────
  const untapUi = onUi((e) => {
    const t = rel()
    if (e.type === 'sound') {
      r.sounds.push({ t, name: e.name, key: e.key, volume: e.volume, ok: e.ok, scene: e.scene })
    } else if (e.type === 'toast') {
      r.toasts.push({ t, text: e.text, where: e.where, ms: e.ms, scene: e.scene })
    } else if (e.type === 'key') {
      // сигнал приходит синхронно сразу за записью keys (DOM: capture → Phaser →
      // обработчик; itd: notifyItdKey → emit) — привязываем к последней с тем же именем
      for (let i = r.keys.length - 1; i >= 0; i--) {
        if (r.keys[i].key === e.key) { r.keys[i].acted.push({ scene: e.scene, action: e.action }); break }
      }
    }
  })
  offs.push(untapUi)

  // ── pointer (ITGAME-88): mousedown/mouseup в capture окна — раньше Phaser ──
  // (его слушатель на канвасе, обработка синхронная): хит-тест в тот же момент,
  // что у Phaser. got — GAMEOBJECT_POINTER_DOWN/UP объектов из хит-теста: слушатели
  // на них ставятся здесь же, в capture, — раньше обработчиков игры. Сценовый
  // GAMEOBJECT_DOWN/UP Phaser шлёт, только если у объекта после его события ещё
  // есть input (InputPlugin.processDownEvents), так что объект, удаливший себя
  // в pointerdown (✕ модалки, «Продолжить»), оставался бы в got [].
  // ITGAME-148: получившие down, по кнопке мыши — левый down → правый down → левый up не теряет gone левой.
  // Окно, открытое посреди нажатия, gone для него не покажет (down не видели)
  const downGot = new Map<number, { obj: Phaser.GameObjects.GameObject; label: string }[]>()
  const got = makeGotCatcher()
  const onMouse = (ev: MouseEvent) => {
    got.flush() // слушатели прошлого события: Phaser разослал его синхронно, они отработали
    let hit: ReturnType<PointerProbe> = { x: 0, y: 0, wins: null, stack: [], objs: [] }
    try {
      hit = probe(ev)
    } catch (e) {
      console.error('[trace] pointer probe упал:', e)
    }
    const down = ev.type === 'mousedown'
    const rec: TracePointer = {
      t: rel(), type: down ? 'down' : 'up', button: ev.button,
      x: Math.round(hit.x * 10) / 10, y: Math.round(hit.y * 10) / 10,
      onCanvas: ev.target === game.canvas,
      // ITGAME-179: метка победителя той же формы, что got (stackTarget: safe = id с «:», type)
      wins: hit.wins ? (hit.wins.safe ?? hit.wins.type) : null, stack: hit.stack, got: [], gone: [],
    }
    r.pointer.push(rec)
    if (!down) {
      // ITGAME-148: момент up до Phaser (capture) — тот же, что у хит-теста wins/stack
      rec.gone = (downGot.get(ev.button) ?? []).filter((d) => goneObj(d.obj)).map((d) => d.label)
      downGot.delete(ev.button)
    }
    const mine: { obj: Phaser.GameObjects.GameObject; label: string }[] | null = down ? [] : null
    if (mine) downGot.set(ev.button, mine)
    // Phaser отрабатывает событие синхронно сразу за capture-слушателем (makeGotCatcher)
    got.arm(hit.objs, down, (label, obj) => {
      rec.got.push(label)
      mine?.push({ obj, label })
    })
  }
  window.addEventListener('mousedown', onMouse, true)
  window.addEventListener('mouseup', onMouse, true)
  offs.push(() => {
    window.removeEventListener('mousedown', onMouse, true)
    window.removeEventListener('mouseup', onMouse, true)
    got.flush()
    downGot.clear()
  })
  let closed = false
  return {
    r,
    rel,
    close: () => {
      if (closed) return
      closed = true
      try {
        stepOnce(game) // диф сцен на самой границе окна
      } finally {
        offs.forEach((f) => f())
        r.t1 = Date.now()
      }
    },
  }
}

export async function runTrace(game: Phaser.Game, probe: PointerProbe, action: () => unknown, windowMs: number): Promise<TraceResult> {
  if (!Number.isFinite(windowMs) || windowMs < 0 || windowMs > 10000) {
    throw new Error('itd.trace: windowMs — конечное число 0..10000')
  }
  const tr = openTrace(game, probe, windowMs)
  const r = tr.r
  try {
    try {
      r.result = await action()
    } catch (e) {
      // Ошибка action не пробрасывается — ok:false, но окно всё равно
      // дожидаемся: слушатели уже поставлены, события окна не теряем.
      r.ok = false
      r.error = e instanceof Error ? e.message : String(e)
    }
    r.actionMs = tr.rel()
    await sleep(windowMs)
  } finally {
    tr.close()
  }
  return r
}

// ── Открытое окно (ITGAME-88) ─────────────────────────────────────────────
// start() ставит подписки и отдаёт id; stop(id?) закрывает и отдаёт TraceResult;
// peek(id?) читает, не закрывая (ITGAME-160).
// Окно, забытое без stop(), закрывается само по maxMs (cut: true) и ждёт
// stop() с готовым результатом. Окон одновременно — не больше TRACE_MAX_OPEN.

const TRACE_MAX_OPEN = 8
const TRACE_DEFAULT_MAX_MS = 120_000
let traceSeq = 0
type OpenEntry = { tr: OpenTrace; timer: ReturnType<typeof setTimeout> | null }
type NoTrace = { ok: false; code: 'no_trace'; error: string }
const openTraces = new Map<number, OpenEntry>()

export function startTrace(game: Phaser.Game, probe: PointerProbe, opts: TraceStartOptions = {}): TraceStart {
  const maxMs = opts?.maxMs ?? TRACE_DEFAULT_MAX_MS
  if (!Number.isInteger(maxMs) || maxMs < 1 || maxMs > 600_000) {
    return { ok: false, code: 'bad_max', error: 'itd.trace.start: maxMs — целое 1..600000 мс' }
  }
  if (openTraces.size >= TRACE_MAX_OPEN) {
    return { ok: false, code: 'too_many', error: `itd.trace.start: открыто уже ${openTraces.size} окон — закройте itd.trace.stop()`, open: [...openTraces.keys()] }
  }
  const id = ++traceSeq
  const tr = openTrace(game, probe, 0)
  tr.r.id = id
  const entry: OpenEntry = { tr, timer: null }
  entry.timer = setTimeout(() => {
    entry.timer = null
    tr.r.cut = true
    finishOpen(tr)
  }, maxMs)
  openTraces.set(id, entry)
  return { ok: true, id, t0: tr.r.t0, maxMs, open: [...openTraces.keys()] }
}

function finishOpen(tr: OpenTrace): void {
  tr.close()
  tr.r.windowMs = tr.r.t1 - tr.r.t0
}

// Окно по id (без id — последнее открытое); cut-окно лежит в openTraces до stop().
function findOpen(id?: number): { ok: true; key: number; entry: OpenEntry } | NoTrace {
  const key = id ?? [...openTraces.keys()].pop()
  const entry = key === undefined ? undefined : openTraces.get(key)
  if (key === undefined || !entry) {
    return { ok: false, code: 'no_trace', error: id === undefined ? 'нет открытого окна — сначала itd.trace.start()' : `нет окна ${id}: открыты [${[...openTraces.keys()].join(' ')}]` }
  }
  return { ok: true, key, entry }
}

export function stopTrace(id?: number): TraceResult | NoTrace {
  const found = findOpen(id)
  if (!found.ok) return found
  openTraces.delete(found.key)
  if (found.entry.timer) clearTimeout(found.entry.timer)
  finishOpen(found.entry.tr)
  return found.entry.tr.r
}

// ITGAME-160: прочитать окно, не закрывая — копия результата на сейчас; окно, его
// maxMs и луп не трогаем (без stepOnce: смену сцен на самом последнем шаге увидит
// stop(), peek — со следующего POST_STEP). cut-окно — каким закрылось.
export function peekTrace(id?: number): TraceResult | NoTrace {
  const found = findOpen(id)
  if (!found.ok) return found
  const r = structuredClone(found.entry.tr.r)
  if (!r.cut) {
    r.t1 = Date.now()
    r.windowMs = r.t1 - r.t0
  }
  return r
}

// ── summary (ITGAME-179) ──────────────────────────────────────────────────
// Короткие строки вместо разбора TraceResult руками: по строке на запись окна,
// одним списком по t. Формат закреплён qa:trace 16.
export interface TraceSummary {
  ok: boolean // как у TraceResult (false — action упал, см. error); нет окна — false и code no_trace
  code?: 'no_trace'
  error?: string // no_trace — почему; иначе ошибка action окна (TraceResult.error)
  id?: number // окно itd.trace.start()
  cut?: boolean // окно закрылось само по maxMs
  /**
   * По строке на запись окна по возрастанию t (при равном t: ptr, key, sent, recv,
   * state, trans, toast, sound); [] при no_trace.
   * 't<мс> ptr down|up [b<кнопка>] x,y canvas|page wins <метка>|- got [..] [gone [..]]',
   * 't<мс> key <KEY> dom|itd [repeat] handled [сцены]|unhandled [acted [сцена:действие ..]]',
   * 't<мс> sent <type> [o<office>] [k=v ..] [id<id>] itd|ui',
   * 't<мс> recv <type> [<code>] [re<id>] [rev<N>] [k=v ..]', 't<мс> state rev<N> <cause> [re<id>]',
   * 't<мс> trans <kind> <from>→<to>' (null — '-'), 't<мс> toast "<текст>"', 't<мс> sound <name> ok|fail'.
   */
  lines: string[]
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()
// Значение k=v одним токеном: строка с пробелом/переводом строки — в одну строку и в кавычках (ITGAME-179)
const val = (v: unknown): string => {
  if (typeof v !== 'string') return JSON.stringify(v)
  const s = oneLine(v)
  return s === '' || /\s/.test(s) ? JSON.stringify(s) : s
}

export function summarizeTrace(r: TraceResult): string[] {
  const out: { t: number; k: number; line: string }[] = []
  const add = (k: number, t: number, parts: string[]) => out.push({ t, k, line: `t${Math.round(t)} ${parts.join(' ')}` })
  for (const p of r.pointer ?? []) {
    add(0, p.t, ['ptr', p.type, ...(p.button ? [`b${p.button}`] : []), `${Math.round(p.x)},${Math.round(p.y)}`,
      p.onCanvas ? 'canvas' : 'page', 'wins', p.wins ?? '-', `got [${p.got.join(' ')}]`, ...(p.gone?.length ? [`gone [${p.gone.join(' ')}]`] : [])])
  }
  for (const e of r.keys ?? []) {
    add(1, e.t, ['key', e.key, e.source, ...(e.repeat ? ['repeat'] : []),
      e.handled ? `handled [${e.scenes.join(' ')}]` : 'unhandled',
      ...(e.acted.length ? [`acted [${e.acted.map((a) => `${a.scene}:${a.action}`).join(' ')}]`] : [])])
  }
  for (const s of r.sent ?? []) {
    const { t, type, office, id, src, ...rest } = s
    const parts = ['sent', type]
    if (office !== undefined) parts.push(`o${val(office)}`)
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) parts.push(`${k}=${val(v)}`)
    if (id !== undefined) parts.push(`id${val(id)}`)
    parts.push(src ?? '?')
    add(2, t, parts)
  }
  for (const e of r.recv ?? []) {
    const { code, re, rev, ...rest } = e.info
    const parts = ['recv', e.type]
    if (code !== undefined) parts.push(val(code))
    if (re !== undefined) parts.push(`re${val(re)}`)
    if (rev !== undefined) parts.push(`rev${val(rev)}`)
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) parts.push(`${k}=${val(v)}`)
    add(3, e.t, parts)
  }
  for (const s of r.states ?? []) add(4, s.t, ['state', `rev${s.rev}`, s.cause, ...(s.re !== undefined ? [`re${s.re}`] : [])])
  for (const e of r.transitions ?? []) add(5, e.t, ['trans', e.kind, `${e.from ?? '-'}→${e.to ?? '-'}`])
  for (const e of r.toasts ?? []) add(6, e.t, ['toast', `"${oneLine(e.text)}"`])
  for (const e of r.sounds ?? []) add(7, e.t, ['sound', e.name, e.ok ? 'ok' : 'fail'])
  // sort стабилен (ES2019): внутри разновидности — порядок записи
  return out.sort((a, b) => a.t - b.t || a.k - b.k).map((e) => e.line)
}

// summary(id?) — открытое (или cut) окно, не закрывая; summary(tr) — любой TraceResult.
export function summaryTrace(src?: number | TraceResult): TraceSummary {
  let r: TraceResult
  if (src === undefined || typeof src === 'number') {
    const found = findOpen(src)
    if (!found.ok) return { ...found, lines: [] }
    r = found.entry.tr.r
  } else if (src && typeof src === 'object' && typeof src.t0 === 'number' && Array.isArray(src.pointer)) {
    r = src
  } else {
    return { ok: false, code: 'no_trace', error: 'itd.trace.summary: это не TraceResult — id окна или результат itd.trace()/stop()', lines: [] }
  }
  return {
    ok: r.ok,
    ...(r.error !== undefined ? { error: r.error } : {}),
    ...(r.id !== undefined ? { id: r.id } : {}),
    ...(r.cut ? { cut: true } : {}),
    lines: summarizeTrace(r),
  }
}
