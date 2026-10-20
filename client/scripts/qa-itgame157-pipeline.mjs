// qa-itgame157-pipeline — qa:sprite и sprite:take против заглушки minipc (ITGAME-157,
// docs/design/sprite-pipeline.md, «Проверка»): три ревизии одного ключа — вне палитры
// (returned с причиной и кропом), зелёная (accepted), заменённая после accepted (забор
// старой отказывает, файлы не тронуты) — и полный путь до committed. sprite:take пишет во
// временную git-копию манифеста и спрайтов (--root), не в этот репо.
// Ключ — cooler (пиксельный hd32, seenIn full_office/office). Нужен client/dist (npm run build).
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { jobBody, startMinipcStub } from './lib/minipc-stub.mjs'
import { makePng, sha256 } from './lib/sprite-fixtures.mjs'

const CLIENT = dirname(dirname(fileURLToPath(import.meta.url)))
const KEY = 'cooler'

const results = []
function check(name, pass, fact) {
  results.push({ name, pass, fact })
  console.log(`${pass ? 'PASS' : 'FAIL'}: ${name}${fact !== undefined ? ` — ${JSON.stringify(fact)}` : ''}`)
}

const stub = await startMinipcStub()
const tmp = mkdtempSync(join(tmpdir(), 'qa-sprite-pipeline-'))
const root = join(tmp, 'repo')
const out = join(tmp, 'qa')
const env = {
  ...process.env,
  ITGAME_MINIPC_URL: stub.url,
  ITGAME_MINIPC_CLI_TOKEN: stub.tokens.cli,
  ITGAME_MINIPC_TOKEN: stub.tokens.go,
  QA_PORT: process.env.QA_PORT || '4196',
}
// Асинхронно: заглушка живёт в этом процессе, spawnSync заморозил бы её цикл событий.
const run = (script, ...args) => runEnv(env, script, ...args)
const runEnv = (env, script, ...args) =>
  new Promise((resolve) => {
    const p = spawn('node', [join(CLIENT, 'scripts', script), ...args], { env })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (out += d))
    p.on('close', (code) => resolve({ code, out }))
  })
const qaSprite = () => run('qa-sprite.mjs', '--task', T, '--out', out)
const take = (rev, ...extra) => run('sprite-take.mjs', '--task', T, '--key', KEY, '--rev', String(rev), '--root', root, '--report', join(out, 'report.json'), '--no-visreg', ...extra)
const report = () => {
  try {
    return JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'))
  } catch {
    return { keys: [{}] } // прогон не дописал отчёт — проверка упадёт с хвостом вывода
  }
}
const pngInRepo = () => sha256(readFileSync(join(root, 'client', 'public', 'assets', 'sprites', `${KEY}.png`)))
const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' }).trim()

// Временный репо: манифест и спрайты этого, git — для --committed.
mkdirSync(join(root, 'client', 'src', 'assets'), { recursive: true })
mkdirSync(join(root, 'client', 'public', 'assets'), { recursive: true })
cpSync(join(CLIENT, 'src', 'assets', 'sprites.json'), join(root, 'client', 'src', 'assets', 'sprites.json'))
cpSync(join(CLIENT, 'public', 'assets', 'sprites'), join(root, 'client', 'public', 'assets', 'sprites'), { recursive: true })
// У cooler в манифесте нет note — даём ему причину порога: забор должен её сохранить.
const tmpManifest = join(root, 'client', 'src', 'assets', 'sprites.json')
const REASON = 'причина порога: тест'
writeFileSync(tmpManifest, readFileSync(tmpManifest, 'utf8').replace('"class": "amenity",\n      "seenIn"', `"class": "amenity", "note": "${REASON}",\n      "seenIn"`))
if (JSON.parse(readFileSync(tmpManifest, 'utf8')).sprites[KEY].note !== REASON) throw new Error('не смог задать note cooler во временном манифесте')
git('init', '-q')
git('-c', 'user.name=qa', '-c', 'user.email=qa@localhost', 'commit', '-q', '--allow-empty', '-m', 'base')
git('add', '-A')
git('-c', 'user.name=qa', '-c', 'user.email=qa@localhost', 'commit', '-q', '-m', 'sprites')
const origPng = pngInRepo()

