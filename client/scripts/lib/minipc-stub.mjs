// minipc-stub — заглушка API заданий и ревизий minipc (MINIPC-231, письмо 4123) для
// конвейера спрайтов (ITGAME-157, docs/design/sprite-pipeline.md): Go-ручки
// /api/debug/sprite/*, itd.sprite.pull/watch, qa:sprite и sprite:take гоняются против
// неё без настоящего minipc. Повторяет ручки, роли токенов, статусную машину и формы
// ответов настоящего minipc; хранит всё в памяти процесса.
//
// Формы сверены с настоящим minipc 20.10 (ITGAME-182; отказы и порядок проверок — по
// живым ответам и исходнику minipc):
//   GET  /jobs            → {items: [{taskId, about, created_at, keys: <число ключей>}]}
//   POST /jobs            → 201, задание как в GET /jobs/{taskId}; ошибка тела — 422 {error, field}
//   GET  /jobs/{taskId}   → {taskId, about, profile, class, created_at,
//                            items: [{key, brief, ctx: {text, bg}, status, status_at,
//                                     revisions: <число>, latest: {rev, sha256} | null, final: … | null}]}
//                            (в POST контекст — context {text, bg, cropPng}; кроп в ответ не попадает)
//   GET  …/keys/{key}/revisions        → {taskId, key, items: [{rev, sha256, origin, size, created_at}]}, новые сверху;
//                                        ревизий нет — 404, а не пустой список
//   GET  …/revisions/{rev}, …/latest   → PNG, ETag "sha256", X-Sprite-Rev/X-Sprite-Sha256, If-None-Match → 304
//   POST …/revisions      → 201 {taskId, key, rev, sha256, origin}; origin {kind: edited, from: N | null}
//                            (по умолчанию) или {kind: generated, seed, prompt}
//   POST …/final {rev}    → {key, status, final_rev}
//   POST …/status         → {key, status}
// Отказы — JSON {error, field?}; 401 {error: unauthorized}; 403 {error: forbidden, detail};
// путь вне маршрутов (нечисловой taskId или rev, чужой префикс) — HTML-страница 404.
// Новая ревизия возвращает ключ в draft, но указатель final не сбрасывает. committed
// требует непустой reason — хеш коммита minipc не проверяет, это забота sprite:take.
//
// Как модуль: const stub = await startMinipcStub(); stub.url — база …/api/itgame.
// Как процесс: node scripts/lib/minipc-stub.mjs [--port 4199] — печатает адрес и токены.
import { createHash } from 'node:crypto'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

export const STUB_TOKENS = { cli: 'stub-itgame-cli', go: 'stub-itgame-go' }

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const MAX_PNG = 2 * 1024 * 1024
const KEY_RE = /^[a-z0-9][a-z0-9_-]*$/
const HTML_404 = '<!DOCTYPE html>\n<html lang="en"><head><meta charset="UTF-8" /><title>An Error Occurred: Not Found</title></head><body><h2>The server returned a "404 Not Found".</h2></body></html>\n'

/** Отказ minipc из программных помощников: status и машинное тело. */
export class StubRefusal extends Error {
  constructor(status, body) {
    super(`${status} ${body.error}${body.field ? ` (${body.field})` : ''}`)
    this.status = status
    this.body = body
  }
}
const refuse = (status, error, field) => new StubRefusal(status, field ? { error, field } : { error })
const isPng = (buf) => buf.length >= PNG_SIG.length && buf.subarray(0, PNG_SIG.length).equals(PNG_SIG)

/**
 * Тело POST /jobs, которое настоящий minipc примет: профиль и класс по умолчанию,
 * items — ключи (строки) или объекты {key, brief?, context?}.
 * @param {(string | {key: string, brief?: string, context?: object})[]} items
 * @param {object} [over] — поля поверх (about, profile, class)
 */
export function jobBody(items, over = {}) {
  const text = over.profile?.text ?? 'профиль заглушки'
  return {
    about: 'ITGAME-157',
    profile: { version: 'stub', sha256: sha256(text), text },
    class: { name: 'icon', screenPx: 32, sourcePx: 64, palette: 'sweetie16', colors: ['1a1c2c', 'f4f4f4'] },
    ...over,
    items: items.map((it) => (typeof it === 'string' ? { key: it, brief: `ключ ${it}` } : { brief: `ключ ${it.key}`, ...it })),
  }
}

