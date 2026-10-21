// node --test: заглушка minipc (ITGAME-157) держит роли токенов, ETag/304, статусную
// машину письма 4123 и формы ответов настоящего minipc (сверены 20.10, ITGAME-182) —
// иначе прогоны против неё доказывают не то. Последний блок — minipc-client против неё.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { after, before, test } from 'node:test'
import { getJob, getRevisions, jobItems, postStatus } from './minipc-client.mjs'
import { jobBody, startMinipcStub } from './minipc-stub.mjs'

let stub
before(async () => {
  stub = await startMinipcStub()
})
after(() => stub.stop())

const req = (path, { token = stub.tokens.cli, method = 'GET', body, headers = {} } = {}) =>
  fetch(stub.url + path, {
    method,
    headers: token === null ? headers : { authorization: `Bearer ${token}`, ...headers },
    body: body === undefined ? undefined : Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body),
  })
const json = async (r) => ({ status: r.status, body: await r.json() })
// minipc проверяет только сигнатуру PNG — тело дальше может быть любым.
const png = (s) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(s)])
const sha = (b) => createHash('sha256').update(b).digest('hex')

test('роли: без токена и с чужим 401 {error: unauthorized}, itgame-go читает, но не пишет — 403 с detail', async () => {
  assert.deepEqual(await json(await req('/jobs', { token: null })), { status: 401, body: { error: 'unauthorized' } })
  assert.deepEqual(await json(await req('/jobs', { token: 'wrong' })), { status: 401, body: { error: 'unauthorized' } })
  assert.equal((await req('/jobs', { token: stub.tokens.go })).status, 200)
  assert.deepEqual(await json(await req('/jobs', { token: stub.tokens.go, method: 'POST', body: {} })), {
    status: 403,
    body: { error: 'forbidden', detail: 'the itgame-cli token is required for this handle' },
  })
})

test('пути вне маршрутов — HTML 404, а не JSON: нечисловой taskId или rev, чужой префикс', async () => {
  for (const path of ['/jobs/abc', '/jobs/1/keys/icon_trophy/revisions/abc', '/jobs/1/keys/Icon/latest', '/../nope']) {
    const r = await req(path)
    assert.equal(r.status, 404, path)
    assert.match(r.headers.get('content-type'), /^text\/html/, path)
  }
})

test('задание: POST /jobs → 201 в форме GET (ctx, created_at, status_at, revisions), кроп не возвращается; GET /jobs — сводка', async () => {
  const crop = png('crop').toString('base64')
  const r = await json(await req('/jobs', { method: 'POST', body: jobBody([{ key: 'icon_lock', context: { text: '12px', bg: '232640', cropPng: crop } }], { about: 'ITGAME-182' }) }))
  assert.equal(r.status, 201)
  const it = r.body.items[0]
  assert.equal(typeof r.body.taskId, 'string')
  assert.ok(r.body.created_at && it.status_at)
  assert.deepEqual({ ...it, status_at: undefined }, { key: 'icon_lock', brief: 'ключ icon_lock', ctx: { text: '12px', bg: '232640' }, status: 'open', status_at: undefined, revisions: 0, latest: null, final: null })
  assert.deepEqual((await json(await req(`/jobs/${r.body.taskId}`))).body, r.body) // один ключ — порядок не играет
  const list = (await json(await req('/jobs'))).body
  assert.deepEqual(list.items[0], { taskId: r.body.taskId, about: 'ITGAME-182', created_at: r.body.created_at, keys: 1 })
  assert.deepEqual(await json(await req('/jobs/999999')), { status: 404, body: { error: 'task 999999 not found' } })
})

