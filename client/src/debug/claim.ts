import type Phaser from 'phaser'
import { sessionStore } from '../storage'
import { makeGotCatcher } from './trace'
import type { PointerProbe } from './trace'
import {
  CLAIM_KEY, MINE_DEFAULT_MS, addPress, addResize, checkAllow, checkLabel, checkMine, closeAllow, joinsGroup, newRecord,
  openAllow, parseRecord, refuse, serialize, setMine, stateOf,
} from './claimCore'
import type { ClaimAllowResult, ClaimRecord, ClaimRefusal, ClaimResizeDims, ClaimResizeLast, ClaimResizes, ClaimState } from './claimCore'
export type { ClaimAllowResult, ClaimRecord, ClaimRefusal, ClaimResizeDims, ClaimResizeLast, ClaimResizes, ClaimState } from './claimCore'

// itd.claim (ITGAME-151): вкладка агента занята — полоса 40 px поверх страницы и счёт
// каждого настоящего нажатия в ней. Ретро 17.10: человек трижды нажимал во вкладке агента
// (54 события посреди блока) и раз смотрел свою вкладку — ~35 вызовов и повторный заход;
// ручная изоляция брифа v13 (заголовок руками, окно трассы на пункт) стоила 2 действия на
// пункт и не была видна человеку в момент клика. Настоящие клики агента (CDP) тоже
// isTrusted — агент объявляет их через mine(). Логика счёта — claimCore.ts.

const BAR_ID = 'itd-claim'
const TITLE_BUSY = '▶ АГЕНТ — смотри, не кликай'
const TITLE_FREE = 'вкладка свободна'
const COLOR_CLAIM = '#f5c542'
const COLOR_ALLOW = '#51cf66'
const COLOR_FOREIGN = '#ff6b6b'
const FLASH_MS = 600

export interface ClaimMine {
  ok: true
  /** Сколько следующих настоящих нажатий — own. */
  pending: number
  /** Сколько мс бюджет жив. */
  ms: number
}

// itd.claim — функция с методами, как itd.sandbox: itd.claim('acc151'), itd.claim.mine(),
// itd.claim.allow(что, {target}), itd.claim.deny(), itd.claim.state(), itd.claim.stop().
export interface ClaimApi {
  (label: string): ClaimState | ClaimRefusal
  /** Следующие n (1..20, по умолчанию 1) настоящих нажатий за ms (100..120000, по умолчанию 20000) — свои (own), без вспышки: звать перед своим настоящим кликом; новый вызов заменяет бюджет; отказы bad_args, no_claim. */
  mine: (n?: number, ms?: number) => ClaimMine | ClaimRefusal
  /** «Нажми сам»: зелёная полоса «▶ ТВОЙ ХОД: что — только это», нажатия — allowed; target — id цели (btn.hire или btn:hire), его hit — в state().allow и deny(); новое окно заменяет открытое; отказы bad_args, no_claim. */
  allow: (what: string, opts?: { target?: string }) => ClaimState | ClaimRefusal
  /** Закрыть окно allow → {what, target, presses, hit}: hit — target в got разрешённого нажатия окна, null без target; полоса снова жёлтая; отказы no_allow, no_claim. */
  deny: () => ClaimAllowResult | ClaimRefusal
  /** Счёт на сейчас; без полосы — {ok: true, active: false}. */
  state: () => ClaimState | { ok: true; active: false }
  /** Снять полосу и слушатели, стереть sessionStorage itd.claim, заголовок «вкладка свободна» → итог (active: false); отказ no_claim. */
  stop: () => ClaimState | ClaimRefusal
}

type TouchAware = MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } | null }

