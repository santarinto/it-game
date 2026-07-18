import Phaser from 'phaser'
import { GAME_H, GAME_W } from '../layout'
import { drawDebugFrames } from '../debug'

export interface ModalButton {
  label: string
  onClick: () => void
}

// Схема заполнения стойки: filled из total юнитов заняты.
// Заполнение снизу вверх — железо ставят с нижних юнитов.
export interface ModalScheme {
  filled: number // занятых юнитов
  total: number // всего юнитов (всегда 24)
}

const UNIT_W = 96 // ширина юнита в схеме
const UNIT_H = 10 // высота юнита
const UNIT_GAP = 2 // зазор между юнитами

// Единый шаблон модалок устройств (роутер, сервер, core): подложка,
// панель, заголовок, строки, кнопки действий. Клик по действию шлёт
// команду и закрывает модалку — новое состояние придёт снапшотом.
// Со scheme панель шире, слева — вертикальная схема «24U СТОЙКА»,
// текст и кнопки сдвинуты вправо от неё.
export function showModal(
  scene: Phaser.Scene,
  title: string,
  lines: string[],
  buttons: ModalButton[],
  scheme?: ModalScheme,
): () => void {
  const objs: Phaser.GameObjects.GameObject[] = []
  const close = () => objs.splice(0).forEach((o) => o.destroy())
  const cx = GAME_W / 2
  const cy = GAME_H / 2 - 40
  // заголовок схемы + колонка юнитов + подпись «NU занято»
  const rackH = scheme ? 24 + scheme.total * (UNIT_H + UNIT_GAP) + 22 : 0
  const panelW = scheme ? 620 : 460
  const panelH = Math.max(110 + lines.length * 26 + buttons.length * 46, rackH ? rackH + 40 : 0)
  const shift = scheme ? 90 : 0 // сдвиг текста и кнопок вправо от схемы
  // Подложка interactive: глушит клики по сцене; клик по ней закрывает.
  const overlay = scene.add.rectangle(0, 0, GAME_W, GAME_H, 0x1a1c2c, 0.75).setOrigin(0).setDepth(70).setInteractive()
  overlay.on('pointerdown', close)
  // Панель тоже interactive: topOnly-ввод Phaser не пропустит клик к подложке.
  const panel = scene.add.rectangle(cx, cy, panelW, panelH, 0x14162b).setStrokeStyle(2, 0x41a6f6).setDepth(71).setInteractive()
  const titleText = scene.add
    .text(cx + shift, cy - panelH / 2 + 26, title, { fontFamily: 'monospace', fontSize: '18px', color: '#ffcd75' })
    .setOrigin(0.5).setDepth(72)
  const closeX = scene.add
    .text(cx + panelW / 2 - 20, cy - panelH / 2 + 26, '✕', { fontFamily: 'monospace', fontSize: '16px', color: '#5d7275' })
    .setOrigin(0.5).setDepth(72).setInteractive({ useHandCursor: true })
  closeX.on('pointerdown', close)
  const body = scene.add
    .text(cx + shift, cy - panelH / 2 + 56, lines.join('\n'), {
      fontFamily: 'monospace', fontSize: '14px', color: '#f4f4f4', lineSpacing: 8, align: 'center',
    })
    .setOrigin(0.5, 0).setDepth(72)
  objs.push(overlay, panel, titleText, closeX, body)
  if (scheme) {
    const rx = cx - panelW / 2 + 78 // ось колонки юнитов
    const top = cy - rackH / 2
    objs.push(
      scene.add.text(rx, top, '24U СТОЙКА', { fontFamily: 'monospace', fontSize: '12px', color: '#5d7275' })
        .setOrigin(0.5, 0).setDepth(72),
    )
    for (let u = 0; u < scheme.total; u++) {
      // u — номер юнита снизу вверх: железо ставят с нижних юнитов
      const uy = top + 24 + (scheme.total - 1 - u) * (UNIT_H + UNIT_GAP)
      if (u < scheme.filled) {
        objs.push(scene.add.rectangle(rx, uy, UNIT_W, UNIT_H, 0x38b764).setOrigin(0.5, 0).setDepth(72))
        // тёмные «диски» — декор занятой плашки
        for (let d = 0; d < 3; d++) {
          objs.push(scene.add.circle(rx - 30 + d * 10, uy + UNIT_H / 2, 2, 0x14162b).setDepth(73))
        }
      } else {
        objs.push(
          scene.add.rectangle(rx, uy, UNIT_W, UNIT_H, 0x232640).setOrigin(0.5, 0).setDepth(72)
            .setStrokeStyle(1, 0x3a3f5c),
        )
      }
    }
    objs.push(
      scene.add.text(rx, top + 24 + scheme.total * (UNIT_H + UNIT_GAP) + 6, `${scheme.filled}U занято`, {
        fontFamily: 'monospace', fontSize: '12px', color: '#41a6f6',
      }).setOrigin(0.5, 0).setDepth(72),
    )
  }
  buttons.forEach((b, i) => {
    const by = cy + panelH / 2 - 26 - (buttons.length - 1 - i) * 46
    const bg = scene.add.rectangle(cx + shift - 110, by - 17, 220, 34, 0x3b5dc9).setOrigin(0).setDepth(72)
      .setInteractive({ useHandCursor: true })
    const txt = scene.add
      .text(cx + shift, by, b.label, { fontFamily: 'monospace', fontSize: '14px', color: '#f4f4f4' })
      .setOrigin(0.5).setDepth(73)
    bg.on('pointerdown', () => {
      b.onClick()
      close()
    })
    bg.on('pointerover', () => bg.setFillStyle(0x41a6f6))
    bg.on('pointerout', () => bg.setFillStyle(0x3b5dc9))
    objs.push(bg, txt)
  })
  objs.push(...drawDebugFrames(scene, objs))
  return close
}
