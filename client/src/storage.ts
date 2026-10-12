// Безопасное хранилище (ITGAME-80): localStorage/sessionStorage, которые никогда не бросают.
//
// Chrome с запретом данных сайта (приватный режим с запретом, политика сайта) бросает SecurityError уже на
// геттере window.localStorage, переполненное хранилище — на setItem. Ключи itd.* клиент читает и пишет только
// через localStore/sessionStore (кроме uiscale.ts, main.ts itd.admin и debug/telemetry.ts — у них свои
// try/catch-фолбэки):
//   get(key)            — значение или null
//   set(key, value)     — запись
//   remove(key)         — удаление
//   clearPrefix(prefix) — снести ключи с префиксом в настоящем хранилище и в памяти, вернуть их имена (itd.reset)
// Правила:
// - чтение сквозное, кэша чтения нет: настоящий store пишут соседние вкладки, itd.sandbox и QA-скрипты;
// - память вкладки — только когда настоящий вызов бросил: непринятая запись живёт в памяти и читается раньше
//   настоящего значения, пока следующая успешная запись/удаление ключа её не снимет; непринятое удаление —
//   метка null («удалено»);
// - при закрытом целиком хранилище ключи (sid, сложность, пауза отчёта, хинты, мета) живут до перезагрузки
//   вкладки: «Продолжить» в той же вкладке есть, после F5 — нет;
// - к window.localStorage/sessionStorage — только внутри try и каждый раз заново: геттер бросает сам.
// При рабочем хранилище имена ключей и запись в настоящий store — как без обёртки.

export interface SafeStore {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
  clearPrefix(prefix: string): string[]
}

function makeStore(name: 'localStorage' | 'sessionStorage'): SafeStore {
  // ключ → значение, которое браузер не принял; null — непринятое удаление
  const memory = new Map<string, string | null>()
  let warned = false
  const real = (): Storage => window[name]
  const refused = (op: string, e: unknown): void => {
    if (warned) return
    warned = true
    console.warn(`[storage] ${name}.${op}: отказ (${e instanceof Error ? e.name : String(e)}) — ключи живут в памяти вкладки до перезагрузки`)
  }
  return {
    get(key) {
      if (memory.has(key)) return memory.get(key) ?? null
      try {
        return real().getItem(key)
      } catch (e) {
        refused('getItem', e)
        return null
      }
    },
    set(key, value) {
      try {
        real().setItem(key, value)
        memory.delete(key)
      } catch (e) {
        refused('setItem', e)
        memory.set(key, value)
      }
    },
    remove(key) {
      try {
        real().removeItem(key)
        memory.delete(key)
      } catch (e) {
        refused('removeItem', e)
        memory.set(key, null)
      }
    },
    clearPrefix(prefix) {
      const removed: string[] = []
      const stuck: string[] = [] // отказ removeItem — ключ остаётся в настоящем store, нужна метка «удалено»
      try {
        const s = real()
        for (let i = s.length - 1; i >= 0; i--) {
          const k = s.key(i)
          if (!k?.startsWith(prefix)) continue
          try {
            s.removeItem(k)
          } catch (e) {
            refused('removeItem', e)
            stuck.push(k)
          }
          removed.push(k)
        }
      } catch (e) {
        refused('clear', e)
      }
      for (const [k, v] of [...memory]) {
        if (!k.startsWith(prefix)) continue
        memory.delete(k)
        if (v !== null && !removed.includes(k)) removed.push(k)
      }
      for (const k of stuck) memory.set(k, null)
      return removed
    },
  }
}

export const localStore: SafeStore = makeStore('localStorage')
export const sessionStore: SafeStore = makeStore('sessionStorage')
