// minipc-stub — заглушка API заданий и ревизий minipc (MINIPC-231, письмо 4123) для
// шага 4 конвейера спрайтов (ITGAME-157, docs/design/sprite-pipeline.md): Go-ручки
// /api/debug/sprite/*, itd.sprite.pull/watch, qa:sprite и sprite:take гоняются против
// неё без настоящего minipc. Повторяет ручки, роли токенов и статусную машину письма;
// хранит всё в памяти процесса.
//
// Форма GET /jobs/{taskId} в письме не приведена — здесь она такая:
//   { taskId: "1", about, profile, class, createdAt,
//     items: [{ key, brief, context, status, latest: {rev, sha256} | null, final: {rev, sha256} | null }] }
// Сверить с настоящим minipc на шаге 5 (ITGAME-182); читатели (spriteTry.ts,
// minipc-client.mjs) принимают и keys[] вместо items[].
//
// Как модуль: const stub = await startMinipcStub(); stub.url — база …/api/itgame.
// Как процесс: node scripts/lib/minipc-stub.mjs [--port 4199] — печатает адрес и токены.
import { createHash } from 'node:crypto'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

export const STUB_TOKENS = { cli: 'stub-itgame-cli', go: 'stub-itgame-go' }

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const COMMIT_RE = /^[0-9a-f]{7,40}$/

/**
 * @param {{ port?: number, tokens?: { cli: string, go: string } }} [opts]
 */
