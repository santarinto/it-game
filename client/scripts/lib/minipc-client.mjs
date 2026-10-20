// minipc-client — API заданий и ревизий minipc (MINIPC-231, письмо 4123) для скриптов
// координатора конвейера спрайтов (ITGAME-157): qa:sprite и sprite:take. Роль токена —
// itgame-cli (чтение, вердикты); токен Go-сервера (itgame-go) сюда не годится — он
// только читает. Адрес и токен — из окружения, в репо и трекер не пишутся.
import { createHash } from 'node:crypto'

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

/** ITGAME_MINIPC_URL (…/api/itgame) и ITGAME_MINIPC_CLI_TOKEN; нет — исключение с именами переменных. */
export function minipcFromEnv() {
  const url = process.env.ITGAME_MINIPC_URL
  const token = process.env.ITGAME_MINIPC_CLI_TOKEN
  if (!url || !token) {
    throw new Error('нужны ITGAME_MINIPC_URL (…/api/itgame) и ITGAME_MINIPC_CLI_TOKEN (роль itgame-cli) — см. docs/development.md, «Sprite pipeline»')
  }
  return { url: url.replace(/\/+$/, ''), token }
}

async function call(mp, method, path, body) {
  const headers = { authorization: `Bearer ${mp.token}` }
  if (body !== undefined) headers['content-type'] = 'application/json'
  let resp
  try {
    resp = await fetch(mp.url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  } catch (e) {
    throw new Error(`minipc не ответил (${method} ${path}): ${e?.cause?.message ?? e?.message ?? e}`)
  }
  return resp
}

async function errorText(resp) {
  try {
    const b = await resp.json()
    return b.error ? `${b.error}${b.field ? ` (${b.field})` : ''}` : JSON.stringify(b)
  } catch {
    return `HTTP ${resp.status}`
  }
}

export async function getJob(mp, taskId) {
  const resp = await call(mp, 'GET', `/jobs/${encodeURIComponent(taskId)}`)
  if (!resp.ok) throw new Error(`задание ${taskId}: ${resp.status} ${await errorText(resp)}`)
  return resp.json()
}

/**
 * Ключи задания: items[] (заглушка) или keys[]; элемент — {key, status, latest, final}.
 * Форму GET /jobs/{taskId} письмо 4123 не приводит — сверить на шаге 5 (ITGAME-182).
 */
export function jobItems(job) {
  const list = Array.isArray(job?.items) ? job.items : Array.isArray(job?.keys) ? job.keys : []
  return list
    .map((x) => (typeof x === 'string' ? { key: x } : x))
    .filter((x) => typeof x?.key === 'string')
    .map((x) => ({ key: x.key, status: x.status ?? null, latest: x.latest ?? null, final: x.final ?? null }))
}

/** PNG ревизии; sha256 байт сверяется с X-Sprite-Sha256 — расхождение исключением. */
export async function getRevision(mp, taskId, key, rev) {
  const resp = await call(mp, 'GET', `/jobs/${encodeURIComponent(taskId)}/keys/${encodeURIComponent(key)}/revisions/${rev}`)
  if (!resp.ok) throw new Error(`ревизия ${key}#${rev}: ${resp.status} ${await errorText(resp)}`)
  const bytes = Buffer.from(await resp.arrayBuffer())
  const claimed = (resp.headers.get('x-sprite-sha256') ?? '').toLowerCase()
  const got = sha256(bytes)
  if (got !== claimed) throw new Error(`ревизия ${key}#${rev}: sha256 байт ${got}, minipc заявил ${claimed || '(нет заголовка)'}`)
  return { bytes, sha256: got, rev: Number(resp.headers.get('x-sprite-rev') ?? rev) }
}

/** Каталог ревизий ключа: [{rev, sha256, origin, size}], новые сверху. */
export async function getRevisions(mp, taskId, key) {
  const resp = await call(mp, 'GET', `/jobs/${encodeURIComponent(taskId)}/keys/${encodeURIComponent(key)}/revisions`)
  if (!resp.ok) throw new Error(`ревизии ${key}: ${resp.status} ${await errorText(resp)}`)
  return resp.json()
}

/** Вердикт ключа: {status: returned|accepted|committed, reason, cropPng?} → {ok, status, error?}. */
export async function postStatus(mp, taskId, key, body) {
  const resp = await call(mp, 'POST', `/jobs/${encodeURIComponent(taskId)}/keys/${encodeURIComponent(key)}/status`, body)
  return resp.ok ? { ok: true, status: resp.status } : { ok: false, status: resp.status, error: await errorText(resp) }
}