function str(obj, name, max, re, field = name) {
  const v = obj?.[name]
  if (typeof v !== 'string' || !re.test(v) || Buffer.byteLength(v) > max) throw refuse(422, `${name} is required: ${re} up to ${max} bytes`, field)
  return v
}
function int(obj, name, lo, hi, field) {
  const v = obj?.[name]
  if (!Number.isInteger(v) || v < lo || v > hi) throw refuse(422, `${name} must be an integer ${lo}..${hi}`, field)
  return v
}
function obj(o, name) {
  const v = o?.[name]
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw refuse(422, `${name} is required`, name)
  return v
}
function cropOf(b64, field, message) {
  if (typeof b64 !== 'string' || b64 === '') throw refuse(422, 'cropPng must be a non-empty base64 string', field)
  // base64_decode(…, true) minipc: только алфавит base64 и паддинг.
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw refuse(422, message, field)
  const bytes = Buffer.from(b64, 'base64')
  if (bytes.length > MAX_PNG || !isPng(bytes)) throw refuse(422, message, field)
  return bytes
}

/** Проверка тела задания как у CreateItgameJob minipc (подмножество, без лимитов БД). */
function validateJob(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw refuse(400, 'a JSON object body is required')
  const about = str(body, 'about', 32, /^[A-Za-z0-9][A-Za-z0-9.-]*$/)
  const profile = obj(body, 'profile')
  str(profile, 'version', 64, /^\S/, 'profile.version')
  str(profile, 'sha256', 64, /^[0-9a-f]{64}$/, 'profile.sha256')
  if (typeof profile.text !== 'string' || !profile.text.trim()) throw refuse(422, 'profile.text is required', 'profile.text')
  const cls = obj(body, 'class')
  str(cls, 'name', 64, KEY_RE, 'class.name')
  int(cls, 'screenPx', 1, 512, 'class.screenPx')
  int(cls, 'sourcePx', 8, 1024, 'class.sourcePx')
  str(cls, 'palette', 64, KEY_RE, 'class.palette')
  const colors = cls.colors
  if (!Array.isArray(colors) || colors.length === 0 || colors.length > 64) throw refuse(422, '1..64 colors are required', 'class.colors')
  for (const c of colors) if (typeof c !== 'string' || !/^[0-9a-fA-F]{6}$/.test(c)) throw refuse(422, `color '${c}' is not 6 hex digits without '#'`, 'class.colors')
  const items = body.items
  if (!Array.isArray(items) || items.length === 0) throw refuse(422, 'at least one item is required', 'items')
  if (items.length > 200) throw refuse(422, 'more than 200 items', 'items')
  const seen = new Set()
  const out = items.map((it, i) => {
    if (!it || typeof it !== 'object') throw refuse(422, 'an item must be an object', `items.${i}`)
    const key = str(it, 'key', 64, KEY_RE, `items.${i}.key`)
    if (seen.has(key)) throw refuse(422, `key '${key}' repeats in the job`, `items.${i}.key`)
    seen.add(key)
    const brief = str(it, 'brief', 500, /^\S/, `items.${i}.brief`)
    const ctx = it.context ?? null
    if (ctx !== null && (typeof ctx !== 'object' || Array.isArray(ctx))) throw refuse(422, 'context must be an object', `items.${i}.context`)
    const text = ctx?.text ?? null
    if (text !== null) str(ctx, 'text', 64, /^\S/s, `items.${i}.context.text`)
    const bg = ctx?.bg ?? null
    if (bg !== null) str(ctx, 'bg', 6, /^[0-9a-fA-F]{6}$/, `items.${i}.context.bg`)
    const crop = ctx?.cropPng ? cropOf(ctx.cropPng, `items.${i}.context.cropPng`, 'not decodable base64 or larger than 2 MiB') : null
    return { key, brief, ctx: { text, bg: bg?.toLowerCase() ?? null }, crop }
  })
  return { about, profile: { version: profile.version, sha256: profile.sha256, text: profile.text }, class: { ...cls, colors: colors.map((c) => c.toLowerCase()) }, items: out }
}

