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

export interface TraceResult {
  ok: boolean
  error?: string
  result?: unknown
  t0: number // epoch ms — момент постановки подписок (до action)
  t1: number // epoch ms — момент закрытия окна
  windowMs: number
  actionMs: number // rel() сразу после await action()
  // handled — в активной сцене есть подписчик keydown-<KEY>/keydown; acted — сцены,
  // реально отработавшие клавишу; [] при handled:true — guard обработчика её отбросил
  keys: { t: number; key: string; source: 'dom' | 'itd'; repeat: boolean; handled: boolean; scenes: string[]; acted: { scene: string; action: string }[] }[]
  sent: { t: number; type: string; office?: number; [k: string]: unknown }[] // полная команда, по порядку отправки
  recv: { t: number; type: string; info: Record<string, unknown> }[] // не-state входящие: error/day_report/game_over/…
  transitions: { t: number; kind: 'phase' | 'speed' | 'day' | 'scenes'; from: string | number | null; to: string | number | null }[]
  toasts: { t: number; text: string; where: 'top' | 'bottom'; ms: number; scene: string }[]
  sounds: { t: number; name: string; key: string; volume: number; ok: boolean; scene: string }[]
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

export async function runTrace(game: Phaser.Game, action: () => unknown, windowMs: number): Promise<TraceResult> {
  if (!Number.isFinite(windowMs) || windowMs < 0 || windowMs > 10000) {
    throw new Error('itd.trace: windowMs — конечное число 0..10000')
  }

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
    transitions: [],
    toasts: [],
    sounds: [],
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
      r.sent.push({ t, ...raw, type: e.type })
    } else if (e.type !== 'state') {
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

  try {
    try {
      r.result = await action()
    } catch (e) {
      // Ошибка action не пробрасывается — ok:false, но окно всё равно
      // дожидаемся: слушатели уже поставлены, события окна не теряем.
      r.ok = false
      r.error = e instanceof Error ? e.message : String(e)
    }
    r.actionMs = rel()
    await sleep(windowMs)
    stepOnce(game) // диф сцен на самой границе окна
  } finally {
    offs.forEach((f) => f())
  }
  r.t1 = Date.now()
  return r
}
