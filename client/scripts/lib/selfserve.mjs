// selfserve — общий self-serve для QA-скриптов (visreg,
// qa-itgame16/17/37/38/39/47, qa-office-slots, qa-itgame35): поднимает
// bin/itdirector со static=dist, чтобы сценарии крутились без внешнего
// сервера.
//
// Раньше каждый скрипт носил свою копию selfServe() с тремя дырами:
//  - готовность проверялась только GET /admin === 200 — если порт уже
//    занят ЧУЖИМ сервером, наш бинарь молча падал на bind, а прогон шёл
//    против чужого dist (воспроизведено на visreg: overlaps старой сборки);
//  - процесс поднимался с stdio:'ignore' — при падении на старте не было
//    видно причины;
//  - цикл ожидания не следил за exit процесса и тупо ждал таймаут, даже
//    если бинарь уже умер.
//
// Этот модуль закрывает все три (плюс ещё две, ITGAME-57): порт проверяется ДО spawn, stderr
// собирается в буфер и печатается хвостом при ошибке, а цикл ожидания
// прерывается сразу на exit процесса. После готовности сверяется, что
// сервер отдаёт именно наш dist (по имени бандла из index.html) — вторая
// защита от «прогон против чужого сервера», уже после старта (например,
// если порт был свободен на проверке, но чужой процесс занял его первым
// в гонке).
//
// ITGAME-57: бинарь пересобирается при КАЖДОМ запуске (go build во временный
// файл + атомарный rename; no-op relink < 1 с, а mtime ненадёжен при смене
// веток и в worktree) — QA не бежит против устаревшего bin/itdirector. Порты
// из WHATWG bad ports отклоняются до spawn: fetch() и Chromium к ним не
// подключатся, и прогон иначе молча упёрся бы в таймаут готовности.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const LIB_DIR = dirname(fileURLToPath(import.meta.url))
const CLIENT_DIR = dirname(dirname(LIB_DIR)) // client/scripts/lib → client
const REPO_DIR = join(CLIENT_DIR, '..')
const DIST_DIR = join(CLIENT_DIR, 'dist')
const BIN_PATH = join(REPO_DIR, 'bin', 'itdirector')
const STDERR_TAIL = 4000

// Порты, к которым fetch() (undici) и Chromium не подключаются: список
// https://fetch.spec.whatwg.org/#port-blocking. Node не отдаёт его API —
// fetch падает TypeError('fetch failed') с cause.message === 'bad port'.
const BAD_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110,
  111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061,
  6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
])
const badPortMessage = (port) =>
  `порт ${port} в списке запрещённых портов WHATWG (bad ports) — fetch() и Chromium к нему не подключатся; задайте другой порт (QA_PORT / VISREG_PORT)`

// Имя главного бандла из <script src="/assets/index-XXXX.js"> — короче и
// надёжнее хэша, отличается на каждую сборку (vite хэширует по контенту).
function mainBundleName(html) {
  const m = html.match(/\/assets\/(index-[^"'?]+\.js)/)
  return m ? m[1] : null
}

// true — порт свободен (connect дал именно ECONNREFUSED). Любой другой
// исход (кто-то ответил, таймаут, другая ошибка) трактуем как «занято» —
// безопаснее отказаться от spawn, чем случайно сесть поверх чужого сервера.
function portIsFree(port) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (free) => {
      if (settled) return
      settled = true
      sock.destroy()
      resolve(free)
    }
    const sock = net.connect({ host: '127.0.0.1', port })
    sock.once('connect', () => finish(false))
    sock.once('error', (err) => finish(err.code === 'ECONNREFUSED'))
    sock.setTimeout(1000, () => finish(false))
  })
}

/**
 * @param {{ port: number, saves?: 'off' | 'tmp' | string, label: string }} opts
 * @returns {Promise<{ base: string, stop: () => Promise<void> }>}
 */
