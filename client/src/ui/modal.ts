import Phaser from 'phaser'
import { GAME_H, GAME_W } from '../layout'
import { drawDebugFrames } from '../debug'

export interface ModalButton {
  label: string
  onClick: () => void
}

// Единый шаблон модалок устройств (роутер, сервер, core): подложка,
// панель, заголовок, строки, кнопки действий. Клик по действию шлёт
// команду и закрывает модалку — новое состояние придёт снапшотом.
export function showModal(scene: Phaser.Scene, title: string, lines: string[], buttons: ModalButton[]): () => void {
  const objs: Phaser.GameObjects.GameObject[] = []
  const close = () => objs.splice(0).forEach((o) => o.destroy())
  const cx = GAME_W / 2
  const cy = GAME_H / 2 - 40
  const panelH = 110 + lines.length * 26 + buttons.length * 46
  // Подложка interactive: глушит клики по сцене; клик по ней закрывает.
  const overlay = scene.add.rectangle(0, 0, GAME_W, GAME_H, 0x1a1c2c, 0.75).setOrigin(0).setDepth(70).setInteractive()
  overlay.on('pointerdown', close)
  // Панель тоже interactive: topOnly-ввод Phaser не пропустит клик к подложке.
  const panel = scene.add.rectangle(cx, cy, 460, panelH, 0x14162b).setStrokeStyle(2, 0x41a6f6).setDepth(71).setInteractive()
  const titleText = scene.add
    .text(cx, cy - panelH / 2 + 26, title, { fontFamily: 'monospace', fontSize: '18px', color: '#ffcd75' })
    .setOrigin(0.5).setDepth(72)
  const closeX = scene.add
    .text(cx + 210, cy - panelH / 2 + 26, '✕', { fontFamily: 'monospace', fontSize: '16px', color: '#5d7275' })
    .setOrigin(0.5).setDepth(72).setInteractive({ useHandCursor: true })
  closeX.on('pointerdown', close)
  const body = scene.add
    .text(cx, cy - panelH / 2 + 56, lines.join('\n'), {
      fontFamily: 'monospace', fontSize: '14px', color: '#f4f4f4', lineSpacing: 8, align: 'center',
    })
    .setOrigin(0.5, 0).setDepth(72)
  objs.push(overlay, panel, titleText, closeX, body)
  buttons.forEach((b, i) => {
    const by = cy + panelH / 2 - 26 - (buttons.length - 1 - i) * 46
    const bg = scene.add.rectangle(cx - 110, by - 17, 220, 34, 0x3b5dc9).setOrigin(0).setDepth(72)
      .setInteractive({ useHandCursor: true })
    const txt = scene.add
      .text(cx, by, b.label, { fontFamily: 'monospace', fontSize: '14px', color: '#f4f4f4' })
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