export async function startMinipcStub(opts = {}) {
  const tokens = opts.tokens ?? STUB_TOKENS
  /** @type {Map<string, any>} */
  const jobs = new Map()
  let nextTask = 1
  const statusLog = [] // журнал вердиктов — для проверок прогона

  function job(taskId) {
    return jobs.get(String(taskId))
  }
  function item(j, key) {
    return j?.items.find((it) => it.key === key)
  }
  function pointer(it, rev) {
    const r = it.revs.find((x) => x.rev === rev)
    return r ? { rev: r.rev, sha256: r.sha256 } : null
  }
  function publicJob(j) {
    return {
      taskId: j.taskId,
      about: j.about,
      profile: j.profile,
      class: j.class,
      createdAt: j.createdAt,
      items: j.items.map((it) => ({
        key: it.key,
        brief: it.brief,
        context: it.context,
        status: it.status,
        latest: it.revs.length ? pointer(it, it.revs[it.revs.length - 1].rev) : null,
        final: it.final ? pointer(it, it.final) : null,
      })),
    }
  }

  // Программные помощники для тестов — то же, что ручки, без HTTP.
  const api = {
    createJob(body) {
      const taskId = String(nextTask++)
      const j = {
        taskId,
        about: body.about ?? null,
        profile: body.profile ?? null,
        class: body.class ?? null,
        createdAt: new Date().toISOString(),
        items: (body.items ?? []).map((it) => ({ key: it.key, brief: it.brief ?? '', context: it.context ?? null, status: 'open', revs: [], final: null })),
      }
      jobs.set(taskId, j)
      return publicJob(j)
    },
    addRevision(taskId, key, png, origin = { kind: 'generated', seed: 0, prompt: '' }) {
      const it = item(job(taskId), key)
      if (!it) return { status: 404, body: { error: 'нет такого задания или ключа' } }
      if (it.status === 'committed') return { status: 409, body: { error: 'ключ committed — правка принятого спрайта — новое задание' } }
      const rev = it.revs.length + 1
      it.revs.push({ rev, sha256: sha256(png), origin, size: png.length, png })
      it.status = 'draft'
      it.final = null
      return { status: 201, body: { rev, sha256: sha256(png), status: it.status } }
    },
    setFinal(taskId, key, rev) {
      const it = item(job(taskId), key)
      if (!it) return { status: 404, body: { error: 'нет такого задания или ключа' } }
      if (!it.revs.some((r) => r.rev === rev)) return { status: 422, body: { error: 'нет такой ревизии', field: 'rev' } }
      if (it.status === 'accepted' || it.status === 'committed') {
        return { status: 409, body: { error: `финал выбирается из draft|final|returned, ключ в ${it.status}` } }
      }
      it.final = rev
      it.status = 'final'
      return { status: 200, body: { key, status: it.status, final: pointer(it, rev) } }
    },
    setStatus(taskId, key, body) {
      const it = item(job(taskId), key)
      if (!it) return { status: 404, body: { error: 'нет такого задания или ключа' } }
      const { status, reason } = body ?? {}
      if (!['returned', 'accepted', 'committed'].includes(status)) {
        return { status: 422, body: { error: 'status — returned|accepted|committed', field: 'status' } }
      }
      if (status === 'returned' && !reason) return { status: 422, body: { error: 'returned без причины', field: 'reason' } }
      if (status === 'committed' && !COMMIT_RE.test(reason ?? '')) {
        return { status: 422, body: { error: 'committed требует reason = хеш коммита', field: 'reason' } }
      }
      const allowed = (it.status === 'final' && (status === 'returned' || status === 'accepted')) || (it.status === 'accepted' && status === 'committed')
      if (!allowed) return { status: 409, body: { error: `переход ${it.status} → ${status} запрещён: final→returned|accepted, accepted→committed` } }
      it.status = status
      statusLog.push({ taskId: String(taskId), key, status, reason: reason ?? null, cropPng: body.cropPng ? true : false, rev: it.final })
      return { status: 200, body: { key, status } }
    },
    job: (taskId) => (job(taskId) ? publicJob(job(taskId)) : null),
    statusLog,
  }

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
    res.end(JSON.stringify(body))
  }
  function sendPng(req, res, it, rev) {
    const r = it.revs.find((x) => x.rev === rev)
    if (!r) return send(res, 404, { error: 'нет такой ревизии' })
    const etag = `"${r.sha256}"`
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag })
      return res.end()
    }
    res.writeHead(200, { 'content-type': 'image/png', etag, 'x-sprite-rev': String(r.rev), 'x-sprite-sha256': r.sha256 })
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

  const server = http.createServer(async (req, res) => {
    try {
      const auth = req.headers.authorization ?? ''
      const role = auth === `Bearer ${tokens.cli}` ? 'cli' : auth === `Bearer ${tokens.go}` ? 'go' : null
      if (!role) return send(res, 401, { error: 'нужен Bearer-токен' })
      const url = new URL(req.url, 'http://stub')
      const m = url.pathname.match(/^\/api\/itgame\/jobs(?:\/([^/]+)(?:\/keys\/([^/]+)(?:\/(revisions|latest|status|final)(?:\/([^/]+))?)?)?)?$/)
      if (!m) return send(res, 404, { error: 'нет такой ручки' })
      const [, taskId, key, tail, rev] = m
      const write = req.method === 'POST'
      if (write && role !== 'cli') return send(res, 403, { error: 'роль itgame-go — только чтение' })

      if (!taskId) {
        if (req.method === 'GET') return send(res, 200, [...jobs.values()].reverse().map(publicJob))
        if (write) return send(res, 201, api.createJob(JSON.parse((await readBody(req)).toString() || '{}')))
      }
      const j = job(taskId)
      if (!j) return send(res, 404, { error: 'нет такого задания' })
      if (!key) {
        if (req.method === 'GET') return send(res, 200, publicJob(j))
        return send(res, 405, { error: 'метод не тот' })
      }
      const it = item(j, key)
      if (!it) return send(res, 404, { error: 'нет такого ключа в задании' })
      if (req.method === 'GET' && tail === 'latest' && !rev) {
        if (!it.revs.length) return send(res, 404, { error: 'у ключа нет ревизий' })
        return sendPng(req, res, it, it.revs[it.revs.length - 1].rev)
      }
      if (req.method === 'GET' && tail === 'revisions' && rev) return sendPng(req, res, it, Number(rev))
      if (req.method === 'GET' && tail === 'revisions') {
        return send(res, 200, [...it.revs].reverse().map((r) => ({ rev: r.rev, sha256: r.sha256, origin: r.origin, size: r.size })))
      }
      if (write && tail === 'revisions' && !rev) {
        const h = req.headers
        const origin = h['x-sprite-origin'] === 'edited'
          ? { kind: 'edited', from: Number(h['x-sprite-from']) }
          : { kind: 'generated', seed: Number(h['x-sprite-seed'] ?? 0), prompt: String(h['x-sprite-prompt'] ?? '') }
        const r = api.addRevision(taskId, key, await readBody(req), origin)
        return send(res, r.status, r.body)
      }
      if (write && tail === 'final') {
        const r = api.setFinal(taskId, key, Number(JSON.parse((await readBody(req)).toString() || '{}').rev))
        return send(res, r.status, r.body)
      }
      if (write && tail === 'status') {
        const r = api.setStatus(taskId, key, JSON.parse((await readBody(req)).toString() || '{}'))
        return send(res, r.status, r.body)
      }
      return send(res, 405, { error: 'метод не тот' })
    } catch (e) {
      send(res, 400, { error: `тело не разобрано: ${e instanceof Error ? e.message : String(e)}` })
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
