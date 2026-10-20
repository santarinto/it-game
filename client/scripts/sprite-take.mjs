// sprite-take — забор принятой ревизии minipc в репо (ITGAME-157, docs/design/sprite-pipeline.md,
// «Забор в репо»).
//
//   npm run sprite:take -- --task <id> --key <k> --rev <N> [--report <path>] [--no-visreg]
//   npm run sprite:take -- --task <id> --key <k> --rev <N> --committed
//
// Забор: скачать ревизию N, проверить три совпадения — sha256 файла = sha256 в отчёте
// qa:sprite (client/.qa/sprite/<task>/report.json), ревизия — текущий финал ключа, статус
// ключа accepted. Любое расхождение — отказ с его названием, файлы не тронуты. Дальше:
// PNG в client/public/assets/sprites/<key>.png, note ключа в sprites.json, происхождение
// (задание, ревизия, seed/промт, версия профиля) в scripts/sprites/minipc/<key>.json,
// check:sprites (не прошёл — всё откатывается), сборка и visreg (расхождение кадров с
// эталоном там, где ключ виден, ожидаемо: эталоны обновляются осознанно).
// Состояний (locked/disabled, recolor) у ключей конвейера пока нет — собирать нечего.
//
// --committed — после коммита: HEAD содержит этот PNG с sha256 ревизии N → статус
// committed с хешем HEAD в minipc.
//
// Окружение: ITGAME_MINIPC_URL, ITGAME_MINIPC_CLI_TOKEN — без них из файлов владельца
// (~/.config/itgame-dev/env — только адрес, ~/.config/itgame-dev/minipc-cli.env — токен;
// lib/minipc-client.mjs, minipcFromEnv). --root <dir> — корень другого репо (прогон против
// заглушки minipc пишет во временную копию, не в этот репо).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeSource, getJob, getRevision, getRevisions, jobItems, minipcFromEnv, postStatus, sha256 } from './lib/minipc-client.mjs'

const OWN_CLIENT = dirname(dirname(fileURLToPath(import.meta.url)))
// Часть note о заборе из minipc: прежняя причина порога (зачем smooth, почему палитра не
// проверяется) остаётся, меняется только хвост «minipc: задание …».
const MINIPC_NOTE = 'minipc: задание '

function arg(name) {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}
function die(msg) {
  console.error(`SPRITE-TAKE FAIL: ${msg}`)
  process.exit(1)
}

const TASK = arg('--task')
const KEY = arg('--key')
const REV = Number(arg('--rev'))
const ROOT = arg('--root') ?? join(OWN_CLIENT, '..')
const COMMITTED = process.argv.includes('--committed')
const VISREG = !process.argv.includes('--no-visreg')
if (!TASK || !/^[0-9]+$/.test(TASK)) die('нужен --task <номер задания minipc>')
if (!KEY || !/^[a-z0-9_]+$/.test(KEY)) die('нужен --key <ключ манифеста>')
if (!Number.isInteger(REV) || REV < 1) die('нужен --rev <номер ревизии ≥ 1>')

const CLIENT = join(ROOT, 'client')
const PNG_PATH = join(CLIENT, 'public', 'assets', 'sprites', `${KEY}.png`)
const MANIFEST_PATH = join(CLIENT, 'src', 'assets', 'sprites.json')
const ORIGIN_PATH = join(ROOT, 'scripts', 'sprites', 'minipc', `${KEY}.json`)
const REPORT_PATH = arg('--report') ?? join(CLIENT, '.qa', 'sprite', TASK, 'report.json')

let mp
try {
  mp = minipcFromEnv()
} catch (e) {
  die(e.message)
}
console.log(describeSource(mp))

if (COMMITTED) await committed()
else await take()

