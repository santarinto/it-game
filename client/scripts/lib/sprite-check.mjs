// sprite-check — контракт спрайта для Node-скриптов: чистая проверка живёт в
// sprite-check-core.mjs (её же импортирует клиент, ITGAME-119), здесь — чтение
// манифеста с диска. Поведение 1:1 с прежним: числа и формулировки не менялись.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export {
  DEFAULT_MAX_SPECKS,
  DEFAULT_MAX_WHITE_PCT,
  INTERIOR_SPECKLE_WARN_PCT,
  MIN_TRANSPARENT_PCT,
  WHITE_HEX,
  checkSpriteImage,
} from './sprite-check-core.mjs'

/**
 * Читает client/src/assets/sprites.json. clientDir — корень client/ (dirname дважды от scripts/lib).
 */
export function loadManifest(clientDir) {
  const path = join(clientDir, 'src', 'assets', 'sprites.json')
  return JSON.parse(readFileSync(path, 'utf8'))
}
