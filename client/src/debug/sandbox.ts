import type Phaser from 'phaser'
import { SANDBOX_KEY, adoptTabSid, forgetTabSid, sandboxRecord, sandboxSid } from '../net'
import type { SandboxRecord } from '../net'
import { localStore, sessionStore } from '../storage'
import { ZOOM_KEY, onZoomWrite, rereadZoom } from '../uiscale'

// itd.sandbox (ITGAME-77): своя партия вкладки одним вызовом, ключи владельца под
// охраной. Ретро 10.10: агент в каждом заходе руками ставил sessionStorage-sid,
// держал acc.ownSid/ownDiff/mySid и возвращал itd.sid владельца после «Сдаться»
// (itd.diff вернуть не смог). Запись песочницы живёт в sessionStorage вкладки
// (переживает перезагрузку), а пока она есть, net.ts не откатывает партии вкладки
// к общему ключу владельца (sessionId/prepareNewGame/hasSavedSession).

const SID = 'itd.sid'
const DIFF = 'itd.diff'
const AUTO = 'itd.sid.auto'
// Цепочка онбординга HUD (ITGAME-21): партия песочницы может её пройти и записать
// done в настоящий localStorage владельца — он больше не увидел бы плашку.
const ONBOARD = 'itd.onboard'
// Масштаб UI (ITGAME-155, ретро 17.10): агент переключил его в песочнице (null → '1' → '1.4') и
// вернуть ключ в null не мог — '1.4' тот же масштаб, но ключ уже не владельца.
const ZOOM = ZOOM_KEY
const LABEL = /^[A-Za-z0-9_-]{1,24}$/

export interface SandboxResult {
  ok: boolean
  sid?: string // sid песочницы во вкладке: a-<метка>-<время>
  owner?: { sid: boolean; diff: string | null } // общий ключ владельца при входе: есть ли sid, его сложность
  code?: 'bad_label' | 'in_party'
  error?: string
}

export interface SandboxRestore {
  ok: boolean
  sidSame?: boolean // localStorage itd.sid — тот, что был при входе (или fakeOwner): гард не тронул
  diffSame?: boolean // то же для itd.diff
  fake?: boolean // сверяли с «чужим» ключом fakeOwner()
  restored?: string[] // ключи, возвращённые как при входе (itd.uiScale — и удалённый, если при входе его не было)
  kept?: string[] // общие ключи с ЧУЖИМ значением — не перетёрты: их мог записать сам владелец (itd.uiScale — масштаб, который песочница не выбирала)
  removed?: string[] // служебные ключи вкладки, убранные при выходе
  code?: 'no_sandbox' | 'in_party'
  error?: string
}

export interface FakeOwnerResult {
  ok: boolean
  sid?: string // «чужой» общий sid: fake-owner-<время>
  diff?: string // его сложность — всегда не та, что у владельца
  code?: 'no_sandbox'
  error?: string
}

// itd.sandbox — функция с двумя методами: itd.sandbox('acc3'), itd.sandbox.restore(),
// itd.sandbox.fakeOwner().
export interface SandboxApi {
  (label: string): SandboxResult
  /** Выйти: сверить и вернуть ключи владельца, убрать служебные; не в партии. */
  restore: () => SandboxRestore
  /** Поставить «чужой» общий ключ (localStorage itd.sid/itd.diff) вызовом игры; restore() его уберёт. */
  fakeOwner: () => FakeOwnerResult
}

const inParty = (game: Phaser.Game): boolean => game.scene.isActive('hud')

// Меню перечитывает сводку сейва под новым sid («Продолжить» владельца в
// песочнице не показывается, после выхода — снова).
function restartMenu(game: Phaser.Game): void {
  if (game.scene.isActive('menu')) game.scene.getScene('menu').scene.restart()
}

const write = (rec: SandboxRecord): void => sessionStore.set(SANDBOX_KEY, JSON.stringify(rec))

