// sprite-stub-core.mjs — чистая логика генерации заглушек спрайтов по ролям (ITGAME-243).
// Точечная перекраска worker.png (рубашка), desk_pc.png (экран) и iso_desk_crt.png (CRT-экран)
// в акцентные цвета ролей сотрудников из палитры hd32, плюс процедурные iso-клетки.
import { PNG } from 'pngjs'

export const DESK_SCREEN_REGION = { x0: 45, y0: 36, x1: 70, y1: 64 }

/**
 * 7 базовых ролей сотрудников IT-компании (ITGAME-197) и их цветовые схемы из палитры hd32.
 * Рубашка worker.png: f4f4f4 (блик) → c4d2db (свет) → 94b0c2 (полутень) → 758ea4 (тень).
 * Экран desk_pc.png: 324a9c (основной) + 41a6f6 (блик) + 3b5dc9 (грань).
 * Экран iso_desk_crt.png: 73eff7 (CRT-свечение).
 */
export const ROLE_STUBS = {
  developer: {
    slug: 'developer',
    title: 'Программист',
    accent: '41a6f6', // яркий синий
    shirt: { f4f4f4: '5acbf7', c4d2db: '41a6f6', '94b0c2': '3e82e0', '758ea4': '324a9c' },
    screen: { '324a9c': '324a9c', '41a6f6': '41a6f6', '3b5dc9': '3b5dc9' },
    isoScreen: '41a6f6',
  },
  tester: {
    slug: 'tester',
    title: 'Тестировщик',
    accent: '38b764', // зелёный
    shirt: { f4f4f4: 'a7f070', c4d2db: '70d46a', '94b0c2': '38b764', '758ea4': '2f946f' },
    screen: { '324a9c': '38b764', '41a6f6': 'a7f070', '3b5dc9': '70d46a' },
    isoScreen: '70d46a',
  },
  support: {
    slug: 'support',
    title: 'Саппорт',
    accent: 'ffcd75', // янтарно-оранжевый
    shirt: { f4f4f4: 'fae1b5', c4d2db: 'ffcd75', '94b0c2': 'f7a566', '758ea4': 'ef7d57' },
    screen: { '324a9c': 'f7a566', '41a6f6': 'fae1b5', '3b5dc9': 'ffcd75' },
    isoScreen: 'ffcd75',
  },
  designer: {
    slug: 'designer',
    title: 'Дизайнер',
    accent: 'b13e53', // маджента / ягодный
    shirt: { f4f4f4: 'd05e55', c4d2db: 'b13e53', '94b0c2': '873358', '758ea4': '5d275d' },
    screen: { '324a9c': '873358', '41a6f6': 'd05e55', '3b5dc9': 'b13e53' },
    isoScreen: 'd05e55',
  },
  pm: {
    slug: 'pm',
    title: 'Проджект-менеджер',
    accent: '5acbf7', // циан / бирюза
    shirt: { f4f4f4: '73eff7', c4d2db: '5acbf7', '94b0c2': '257179', '758ea4': '204753' },
    screen: { '324a9c': '257179', '41a6f6': '73eff7', '3b5dc9': '5acbf7' },
    isoScreen: '73eff7',
  },
  lead: {
    slug: 'lead',
    title: 'Лид',
    accent: 'fae1b5', // золото / тёмный пурпур
    shirt: { f4f4f4: 'fae1b5', c4d2db: '873358', '94b0c2': '5d275d', '758ea4': '3c2245' },
    screen: { '324a9c': '5d275d', '41a6f6': 'fae1b5', '3b5dc9': 'ffcd75' },
    isoScreen: 'fae1b5',
  },
  analyst: {
    slug: 'analyst',
    title: 'Системный аналитик',
    accent: '3b5dc9', // глубокий индиго
    shirt: { f4f4f4: '41a6f6', c4d2db: '3b5dc9', '94b0c2': '29366f', '758ea4': '22294e' },
    screen: { '324a9c': '29366f', '41a6f6': '5acbf7', '3b5dc9': '3b5dc9' },
    isoScreen: '3e82e0',
  },
}

