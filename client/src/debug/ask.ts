import type Phaser from 'phaser'
import { sessionStore } from '../storage'
import {
  ASK_BOX_ID,
  ASK_KEY,
  calcDockBoxStyle,
  calcDockWhere,
  checkAskItems,
  checkAskOptions,
  newAskRecord,
  parseAskRecord,
  serializeAskRecord,
} from './askCore'
import type {
  AskAnswer,
  AskItem,
  AskOptions,
  AskRecord,
  AskRefusal,
  AskResult,
  AskStartResult,
  AskWhere,
} from './askCore'
import type { ClaimApi } from './claim'

export type { AskAnswer, AskDock, AskItem, AskOptions, AskRecord, AskRefusal, AskResult, AskStartResult, AskWhere } from './askCore'

export interface AskState {
  active: boolean
  where?: AskWhere
  collapsed?: boolean
  submitted?: boolean
  result?: AskResult | null
  answers?: Record<number, { status: string | null; comment: string }>
}

export interface AskApi {
  /** Открыть форму опроса человека прямо в странице: items — массив пунктов {n, text, kind?, choices?, target?}, opts — {dock?: 'auto' | 'bottom' | 'right' | 'overlay'}. */
  (items: AskItem[], opts?: AskOptions): AskStartResult | AskRefusal
  /** Результат опроса или null, если ответ ещё не отправлен. */
  result: () => AskResult | null
  /** Асинхронное ожидание ответа человека (до ms мс, по умолчанию 120_000). Резолвится AskResult или null при таймауте/закрытии. */
  wait: (ms?: number) => Promise<AskResult | null>
  /** Текущее состояние формы опроса. */
  state: () => AskState
  /** Закрыть форму опроса и очистить состояние в DOM и sessionStorage. */
  close: () => { ok: true }
}

export function isTargetHit(target: string, claimApi?: ClaimApi): boolean {
  if (!claimApi) return false
  const state = claimApi.state()
  if (!('active' in state) || !state.active) return false
  const norm = target.replace(/\./g, ':')
  if (state.allow && state.allow.hit && (state.allow.target === norm || state.allow.target === target)) {
    return true
  }
  return state.presses.some(
    (p) => p.got.includes(norm) || p.got.includes(target) || p.wins === norm || p.wins === target,
  )
}

