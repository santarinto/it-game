import Phaser from 'phaser'
import { spriteKey } from '../assets/manifest'

// Иконка-спрайт рядом с Text (ITGAME-83): вместо эмодзи в строке — Image слева от первой
// строки текста. Место под иконку берётся левым padding самого Text, поэтому:
//   • фон текста (backgroundColor у тоста) растягивается и накрывает иконку;
//   • центрированный текст (origin 0.5) остаётся центрированным парой «иконка + текст»;
//   • раскладка, которая двигает текст (стек тостов) или гасит его (tween alpha),
//     ничего про иконку не знает — иконка каждый кадр повторяет x/y/alpha/visible/depth
//     текста и уничтожается вместе с ним.
// Размер — displaySize: itd.sprite.try сохраняет экранный размер объекта при любой пробе.

export interface IconTextOptions {
  px?: number // сторона иконки на экране, мировые px (по умолчанию 16)
  gap?: number // зазор иконка → текст (по умолчанию 6)
  alpha?: number // множитель поверх alpha текста — приглушить иконку (по умолчанию 1)
}

export function attachIcon(text: Phaser.GameObjects.Text, key: string, opts: IconTextOptions = {}): Phaser.GameObjects.Image {
  const scene = text.scene
  const px = opts.px ?? 16
  const gap = opts.gap ?? 6
  const alphaMul = opts.alpha ?? 1
  const pad = text.padding
  const baseLeft = pad.left ?? 0
  text.setPadding(baseLeft + px + gap, pad.top ?? 0, pad.right ?? 0, pad.bottom ?? 0)

  const icon = scene.add.image(0, 0, spriteKey(scene, key)).setDisplaySize(px, px)
  // Без фона — под текстом в порядке отрисовки: иконка в поле padding глифов не задевает,
  // а itd.overlaps не принимает её за плашку поверх текста. С фоном — над ним, иначе фон
  // текста её закроет.
  if (!text.style.backgroundColor) scene.children.moveBelow(icon as never, text as never)

  const sync = () => {
    const tl = text.getTopLeft()
    const lines = Math.max(1, text.getWrappedText().length)
    const innerH = text.height - (text.padding.top ?? 0) - (text.padding.bottom ?? 0)
    icon.setPosition(Math.round(tl.x + baseLeft + px / 2), Math.round(tl.y + (text.padding.top ?? 0) + innerH / lines / 2))
    icon.setAlpha(text.alpha * alphaMul).setVisible(text.visible).setDepth(text.depth)
  }
  sync()
  scene.events.on(Phaser.Scenes.Events.PRE_RENDER, sync)
  text.once(Phaser.GameObjects.Events.DESTROY, () => {
    scene.events.off(Phaser.Scenes.Events.PRE_RENDER, sync)
    icon.destroy()
  })
  return icon
}