export async function selfServe({ port, saves = 'off', label }) {
  const tag = label || 'QA'
  if (!port) throw new Error(`${tag} FAIL: selfServe() вызван без port`)
  if (BAD_PORTS.has(Number(port))) throw new Error(`${tag} FAIL: ${badPortMessage(port)}`)

  if (!existsSync(join(DIST_DIR, 'index.html'))) {
    throw new Error(`${tag} FAIL: нет client/dist — сначала npm run build`)
  }
  const distHtml = readFileSync(join(DIST_DIR, 'index.html'), 'utf8')
  const expectedBundle = mainBundleName(distHtml)

  // Всегда пересобираем: во временный файл, затем атомарный rename — параллельный
  // прогон не словит ETXTBSY на запущенном бинаре и не увидит недописанный файл.
  const tmpBin = `${BIN_PATH}.${process.pid}.tmp`
  try {
    execFileSync('go', ['build', '-o', tmpBin, './cmd/server'], {
      cwd: join(REPO_DIR, 'server'),
      stdio: 'inherit',
    })
    renameSync(tmpBin, BIN_PATH)
  } catch (e) {
    rmSync(tmpBin, { force: true })
    throw new Error(`${tag} FAIL: go build сервера упал: ${e instanceof Error ? e.message : String(e)}`)
  }

  if (!(await portIsFree(port))) {
    throw new Error(`${tag} FAIL: порт ${port} занят чужим процессом — освободите его или задайте другой порт`)
  }

  let savesArg = saves
  let cleanupSaves = () => {}
  if (saves === 'tmp') {
    savesArg = mkdtempSync(join(tmpdir(), 'qa-saves-'))
    cleanupSaves = () => {
      try {
        rmSync(savesArg, { recursive: true, force: true })
      } catch {
        // не критично для QA
      }
    }
  }

  let stderrBuf = ''
  // ITGAME_DEBUG=1: QA/visreg говорят с /api/debug/* (itd.set/advance/…) и
  // могут понадобиться /ws/agent — без флага main.go не регистрирует эти
  // маршруты вовсе (гейт ITGAME-26/29, см. server/cmd/server/main.go).
  const proc = spawn(BIN_PATH, ['-addr', `127.0.0.1:${port}`, '-static', DIST_DIR, '-saves', savesArg], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, ITGAME_DEBUG: '1' },
  })
  proc.stderr.on('data', (d) => {
    stderrBuf = (stderrBuf + d.toString()).slice(-STDERR_TAIL)
  })
  let exited = null
  proc.once('exit', (code, signal) => {
    exited = { code, signal }
  })
  // ошибка самого spawn (ENOENT/EACCES): без обработчика — uncaught 'error'
  let spawnError = null
  proc.once('error', (e) => {
    spawnError = e
  })

  const base = `http://127.0.0.1:${port}`
  const failWith = (msg) => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
    cleanupSaves()
    const tail = stderrBuf.trim() ? `\n--- stderr (${tag}, :${port}) ---\n${stderrBuf.trim()}` : ''
    throw new Error(`${tag} FAIL: ${msg}${tail}`)
  }

  let ready = false
  for (let i = 0; i < 40; i++) {
    if (spawnError) failWith(`не удалось запустить ${BIN_PATH}: ${spawnError.message}`)
    if (exited) failWith(`Go-сервер завершился раньше готовности (code=${exited.code} signal=${exited.signal})`)
    try {
      const r = await fetch(`${base}/admin`)
      if (r.ok) {
        ready = true
        r.body?.cancel()
        break
      }
      r.body?.cancel()
    } catch (e) {
      // bad port не лечится ожиданием — не ждём 10 с таймаута
      if (e?.cause?.message === 'bad port') failWith(badPortMessage(port))
      // иначе сервер ещё поднимается
    }
    await delay(250)
  }
  if (!ready) failWith(`Go-сервер не поднялся на :${port}`)

  // Вторая защита: сверяем, что / реально отдаёт наш dist, а не чужой
  // сервер, который занял порт между проверкой portIsFree() и spawn().
  try {
    const r = await fetch(`${base}/`)
    const body = await r.text()
    const gotBundle = mainBundleName(body)
    const matches = expectedBundle ? gotBundle === expectedBundle : body === distHtml
    if (!matches) {
      failWith(
        `сервер на :${port} отдаёт не наш dist (ожидался бандл ${expectedBundle ?? '(файл целиком)'}, получен ${gotBundle ?? '(не найден)'})`,
      )
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith(`${tag} FAIL:`)) throw e
    failWith(`не удалось проверить / после готовности: ${e instanceof Error ? e.message : String(e)}`)
  }

  async function stop() {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGKILL')
      await Promise.race([new Promise((resolve) => proc.once('exit', resolve)), delay(5000)])
    }
    cleanupSaves()
  }

  return { base, stop }
}