export function makeAsk(game: Phaser.Game, sha: string, getClaimApi?: () => ClaimApi | undefined): AskApi {
  let rec: AskRecord | null = null
  let box: HTMLDivElement | null = null
  let waitResolvers: Array<(res: AskResult | null) => void> = []

  const save = () => {
    if (rec) {
      sessionStore.set(ASK_KEY, serializeAskRecord(rec))
    }
  }

  const getCanvasRect = () => {
    if (typeof document === 'undefined') {
      return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
    }
    const canvas = game.canvas ?? document.querySelector('canvas')
    if (canvas) {
      return canvas.getBoundingClientRect()
    }
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
  }

  const getViewport = () => ({
    iw: typeof window !== 'undefined' ? window.innerWidth : 1920,
    ih: typeof window !== 'undefined' ? window.innerHeight : 1080,
  })

  const applyGeometry = () => {
    if (!rec || !box) return
    const canvasRect = getCanvasRect()
    const viewport = getViewport()
    rec.where = calcDockWhere(rec.dock, canvasRect, viewport)
    box.dataset.where = rec.where
    const styles = calcDockBoxStyle(rec.where, canvasRect, viewport, rec.collapsed)
    Object.assign(box.style, styles)
  }

  const onWindowResize = () => {
    applyGeometry()
  }

  const render = () => {
    if (!rec) {
      if (box) {
        box.remove()
        box = null
      }
      return
    }

    if (typeof document === 'undefined') return

    if (!box) {
      box = document.createElement('div')
      box.id = ASK_BOX_ID
      Object.assign(box.style, {
        position: 'fixed',
        overflow: 'auto',
        background: '#14162bee',
        color: '#e8e8f0',
        border: '2px solid #f5c542',
        borderRadius: '8px',
        padding: '12px 16px',
        font: '15px/1.4 "Departure Mono", monospace, monospace',
        zIndex: '99999',
        boxSizing: 'border-box',
      })
      // Останавливаем события мыши/колеса, чтобы ввод в форме не трогал сцену игры
      ;['mousedown', 'mouseup', 'click', 'wheel', 'touchstart', 'touchend'].forEach((e) => {
        box?.addEventListener(e, (ev) => ev.stopPropagation())
      })
      document.body.appendChild(box)
      window.addEventListener('resize', onWindowResize)
    }

    applyGeometry()
    box.innerHTML = ''

    if (rec.submitted) {
      // Ответ отправлен: показываем плашку подтверждения
      const header = document.createElement('div')
      Object.assign(header.style, {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '8px',
      })
      const title = document.createElement('div')
      title.innerHTML = '<b style="color:#f5c542">Вопрос агента</b> — ответ отправлен'
      header.appendChild(title)

      const closeBtn = document.createElement('button')
      closeBtn.id = 'itd-ask-close'
      closeBtn.textContent = 'закрыть'
      Object.assign(closeBtn.style, {
        font: 'inherit',
        fontSize: '13px',
        padding: '2px 10px',
        background: '#2a2d4a',
        color: '#e8e8f0',
        border: '1px solid #556',
        borderRadius: '4px',
        cursor: 'pointer',
      })
      closeBtn.onclick = () => {
        api.close()
      }
      header.appendChild(closeBtn)
      box.appendChild(header)

      const msg = document.createElement('div')
      msg.style.color = '#51cf66'
      msg.innerHTML = '<b>Ответ получен.</b> Вкладку не трогай — агент напишет «вкладка свободна».'
      box.appendChild(msg)
      return
    }

    // Заголовок формы с кнопкой сворачивания
    const header = document.createElement('div')
    Object.assign(header.style, {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: rec.collapsed ? '0' : '10px',
    })
    const headText = document.createElement('div')
    headText.innerHTML = '<b style="color:#f5c542">Вопрос агента</b> — ответь здесь; остальную вкладку не трогай'
    header.appendChild(headText)

    const toggleBtn = document.createElement('button')
    toggleBtn.id = 'itd-ask-toggle'
    toggleBtn.textContent = rec.collapsed ? 'развернуть' : 'свернуть'
    Object.assign(toggleBtn.style, {
      font: 'inherit',
      fontSize: '13px',
      padding: '2px 10px',
      marginLeft: '12px',
      background: '#2a2d4a',
      color: '#e8e8f0',
      border: '1px solid #556',
      borderRadius: '4px',
      cursor: 'pointer',
    })
    toggleBtn.onclick = () => {
      if (!rec) return
      rec.collapsed = !rec.collapsed
      save()
      render()
    }
    header.appendChild(toggleBtn)
    box.appendChild(header)

    if (rec.collapsed) {
      return
    }

    const content = document.createElement('div')
    content.id = 'itd-ask-content'

    const claimApi = getClaimApi?.()

    // Рендер каждого пункта
    rec.items.forEach((it) => {
      if (!rec) return
      if (!rec.answers[it.n]) {
        rec.answers[it.n] = { status: null, comment: '' }
      }
      const st = rec.answers[it.n]

      const q = document.createElement('div')
      q.dataset.n = String(it.n)
      q.style.margin = '12px 0 14px 0'

      const titleRow = document.createElement('div')
      titleRow.innerHTML = `<b>${it.n}.</b> ${it.text}`

      // Индикатор «нажми сам» / цели
      let hit = false
      if (it.target) {
        hit = isTargetHit(it.target, claimApi)
        const badge = document.createElement('span')
        badge.style.fontSize = '12px'
        badge.style.marginLeft = '8px'
        badge.style.fontWeight = 'normal'
        if (hit) {
          badge.style.color = '#51cf66'
          badge.textContent = `[цель: ${it.target} ✓ клик получен]`
        } else {
          badge.style.color = '#f59f00'
          badge.textContent = `[цель: ${it.target} — нажми в игре]`
        }
        titleRow.appendChild(badge)
      }
      q.appendChild(titleRow)

      const warnRow = document.createElement('div')
      warnRow.style.color = '#ff6b6b'
      warnRow.style.fontSize = '12px'
      warnRow.style.marginTop = '4px'
      warnRow.style.display = 'none'
      q.appendChild(warnRow)

      const btnRow = document.createElement('div')
      btnRow.style.margin = '6px 0'

      const opts = it.kind === 'value' ? (it.choices || []) : ['корректно', 'нет', 'непонятно']
      opts.forEach((opt) => {
        const b = document.createElement('button')
        b.textContent = opt
        const isSelected = st.status === opt
        let bg = '#2a2d4a'
        if (isSelected) {
          if (opt === 'корректно') bg = '#2b8a3e'
          else if (opt === 'нет') bg = '#c92a2a'
          else if (opt === 'непонятно') bg = '#e67700'
          else bg = '#3b5bdb'
        }
        Object.assign(b.style, {
          font: 'inherit',
          fontSize: '14px',
          margin: '0 8px 6px 0',
          padding: '4px 12px',
          background: bg,
          color: '#e8e8f0',
          border: isSelected ? '1px solid #fff' : '1px solid #556',
          borderRadius: '4px',
          cursor: 'pointer',
        })

        b.onclick = () => {
          if (!rec) return
          if (it.target && opt === 'корректно') {
            const currentHit = isTargetHit(it.target, claimApi)
            if (!currentHit) {
              warnRow.textContent = `Клик по цели «${it.target}» ещё не зафиксирован! Сначала нажми кнопку в игре.`
              warnRow.style.display = 'block'
            } else {
              warnRow.style.display = 'none'
            }
          } else {
            warnRow.style.display = 'none'
          }
          st.status = opt
          save()
          render()
        }
        btnRow.appendChild(b)
      })
      q.appendChild(btnRow)

      const commentInput = document.createElement('input')
      commentInput.type = 'text'
      commentInput.value = st.comment
      commentInput.placeholder = it.kind === 'value' ? 'свой ответ / комментарий' : 'комментарий (можно пусто)'
      Object.assign(commentInput.style, {
        width: '100%',
        font: 'inherit',
        fontSize: '13px',
        padding: '5px 8px',
        background: '#0d0e1c',
        color: '#e8e8f0',
        border: '1px solid #556',
        borderRadius: '4px',
        boxSizing: 'border-box',
      })
      commentInput.oninput = () => {
        st.comment = commentInput.value
        save()
      }
      q.appendChild(commentInput)

      content.appendChild(q)
    })

    // Кнопка «Отправить агенту»
    const sendRow = document.createElement('div')
    sendRow.style.marginTop = '16px'

    const sendBtn = document.createElement('button')
    sendBtn.id = 'itd-ask-send'
    sendBtn.textContent = 'Отправить агенту'
    Object.assign(sendBtn.style, {
      font: 'inherit',
      fontSize: '15px',
      fontWeight: 'bold',
      padding: '8px 20px',
      background: '#f5c542',
      color: '#14162b',
      border: 'none',
      borderRadius: '4px',
      cursor: 'pointer',
    })

    sendBtn.onclick = () => {
      if (!rec) return
      const currentClaimApi = getClaimApi?.()
      const answers: AskAnswer[] = rec.items.map((it) => {
        if (!rec) return { n: it.n, status: null, comment: '' }
        const a = rec.answers[it.n] ?? { status: null, comment: '' }
        const ans: AskAnswer = {
          n: it.n,
          status: a.status,
          comment: a.comment,
        }
        if (it.target) {
          ans.target = it.target
          ans.hit = isTargetHit(it.target, currentClaimApi)
        }
        return ans
      })

      rec.submitted = true
      rec.result = {
        at: Date.now(),
        sha,
        ui: typeof localStorage !== 'undefined' ? localStorage.getItem('itd.uiScale') : null,
        iw: window.innerWidth,
        ih: window.innerHeight,
        dpr: window.devicePixelRatio || 1,
        title: document.title,
        answers,
      }
      save()
      render()

      const res = rec.result
      while (waitResolvers.length > 0) {
        const r = waitResolvers.shift()
        r?.(res)
      }
    }
    sendRow.appendChild(sendBtn)
    content.appendChild(sendRow)

    box.appendChild(content)
  }

  // При старте проверяем сохранённое состояние в sessionStorage
  try {
    const saved = sessionStore.get(ASK_KEY)
    if (saved) {
      const parsed = parseAskRecord(saved)
      if (parsed) {
        rec = parsed
        render()
      }
    }
  } catch (e) {
    console.error('[ask] ошибка восстановления из sessionStorage:', e)
  }

  const api: AskApi = Object.assign(
    (items: AskItem[], opts?: AskOptions): AskStartResult | AskRefusal => {
      const errItems = checkAskItems(items)
      if (errItems) return errItems
      const errOpts = checkAskOptions(opts)
      if (errOpts) return errOpts

      const dock = opts?.dock ?? 'auto'
      const canvasRect = getCanvasRect()
      const viewport = getViewport()
      const where = calcDockWhere(dock, canvasRect, viewport)

      rec = newAskRecord(items, dock, where)
      save()
      render()

      return { ok: true, n: items.length, where }
    },
    {
      result: (): AskResult | null => {
        if (rec && rec.submitted && rec.result) {
          return rec.result
        }
        return null
      },

      wait: (ms: number = 120_000): Promise<AskResult | null> => {
        const res = api.result()
        if (res) return Promise.resolve(res)

        return new Promise<AskResult | null>((resolve) => {
          let timer: ReturnType<typeof setTimeout> | null = null
          const resolver = (ans: AskResult | null) => {
            if (timer !== null) {
              clearTimeout(timer)
              timer = null
            }
            resolve(ans)
          }
          waitResolvers.push(resolver)
          timer = setTimeout(() => {
            const idx = waitResolvers.indexOf(resolver)
            if (idx !== -1) waitResolvers.splice(idx, 1)
            resolve(null)
          }, ms)
        })
      },

      state: (): AskState => {
        if (!rec) return { active: false }
        return {
          active: true,
          where: rec.where,
          collapsed: rec.collapsed,
          submitted: rec.submitted,
          result: rec.result,
          answers: rec.answers,
        }
      },

      close: (): { ok: true } => {
        sessionStore.remove(ASK_KEY)
        rec = null
        if (box) {
          box.remove()
          box = null
        }
        if (typeof window !== 'undefined') {
          window.removeEventListener('resize', onWindowResize)
        }
        while (waitResolvers.length > 0) {
          const r = waitResolvers.shift()
          r?.(null)
        }
        return { ok: true }
      },
    },
  )

  return api
}