export function makeSandbox(game: Phaser.Game): SandboxApi {
  // Выбор масштаба во вкладке песочницы — отметка в её записи (переживает F5): restore() отличит
  // свой масштаб от выбранного владельцем в другой вкладке (ITGAME-155).
  onZoomWrite((v) => {
    const rec = sandboxRecord()
    if (rec) write({ ...rec, zoom: v })
  })

  const enter = (label: string): SandboxResult => {
    if (typeof label !== 'string' || !LABEL.test(label)) {
      return { ok: false, code: 'bad_label', error: 'метка — 1..24 символа [A-Za-z0-9_-]' }
    }
    if (inParty(game)) {
      return { ok: false, code: 'in_party', error: 'вкладка в партии — сначала «В меню»/«Сдаться», песочница ставится из меню' }
    }
    // Повторный вход не переснимает ключи владельца: при входе они уже были сняты.
    const prev = sandboxRecord()
    const rec: SandboxRecord = prev
      ? { ...prev, label }
      : {
          label,
          ownerSid: localStore.get(SID),
          ownerDiff: localStore.get(DIFF),
          ownerOnboard: localStore.get(ONBOARD),
          ownerZoom: localStore.get(ZOOM),
          tabSid: sessionStore.get(SID),
          tabAuto: sessionStore.get(AUTO),
          fake: null,
          at: Date.now(),
        }
    write(rec)
    const sid = sandboxSid(label)
    adoptTabSid(sid)
    restartMenu(game)
    return { ok: true, sid, owner: { sid: rec.ownerSid !== null, diff: rec.ownerDiff } }
  }

  const restore = (): SandboxRestore => {
    const rec = sandboxRecord()
    if (!rec) return { ok: false, code: 'no_sandbox', error: 'песочницы нет — itd.sandbox(метка)' }
    if (inParty(game)) {
      return { ok: false, code: 'in_party', error: 'вкладка в партии — сначала «В меню»/«Сдаться»: реконнект ушёл бы в партию владельца' }
    }
    const restored: string[] = []
    const kept: string[] = []
    const removed: string[] = []
    const check = (key: string, real: string | null, fake: string | null): boolean => {
      const expected = fake ?? real
      const now = localStore.get(key)
      // Наше значение (fake) или стёртое — возвращаем; чужое — владелец мог
      // записать его сам в другой вкладке, не перетираем.
      if (now !== real && (now === fake || now === null)) {
        if (real === null) localStore.remove(key)
        else localStore.set(key, real)
        restored.push(`localStorage.${key}`)
      } else if (now !== real) kept.push(`localStorage.${key}`)
      return now === expected
    }
    const sidSame = check(SID, rec.ownerSid, rec.fake?.sid ?? null)
    const diffSame = check(DIFF, rec.ownerDiff, rec.fake?.diff ?? null)
    // itd.onboard пишет только HUD («done»), fakeOwner его не трогает: любое отличие от
    // значения при входе — след партии песочницы, возвращаем как при входе.
    if (rec.ownerOnboard !== undefined && localStore.get(ONBOARD) !== rec.ownerOnboard) {
      if (rec.ownerOnboard === null) localStore.remove(ONBOARD)
      else localStore.set(ONBOARD, rec.ownerOnboard)
      restored.push(`localStorage.${ONBOARD}`)
    }
    // itd.uiScale — как itd.sid: свой масштаб (последний выбранный в песочнице) или стёртый
    // возвращаем к значению при входе (null — ключ удаляется), чужой — kept. Выбор вкладки в
    // памяти uiscale.ts забываем, иначе меню и канвас остались бы на масштабе песочницы.
    if (rec.ownerZoom !== undefined) {
      check(ZOOM, rec.ownerZoom, rec.zoom ?? null)
      if (restored.includes(`localStorage.${ZOOM}`)) rereadZoom(game)
    }
    for (const [key, val] of [[SID, rec.tabSid], [AUTO, rec.tabAuto]] as const) {
      if (sessionStore.get(key) === val) continue
      if (val === null) {
        sessionStore.remove(key)
        removed.push(`sessionStorage.${key}`)
      } else {
        sessionStore.set(key, val)
        restored.push(`sessionStorage.${key}`)
      }
    }
    sessionStore.remove(SANDBOX_KEY)
    removed.push(`sessionStorage.${SANDBOX_KEY}`)
    forgetTabSid()
    restartMenu(game)
    return { ok: true, sidSame, diffSame, fake: rec.fake !== null, restored, kept, removed }
  }

  const fakeOwner = (): FakeOwnerResult => {
    const rec = sandboxRecord()
    if (!rec) return { ok: false, code: 'no_sandbox', error: 'сначала itd.sandbox(метка): restore() вернёт настоящий ключ владельца' }
    const fake = rec.fake ?? { sid: `fake-owner-${Date.now()}`, diff: rec.ownerDiff === 'hard' ? 'easy' : 'hard' }
    localStore.set(SID, fake.sid)
    localStore.set(DIFF, fake.diff)
    write({ ...rec, fake })
    return { ok: true, sid: fake.sid, diff: fake.diff }
  }

  return Object.assign(enter, { restore, fakeOwner })
}