test('порядок ключей: ответ POST /jobs и GET /jobs/{taskId} — в порядке создания, как тело (MINIPC-317)', async () => {
  const r = await json(await req('/jobs', { method: 'POST', body: jobBody(['desk_pc_crt', 'desk_pc_lcd', 'desk_ov_off']) }))
  assert.deepEqual(r.body.items.map((x) => x.key), ['desk_pc_crt', 'desk_pc_lcd', 'desk_ov_off'])
  assert.deepEqual((await json(await req(`/jobs/${r.body.taskId}`))).body.items.map((x) => x.key), ['desk_pc_crt', 'desk_pc_lcd', 'desk_ov_off'])
})

test('задание: тело не по контракту — 422 {error, field}, задание не заводится', async () => {
  const before = (await json(await req('/jobs'))).body.items.length
  const bad = [
    [{ ...jobBody(['a']), profile: { version: 'v', sha256: 'p', text: 't' } }, 'profile.sha256'],
    [jobBody([{ key: 'a', context: { cropPng: '137,80,78,71' } }]), 'items.0.context.cropPng'],
    [jobBody([{ key: 'a', context: { cropPng: Buffer.from('not png').toString('base64') } }]), 'items.0.context.cropPng'],
    [jobBody(['a', 'a']), 'items.1.key'],
    [{ ...jobBody(['a']), items: [] }, 'items'],
    [jobBody(['a'], { class: { name: 'icon', screenPx: 32, sourcePx: 64, palette: 'sweetie16', colors: ['1a1c2c', '1A1C2C'] } }), 'class.colors'],
  ]
  for (const [body, field] of bad) {
    const r = await json(await req('/jobs', { method: 'POST', body }))
    assert.equal(r.status, 422, field)
    assert.equal(r.body.field, field)
  }
  assert.equal((await json(await req('/jobs'))).body.items.length, before)
})

test('ревизии: нет — 404 у latest и каталога; PNG-сигнатура; 201-ответ; ETag/304; каталог обёрнут; новая ревизия → draft, final остаётся', async () => {
  const job = stub.createJob(jobBody(['icon_lock']))
  const base = `/jobs/${job.taskId}/keys/icon_lock`
  assert.deepEqual(await json(await req(`${base}/latest`)), { status: 404, body: { error: "key 'icon_lock' has no revisions yet" } })
  assert.equal((await req(`${base}/revisions`)).status, 404)
  assert.deepEqual(await json(await req(`/jobs/${job.taskId}/keys/nope/latest`)), { status: 404, body: { error: "key 'nope' not found in the job" } })
  assert.deepEqual(await json(await req(`${base}/revisions`, { method: 'POST', body: Buffer.from('png-1') })), { status: 422, body: { error: 'the body is not a PNG', field: 'png' } })

  const p1 = png('1')
  const posted = await json(await req(`${base}/revisions`, { method: 'POST', body: p1, headers: { 'x-sprite-origin': 'edited' } }))
  assert.deepEqual(posted, { status: 201, body: { taskId: job.taskId, key: 'icon_lock', rev: 1, sha256: sha(p1), origin: { kind: 'edited', from: null } } })
  const r = await req(`${base}/latest`, { token: stub.tokens.go })
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('etag'), `"${sha(p1)}"`)
  assert.equal(r.headers.get('x-sprite-rev'), '1')
  assert.equal(r.headers.get('x-sprite-sha256'), sha(p1))
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), p1)
  assert.equal((await req(`${base}/latest`, { headers: { 'if-none-match': `"${sha(p1)}"` } })).status, 304)
  assert.deepEqual(await json(await req(`${base}/revisions/9`)), { status: 404, body: { error: "revision 9 of 'icon_lock' not found" } })

  assert.deepEqual(await json(await req(`${base}/final`, { method: 'POST', body: { rev: 2 } })), { status: 404, body: { error: "revision 2 of 'icon_lock' not found" } })
  assert.deepEqual(await json(await req(`${base}/final`, { method: 'POST', body: { rev: 1 } })), { status: 200, body: { key: 'icon_lock', status: 'final', final_rev: 1 } })
  const gen = await json(await req(`${base}/revisions`, { method: 'POST', body: png('2'), headers: { 'x-sprite-origin': 'generated', 'x-sprite-seed': '7', 'x-sprite-prompt': 'padlock icon' } }))
  assert.deepEqual(gen.body.origin, { kind: 'generated', seed: 7, prompt: 'padlock icon' })
  assert.equal((await req(`${base}/revisions`, { method: 'POST', body: png('3'), headers: { 'x-sprite-origin': 'generated' } })).status, 422) // без seed и prompt
  const it = stub.job(job.taskId).items[0]
  assert.equal(it.status, 'draft')
  assert.deepEqual(it.final, { rev: 1, sha256: sha(p1) }) // minipc не сбрасывает указатель финала
  assert.equal(it.latest.rev, 2)
  assert.equal(it.revisions, 2)
  const cat = (await json(await req(`${base}/revisions`))).body
  assert.equal(cat.taskId, job.taskId)
  assert.equal(cat.key, 'icon_lock')
  assert.deepEqual(cat.items.map((x) => [x.rev, x.origin.kind, x.size]), [[2, 'generated', p1.length], [1, 'edited', p1.length]])
  assert.ok(cat.items.every((x) => x.created_at))
})