/**
 * @param {{ port?: number, tokens?: { cli: string, go: string } }} [opts]
 */
export async function startMinipcStub(opts = {}) {
  const tokens = opts.tokens ?? STUB_TOKENS
  /** @type {Map<string, any>} */
  const jobs = new Map()
  let nextTask = 1
  const statusLog = [] // журнал вердиктов — для проверок прогона
  const now = () => new Date().toISOString().replace(/\.\d+Z$/, '+00:00')

  function job(taskId) {
    const j = jobs.get(String(taskId))
    if (!j) throw refuse(404, `task ${taskId} not found`)
    return j
  }
  function item(taskId, key) {
    const it = job(taskId).items.find((x) => x.key === key)
    if (!it) throw refuse(404, `key '${key}' not found in the job`)
    return it
  }
  function revision(it, rev) {
    const r = it.revs.find((x) => x.rev === rev)
    if (!r) throw refuse(404, `revision ${rev} of '${it.key}' not found`)
    return r
  }
  const pointer = (r) => (r ? { rev: r.rev, sha256: r.sha256 } : null)
  const move = (it, status) => {
    it.status = status
    it.statusAt = now()
  }
  function publicJob(j) {
    return {
      taskId: j.taskId,
      about: j.about,
      profile: j.profile,
      class: j.class,
      created_at: j.createdAt,
      items: j.items.map((it) => ({
        key: it.key,
        brief: it.brief,
        ctx: it.ctx,
        status: it.status,
        status_at: it.statusAt,
        revisions: it.revs.length,
        latest: pointer(it.revs.at(-1)),
        final: it.final ? pointer(it.revs.find((r) => r.rev === it.final)) : null,
      })),
    }
  }

  // Программные помощники для тестов — то же, что ручки, без HTTP. createJob при отказе
  // бросает StubRefusal; остальные возвращают {status, body}, как ответил бы minipc.
  const wrap = (fn) => (...a) => {
    try {
      return fn(...a)
    } catch (e) {
      if (e instanceof StubRefusal) return { status: e.status, body: e.body }
      throw e
    }
  }
  const api = {
    createJob(body) {
      const v = validateJob(body)
      const taskId = String(nextTask++)
      const at = now()
      const j = {
        taskId,
        about: v.about,
        profile: v.profile,
        class: v.class,
        createdAt: at,
        items: v.items.map((it) => ({ key: it.key, brief: it.brief, ctx: it.ctx, hasCrop: !!it.crop, status: 'open', statusAt: at, revs: [], final: null })),
      }
      jobs.set(taskId, j)
      return publicJob(j)
    },
    addRevision: wrap((taskId, key, png, origin = { kind: 'edited', from: null }) => {
      if (!png?.length || png.length > MAX_PNG) throw refuse(422, 'a non-empty PNG of at most 2 MiB is required', 'png')
      if (!isPng(png)) throw refuse(422, 'the body is not a PNG', 'png')
      const it = item(taskId, key)
      if (it.status === 'committed') throw refuse(409, `key '${key}' is committed, a rework is a new job`)
      let o
      if (origin.kind === 'generated') {
        if (!Number.isInteger(origin.seed) || origin.seed < 0 || typeof origin.prompt !== 'string' || !origin.prompt || Buffer.byteLength(origin.prompt) > 2000) {
          throw refuse(422, 'generated needs seed (int >= 0) and prompt (1..2000 bytes)', 'origin')
        }
        o = { kind: 'generated', seed: origin.seed, prompt: origin.prompt }
      } else if (origin.kind === 'edited' || origin.kind === undefined) {
        const from = origin.from ?? null
        if (from !== null && !it.revs.some((r) => r.rev === from)) throw refuse(422, `from: revision ${from} does not exist`, 'origin')
        o = { kind: 'edited', from }
      } else {
        throw refuse(422, `origin.kind must be generated|edited, got '${origin.kind}'`, 'origin')
      }
      const rev = it.revs.length + 1
      const sha = sha256(png)
      it.revs.push({ rev, sha256: sha, origin: o, size: png.length, createdAt: now(), png })
      // open → draft; final/returned/accepted → draft. Указатель final остаётся (minipc его не сбрасывает).
      if (it.status !== 'draft') move(it, 'draft')
      return { status: 201, body: { taskId: String(taskId), key, rev, sha256: sha, origin: o } }
    }),
    setFinal: wrap((taskId, key, rev) => {
      if (!Number.isInteger(rev) || rev < 1) throw refuse(422, 'a JSON body {rev: <int>} is required')
      const it = item(taskId, key)
      if (it.status === 'open') throw refuse(409, `key '${key}' has no revisions to pick from`)
      if (it.status === 'committed') throw refuse(409, `key '${key}' is committed, a rework is a new job`)
      if (it.status !== 'draft' && it.status !== 'final') throw refuse(409, `key '${key}' is '${it.status}': save a new revision first, it returns the key to draft`)
      revision(it, rev)
      it.final = rev
      move(it, 'final')
      return { status: 200, body: { key, status: it.status, final_rev: rev } }
    }),
    setStatus: wrap((taskId, key, body) => {
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw refuse(400, 'a JSON object body is required')
      const to = typeof body.status === 'string' ? body.status : ''
      const need = { returned: 'a reason is required', accepted: null, committed: 'the repo commit hash is required' }
      if (!(to in need)) throw refuse(422, `status must be one of returned|accepted|committed, got '${to}'`, 'status')
      const reason = (typeof body.reason === 'string' ? body.reason : '').trim()
      if (need[to] && !reason) throw refuse(422, need[to], 'reason')
      if (Buffer.byteLength(reason) > 1000) throw refuse(422, 'longer than 1000 bytes', 'reason')
      const it = item(taskId, key)
      const from = it.status
      if (from === 'committed') throw refuse(409, `key '${key}' is committed, a rework is a new job`)
      if (it.final === null && from !== 'draft') throw refuse(409, `key '${key}' has no final revision to act on`)
      const moves = { final: ['returned', 'accepted'], accepted: ['committed'] }
      if (!(moves[from] ?? []).includes(to)) throw refuse(409, `coordinator cannot move '${from}' to '${to}' (allowed from '${from}': ${(moves[from] ?? ['nothing from here']).join(', ')})`)
      const hasCrop = body.cropPng !== undefined && body.cropPng !== null
      if (hasCrop) {
        if (to !== 'returned') throw refuse(422, 'a crop can only be attached to a returned verdict', 'cropPng')
        cropOf(body.cropPng, 'cropPng', 'not decodable base64 PNG of at most 2 MiB')
      }
      move(it, to)
      statusLog.push({ taskId: String(taskId), key, status: to, reason: reason || null, cropPng: hasCrop, rev: it.final })
      return { status: 200, body: { key, status: to } }
    }),
    job: (taskId) => (jobs.has(String(taskId)) ? publicJob(jobs.get(String(taskId))) : null),
    statusLog,
  }

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-cache, private', ...headers })
    res.end(JSON.stringify(body))
  }
  function sendPng(req, res, r) {
    const etag = `"${r.sha256}"`
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag, 'cache-control': 'no-cache, private' })
      return res.end()
    }
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-cache, private', etag, 'x-sprite-rev': String(r.rev), 'x-sprite-sha256': r.sha256 })
    res.end(r.png)
  }
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => resolve(Buffer.concat(chunks)))
      req.on('error', reject)
    })
  }
  const jsonOf = (buf) => {
    try {
      return JSON.parse(buf.toString())
    } catch {
      return undefined
    }
  }

  // Маршруты minipc: taskId \d+, key [a-z0-9][a-z0-9_-]*, rev \d+; остальное — HTML 404.
  const ROUTES = [
    [/^\/api\/itgame\/jobs$/, ['GET', 'POST'], 'jobs'],
    [/^\/api\/itgame\/jobs\/(\d+)$/, ['GET'], 'job'],
    [/^\/api\/itgame\/jobs\/(\d+)\/keys\/([a-z0-9][a-z0-9_-]*)\/revisions$/, ['GET', 'POST'], 'revisions'],
    [/^\/api\/itgame\/jobs\/(\d+)\/keys\/([a-z0-9][a-z0-9_-]*)\/revisions\/(\d+)$/, ['GET'], 'revision'],
    [/^\/api\/itgame\/jobs\/(\d+)\/keys\/([a-z0-9][a-z0-9_-]*)\/latest$/, ['GET'], 'latest'],
    [/^\/api\/itgame\/jobs\/(\d+)\/keys\/([a-z0-9][a-z0-9_-]*)\/status$/, ['POST'], 'status'],
    [/^\/api\/itgame\/jobs\/(\d+)\/keys\/([a-z0-9][a-z0-9_-]*)\/final$/, ['POST'], 'final'],
  ]

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://stub')
    let route = null
    let m = null
    for (const r of ROUTES) {
      m = url.pathname.match(r[0])
      if (m) {
        route = r
        break
      }
    }
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/html; charset=UTF-8' })
      return res.end(HTML_404)
    }
    if (!route[1].includes(req.method)) {
      res.writeHead(405, { 'content-type': 'text/html; charset=UTF-8', allow: route[1].join(', ') })
      return res.end(HTML_404.replace('404 Not Found', '405 Method Not Allowed'))
    }
    const auth = req.headers.authorization ?? ''
    const role = auth === `Bearer ${tokens.cli}` ? 'cli' : auth === `Bearer ${tokens.go}` ? 'go' : null
    if (!role) return send(res, 401, { error: 'unauthorized' })
    if (req.method === 'POST' && role !== 'cli') return send(res, 403, { error: 'forbidden', detail: 'the itgame-cli token is required for this handle' })
    const [, taskId, key, rev] = m
    const reply = (r) => send(res, r.status, r.body)
    try {
      switch (`${req.method} ${route[2]}`) {
        case 'GET jobs':
          return send(res, 200, { items: [...jobs.values()].reverse().map((j) => ({ taskId: j.taskId, about: j.about, created_at: j.createdAt, keys: j.items.length })) })
        case 'POST jobs': {
          const body = jsonOf(await readBody(req))
          return send(res, 201, api.createJob(body))
        }
        case 'GET job':
          return send(res, 200, publicJob(job(taskId)))
        case 'GET revisions': {
          const it = item(taskId, key)
          if (!it.revs.length) throw refuse(404, `key '${key}' has no revisions yet`)
          return send(res, 200, { taskId, key, items: [...it.revs].reverse().map((r) => ({ rev: r.rev, sha256: r.sha256, origin: r.origin, size: r.size, created_at: r.createdAt })) })
        }
        case 'GET revision':
          return sendPng(req, res, revision(item(taskId, key), Number(rev)))
        case 'GET latest': {
          const it = item(taskId, key)
          if (!it.revs.length) throw refuse(404, `key '${key}' has no revisions yet`)
          return sendPng(req, res, it.revs.at(-1))
        }
        case 'POST revisions': {
          const h = req.headers
          const origin = { kind: h['x-sprite-origin'] ?? 'edited' }
          if (h['x-sprite-seed'] !== undefined) origin.seed = Number.parseInt(String(h['x-sprite-seed']), 10)
          if (h['x-sprite-prompt'] !== undefined) origin.prompt = String(h['x-sprite-prompt'])
          if (h['x-sprite-from'] !== undefined) origin.from = Number.parseInt(String(h['x-sprite-from']), 10)
          return reply(api.addRevision(taskId, key, await readBody(req), origin))
        }
        case 'POST final': {
          const body = jsonOf(await readBody(req))
          return reply(api.setFinal(taskId, key, body && typeof body === 'object' ? body.rev : undefined))
        }
        case 'POST status':
          return reply(api.setStatus(taskId, key, jsonOf(await readBody(req))))
      }
    } catch (e) {
      if (e instanceof StubRefusal) return send(res, e.status, e.body)
      return send(res, 500, { error: 'stub_failed', detail: e instanceof Error ? e.message : String(e) })
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, '127.0.0.1', resolve)
  })
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address())
  return {
    url: `http://127.0.0.1:${port}/api/itgame`,
    tokens,
    ...api,
    stop: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--port')
  const stub = await startMinipcStub({ port: i > 0 ? Number(process.argv[i + 1]) : 4199 })
  console.log(`minipc-stub: ${stub.url}`)
  console.log(`  ITGAME_MINIPC_URL=${stub.url} ITGAME_MINIPC_TOKEN=${stub.tokens.go} ITGAME_MINIPC_CLI_TOKEN=${stub.tokens.cli}`)
}
