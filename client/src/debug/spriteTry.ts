import type Phaser from 'phaser'
import { checkSpriteImage } from '../../scripts/lib/sprite-check-core.mjs'
import type { SpriteCheckResult } from '../../scripts/lib/sprite-check-core.mjs'
import { PALETTES, SPRITES } from '../assets/manifest'

// itd.sprite (ITGAME-119): подмена текстуры по ключу манифеста во вкладке — примерка
// спрайта на сцене без коммита и пересборки (docs/design/sprite-pipeline.md). Подмена
// живёт в памяти вкладки: в репо, dist, сейв и хранилища ничего не пишется,
// перезагрузка её снимает. Контракт считает тот же код, что npm run check:sprites.

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

// Исходная текстура подменённого ключа не уничтожается, а прячется под служебным
// ключом (renameTexture): remove() кодоген-текстуры отдал бы её canvas в CanvasPool,
// и первый же add.text забрал бы его себе — reset вернул бы чужие пиксели (ревью
// ITGAME-119). Texture-объект оригинала, его кадры и GL-текстура живут до reset.
const ORIG_PREFIX = '__itd_orig:'
const tried = new Map<string, SpriteTried>()

// Служебный ключ спрятанного оригинала — itd.assets() его не аудирует.
export function isHiddenOriginal(key: string): boolean {
  return key.startsWith(ORIG_PREFIX)
}

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
  displayWidth: number
  displayHeight: number
  setTexture(key: string, frame?: string | number): unknown
  setDisplaySize?(w: number, h: number): unknown
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

// Поставить под key новую текстуру из source (или, без source, вернуть спрятанный
// оригинал). Занятый ключ add* не перезаписывает (инцидент ITGAME-11): текущую
// текстуру ключа сначала прячем (первый try) или снимаем (проба поверх пробы, reset).
// Объекты перевешиваем в том же тике, до кадра рендера, и сохраняем им экранный
// размер: кодоген-плейсхолдер 16px растянут до слота, PNG того же слота — 128px.
function swap(game: Phaser.Game, key: string, source: HTMLImageElement | null): number {
  const spec = SPRITES[key]
  const users = usersOf(game, key).map((u) => ({ ...u, w: u.obj.displayWidth, h: u.obj.displayHeight }))
  const hidden = ORIG_PREFIX + key
  if (source === null) {
    game.textures.remove(key)
    game.textures.renameTexture(hidden, key)
  } else {
    if (game.textures.exists(hidden)) game.textures.remove(key)
    else game.textures.renameTexture(key, hidden)
    if (spec.frames > 1) {
      game.textures.addSpriteSheet(key, source, { frameWidth: spec.size, frameHeight: spec.size })
    } else {
      game.textures.addImage(key, source)
    }
  }
  for (const { obj, frame, w, h } of users) {
    obj.setTexture(key, frame)
    obj.setDisplaySize?.(w, h)
  }
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
      // Оригинал прячется один раз: второй try того же ключа снимает только пробу.
      const objects = swap(game, key, img)
      tried.set(key, { key, w, h, sha256, problems: res.problems })
      return { ok: true, key, w, h, sha256, objects, problems: res.problems, warnings: res.warnings, stats: res.stats }
    },

    reset(key) {
      if (key !== undefined && !tried.has(key)) {
        return { ok: false, reset: [], code: 'not_tried', error: `ключ '${key}' не подменён — см. itd.sprite.list()` }
      }
      const keys = key !== undefined ? [key] : [...tried.keys()]
      for (const k of keys) {
        swap(game, k, null)
        tried.delete(k)
      }
      return { ok: true, reset: keys }
    },

    list: () => [...tried.values()].sort((a, b) => a.key.localeCompare(b.key)),
  }
}
