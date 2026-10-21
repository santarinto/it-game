// itd.claim (ITGAME-151): чистая логика полосы «АГЕНТ работает в этой вкладке» — счёт
// нажатий own/allowed/foreign, бюджет mine, окно allow, запись для sessionStorage.
// Без Phaser и DOM: scripts/lib/claim.test.mjs гоняет её прямо в Node (type stripping —
// ни enum, ни parameter properties). DOM-часть — claim.ts.

export const CLAIM_KEY = 'itd.claim'
export const GROUP_MS = 50 // события одного нажатия (pointerdown → mousedown) — одна группа
export const PRESS_CAP = 50 // presses хранит последние 50 нажатий
export const LABEL_MAX = 40
export const WHAT_MAX = 80
export const MINE_MAX_N = 20
export const MINE_MIN_MS = 100
export const MINE_MAX_MS = 120_000
export const MINE_DEFAULT_MS = 20_000

export type ClaimKind = 'own' | 'allowed' | 'foreign'

export interface ClaimPress {
  /** Номер нажатия с claim(): общий счёт own, allowed и foreign. */
  n: number
  /** Секунды от claim(), одна десятая. */
  t: number
  /** own — после itd.claim.mine(), allowed — в окне allow, foreign — чужое. */
  kind: ClaimKind
  button: number
  /** Нажатие пришло в холст игры; false — мимо (#topbar, поля страницы). */
  onCanvas: boolean
  /** Победитель хит-теста Phaser в момент нажатия — метка, как pointer.wins в itd.trace (safe id или тип); null — мимо интерактивов. */
  wins: string | null
  /** Кому Phaser отдал нажатие (GAMEOBJECT_POINTER_DOWN), как pointer.got в itd.trace. */
  got: string[]
}

export interface ClaimAllowWindow {
  what: string
  /** id цели в safe-форме (с «:»), null — без цели. */
  target: string | null
  /** Секунды от claim() до allow(). */
  since: number
  /** Окну принадлежат нажатия с n > from. */
  from: number
}

export interface ClaimRecord {
  label: string
  sha: string
  at: number // Date.now() при claim()
  own: number
  allowed: number
  foreign: number
  synthetic: number
  onCanvas: number
  reloads: number
  mine: { pending: number; until: number } | null // until — Date.now()
  allow: ClaimAllowWindow | null
  presses: ClaimPress[]
}

export interface ClaimState {
  ok: true
  /** Полоса стоит; в итоге stop() — false. */
  active: boolean
  label: string
  /** itd.version.sha вкладки. */
  sha: string
  /** Секунды от claim(). */
  sec: number
  /** Настоящие нажатия: own + allowed + foreign. */
  downs: number
  own: number
  allowed: number
  foreign: number
  /** isTrusted false (dispatchEvent, itd.tap) — в downs не входят. */
  synthetic: number
  onCanvas: number
  /** Сколько перезагрузок вкладки claim пережил. */
  reloads: number
  /** Бюджет itd.claim.mine(): сколько ещё нажатий — own и сколько мс он жив; null — нет. */
  mine: { pending: number; leftMs: number } | null
  /** Открытое окно allow; hit — target в got разрешённого нажатия окна (null без target). */
  allow: (ClaimAllowWindow & { hit: boolean | null }) | null
  /** Последние 50 нажатий, старые первыми. */
  presses: ClaimPress[]
}

export interface ClaimAllowResult {
  ok: true
  what: string
  target: string | null
  /** Разрешённые нажатия этого окна. */
  presses: ClaimPress[]
  /** target в got хотя бы одного из них; null — окно без target. */
  hit: boolean | null
}

export interface ClaimRefusal {
  ok: false
  code: 'bad_label' | 'bad_args' | 'no_claim' | 'no_allow'
  error: string
}

export function refuse(code: ClaimRefusal['code'], error: string): ClaimRefusal {
  return { ok: false, code, error }
}

export function newRecord(label: string, sha: string, now: number): ClaimRecord {
  return {
    label, sha, at: now, own: 0, allowed: 0, foreign: 0, synthetic: 0, onCanvas: 0, reloads: 0,
    mine: null, allow: null, presses: [],
  }
}

const filled = (s: unknown, max: number): boolean => typeof s === 'string' && s.trim() !== '' && s.length <= max

export function checkLabel(label: unknown): ClaimRefusal | null {
  return filled(label, LABEL_MAX) ? null : refuse('bad_label', `метка — непустая строка до ${LABEL_MAX} символов`)
}

const intIn = (v: unknown, lo: number, hi: number): boolean => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi

export function checkMine(n: unknown, ms: unknown): ClaimRefusal | null {
  return intIn(n, 1, MINE_MAX_N) && intIn(ms, MINE_MIN_MS, MINE_MAX_MS)
    ? null
    : refuse('bad_args', `mine(n, ms): n — целое 1..${MINE_MAX_N}, ms — целое ${MINE_MIN_MS}..${MINE_MAX_MS}`)
}

