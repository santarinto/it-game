// sprite-check — общая проверка одного декодированного PNG против записи
// манифеста client/src/assets/sprites.json. Вынесено из check-sprites.mjs
// (ITGAME-28) для повторного использования в sprite-remap.mjs: свежий
// remap прогоняет тот же контракт (палитра/размер/прозрачность/шум) и
// печатает отчёт до того, как файл попадёт в client/public.
//
// checkSpriteImage() — чистая функция без side-effects (никакого fs/console):
// вызывающий код сам решает, как логировать problems/warnings. Поведение
// 1:1 с прежней логикой check-sprites.mjs — числа и формулировки не менялись.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const MIN_TRANSPARENT_PCT = 5
export const DEFAULT_MAX_WHITE_PCT = 40
export const DEFAULT_MAX_SPECKS = 0
export const INTERIOR_SPECKLE_WARN_PCT = 10
export const WHITE_HEX = 'f4f4f4'

/**
 * @param {{width:number, height:number, data:Uint8Array|Buffer}} png декодированный RGBA-буфер (pngjs или совместимый)
 * @param {{size:number, frames?:number, maxWhitePct?:number, maxSpecks?:number}} spec запись манифеста для ключа (или эквивалент)
 * @param {string[]} palette палитра ключа (hex без '#'), т.е. manifest.palettes[spec.palette]
 * @param {string} [paletteName] имя палитры — только для текста сообщения «вне палитры <имя>»
 * @returns {{problems:string[], warnings:string[], stats:{transparentPct:number, whitePct:number, noiseSummary:string, totalSpecks:number, maxSpecks:number}}}
 */
export function checkSpriteImage(png, spec, palette, paletteName) {
  const { width: w, height: h, data } = png
  const paletteSet = new Set(palette)
  const size = spec.size
  const frames = spec.frames ?? 1
  const expectW = size * frames
  const expectH = size

  const problems = []
  const warnings = []

  if (w !== expectW || h !== expectH) {
    problems.push(`размер ${w}×${h}, контракт ${expectW}×${expectH} (size=${size}×frames=${frames})`)
  }

  const opaque = (x, y) => x >= 0 && y >= 0 && x < w && y < h && data[(y * w + x) * 4 + 3] >= 26
  const hexAt = (x, y) => {
    const i = (y * w + x) * 4
    return [data[i], data[i + 1], data[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('')
  }

  let transparent = 0
  let semi = 0
  let white = 0
  const offPalette = new Map()
  for (let i = 3; i < data.length; i += 4) {
    const a = data[i]
    if (a < 26) {
      transparent++
      continue
    }
    if (a < 255) semi++
    const idx = i - 3
    const hex = [data[idx], data[idx + 1], data[idx + 2]].map((v) => v.toString(16).padStart(2, '0')).join('')
    if (hex === WHITE_HEX) white++
    if (!paletteSet.has(hex)) offPalette.set(hex, (offPalette.get(hex) ?? 0) + 1)
  }
  const total = w * h
  const transparentPct = Math.round((transparent / total) * 1000) / 10
  const whitePct = Math.round((white / total) * 1000) / 10
  const maxWhitePct = spec.maxWhitePct ?? DEFAULT_MAX_WHITE_PCT

  if (transparentPct < MIN_TRANSPARENT_PCT) {
    problems.push(`прозрачных ${transparentPct}% < ${MIN_TRANSPARENT_PCT}% — фон запечён?`)
  }
  if (semi > 0) {
    problems.push(`полупрозрачных пикселей ${semi} (alpha 26..254) — сглаживание/полутон не по контракту`)
  }
  if (whitePct > maxWhitePct) {
    problems.push(`#${WHITE_HEX} занимает ${whitePct}% > ${maxWhitePct}% — чекерборд/белая заливка`)
  }
  if (offPalette.size > 0) {
    const top = [...offPalette.keys()].slice(0, 5)
    const label = paletteName ? `вне палитры ${paletteName}` : 'вне палитры'
    problems.push(`${label}: ${top.join(' ')}${offPalette.size > 5 ? '…' : ''}`)
  }

  let noiseSummary = ''
  let totalSpecks = 0
  const maxSpecks = spec.maxSpecks ?? DEFAULT_MAX_SPECKS
  if (w === expectW && h === expectH) {
    let totalInterior = 0
    let totalSpeckled = 0
    const speckThreshold = 4 * (size / 64) ** 2
    for (let f = 0; f < frames; f++) {
      const fx0 = f * size
      const inFrame = (x, y) => x >= fx0 && x < fx0 + size && y >= 0 && y < size
      const frameOpaque = (x, y) => inFrame(x, y) && opaque(x, y)
      const seen = new Uint8Array(size * size)
      const idxOf = (x, y) => y * size + (x - fx0)
      for (let y = 0; y < size; y++) {
        for (let x = fx0; x < fx0 + size; x++) {
          if (!frameOpaque(x, y) || seen[idxOf(x, y)]) continue
          let n = 0
          const stack = [[x, y]]
          seen[idxOf(x, y)] = 1
          while (stack.length) {
            const [cx, cy] = stack.pop()
            n++
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                if (!dx && !dy) continue
                const nx = cx + dx
                const ny = cy + dy
                if (frameOpaque(nx, ny) && !seen[idxOf(nx, ny)]) {
                  seen[idxOf(nx, ny)] = 1
                  stack.push([nx, ny])
                }
              }
            }
          }
          if (n <= speckThreshold) totalSpecks++
        }
      }
      for (let y = 0; y < size; y++) {
        for (let x = fx0; x < fx0 + size; x++) {
          if (!frameOpaque(x, y)) continue
          const neighbours = []
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (!dx && !dy) continue
              if (frameOpaque(x + dx, y + dy)) neighbours.push(hexAt(x + dx, y + dy))
            }
          }
          if (neighbours.length === 8) {
            totalInterior++
            if (!neighbours.includes(hexAt(x, y))) totalSpeckled++
          }
        }
      }
    }
    if (totalSpecks > maxSpecks) {
      problems.push(`шум: ${totalSpecks} спек(ов) площадью <=${speckThreshold}px > лимита ${maxSpecks}`)
    }
    const speckledPct = totalInterior > 0 ? Math.round((totalSpeckled / totalInterior) * 1000) / 10 : 0
    if (speckledPct > INTERIOR_SPECKLE_WARN_PCT) {
      warnings.push(`${speckledPct}% внутренних пикселей шумят цветом (>${INTERIOR_SPECKLE_WARN_PCT}%) — не фейл, но арт стоит перегенерировать`)
    }
    noiseSummary = `, шум ${totalSpecks}/${maxSpecks}`
  }

  return {
    problems,
    warnings,
    stats: { transparentPct, whitePct, noiseSummary, totalSpecks, maxSpecks },
  }
}

/**
 * Читает client/src/assets/sprites.json. clientDir — корень client/ (dirname дважды от scripts/lib).
 */
export function loadManifest(clientDir) {
  const path = join(clientDir, 'src', 'assets', 'sprites.json')
  return JSON.parse(readFileSync(path, 'utf8'))
}