async function take() {
  const manifestText = readFileSync(MANIFEST_PATH, 'utf8')
  if (!JSON.parse(manifestText).sprites[KEY]) die(`ключа ${KEY} нет в ${relative(ROOT, MANIFEST_PATH)}`)

  const job = await getJob(mp, TASK).catch((e) => die(e.message))
  const it = jobItems(job).find((x) => x.key === KEY)
  if (!it) die(`ключа ${KEY} нет в задании ${TASK}`)
  const rev = await getRevision(mp, TASK, KEY, REV).catch((e) => die(e.message))

  // Три совпадения — все сразу, чтобы отказ называл каждое расхождение.
  const mismatches = []
  if (it.status !== 'accepted') mismatches.push(`статус ключа ${it.status}, нужен accepted`)
  if (it.final?.rev !== REV) mismatches.push(`финал ключа — ревизия ${it.final?.rev ?? 'не выбрана'}, а не ${REV}`)
  let report = null
  if (!existsSync(REPORT_PATH)) {
    mismatches.push(`нет отчёта qa:sprite ${relative(ROOT, REPORT_PATH)} — сначала npm run qa:sprite -- --task ${TASK}`)
  } else {
    report = JSON.parse(readFileSync(REPORT_PATH, 'utf8'))
    const entry = report.keys?.find((k) => k.key === KEY && k.rev === REV)
    if (!entry) mismatches.push(`в отчёте qa:sprite нет ${KEY}#${REV}`)
    else if (entry.verdict !== 'accepted') mismatches.push(`в отчёте qa:sprite ${KEY}#${REV} — ${entry.verdict ?? entry.error}`)
    else if (entry.sha256 !== rev.sha256) mismatches.push(`sha256 файла ${rev.sha256} ≠ sha256 в отчёте ${entry.sha256}`)
  }
  if (mismatches.length) die(`${KEY}#${REV}, файлы не тронуты:\n  - ${mismatches.join('\n  - ')}`)

  let origin = null
  try {
    origin = (await getRevisions(mp, TASK, KEY)).find((r) => r.rev === REV)?.origin ?? null
  } catch (e) {
    console.warn(`SPRITE-TAKE: каталог ревизий не прочитан (${e.message}) — origin в происхождении пуст`)
  }
  if (!origin) console.warn(`SPRITE-TAKE: у ${KEY}#${REV} нет origin (seed/промт) — происхождение неполное`)
  const provenance = {
    about: job.about ?? null,
    taskId: TASK,
    key: KEY,
    rev: REV,
    sha256: rev.sha256,
    origin,
    profile: job.profile ? { version: job.profile.version ?? null, sha256: job.profile.sha256 ?? null } : null,
    class: job.class?.name ?? null,
    qa: { at: report.at, commit: report.commit },
    takenAt: new Date().toISOString(),
  }
  const note = `${MINIPC_NOTE}${TASK}${job.about ? ` (${job.about})` : ''}, ревизия ${REV} — происхождение в scripts/sprites/minipc/${KEY}.json`

  // Откат — к байтам до забора, по каждому из трёх файлов.
  const backup = [PNG_PATH, MANIFEST_PATH, ORIGIN_PATH].map((p) => [p, existsSync(p) ? readFileSync(p) : null])
  const originDirNew = !existsSync(dirname(ORIGIN_PATH))
  const rollback = () => {
    for (const [p, bytes] of backup) bytes === null ? rmSync(p, { force: true }) : writeFileSync(p, bytes)
    if (originDirNew) rmSync(dirname(ORIGIN_PATH), { recursive: true, force: true })
  }
  try {
    writeFileSync(PNG_PATH, rev.bytes)
    writeFileSync(MANIFEST_PATH, withNote(manifestText, KEY, note))
    mkdirSync(dirname(ORIGIN_PATH), { recursive: true })
    writeFileSync(ORIGIN_PATH, JSON.stringify(provenance, null, 2) + '\n')
    execFileSync('node', [join(OWN_CLIENT, 'scripts', 'check-sprites.mjs'), '--client', CLIENT], { stdio: ['ignore', 'ignore', 'inherit'] })
  } catch (e) {
    rollback()
    die(`${KEY}#${REV}: ${e?.status !== undefined ? 'check:sprites не прошёл' : e.message} — забор откатан`)
  }
  console.log(`SPRITE-TAKE: ${KEY}#${REV} → ${relative(ROOT, PNG_PATH)}, ${relative(ROOT, ORIGIN_PATH)}, note в sprites.json; check:sprites OK`)

  if (VISREG && ROOT === join(OWN_CLIENT, '..')) {
    try {
      execFileSync('npm', ['run', '--silent', 'build'], { cwd: CLIENT, stdio: 'inherit' })
    } catch {
      console.error('SPRITE-TAKE: npm run build упал — PNG забран, visreg не запускался; почини сборку и прогони visreg')
      process.exit(2)
    }
    try {
      execFileSync('npm', ['run', '--silent', 'visreg'], { cwd: CLIENT, stdio: 'inherit' })
      console.log('SPRITE-TAKE: visreg без расхождений')
    } catch {
      console.error('SPRITE-TAKE: visreg разошёлся — посмотри кадры: если разница — новый спрайт, обнови эталоны (npm run visreg -- --update) и коммить вместе с PNG')
      process.exit(2)
    }
  }
  console.log(`дальше: коммит PNG, sprites.json и scripts/sprites/minipc/${KEY}.json, затем npm run sprite:take -- --task ${TASK} --key ${KEY} --rev ${REV} --committed`)
}

