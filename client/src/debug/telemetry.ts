import type Phaser from 'phaser'
import { client, offlineShown } from '../net'
import { onUi } from '../uibus'

// Журнал переходов и ошибки страницы (ITGAME-25): кольцевой буфер на 200
// записей переживает чистку консоли — свежая сессия агента видит историю.
// Каждая запись дублируется console.debug('[itd]', …) для живого наблюдения.

export interface LogEntry {
  t: number // epoch ms
  type: string
  [k: string]: unknown
}

export interface ErrorEntry {
  t: number
  kind: 'error' | 'unhandledrejection'
  message: string
  load: number // номер загрузки страницы в этой вкладке (1 — первая); ошибки прошлых загрузок переживают навигацию
  injected: boolean // тестовая ошибка itd.injectError — не ошибка игры
}

const RING = 200
// Ошибки переживают перезагрузку и навигацию вкладки (приёмка 10.10: журнал
// ранних загрузок пропадал, «ошибок игры — 0» подтверждалось частично).
// sessionStorage — своя вкладка; кольцо на ERR_RING записей.
const ERR_KEY = 'itd.errors'
const LOADS_KEY = 'itd.loads'
const ERR_RING = 100

function readStored(): ErrorEntry[] {
  try {
    const raw = sessionStorage.getItem(ERR_KEY)
    const v: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(v) ? (v as ErrorEntry[]) : []
  } catch {
    return []
  }
}

function nextLoad(): number {
  try {
    const n = (Number(sessionStorage.getItem(LOADS_KEY)) || 0) + 1
    sessionStorage.setItem(LOADS_KEY, String(n))
    return n
  } catch {
    return 1
  }
}

export interface Telemetry {
  log(n?: number): LogEntry[]
  errors(): ErrorEntry[]
}

export function startTelemetry(game: Phaser.Game): Telemetry {
  const ring: LogEntry[] = []
  const load = nextLoad()
  const errors: ErrorEntry[] = readStored()
  const pushError = (kind: ErrorEntry['kind'], message: string) => {
    errors.push({ t: Date.now(), kind, message, load, injected: message.includes('itd.injectError:') })
    if (errors.length > ERR_RING) errors.splice(0, errors.length - ERR_RING)
    try { sessionStorage.setItem(ERR_KEY, JSON.stringify(errors)) } catch { /* квота — журнал в памяти остаётся */ }
  }

  const add = (type: string, payload: Record<string, unknown> = {}) => {
    const entry: LogEntry = { t: Date.now(), type, ...payload }
    ring.push(entry)
    if (ring.length > RING) ring.splice(0, ring.length - RING)
    console.debug('[itd]', entry)
  }

  // Ошибки страницы: и всплывшие, и отвергнутые промисы.
  addEventListener('error', (ev) => {
    pushError('error', ev.message)
    add('page_error', { message: ev.message })
  })
  addEventListener('unhandledrejection', (ev) => {
    const reason = (ev as PromiseRejectionEvent).reason
    const message = reason instanceof Error ? reason.message : String(reason)
    pushError('unhandledrejection', message)
    add('unhandledrejection', { message })
  })

  // Переходы игрового состояния: диф последнего снапшота.
  let prev: { connected: boolean; day: number; phase: string; speed: number; staff: number } | null = null
  client.subscribe({
    onState: (s) => {
      const now = { connected: true, day: s.day, phase: s.phase, speed: s.speed, staff: s.offices.reduce((n, o) => n + o.employees.length, 0) }
      if (!prev) {
        add('state', { day: now.day, clock: s.clock, phase: now.phase, speed: now.speed, staff: now.staff })
      } else {
        if (now.day !== prev.day) add('day', { day: now.day, clock: s.clock })
        if (now.phase !== prev.phase) add('phase', { from: prev.phase, to: now.phase, day: now.day })
        if (now.speed !== prev.speed) add('speed', { from: prev.speed, to: now.speed })
        if (now.staff !== prev.staff) add('staff', { from: prev.staff, to: now.staff })
      }
      prev = now
    },
    onError: (code) => add('cmd_error', { code }),
    onDayReport: (r) => add('day_report', { day: r.day, profit: r.profit, balance: r.balance }),
    onGameOver: (o) => add('game_over', { reason: o.reason, days: o.daysSurvived }),
    onVictory: (v) => add('victory', { day: v.day, balance: v.balance }),
    onOfflineReport: (r) => add('offline_report', { days: r.days, ticks: r.ticks, shown: offlineShown(r) }),
    onDisconnect: (reason) => add('disconnect', { reason: reason ?? 'unknown' }),
    onReconnecting: (attempt) => add('reconnecting', { attempt }),
    // журнал, а не экран: не снимает отчёты с очереди HUD (ITGAME-19)
    observer: true,
  })

  // Звук и тосты (ITGAME-38): шина UI-событий (audio.ts, HUDScene.toast()) —
  // { type: 'sound', ... } / { type: 'toast', ... } прямо в общий буфер.
  onUi((e) => { if (e.type === 'key') return; const { type, ...rest } = e; add(type, rest) })

  // Переключения сцен: диф списка активных сцен раз в 500мс — ловит и
  // launch/stop, и возвраты в меню без хуков в сами сцены.
  let prevScenes = ''
  setInterval(() => {
    const active = game.scene.getScenes(true).map((sc) => sc.scene.key).join(',')
    if (active !== prevScenes) {
      add('scenes', { from: prevScenes || null, to: active })
      prevScenes = active
    }
  }, 500)

  return {
    log: (n = 50) => ring.slice(-n),
    errors: () => [...errors],
  }
}
