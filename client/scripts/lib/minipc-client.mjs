// minipc-client — API заданий и ревизий minipc (MINIPC-231, письмо 4123) для скриптов
// координатора конвейера спрайтов (ITGAME-157, ITGAME-182): qa:sprite и sprite:take. Роль
// токена — itgame-cli (чтение, вердикты); токен Go-сервера (itgame-go) сюда не годится —
// он только читает. Адрес и токен — из окружения, а без него — из файлов владельца
// (решение 20.10, ITGAME-182): ITGAME_MINIPC_CLI_TOKEN — из ~/.config/itgame-dev/minipc-cli.env,
// ITGAME_MINIPC_URL — из ~/.config/itgame-dev/env, и оттуда ТОЛЬКО адрес: токен itgame-go
// в том же файле — серверный, координатору он не нужен. Значения не печатаются нигде.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

// Файлы владельца; пути переопределяются для тестов (ITGAME_MINIPC_CLI_ENV_FILE,
// ITGAME_DEV_ENV_FILE). ~/.config/itgame-dev/env — EnvironmentFile стенда :15555.
export function envFiles(env = process.env) {
  return {
    cli: env.ITGAME_MINIPC_CLI_ENV_FILE || join(homedir(), '.config', 'itgame-dev', 'minipc-cli.env'),
    dev: env.ITGAME_DEV_ENV_FILE || join(homedir(), '.config', 'itgame-dev', 'env'),
  }
}

/**
 * KEY=VALUE построчно, как EnvironmentFile systemd и `. file` в shell: пустые строки и
 * строки с # пропускаются, `export ` впереди допустим, значение в "…" или '…' — без
 * кавычек. Возвращает Map; строки не того вида — в bad (номера строк, без содержимого).
 * @param {string} text
 */
export function parseEnvText(text) {
  const vars = new Map()
  const bad = []
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!m) return void bad.push(i + 1)
    let v = m[2].trim()
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) v = v.slice(1, -1)
    vars.set(m[1], v)
  })
  return { vars, bad }
}

/**
 * Одна переменная из файла владельца. Нет файла, нет переменной или она пустая —
 * исключение с именем файла и переменной (значение в текст ошибки не попадает).
 * @param {string} file
 * @param {string} name
 */
export function envFromFile(file, name) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (e) {
    const why = e?.code === 'ENOENT' ? 'нет файла' : `файл не читается (${e?.code ?? e?.message ?? e})`
    throw new Error(`${name} не задан в окружении, а ${why} ${file} — см. docs/development.md, «Sprite pipeline (minipc)»`)
  }
  const { vars, bad } = parseEnvText(text)
  const v = vars.get(name)
  if (!v) {
    const hint = bad.length ? `; строки не вида KEY=VALUE: ${bad.join(', ')}` : ''
    throw new Error(`${name} не задан в окружении и ${vars.has(name) ? 'пуст' : 'не найден'} в ${file}${hint} — см. docs/development.md, «Sprite pipeline (minipc)»`)
  }
  return v
}

/**
 * Адрес (…/api/itgame) и токен координатора (роль itgame-cli). Окружение главнее
 * файлов; from — откуда взято каждое ('env' или путь файла), для сообщений без значений.
 * Нет ни там, ни там — исключение с именами переменной и файла.
 */