test('статусы: open/draft → 409, final→returned|accepted, accepted→committed, кроп только у returned, reason ≤ 1000 байт, у committed — хеш', async () => {
  const job = stub.createJob(jobBody(['icon_chart']))
  const base = `/jobs/${job.taskId}/keys/icon_chart`
  const post = (body) => req(`${base}/status`, { method: 'POST', body }).then(json)
  assert.deepEqual(await post({ status: 'accepted' }), { status: 409, body: { error: "key 'icon_chart' has no final revision to act on" } })
  assert.equal((await req(`${base}/final`, { method: 'POST', body: { rev: 1 } })).status, 409) // open: выбирать не из чего
  stub.addRevision(job.taskId, 'icon_chart', png('a'))
  assert.equal((await post({ status: 'accepted' })).status, 409) // draft
  stub.setFinal(job.taskId, 'icon_chart', 1)
  assert.deepEqual(await post({ status: 'returned' }), { status: 422, body: { error: 'a reason is required', field: 'reason' } })
  assert.deepEqual(await post({ status: 'bogus', reason: 'x' }), { status: 422, body: { error: "status must be one of returned|accepted|committed, got 'bogus'", field: 'status' } })
  assert.equal((await post({ status: 'returned', reason: 'я'.repeat(501) })).body.field, 'reason') // 1002 байта
  assert.equal((await post({ status: 'committed', reason: 'abc1234' })).status, 409)
  // Не хеш у committed — 422 раньше статусной машины (тут было бы 409) и поиска задания (404).
  const notHash = { status: 422, body: { error: 'the repo commit hash is required: 7..40 hex digits', field: 'reason' } }
  assert.deepEqual(await post({ status: 'committed', reason: 'не хеш' }), notHash)
  assert.deepEqual(await json(await req('/jobs/999999/keys/icon_chart/status', { method: 'POST', body: { status: 'committed', reason: 'abc123' } })), notHash) // 6 знаков
  assert.deepEqual(await json(await req('/jobs/999999/keys/icon_chart/status', { method: 'POST', body: { status: 'committed', reason: 'g'.repeat(7) } })), notHash)
  assert.deepEqual(await json(await req('/jobs/999999/keys/icon_chart/status', { method: 'POST', body: { status: 'committed', reason: 'a'.repeat(41) } })), notHash)
  assert.equal((await req('/jobs/999999/keys/icon_chart/status', { method: 'POST', body: { status: 'committed', reason: 'abc1234' } })).status, 404) // хеш годный — дальше ищется задание
  assert.deepEqual(await post({ status: 'accepted', reason: 'x', cropPng: png('c').toString('base64') }), { status: 422, body: { error: 'a crop can only be attached to a returned verdict', field: 'cropPng' } })
  assert.equal((await req(`${base}/status`, { method: 'POST', body: 'not json' })).status, 400)
  assert.equal(stub.job(job.taskId).items[0].status, 'final') // ни один отказ состояние не тронул
  assert.deepEqual(await post({ status: 'accepted' }), { status: 200, body: { key: 'icon_chart', status: 'accepted' } }) // reason у accepted не обязателен
  assert.equal((await req(`${base}/final`, { method: 'POST', body: { rev: 1 } })).status, 409) // accepted: сначала новая ревизия
  assert.deepEqual(await post({ status: 'committed' }), notHash)
  assert.deepEqual(await post({ status: 'committed', reason: 'не хеш' }), notHash)
  assert.equal(stub.job(job.taskId).items[0].status, 'accepted')
  // Регистр любой, пробелы по краям срезаются (MINIPC-317); в журнал идёт reason после trim.
  assert.deepEqual(await post({ status: 'committed', reason: '  ABCdef0123  ' }), { status: 200, body: { key: 'icon_chart', status: 'committed' } })
  assert.equal(stub.statusLog.at(-1).reason, 'ABCdef0123')
  assert.equal((await req(`${base}/revisions`, { method: 'POST', body: png('b') })).status, 409) // committed терминален
  assert.equal((await post({ status: 'returned', reason: 'x' })).status, 409)
})