export function checkAllow(what: unknown, target: unknown): ClaimRefusal | null {
  if (!filled(what, WHAT_MAX)) return refuse('bad_args', `allow(что, {target?}): что — непустая строка до ${WHAT_MAX} символов`)
  if (target !== undefined && (typeof target !== 'string' || target === '')) {
    return refuse('bad_args', 'allow: target — id объекта (btn.hire или btn:hire)')
  }
  return null
}

// safe-форма id, как у got/wins трассы: «:» вместо точек (в id игры двоеточий нет).
export const normTarget = (id: string): string => id.replace(/\./g, ':')

export const downsOf = (rec: ClaimRecord): number => rec.own + rec.allowed + rec.foreign

const tenths = (ms: number): number => Math.round(ms / 100) / 10

export function liveMine(rec: ClaimRecord, now: number): ClaimRecord['mine'] {
  return rec.mine && rec.mine.pending > 0 && now < rec.mine.until ? rec.mine : null
}

// Новый вызов заменяет бюджет, а не прибавляет.
export function setMine(rec: ClaimRecord, n: number, ms: number, now: number): void {
  rec.mine = { pending: n, until: now + ms }
}

// Нажатие: own — пока жив бюджет mine, allowed — пока открыт allow, иначе foreign.
// Возвращает объект из rec.presses: wins/got вызывающий дописывает в него же.
export function addPress(rec: ClaimRecord, now: number, input: { button: number; onCanvas: boolean }): ClaimPress {
  let kind: ClaimKind
  const mine = liveMine(rec, now)
  if (mine) {
    kind = 'own'
    mine.pending -= 1
    rec.mine = mine.pending > 0 ? mine : null
  } else {
    rec.mine = null
    kind = rec.allow ? 'allowed' : 'foreign'
  }
  rec[kind] += 1
  if (input.onCanvas) rec.onCanvas += 1
  const press: ClaimPress = {
    n: downsOf(rec), t: tenths(now - rec.at), kind, button: input.button, onCanvas: input.onCanvas, wins: null, got: [],
  }
  rec.presses.push(press)
  if (rec.presses.length > PRESS_CAP) rec.presses.splice(0, rec.presses.length - PRESS_CAP)
  return press
}

// Новое окно заменяет открытое: его нажатия остаются в presses, но в новое не входят.
export function openAllow(rec: ClaimRecord, what: string, target: string | undefined, now: number): void {
  rec.allow = { what, target: target === undefined ? null : normTarget(target), since: tenths(now - rec.at), from: downsOf(rec) }
}

export function allowPresses(rec: ClaimRecord): ClaimPress[] {
  const w = rec.allow
  return w ? rec.presses.filter((p) => p.kind === 'allowed' && p.n > w.from) : []
}

export function allowHit(rec: ClaimRecord): boolean | null {
  const w = rec.allow
  if (!w || w.target === null) return null
  const target = w.target
  return allowPresses(rec).some((p) => p.got.includes(target))
}

const copyPress = (p: ClaimPress): ClaimPress => ({ ...p, got: [...p.got] })

export function closeAllow(rec: ClaimRecord): ClaimAllowResult | ClaimRefusal {
  const w = rec.allow
  if (!w) return refuse('no_allow', 'окна allow нет — itd.claim.allow(что, {target?})')
  const res: ClaimAllowResult = { ok: true, what: w.what, target: w.target, presses: allowPresses(rec).map(copyPress), hit: allowHit(rec) }
  rec.allow = null
  return res
}

export function stateOf(rec: ClaimRecord, now: number, active: boolean): ClaimState {
  const mine = liveMine(rec, now)
  return {
    ok: true, active, label: rec.label, sha: rec.sha, sec: Math.round((now - rec.at) / 1000), downs: downsOf(rec),
    own: rec.own, allowed: rec.allowed, foreign: rec.foreign, synthetic: rec.synthetic, onCanvas: rec.onCanvas,
    reloads: rec.reloads,
    mine: mine ? { pending: mine.pending, leftMs: mine.until - now } : null,
    allow: rec.allow ? { ...rec.allow, hit: allowHit(rec) } : null,
    presses: rec.presses.map(copyPress),
  }
}

// groupAt — timeStamp (часы события) первого события группы; null — групп ещё не было.
export const joinsGroup = (groupAt: number | null, now: number): boolean => groupAt !== null && now - groupAt < GROUP_MS

export const serialize = (rec: ClaimRecord): string => JSON.stringify(rec)

const COUNTERS = ['at', 'own', 'allowed', 'foreign', 'synthetic', 'onCanvas', 'reloads'] as const

export function parseRecord(raw: string | null): ClaimRecord | null {
  if (raw === null) return null
  try {
    const r = JSON.parse(raw) as Partial<ClaimRecord> | null
    if (!r || typeof r.label !== 'string' || typeof r.sha !== 'string' || !Array.isArray(r.presses)) return null
    if (!COUNTERS.every((k) => Number.isFinite(r[k]))) return null
    return { ...(r as ClaimRecord), mine: r.mine ?? null, allow: r.allow ?? null }
  } catch {
    return null
  }
}
