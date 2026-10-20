// node --test: minipc-client (ITGAME-182) — откуда координатор берёт адрес и токен minipc
// (окружение, иначе файлы владельца; из файла стенда — только адрес) и как читает
// настоящую форму ответов minipc. Значения токенов в тексте ошибок не появляются.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { clipUtf8, errorText, jobItems, minipcFromEnv, parseEnvText, REASON_MAX_BYTES } from './minipc-client.mjs'

const dir = mkdtempSync(join(tmpdir(), 'minipc-client-'))
after(() => rmSync(dir, { recursive: true, force: true }))

const CLI_SECRET = 'cli-secret-value-1'
const GO_SECRET = 'go-secret-value-2'
const URL = 'https://minipc.example/api/itgame'

// Свой каталог на случай: пути обоих файлов — внутри, сами файлы — по желанию.
function home(name, { cli, dev } = {}) {
  const d = mkdtempSync(join(dir, `${name}-`))
  const env = { ITGAME_MINIPC_CLI_ENV_FILE: join(d, 'minipc-cli.env'), ITGAME_DEV_ENV_FILE: join(d, 'env') }
  if (cli !== undefined) writeFileSync(env.ITGAME_MINIPC_CLI_ENV_FILE, cli, { mode: 0o600 })
  if (dev !== undefined) writeFileSync(env.ITGAME_DEV_ENV_FILE, dev, { mode: 0o600 })
  return env
}

const DEV_FILE = `# Стенд :15555 — EnvironmentFile\nITGAME_MINIPC_URL=${URL}/\nITGAME_MINIPC_TOKEN=${GO_SECRET}\n`
const CLI_FILE = `# координатор\n\nITGAME_MINIPC_CLI_TOKEN=${CLI_SECRET}\n`

test('parseEnvText: комментарии, пустые строки, export, кавычки; кривые строки — номерами', () => {
  const { vars, bad } = parseEnvText('# c\n\n  A=1\nexport B="два слова"\nC=\'x\'\nD=a=b\n  # e=f\nне строка\n')
  assert.deepEqual([...vars], [['A', '1'], ['B', 'два слова'], ['C', 'x'], ['D', 'a=b']])
  assert.deepEqual(bad, [8])
})

test('окружение главнее файлов: файлы не читаются вовсе', () => {
  const env = { ITGAME_MINIPC_URL: 'http://127.0.0.1:1/api/itgame', ITGAME_MINIPC_CLI_TOKEN: 'from-env', ...home('envwins') }
  const mp = minipcFromEnv(env)
  assert.equal(mp.url, 'http://127.0.0.1:1/api/itgame')
  assert.equal(mp.token, 'from-env')
  assert.deepEqual(mp.from, { url: 'env', token: 'env' })
})

test('без окружения: токен — из minipc-cli.env, адрес — из env стенда, токен itgame-go оттуда не берётся', () => {
  const env = home('files', { cli: CLI_FILE, dev: DEV_FILE })
  const mp = minipcFromEnv(env)
  assert.equal(mp.url, URL) // хвостовой / срезан
  assert.equal(mp.token, CLI_SECRET)
  assert.notEqual(mp.token, GO_SECRET)
  assert.deepEqual(mp.from, { url: env.ITGAME_DEV_ENV_FILE, token: env.ITGAME_MINIPC_CLI_ENV_FILE })
})

test('нет minipc-cli.env — ошибка с именем файла и переменной; токен itgame-go не подставляется', () => {
  const env = home('nocli', { dev: DEV_FILE })
  assert.throws(() => minipcFromEnv(env), (e) => {
    assert.match(e.message, /ITGAME_MINIPC_CLI_TOKEN/)
    assert.ok(e.message.includes(env.ITGAME_MINIPC_CLI_ENV_FILE), e.message)
    assert.match(e.message, /нет файла/)
    assert.ok(!e.message.includes(GO_SECRET))
    return true
  })
})

test('нет env стенда — ошибка с именем файла и ITGAME_MINIPC_URL', () => {
  const env = { ...home('nodev', { cli: CLI_FILE }) }
  assert.throws(() => minipcFromEnv(env), (e) => {
    assert.match(e.message, /ITGAME_MINIPC_URL/)
    assert.ok(e.message.includes(env.ITGAME_DEV_ENV_FILE), e.message)
    assert.ok(!e.message.includes(CLI_SECRET))
    return true
  })
})