const job = stub.createJob(jobBody([KEY], {
  profile: { version: 'v1', sha256: sha256(Buffer.from('…')), text: '…' },
  class: { name: 'amenity', screenPx: 64, sourcePx: 128, palette: 'hd32', colors: ['1a1c2c', 'f4f4f4'] },
}))
const T = job.taskId
const off = makePng({ size: 128, fill: 'ff00ff' })
const green = makePng({ size: 128 })
const green3 = makePng({ size: 128, fill: '38b764' })
const green4 = makePng({ size: 128, fill: 'ffcd75' })

try {
  // R1: ревизия вне палитры → returned с причиной и кропом.
  stub.addRevision(T, KEY, off, { kind: 'generated', seed: 11, prompt: 'кулер' })
  stub.setFinal(T, KEY, 1)

  // R0: Go-серверу прогона — только свой токен itgame-go: без него или с токеном
  // координатора вместо него qa:sprite отказывает до сервера, вердиктов нет (ITGAME-182).
  const { ITGAME_MINIPC_TOKEN: _go, ...noGo } = env
  const r0a = await runEnv(noGo, 'qa-sprite.mjs', '--task', T, '--out', out)
  const r0b = await runEnv({ ...env, ITGAME_MINIPC_TOKEN: stub.tokens.cli }, 'qa-sprite.mjs', '--task', T, '--out', out)
  check('R0: без ITGAME_MINIPC_TOKEN и с токеном координатора на его месте — отказ, вердиктов нет',
    r0a.code === 1 && /ITGAME_MINIPC_TOKEN \(роль itgame-go\) не задан/.test(r0a.out) && r0b.code === 1 && /совпал с токеном координатора/.test(r0b.out) && stub.statusLog.length === 0,
    { a: r0a.out.trim().slice(-200), b: r0b.out.trim().slice(-200), log: stub.statusLog.length })

  const r1 = await qaSprite()
  const r1log = stub.statusLog.at(-1)
  check('R1: вне палитры — qa:sprite выносит returned с причиной «палитр» и кропом',
    r1.code === 0 && r1log?.status === 'returned' && /палитр/.test(r1log.reason) && r1log.cropPng && report().keys[0].crops.length === 2,
    { code: r1.code, log: r1log && { status: r1log.status, reason: r1log.reason.slice(0, 120), crop: r1log.cropPng }, tail: r1.code ? r1.out.slice(-600) : undefined })

  // R2: зелёная ревизия → accepted; sha в отчёте = sha ревизии.
  stub.addRevision(T, KEY, green, { kind: 'edited', from: 1 })
  stub.setFinal(T, KEY, 2)
  const r2 = await qaSprite()
  const r2entry = report().keys[0]
  check('R2: зелёная — accepted, в отчёте sha256 ревизии 2',
    r2.code === 0 && stub.job(T).items[0].status === 'accepted' && r2entry.verdict === 'accepted' && r2entry.rev === 2 && r2entry.sha256 === sha256(green),
    { code: r2.code, status: stub.job(T).items[0].status, entry: { verdict: r2entry.verdict, rev: r2entry.rev, findings: r2entry.findings }, tail: r2.code ? r2.out.slice(-600) : undefined })

  // T1: подделанный отчёт — забор отказывает с названием расхождения, файлы не тронуты.
  const good = readFileSync(join(out, 'report.json'), 'utf8')
  const forged = JSON.parse(good)
  forged.keys[0].sha256 = '0'.repeat(64)
  writeFileSync(join(out, 'report.json'), JSON.stringify(forged))
  const t1 = await take(2)
  writeFileSync(join(out, 'report.json'), good)
  check('T1: sha256 файла ≠ отчёт — отказ, PNG не тронут', t1.code === 1 && /sha256 файла .* ≠ sha256 в отчёте/.test(t1.out) && pngInRepo() === origPng, { code: t1.code, out: t1.out.trim().slice(-300) })

  // R3: замена после accepted — ключ в draft, забор ревизии 2 отказывает по статусу. Указатель
  // final minipc при новой ревизии не сбрасывает (сверено 20.10, ITGAME-182) — он всё ещё 2, и
  // отказ держится на статусе.
  stub.addRevision(T, KEY, green3, { kind: 'edited', from: 2 })
  const t2 = await take(2)
  check('T2: ревизия заменена после accepted — забор 2 отказывает (draft), PNG не тронут',
    t2.code === 1 && /статус ключа draft, нужен accepted/.test(t2.out) && stub.job(T).items[0].final?.rev === 2 && pngInRepo() === origPng,
    { code: t2.code, out: t2.out.trim().slice(-400) })

  // R3 → final → accepted → забор → коммит → committed.
  stub.setFinal(T, KEY, 3)
  const r3 = await qaSprite()

  // T2b: check:sprites падает (висячий fallback в манифесте) — забор откатан целиком.
  const goodManifest = readFileSync(tmpManifest)
  writeFileSync(tmpManifest, goodManifest.toString().replace(`"note": "${REASON}"`, `"note": "${REASON}", "fallback": "нет_такого"`))
  const brokenManifest = readFileSync(tmpManifest)
  const t2b = await take(3)
  check('T2b: check:sprites не прошёл — PNG, манифест и происхождение откатаны',
    t2b.code === 1 && /check:sprites не прошёл — забор откатан/.test(t2b.out) && pngInRepo() === origPng &&
      readFileSync(tmpManifest).equals(brokenManifest) && !existsSync(join(root, 'scripts', 'sprites', 'minipc')),
    { code: t2b.code, out: t2b.out.trim().slice(-200) })
  writeFileSync(tmpManifest, goodManifest)

  const t3 = await take(3)
  const origin = JSON.parse(readFileSync(join(root, 'scripts', 'sprites', 'minipc', `${KEY}.json`), 'utf8'))
  const manifest = JSON.parse(readFileSync(join(root, 'client', 'src', 'assets', 'sprites.json'), 'utf8'))
  check('T3: ревизия 3 принята и забрана — PNG = ревизия, происхождение и note записаны',
    r3.code === 0 && t3.code === 0 && pngInRepo() === sha256(green3) && origin.rev === 3 && origin.sha256 === sha256(green3) &&
      origin.origin?.kind === 'edited' && origin.profile?.version === 'v1' && manifest.sprites[KEY].seenIn?.length === 1 &&
      manifest.sprites[KEY].note === `${REASON} · minipc: задание ${T} (ITGAME-157), ревизия 3 — происхождение в scripts/sprites/minipc/${KEY}.json`,
    { r3: r3.code, t3: t3.code, origin: { rev: origin.rev, origin: origin.origin, profile: origin.profile }, note: manifest.sprites[KEY].note, tail: t3.code ? t3.out.slice(-600) : undefined })

  const early = await take(3, '--committed')
  check('T4: --committed до коммита — отказ', early.code === 1 && /sha256/.test(early.out), { code: early.code, out: early.out.trim().slice(-200) })
  git('add', '-A')
  git('-c', 'user.name=qa', '-c', 'user.email=qa@localhost', 'commit', '-q', '-m', 'cooler из minipc')
  // T4b: после коммита ревизии 3 в minipc пришла 4 — committed тройки отказывает.
  stub.addRevision(T, KEY, green4, { kind: 'edited', from: 3 })
  const t4b = await take(3, '--committed')
  check('T4b: minipc ушёл вперёд (ревизия 4) — --committed 3 отказывает, статус не тронут',
    t4b.code === 1 && /статус ключа draft/.test(t4b.out) && stub.job(T).items[0].status === 'draft', { code: t4b.code, out: t4b.out.trim().slice(-200) })
  stub.setFinal(T, KEY, 4)
  const r4 = await qaSprite()
  const t4 = await take(4)
  check('T4c: ревизия 4 принята и забрана, note — один хвост minipc с ревизией 4',
    r4.code === 0 && t4.code === 0 && JSON.parse(readFileSync(tmpManifest, 'utf8')).sprites[KEY].note.endsWith(`ревизия 4 — происхождение в scripts/sprites/minipc/${KEY}.json`) &&
      JSON.parse(readFileSync(tmpManifest, 'utf8')).sprites[KEY].note.split('minipc: задание').length === 2,
    { r4: r4.code, t4: t4.code, note: JSON.parse(readFileSync(tmpManifest, 'utf8')).sprites[KEY].note })
  git('add', '-A')
  git('-c', 'user.name=qa', '-c', 'user.email=qa@localhost', 'commit', '-q', '-m', 'cooler ревизия 4')
  const head = git('rev-parse', 'HEAD')
  const t5 = await take(4, '--committed')
  const last = stub.statusLog.at(-1)
  check('T5: --committed после коммита — статус committed с хешем HEAD', t5.code === 0 && last.status === 'committed' && last.reason === head && stub.job(T).items[0].status === 'committed',
    { code: t5.code, last, out: t5.code ? t5.out.slice(-300) : undefined })
} finally {
  await stub.stop()
  rmSync(tmp, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} PASS`)
process.exit(failed.length ? 1 : 0)
