import type Phaser from 'phaser'
import { checkSpriteImage } from '../../scripts/lib/sprite-check-core.mjs'
import type { SpriteCheckResult } from '../../scripts/lib/sprite-check-core.mjs'
import { PALETTES, SPRITES } from '../assets/manifest'

// itd.sprite (ITGAME-119): подмена текстуры по ключу манифеста во вкладке — примерка
// спрайта на сцене без коммита и пересборки (docs/design/sprite-pipeline.md). Подмена
// живёт в памяти вкладки: в репо, dist, сейв и хранилища ничего не пишется,
// перезагрузка её снимает. Контракт считает тот же код, что npm run check:sprites.

type Source = HTMLImageElement | HTMLCanvasElement

export interface SpriteReceipt {
  ok: boolean
  key?: string
  w?: number
  h?: number
  sha256?: string | null // null — страница не в secure context, crypto.subtle нет
  objects?: number // живых объектов сцен перевешено на новую текстуру
  problems?: string[] // нарушения контракта; текстура при этом СТОИТ
  warnings?: string[]
  stats?: SpriteCheckResult['stats']
  code?: 'unknown_key' | 'bad_src' | 'bad_size'
  error?: string
}

export interface SpriteTried {
  key: string
  w: number
  h: number
  sha256: string | null
  problems: string[]
}

export interface SpriteResetResult {
  ok: boolean
  reset: string[]
  code?: 'not_tried'
  error?: string
}

export interface SpriteApi {
  try(key: string, src: string): Promise<SpriteReceipt>
  reset(key?: string): SpriteResetResult
  list(): SpriteTried[]
}

const PNG_DATA_URL = /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/

// Исходные источники подменённых ключей — то, что вернёт reset(); и то, что стоит сейчас.
const originals = new Map<string, Source>()
const tried = new Map<string, SpriteTried>()

// Ключи, подменённые через itd.sprite.try, — для пометки в itd.assets().
export function triedKeys(): ReadonlySet<string> {
  return new Set(tried.keys())
}

function decode(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = src
  })
}

async function sha256Of(dataUrl: string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return null
  const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1))
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  const hash = await subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

interface Textured {
  texture: { key: string }
  frame: { name: string | number }
  setTexture(key: string, frame?: string | number): unknown
}

function isTextured(o: unknown): o is Textured {
  const t = o as Partial<Textured> | null
  return !!t && typeof t.setTexture === 'function' && typeof t.texture?.key === 'string'
}

// Живые объекты всех сцен (спящих тоже), нарисованные ключом; контейнеры — вглубь.
function usersOf(game: Phaser.Game, key: string): { obj: Textured; frame: string | number }[] {
  const out: { obj: Textured; frame: string | number }[] = []
  const walk = (list: unknown[]) => {
    for (const o of list) {
      if (isTextured(o) && o.texture.key === key) out.push({ obj: o, frame: o.frame.name })
      const nested = (o as { list?: unknown }).list
      if (Array.isArray(nested)) walk(nested)
    }
  }
  for (const scene of game.scene.getScenes(false)) walk(scene.children.list)
  return out
}

// Заменить источник ключа. Занятый ключ add* не перезаписывает (инцидент ITGAME-11),
// поэтому remove → add; объекты держат кадр снятой текстуры, их перевешиваем в том
// же тике, до следующего кадра рендера.
function swap(game: Phaser.Game, key: string, source: Source): number {
  const spec = SPRITES[key]
  const users = usersOf(game, key)
  game.textures.remove(key)
  if (spec.frames > 1) {
    game.textures.addSpriteSheet(key, source as HTMLImageElement, {
      frameWidth: spec.size, frameHeight: spec.size,
    })
  } else if (source instanceof HTMLCanvasElement) {
    game.textures.addCanvas(key, source)
  } else {
    game.textures.addImage(key, source)
  }
  for (const { obj, frame } of users) obj.setTexture(key, frame)
  return users.length
}

export function makeSpriteApi(game: Phaser.Game): SpriteApi {
  return {
    async try(key, src) {
      const spec = SPRITES[key]
      if (!spec) {
        return { ok: false, code: 'unknown_key', error: `ключа '${key}' нет в манифесте sprites.json` }
      }
      if (typeof src !== 'string' || !PNG_DATA_URL.test(src)) {
        return { ok: false, code: 'bad_src', error: 'src — data URL вида data:image/png;base64,…' }
      }
      const img = await decode(src)
      if (!img) return { ok: false, code: 'bad_src', error: 'PNG не декодируется' }

      const w = img.width
      const h = img.height
      const wantW = spec.size * spec.frames
      if (w !== wantW || h !== spec.size) {
        return {
          ok: false, code: 'bad_size', key, w, h,
          error: `размер ${w}×${h}, контракт ключа — ${wantW}×${spec.size}`,
        }
      }

      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) return { ok: false, code: 'bad_src', error: 'нет 2d-контекста для разбора PNG' }
      ctx.drawImage(img, 0, 0)
      const data = ctx.getImageData(0, 0, w, h).data
      const res = checkSpriteImage({ width: w, height: h, data }, spec, PALETTES[spec.palette], spec.palette)
      const sha256 = await sha256Of(src)

      if (!game.textures.exists(key)) {
        return { ok: false, code: 'unknown_key', error: `текстуры '${key}' нет в игре — boot не закончен?` }
      }
      // Исходник запоминаем один раз: второй try того же ключа его не перетирает.
      if (!originals.has(key)) originals.set(key, game.textures.get(key).getSourceImage() as Source)
      const objects = swap(game, key, img)
      tried.set(key, { key, w, h, sha256, problems: res.problems })
      return { ok: true, key, w, h, sha256, objects, problems: res.problems, warnings: res.warnings, stats: res.stats }
    },

    reset(key) {
      if (key !== undefined && !originals.has(key)) {
        return { ok: false, reset: [], code: 'not_tried', error: `ключ '${key}' не подменён — см. itd.sprite.list()` }
      }
      const keys = key !== undefined ? [key] : [...originals.keys()]
      for (const k of keys) {
        swap(game, k, originals.get(k) as Source)
        originals.delete(k)
        tried.delete(k)
      }
      return { ok: true, reset: keys }
    },

    list: () => [...tried.values()].sort((a, b) => a.key.localeCompare(b.key)),
  }
}