test('файл есть, переменной нет или она пуста — ошибка без значений из файла', () => {
  const env = home('novar', { cli: `ITGAME_MINIPC_TOKEN=${GO_SECRET}\nкривая строка\n`, dev: DEV_FILE })
  assert.throws(() => minipcFromEnv(env), (e) => {
    assert.match(e.message, /ITGAME_MINIPC_CLI_TOKEN не задан в окружении и не найден в /)
    assert.match(e.message, /строки не вида KEY=VALUE: 2/)
    assert.ok(!e.message.includes(GO_SECRET) && !e.message.includes('кривая'))
    return true
  })
  const empty = home('emptyvar', { cli: 'ITGAME_MINIPC_CLI_TOKEN=\n', dev: DEV_FILE })
  assert.throws(() => minipcFromEnv(empty), /пуст в /)
})

test('адрес не http(s) — отказ, значение не печатается', () => {
  const env = home('badurl', { cli: CLI_FILE, dev: 'ITGAME_MINIPC_URL=minipc.lan/api/itgame\n' })
  assert.throws(() => minipcFromEnv(env), (e) => !e.message.includes('minipc.lan') && /не http\(s\)-адрес/.test(e.message))
})

test('jobItems: настоящая форма minipc (ctx, revisions, status_at) и догадка заглушки (keys[], context)', () => {
  const real = {
    taskId: '1',
    created_at: '2026-10-16T22:39:16+00:00',
    items: [{ key: 'icon_trophy', brief: 'кубок', ctx: { text: '12px', bg: '232640' }, status: 'accepted', status_at: '2026-10-16T22:39:29+00:00', revisions: 1, latest: { rev: 1, sha256: 'a' }, final: { rev: 1, sha256: 'a' } }],
  }
  assert.deepEqual(jobItems(real), [{ key: 'icon_trophy', status: 'accepted', latest: { rev: 1, sha256: 'a' }, final: { rev: 1, sha256: 'a' }, revisions: 1, statusAt: '2026-10-16T22:39:29+00:00', ctx: { text: '12px', bg: '232640' } }])
  const old = jobItems({ keys: ['a', { key: 'b', status: 'open', context: { bg: '000000' } }] })
  assert.deepEqual(old.map((x) => [x.key, x.status, x.ctx]), [['a', null, null], ['b', 'open', { bg: '000000' }]])
})

test('errorText: {error, field, detail}; HTML 404 — «нет такой ручки», не «нет задания»', async () => {
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  assert.equal(await errorText(json(404, { error: 'task 999999 not found' })), 'task 999999 not found')
  assert.equal(await errorText(json(422, { error: 'reason is required', field: 'reason' })), 'reason is required (reason)')
  assert.equal(await errorText(json(403, { error: 'forbidden', detail: 'the itgame-cli token is required for this handle' })), 'forbidden — the itgame-cli token is required for this handle')
  const html = new Response('<!DOCTYPE html><title>An Error Occurred: Not Found</title>', { status: 404, headers: { 'content-type': 'text/html' } })
  assert.match(await errorText(html), /нет такой ручки .*ITGAME_MINIPC_URL/)
  assert.equal(await errorText(new Response('oops', { status: 500 })), 'HTTP 500 (ответ не JSON)')
})

test('clipUtf8: reason вердикта ≤ 1000 байт UTF-8 (лимит minipc), символ не рвётся', () => {
  assert.equal(REASON_MAX_BYTES, 1000)
  assert.equal(clipUtf8('коротко'), 'коротко')
  const long = 'контракт — вне палитры ff00ff; '.repeat(60) // ~3300 байт: 900 знаков резали бы до ~1600
  const out = clipUtf8(long)
  assert.ok(Buffer.byteLength(out) <= 1000, String(Buffer.byteLength(out)))
  assert.ok(Buffer.byteLength(out) > 990)
  assert.ok(out.endsWith('…') && long.startsWith(out.slice(0, -1)))
  assert.ok(!out.includes('\uFFFD'))
  assert.equal(clipUtf8('ж'.repeat(10), 9), 'жжж…') // 3×2 + 3 байта «…» = 9
  assert.equal(clipUtf8('ж'.repeat(10), 8), 'жж…') // третья «ж» с «…» — 9 байт > 8
})
