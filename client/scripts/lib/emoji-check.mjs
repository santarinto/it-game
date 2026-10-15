// emoji-check — поиск эмодзи в тексте (ITGAME-83): иконки интерфейса — спрайты рядом с Text,
// цветной системный шрифт облик разный на ОС и в CI. Без node:* — чистая функция.
//
// Эмодзи — символ \p{Extended_Pictographic} или селектор U+FE0F, КРОМЕ символов, которые
// несут наши шрифты (public/assets/fonts): их рисует Departure Mono / ITD Symbols, не
// системный шрифт. Список — пересечение Extended_Pictographic с cmap обоих шрифтов,
// `fc-query --format='%{charset}' <woff2>`; новый глиф в шрифте — сюда же.
export const FONT_PICTOGRAPHS = new Set([...'©®™↕↖↗↘↙▪▫♠♣♥♦⏸▶☣✖'])

/**
 * @param {string} text
 * @returns {{line:number, col:number, char:string, code:string}[]}
 */
export function findEmoji(text) {
  const found = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    let col = 0
    for (const ch of lines[i]) {
      col++
      if (FONT_PICTOGRAPHS.has(ch)) continue
      if (ch === '️' || /\p{Extended_Pictographic}/u.test(ch)) {
        found.push({ line: i + 1, col, char: ch, code: 'U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0') })
      }
    }
  }
  return found
}