export function makeClaim(game: Phaser.Game, probe: PointerProbe, sha: string): ClaimApi {
  let rec: ClaimRecord | null = null
  let bar: HTMLDivElement | null = null
  let flashTimer: ReturnType<typeof setTimeout> | null = null
  let groupAt: number | null = null // ev.timeStamp первого события текущего нажатия
  let synthAt: number | null = null // то же для синтетики
  const got = makeGotCatcher()

  const save = () => {
    if (rec) sessionStore.set(CLAIM_KEY, serialize(rec))
  }

  const paint = () => {
    if (!rec || !bar) return
    const mode = flashTimer !== null ? 'foreign' : rec.allow ? 'allow' : 'claim'
    bar.dataset.mode = mode
    bar.textContent = rec.allow
      ? `▶ ТВОЙ ХОД: ${rec.allow.what} — только это`
      : `▶ АГЕНТ работает в этой вкладке (${rec.label}, ${rec.sha}) — не кликай`
    bar.style.background = mode === 'foreign' ? COLOR_FOREIGN : mode === 'allow' ? COLOR_ALLOW : COLOR_CLAIM
  }

  const flash = () => {
    if (flashTimer !== null) clearTimeout(flashTimer)
    flashTimer = setTimeout(() => {
      flashTimer = null
      paint()
    }, FLASH_MS)
    paint()
  }

  const onDown = (ev: MouseEvent) => {
    const r = rec
    if (!r) return
    // Клик по форме опроса itd.ask или самой полосе claim — не игровое нажатие
    const targetEl = ev.target as Element | null
    if (targetEl && (targetEl.closest?.('#itd-ask') || targetEl.closest?.('#' + BAR_ID))) return
    // Часы самого события: pointerdown и следующий за ним mousedown Chromium штампует одним timeStamp,
    // так что медленный обработчик (проба, запись в sessionStorage, GC) не разрежет одно нажатие надвое
    const now = ev.timeStamp
    if (!ev.isTrusted) {
      if (!joinsGroup(synthAt, now)) {
        synthAt = now
        r.synthetic += 1
        save()
      }
      return
    }
    // Совместимый mousedown после касания: нажатие уже посчитал его pointerdown
    if (ev.type === 'mousedown' && (ev as TouchAware).sourceCapabilities?.firesTouchEvents) return
    if (joinsGroup(groupAt, now)) return
    groupAt = now
    const press = addPress(r, Date.now(), { button: ev.button, onCanvas: ev.target === game.canvas })
    if (press.kind === 'foreign') flash()
    try {
      const hit = probe(ev)
      press.wins = hit.wins ? (hit.wins.safe ?? hit.wins.type) : null
      // got: mousedown/touchstart этого нажатия браузер шлёт в той же задаче, Phaser отдаёт его объектам
      got.arm(hit.objs, true, (label) => {
        press.got.push(label)
        save()
      })
    } catch (e) {
      console.error('[claim] pointer probe упал:', e)
    }
    save()
  }

  const getDims = (): ClaimResizeDims => ({
    iw: typeof window !== 'undefined' ? window.innerWidth : 0,
    ih: typeof window !== 'undefined' ? window.innerHeight : 0,
    dpr: typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1,
  })

  let dprMql: MediaQueryList | null = null

  const onResize = () => {
    if (!rec) return
    if (addResize(rec, Date.now(), getDims())) {
      save()
    }
  }

  const updateDprWatcher = () => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    if (dprMql) {
      dprMql.removeEventListener('change', onDprChange)
      dprMql = null
    }
    try {
      dprMql = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
      dprMql.addEventListener('change', onDprChange)
    } catch {
      dprMql = null
    }
  }

  const onDprChange = () => {
    onResize()
    updateDprWatcher()
  }

  const install = () => {
    if (!bar) {
      bar = document.createElement('div')
      bar.id = BAR_ID
      Object.assign(bar.style, {
        position: 'fixed', left: '0', right: '0', top: '0', height: '40px', zIndex: '100000',
        color: '#14162b', font: 'bold 20px/40px monospace', textAlign: 'center', pointerEvents: 'none',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      })
      document.body.appendChild(bar)
    }
    paint()
    document.title = TITLE_BUSY
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('resize', onResize)
    updateDprWatcher()
    // itd.reset() сносит все itd.* — активная полоса пишет себя снова перед уходом страницы
    window.addEventListener('pagehide', save)
  }

  const uninstall = () => {
    window.removeEventListener('pointerdown', onDown, true)
    window.removeEventListener('mousedown', onDown, true)
    window.removeEventListener('resize', onResize)
    if (dprMql) {
      dprMql.removeEventListener('change', onDprChange)
      dprMql = null
    }
    window.removeEventListener('pagehide', save)
    got.flush()
    if (flashTimer !== null) clearTimeout(flashTimer)
    flashTimer = null
    bar?.remove()
    bar = null
    groupAt = null
    synthAt = null
  }

  const noClaim = (): ClaimRefusal => refuse('no_claim', 'полосы нет — itd.claim(метка)')

  const claim = (label: string): ClaimState | ClaimRefusal => {
    const bad = checkLabel(label)
    if (bad) return bad
    // Повторный вызов меняет только метку: счёт сбрасывает stop() → claim()
    if (rec) rec.label = label
    else {
      rec = newRecord(label, sha, Date.now(), getDims())
      install()
    }
    paint()
    save()
    return stateOf(rec, Date.now(), true)
  }

  const mine = (n: number = 1, ms: number = MINE_DEFAULT_MS): ClaimMine | ClaimRefusal => {
    if (!rec) return noClaim()
    const bad = checkMine(n, ms)
    if (bad) return bad
    setMine(rec, n, ms, Date.now())
    save()
    return { ok: true, pending: n, ms }
  }

  const allow = (what: string, opts?: { target?: string }): ClaimState | ClaimRefusal => {
    if (!rec) return noClaim()
    const target = opts?.target
    const bad = checkAllow(what, target)
    if (bad) return bad
    openAllow(rec, what, target, Date.now())
    paint()
    save()
    return stateOf(rec, Date.now(), true)
  }

  const deny = (): ClaimAllowResult | ClaimRefusal => {
    if (!rec) return noClaim()
    const res = closeAllow(rec)
    paint()
    save()
    return res
  }

  const state = (): ClaimState | { ok: true; active: false } =>
    rec ? stateOf(rec, Date.now(), true) : { ok: true, active: false }

  const stop = (): ClaimState | ClaimRefusal => {
    if (!rec) return noClaim()
    const fin = stateOf(rec, Date.now(), false)
    uninstall()
    rec = null
    sessionStore.remove(CLAIM_KEY)
    document.title = TITLE_FREE
    return fin
  }

  // F5: запись вкладки поднимает полосу сразу, не дожидаясь READY Phaser
  const saved = parseRecord(sessionStore.get(CLAIM_KEY))
  if (saved) {
    rec = saved
    rec.reloads += 1
    rec.sha = sha // JS вкладки после перезагрузки — может быть уже другая сборка
    if (rec.mine && Date.now() >= rec.mine.until) rec.mine = null
    addResize(rec, Date.now(), getDims())
    install()
    save()
  }

  return Object.assign(claim, { mine, allow, deny, state, stop })
}
