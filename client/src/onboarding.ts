// Цепочка онбординга (ITGAME-21): найм → второй ПК → роутер офиса. Шаг определяется
// состоянием партии (первый невыполненный), выполненные пропускаются; новая партия
// стартует с одним ПК, поэтому «купить ПК» уже сделано. Только данные, без Phaser.
import type { StateMessage } from './protocol'

export interface OnboardStep {
  id: 'hire' | 'pc2' | 'router'
  text: string
  done: (s: StateMessage) => boolean
  // Рамка на цели в офисе 0 (мировые px): кнопки колонки действий и слот роутера.
  target: { x: number; y: number; w: number; h: number }
}

export const ONBOARD_STEPS: OnboardStep[] = [
  { id: 'hire', text: '1/3 Наймите сотрудника\nкнопка «Нанять» справа', done: (s) => s.offices.some((o) => o.employees.length > 0), target: { x: 1142, y: 438, w: 128, h: 44 } },
  { id: 'pc2', text: '2/3 Купите второй ПК\nкнопка «Купить ПК» справа', done: (s) => s.offices.reduce((n, o) => n + o.pcs, 0) >= 2, target: { x: 1142, y: 384, w: 128, h: 44 } },
  { id: 'router', text: '3/3 Купите роутер офиса\nслот «сеть» над кнопками', done: (s) => s.offices.some((o) => o.routerTier > 0), target: { x: 1164, y: 128, w: 84, h: 84 } },
]

// Индекс первого невыполненного шага; null — цепочка пройдена.
export function onboardStep(s: StateMessage): number | null {
  const i = ONBOARD_STEPS.findIndex((st) => !st.done(s))
  return i === -1 ? null : i
}
