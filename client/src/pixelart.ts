import Phaser from 'phaser'

// Палитра в духе Sweetie-16. Точка — прозрачный пиксель.
const PALETTE: Record<string, string> = {
  k: '#1a1c2c', // чёрный
  w: '#f4f4f4', // белый
  g: '#5d7275', // серый металл
  b: '#3b5dc9', // синий (одежда)
  s: '#41a6f6', // голубой (экраны)
  d: '#8b5e3c', // дерево
  y: '#ffcd75', // кожа/жёлтый
  r: '#b13e53', // красный
  e: '#38b764', // зелёный (диоды)
}

// Спрайты 16×16: 16 строк по 16 символов из PALETTE.
const SPRITES: Record<string, string[]> = {
  desk_empty: [
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '..dddddddddddd..',
    '..dddddddddddd..',
    '..dd........dd..',
    '..dd........dd..',
    '..dd........dd..',
    '..dd........dd..',
    '................',
  ],
  desk_pc: [
    '................',
    '................',
    '....kkkkkkkk....',
    '....kssssssk....',
    '....kssssssk....',
    '....kssswssk....',
    '....kkkkkkkk....',
    '.......kk.......',
    '......kkkk......',
    '..dddddddddddd..',
    '..dddddddddddd..',
    '..dd........dd..',
    '..dd........dd..',
    '..dd........dd..',
    '..dd........dd..',
    '................',
  ],
  worker: [
    '................',
    '.....yyyyy......',
    '....yyyyyyy.....',
    '....yykykyy.....',
    '....yyyyyyy.....',
    '.....yyyy.......',
    '....bbbbbb......',
    '...bbbbbbbb.....',
    '...b.bbbb.b.....',
    '...y.bbbb.y.....',
    '.....bbbb.......',
    '.....b..b.......',
    '.....b..b.......',
    '.....k..k.......',
    '................',
    '................',
  ],
  router: [
    '................',
    '................',
    '................',
    '......k..k......',
    '......k..k......',
    '......k..k......',
    '...kkkkkkkkkk...',
    '...kwkkkkkkek...',
    '...kkkkkkkkkk...',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
  ],
  rack_empty: [
    '...gggggggggg...',
    '...g........g...',
    '...g........g...',
    '...g........g...',
    '...g........g...',
    '...g........g...',
    '...g........g...',
    '...g........g...',
    '...g........g...',
    '...g........g...',
    '...g........g...',
    '...g........g...',
    '...g........g...',
    '...g........g...',
    '...gggggggggg...',
    '................',
  ],
  rack_server: [
    '...gggggggggg...',
    '...gkkkkkkkkg...',
    '...gke....wkg...',
    '...gkkkkkkkkg...',
    '...gke....wkg...',
    '...gkkkkkkkkg...',
    '...gke....wkg...',
    '...gkkkkkkkkg...',
    '...gke....wkg...',
    '...gkkkkkkkkg...',
    '...gke....wkg...',
    '...gkkkkkkkkg...',
    '...g........g...',
    '...g........g...',
    '...gggggggggg...',
    '................',
  ],
}

// registerTextures рисует все спрайты в canvas-текстуры Phaser.
// Вызывать один раз в BootScene до старта комнат.
export function registerTextures(scene: Phaser.Scene): void {
  for (const [key, rows] of Object.entries(SPRITES)) {
    const canvas = scene.textures.createCanvas(key, 16, 16)
    if (!canvas) continue // текстура уже зарегистрирована
    const ctx = canvas.context
    rows.forEach((row, y) => {
      ;[...row].forEach((ch, x) => {
        const color = PALETTE[ch]
        if (color) {
          ctx.fillStyle = color
          ctx.fillRect(x, y, 1, 1)
        }
      })
    })
    canvas.refresh()
  }
}