function hexToRgb(hex) {
  const h = hex.replace(/^#/, '').toLowerCase()
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

function getPixelHex(data, idx) {
  return [data[idx], data[idx + 1], data[idx + 2]]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Перекрасить рубашку worker.png в цвета роли (128x128).
 */
export function recolorWorker(basePng, roleConfig) {
  const canvas = new PNG({ width: basePng.width, height: basePng.height })
  basePng.data.copy(canvas.data)
  const map = roleConfig.shirt
  const rgbMap = new Map()
  for (const [from, to] of Object.entries(map)) {
    rgbMap.set(from.toLowerCase(), hexToRgb(to))
  }

  for (let i = 0; i < canvas.data.length; i += 4) {
    if (canvas.data[i + 3] < 26) continue
    const hex = getPixelHex(canvas.data, i)
    const targetRgb = rgbMap.get(hex)
    if (targetRgb) {
      canvas.data[i] = targetRgb[0]
      canvas.data[i + 1] = targetRgb[1]
      canvas.data[i + 2] = targetRgb[2]
    }
  }
  return canvas
}

/**
 * Перекрасить экран desk_pc.png в цвета роли (128x128).
 */
export function recolorDesk(basePng, roleConfig, region = DESK_SCREEN_REGION) {
  const canvas = new PNG({ width: basePng.width, height: basePng.height })
  basePng.data.copy(canvas.data)
  const map = roleConfig.screen
  const rgbMap = new Map()
  for (const [from, to] of Object.entries(map)) {
    rgbMap.set(from.toLowerCase(), hexToRgb(to))
  }

  const { x0, y0, x1, y1 } = region
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const idx = (y * canvas.width + x) * 4
      if (canvas.data[idx + 3] < 26) continue
      const hex = getPixelHex(canvas.data, idx)
      const targetRgb = rgbMap.get(hex)
      if (targetRgb) {
        canvas.data[idx] = targetRgb[0]
        canvas.data[idx + 1] = targetRgb[1]
        canvas.data[idx + 2] = targetRgb[2]
      }
    }
  }
  return canvas
}

/**
 * Перекрасить CRT-экран iso_desk_crt.png в акцентный цвет роли (256x256).
 */
export function recolorIsoDesk(basePng, roleConfig, crtScreenHex = '73eff7') {
  const canvas = new PNG({ width: basePng.width, height: basePng.height })
  basePng.data.copy(canvas.data)
  const targetRgb = hexToRgb(roleConfig.isoScreen)
  const fromHex = crtScreenHex.toLowerCase()

  for (let i = 0; i < canvas.data.length; i += 4) {
    if (canvas.data[i + 3] < 26) continue
    const hex = getPixelHex(canvas.data, i)
    if (hex === fromHex) {
      canvas.data[i] = targetRgb[0]
      canvas.data[i + 1] = targetRgb[1]
      canvas.data[i + 2] = targetRgb[2]
    }
  }
  return canvas
}

/**
 * Процедурная изометрическая плитка (256x256): ромб 2:1 клетки пола с каймой и акцентной меткой роли.
 */
export function drawProceduralIsoTile(roleConfig) {
  const png = new PNG({ width: 256, height: 256 })
  const borderRgb = hexToRgb('333c57')
  const fillRgb = hexToRgb('45546f')
  const accentRgb = hexToRgb(roleConfig.accent)

  function setPixel(x, y, rgb) {
    if (x < 0 || x >= 256 || y < 0 || y >= 256) return
    const idx = (y * 256 + x) * 4
    png.data[idx] = rgb[0]
    png.data[idx + 1] = rgb[1]
    png.data[idx + 2] = rgb[2]
    png.data[idx + 3] = 255
  }

  // Ромб 2:1 у нижнего края холста, центр (128, 192)
  for (let y = 128; y <= 255; y++) {
    for (let x = 0; x <= 255; x++) {
      const dx = Math.abs(x - 127.5)
      const dy = Math.abs(y - 191.5)
      const dist = dx + 2 * dy
      if (dist <= 126) {
        if (dist >= 122) {
          setPixel(x, y, borderRgb)
        } else if (dist <= 36) {
          setPixel(x, y, accentRgb) // ромбовидная метка роли в центре
        } else {
          setPixel(x, y, fillRgb)
        }
      }
    }
  }
  return png
}

/**
 * Собрать спецификации спрайтов и алиасы для sprites.json.
 */
export function buildManifestEntries(roles = ROLE_STUBS) {
  const sprites = {}
  const aliases = {}

  for (const [slug, conf] of Object.entries(roles)) {
    sprites[`worker_${slug}`] = {
      size: 128,
      frames: 1,
      palette: 'hd32',
      class: 'person',
      fallback: 'worker',
      note: `заглушка роли: ${conf.title} (ITGAME-197/243) — перекраска рубашки worker.png в акцентный цвет`,
    }
    sprites[`desk_pc_${slug}`] = {
      size: 128,
      frames: 1,
      palette: 'hd32',
      class: 'desk',
      fallback: 'desk_pc',
      note: `заглушка роли: ${conf.title} (ITGAME-197/243) — перекраска экрана desk_pc.png`,
    }
    sprites[`iso_desk_${slug}`] = {
      size: 256,
      frames: 1,
      palette: 'hd32',
      class: 'iso',
      fallback: 'iso_desk_crt',
      note: `заглушка роли: ${conf.title} в изометрии (ITGAME-197/211/243) — перекраска CRT-экрана`,
    }
    aliases[`desk_${slug}`] = `desk_pc_${slug}`
  }

  return { sprites, aliases }
}

/**
 * Обновить sprites.json текстом, сохраняя форматирование файла.
 */
export function updateManifestText(manifestRaw, newSprites, newAliases) {
  const parsed = JSON.parse(manifestRaw)

  // Обновляем структуру
  for (const [k, v] of Object.entries(newSprites)) {
    parsed.sprites[k] = v
  }
  if (!parsed.aliases) parsed.aliases = {}
  for (const [k, v] of Object.entries(newAliases)) {
    parsed.aliases[k] = v
  }

  // Сериализуем с красивыми отступами в стиле репо:
  // palettes и простые sprites на одну строку, если влезают
  const lines = []
  lines.push('{')
  lines.push('  "palettes": {')
  const palKeys = Object.keys(parsed.palettes)
  palKeys.forEach((p, idx) => {
    const trailing = idx < palKeys.length - 1 ? ',' : ''
    const colors = parsed.palettes[p].map((c) => `"${c}"`)
    if (colors.length <= 16) {
      lines.push(`    "${p}": [\n      ${colors.join(', ')}\n    ]${trailing}`)
    } else {
      const half1 = colors.slice(0, 16).join(', ')
      const half2 = colors.slice(16).join(', ')
      lines.push(`    "${p}": [\n      ${half1},\n      ${half2}\n    ]${trailing}`)
    }
  })
  lines.push('  },')

  lines.push('  "sprites": {')
  const sprKeys = Object.keys(parsed.sprites)
  sprKeys.forEach((k, idx) => {
    const trailing = idx < sprKeys.length - 1 ? ',' : ''
    const item = parsed.sprites[k]
    // Если есть seenIn или длинная note, многострочный JSON, иначе одна строка
    if (item.seenIn || (item.note && item.note.length > 80)) {
      const formatted = JSON.stringify(item, null, 2)
        .split('\n')
        .map((l, i) => (i === 0 ? l : `    ${l}`))
        .join('\n')
      lines.push(`    "${k}": ${formatted}${trailing}`)
    } else {
      lines.push(`    "${k}": ${JSON.stringify(item)}${trailing}`)
    }
  })
  lines.push('  },')

  lines.push('  "aliases": {')
  const aliasKeys = Object.keys(parsed.aliases)
  aliasKeys.forEach((k, idx) => {
    const trailing = idx < aliasKeys.length - 1 ? ',' : ''
    lines.push(`    "${k}": "${parsed.aliases[k]}"${trailing}`)
  })
  lines.push('  }')
  lines.push('}\n')

  return lines.join('\n')
}