export function minipcFromEnv(env = process.env) {
  const files = envFiles(env)
  const url = env.ITGAME_MINIPC_URL || envFromFile(files.dev, 'ITGAME_MINIPC_URL')
  const token = env.ITGAME_MINIPC_CLI_TOKEN || envFromFile(files.cli, 'ITGAME_MINIPC_CLI_TOKEN')
  if (!/^https?:\/\//.test(url)) throw new Error(`ITGAME_MINIPC_URL — не http(s)-адрес (из ${env.ITGAME_MINIPC_URL ? 'окружения' : files.dev})`)
  return {
    url: url.replace(/\/+$/, ''),
    token,
    from: { url: env.ITGAME_MINIPC_URL ? 'env' : files.dev, token: env.ITGAME_MINIPC_CLI_TOKEN ? 'env' : files.cli },
  }
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

// Отказ minipc — машинный JSON {error, field?, detail?} (403 роли несёт detail). Не JSON
// приходит только от самого фреймворка minipc: 404 HTML — такой ручки нет (путь вне
// маршрутов: адрес без /api/itgame, нечисловой taskId или rev), это не «нет задания».
export async function errorText(resp) {
  const text = await resp.text().catch(() => '')
  let b = null
  try {
    b = JSON.parse(text)
  } catch {
    // ниже
  }
  if (b && typeof b === 'object' && typeof b.error === 'string') {
    return `${b.error}${b.field ? ` (${b.field})` : ''}${b.detail ? ` — ${b.detail}` : ''}`
  }
  if (b !== null) return JSON.stringify(b).slice(0, 300)
  if (resp.status === 404) return 'нет такой ручки (ответ не JSON) — проверьте ITGAME_MINIPC_URL (…/api/itgame)'
  return `HTTP ${resp.status} (ответ не JSON)`
}

export async function getJob(mp, taskId) {
  const resp = await call(mp, 'GET', `/jobs/${encodeURIComponent(taskId)}`)
  if (!resp.ok) throw new Error(`задание ${taskId}: ${resp.status} ${await errorText(resp)}`)
  return resp.json()
}

/**
 * Ключи задания. Настоящий minipc (сверено 20.10, ITGAME-182): GET /jobs/{taskId} —
 * {taskId, about, profile, class, created_at, items: [{key, brief, ctx, status, status_at,
 * revisions (число), latest: {rev, sha256} | null, final: {rev, sha256} | null}]}. keys[] и
 * context вместо ctx — догадка заглушки ITGAME-157, принимаются по-прежнему.
 */
export function jobItems(job) {
  const list = Array.isArray(job?.items) ? job.items : Array.isArray(job?.keys) ? job.keys : []
  return list
    .map((x) => (typeof x === 'string' ? { key: x } : x))
    .filter((x) => typeof x?.key === 'string')
    .map((x) => ({
      key: x.key,
      status: x.status ?? null,
      latest: x.latest ?? null,
      final: x.final ?? null,
      revisions: Number.isInteger(x.revisions) ? x.revisions : null,
      statusAt: x.status_at ?? null,
      ctx: x.ctx ?? x.context ?? null,
    }))
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

/**
 * Каталог ревизий ключа: [{rev, sha256, origin, size, created_at}], новые сверху. minipc
 * отдаёт его обёрнутым — {taskId, key, items: […]} (сверено 20.10); голый массив — форма
 * заглушки ITGAME-157, принимается. Другое — исключение: молча пустой каталог потерял бы
 * origin в происхождении забора.
 */
export async function getRevisions(mp, taskId, key) {
  const resp = await call(mp, 'GET', `/jobs/${encodeURIComponent(taskId)}/keys/${encodeURIComponent(key)}/revisions`)
  if (!resp.ok) throw new Error(`ревизии ${key}: ${resp.status} ${await errorText(resp)}`)
  const body = await resp.json()
  const list = Array.isArray(body) ? body : Array.isArray(body?.items) ? body.items : null
  if (!list) throw new Error(`ревизии ${key}: каталог не той формы — ждали {items: [...]}`)
  return list
}

// reason вердикта minipc ограничивает 1000 БАЙТ UTF-8 (сверено 20.10): русская причина
// в 900 знаков — до 1800 байт и 422, вердикт бы не ушёл.
export const REASON_MAX_BYTES = 1000
const COMMIT_RE = /^[0-9a-f]{7,40}$/

/** Строка не длиннее max байт UTF-8, без разрыва символа; обрезанная кончается «…». */
export function clipUtf8(s, max = REASON_MAX_BYTES) {
  if (Buffer.byteLength(s) <= max) return s
  let out = ''
  let n = Buffer.byteLength('…')
  for (const ch of s) {
    const b = Buffer.byteLength(ch)
    if (n + b > max) break
    out += ch
    n += b
  }
  return out + '…'
}

/**
 * Вердикт ключа: {status: returned|accepted|committed, reason, cropPng?} → {ok, status, error?}.
 * committed уходит только с хешем коммита в reason: minipc принимает любой непустой reason
 * (сверено 20.10, ITGAME-182), а committed терминален — ошибку потом не исправить.
 */
export async function postStatus(mp, taskId, key, body) {
  if (body?.status === 'committed' && !COMMIT_RE.test(body.reason ?? '')) {
    return { ok: false, status: 0, error: 'committed — reason должен быть хешем коммита (7–40 hex); minipc его не проверяет, а committed не отзывается — не отправлено' }
  }
  const resp = await call(mp, 'POST', `/jobs/${encodeURIComponent(taskId)}/keys/${encodeURIComponent(key)}/status`, body)
  return resp.ok ? { ok: true, status: resp.status } : { ok: false, status: resp.status, error: await errorText(resp) }
}