test('returned с кропом: base64 PNG — принят и записан; не PNG — 422', async () => {
  const job = stub.createJob(jobBody(['cooler']))
  stub.addRevision(job.taskId, 'cooler', png('a'))
  stub.setFinal(job.taskId, 'cooler', 1)
  const base = `/jobs/${job.taskId}/keys/cooler`
  assert.equal((await req(`${base}/status`, { method: 'POST', body: { status: 'returned', reason: 'r', cropPng: 'бред' } })).status, 422)
  assert.equal((await req(`${base}/status`, { method: 'POST', body: { status: 'returned', reason: 'r', cropPng: png('c').toString('base64') } })).status, 200)
  assert.deepEqual(stub.statusLog.at(-1), { taskId: job.taskId, key: 'cooler', status: 'returned', reason: 'r', cropPng: true, rev: 1 })
})

test('minipc-client против заглушки: getJob/jobItems, каталог ревизий из обёртки, committed без хеша не отправляется', async () => {
  const mp = { url: stub.url, token: stub.tokens.cli }
  const job = stub.createJob(jobBody(['icon_money']))
  stub.addRevision(job.taskId, 'icon_money', png('a'))
  stub.addRevision(job.taskId, 'icon_money', png('b'), { kind: 'edited', from: 1 })
  stub.setFinal(job.taskId, 'icon_money', 2)
  const [it] = jobItems(await getJob(mp, job.taskId))
  assert.deepEqual([it.key, it.status, it.final.rev, it.revisions], ['icon_money', 'final', 2, 2])
  const revs = await getRevisions(mp, job.taskId, 'icon_money')
  assert.deepEqual(revs.map((r) => [r.rev, r.origin]), [[2, { kind: 'edited', from: 1 }], [1, { kind: 'edited', from: null }]])
  await assert.rejects(getJob(mp, 999999), /задание 999999: 404 task 999999 not found/)
  assert.equal((await postStatus(mp, job.taskId, 'icon_money', { status: 'accepted', reason: 'ok' })).ok, true)
  const before = stub.statusLog.length
  const bad = await postStatus(mp, job.taskId, 'icon_money', { status: 'committed', reason: 'не хеш' })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /хешем коммита/)
  assert.equal(stub.statusLog.length, before) // до minipc не дошло
  assert.equal(stub.job(job.taskId).items[0].status, 'accepted')
  assert.equal((await postStatus(mp, job.taskId, 'icon_money', { status: 'committed', reason: 'abc1234' })).ok, true)
})