// note ключа в sprites.json — правкой текста: файл отформатирован руками, перезапись
// JSON целиком переложила бы все записи.
function withNote(text, key, part) {
  const start = text.indexOf(`"${key}": {`)
  if (start < 0) throw new Error(`не нашёл запись "${key}" в sprites.json`)
  let depth = 0
  let inStr = false
  let end = -1
  for (let i = text.indexOf('{', start); i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (c === '\\') i++
      else if (c === '"') inStr = false
    } else if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) {
      end = i
      break
    }
  }
  if (end < 0) throw new Error(`запись "${key}" в sprites.json не закрыта`)
  let block = text.slice(start, end + 1)
  const noteRe = /"note":\s*"(?:[^"\\]|\\.)*"/
  let note = part
  if (noteRe.test(block)) {
    const old = JSON.parse(block.match(noteRe)[0].replace(/^"note":\s*/, ''))
    const i = old.indexOf(MINIPC_NOTE)
    const keep = (i < 0 ? old : old.slice(0, i)).replace(/\s*·\s*$/, '')
    note = keep ? `${keep} · ${part}` : part
    block = block.replace(noteRe, () => `"note": ${JSON.stringify(note)}`)
  } else if (block.includes('\n')) {
    block = block.replace(/\s*\}$/, (tail) => `,\n      "note": ${JSON.stringify(note)}${tail}`)
  } else {
    block = block.replace(/\s*\}$/, (tail) => `, "note": ${JSON.stringify(note)}${tail}`)
  }
  const out = text.slice(0, start) + block + text.slice(end + 1)
  if (JSON.parse(out).sprites[key]?.note !== note) throw new Error('правка note сломала sprites.json')
  return out
}

async function committed() {
  if (!existsSync(ORIGIN_PATH)) die(`нет ${relative(ROOT, ORIGIN_PATH)} — ключ не забирали`)
  const provenance = JSON.parse(readFileSync(ORIGIN_PATH, 'utf8'))
  if (provenance.taskId !== TASK || provenance.rev !== REV) {
    die(`${relative(ROOT, ORIGIN_PATH)} — задание ${provenance.taskId}, ревизия ${provenance.rev}, а не ${TASK}#${REV}`)
  }
  const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'buffer' })
  const head = git('rev-parse', 'HEAD').toString().trim()
  const rel = relative(ROOT, PNG_PATH)
  let inHead
  try {
    inHead = git('show', `HEAD:${rel}`)
  } catch {
    die(`${rel} нет в HEAD — сначала коммит`)
  }
  if (sha256(inHead) !== provenance.sha256) die(`${rel} в HEAD — sha256 ${sha256(inHead)}, ревизия ${REV} — ${provenance.sha256}`)
  if (git('status', '--porcelain', '--', rel).toString().trim()) die(`${rel} изменён после HEAD — коммит не тот, что в рабочем дереве`)
  // minipc мог уйти вперёд после забора: новая ревизия принята — committed этой ревизии
  // записал бы в minipc финал, которого в репо нет.
  const job = await getJob(mp, TASK).catch((e) => die(e.message))
  const it = jobItems(job).find((x) => x.key === KEY)
  const stale = []
  if (it?.status !== 'accepted') stale.push(`статус ключа ${it?.status ?? 'нет ключа'}, нужен accepted`)
  if (it?.final?.rev !== REV) stale.push(`финал ключа — ревизия ${it?.final?.rev ?? 'не выбрана'}, а не ${REV}`)
  if (stale.length) die(`${KEY}#${REV} не помечен committed:\n  - ${stale.join('\n  - ')}`)
  const res = await postStatus(mp, TASK, KEY, { status: 'committed', reason: head })
  if (!res.ok) die(`committed не принят: ${res.status} ${res.error}`)
  console.log(`SPRITE-TAKE: ${KEY}#${REV} committed (${head})`)
}
