// node --test: заглушка minipc (ITGAME-157) держит роли токенов, ETag/304 и
// статусную машину письма 4123 — иначе прогоны против неё доказывают не то.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { after, before, test } from 'node:test'
import { startMinipcStub } from './minipc-stub.mjs'

let stub
before(async () => {
  stub = await startMinipcStub()
})
after(() => stub.stop())

const req = (path, { token = stub.tokens.cli, method = 'GET', body, headers = {} } = {}) =>
  fetch(stub.url + path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...headers },
    body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
  })

test('роли: без токена 401, itgame-go читает, но не пишет', async () => {
  assert.equal((await req('/jobs', { token: 'wrong' })).status, 401)
  assert.equal((await req('/jobs', { token: stub.tokens.go })).status, 200)
  assert.equal((await req('/jobs', { token: stub.tokens.go, method: 'POST', body: {} })).status, 403)
})

test('ревизии: latest, ETag/304, X-Sprite-*, новая ревизия возвращает ключ в draft', async () => {
  const job = await (await req('/jobs', { method: 'POST', body: { about: 'ITGAME-157', items: [{ key: 'icon_lock' }] } })).json()
  const base = `/jobs/${job.taskId}/keys/icon_lock`
  assert.equal(job.items[0].status, 'open')
  assert.equal((await req(`${base}/latest`)).status, 404)

  const png = Buffer.from('png-1')
  assert.equal((await req(`${base}/revisions`, { method: 'POST', body: png, headers: { 'x-sprite-origin': 'generated', 'x-sprite-seed': '7' } })).status, 201)
  const r = await req(`${base}/latest`, { token: stub.tokens.go })
  const sha = createHash('sha256').update(png).digest('hex')
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('etag'), `"${sha}"`)
  assert.equal(r.headers.get('x-sprite-rev'), '1')
  assert.equal(r.headers.get('x-sprite-sha256'), sha)
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), png)
  assert.equal((await req(`${base}/latest`, { headers: { 'if-none-match': `"${sha}"` } })).status, 304)

  assert.equal((await req(`${base}/final`, { method: 'POST', body: { rev: 1 } })).status, 200)
  assert.equal(stub.job(job.taskId).items[0].status, 'final')
  await req(`${base}/revisions`, { method: 'POST', body: Buffer.from('png-2') })
  const it = stub.job(job.taskId).items[0]
  assert.equal(it.status, 'draft')
  assert.equal(it.final, null)
  assert.equal(it.latest.rev, 2)
})

test('статусы: final→returned|accepted, accepted→committed, остальное 409/422', async () => {
  const job = stub.createJob({ items: [{ key: 'icon_chart' }] })
  const base = `/jobs/${job.taskId}/keys/icon_chart`
  stub.addRevision(job.taskId, 'icon_chart', Buffer.from('a'))
  assert.equal((await req(`${base}/status`, { method: 'POST', body: { status: 'accepted' } })).status, 409) // draft
  stub.setFinal(job.taskId, 'icon_chart', 1)
  assert.equal((await req(`${base}/status`, { method: 'POST', body: { status: 'returned' } })).status, 422)
  assert.equal((await req(`${base}/status`, { method: 'POST', body: { status: 'committed', reason: 'abc1234' } })).status, 409)
  assert.equal((await req(`${base}/status`, { method: 'POST', body: { status: 'accepted' } })).status, 200)
  assert.equal((await req(`${base}/status`, { method: 'POST', body: { status: 'committed', reason: 'не хеш' } })).status, 422)
  assert.equal((await req(`${base}/status`, { method: 'POST', body: { status: 'committed', reason: 'abc1234' } })).status, 200)
  assert.equal((await req(`${base}/revisions`, { method: 'POST', body: Buffer.from('b') })).status, 409) // committed терминален
})
