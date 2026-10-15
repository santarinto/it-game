export interface SpritePng {
  width: number
  height: number
  data: Uint8Array | Uint8ClampedArray
}

export interface SpriteCheckSpec {
  size: number
  frames?: number
  maxWhitePct?: number
  maxSpecks?: number
  render?: 'pixel' | 'smooth'
}

export interface SpriteCheckResult {
  problems: string[]
  warnings: string[]
  stats: {
    transparentPct: number
    whitePct: number
    noiseSummary: string
    totalSpecks: number
    maxSpecks: number
  }
}

export const MIN_TRANSPARENT_PCT: number
export const DEFAULT_MAX_WHITE_PCT: number
export const DEFAULT_MAX_SPECKS: number
export const INTERIOR_SPECKLE_WARN_PCT: number
export const WHITE_HEX: string

export function checkSpriteImage(
  png: SpritePng,
  spec: SpriteCheckSpec,
  palette: string[],
  paletteName?: string,
): SpriteCheckResult
