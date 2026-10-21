import { defineConfig, type Plugin } from 'vite'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Штамп сборки (ITGAME-28): sha коммита и время билда. Пробрасываются в
// бандл (define) и в <meta name="build"> — «доехала ли правка до стенда»
// проверяется без хэша в имени файла. Dev-сервер штампует на старте.
//
// Релиз собирается из git archive — .git там нет, и рецепт деплоя должен
// передавать sha в BUILD_SHA (ITGAME-81); tools/deploy передаёт его с
// ITGAME-98.
// Берём его только как hex-sha git (7..40, нижний регистр): в meta и define не
// попадает произвольная строка. Иное значение — предупреждение и откат на git,
// а не падение сборки: имя переменной общее, случайное значение в шелле не
// должно ронять make build и QA, а рецепты передают sha из git.
const SHA_RE = /^[0-9a-f]{7,40}$/

// Версия сборки год.мес.день.час.мин (ITGAME-140): время коммита по Москве (MSK-3 — POSIX TZ,
// UTC+3 без tzdata), как -X ws.buildVersion сервера. Релиз (архив без .git) передаёт её в
// BUILD_VERSION; иначе git; не git-чекаут — 'dev'.
const VERSION_RE = /^\d{4}\.\d{2}\.\d{2}\.\d{2}\.\d{2}$/

function buildVersion(): string {
  const fromEnv = process.env.BUILD_VERSION ?? ''
  if (VERSION_RE.test(fromEnv)) return fromEnv
  if (fromEnv !== '') {
    console.warn(`[itd-build-meta] BUILD_VERSION=${JSON.stringify(fromEnv.slice(0, 64))} — не год.мес.день.час.мин, беру git`)
  }
  try {
    const v = execSync('git log -1 --format=%cd --date=format-local:%Y.%m.%d.%H.%M', {
      stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, TZ: 'MSK-3' },
    }).toString().trim()
    if (VERSION_RE.test(v)) return v
  } catch {
    // не git-чекаут и без BUILD_VERSION — честный 'dev'
  }
  return 'dev'
}

function buildStamp() {
  const builtAt = new Date().toISOString()
  const fromEnv = process.env.BUILD_SHA ?? ''
  if (SHA_RE.test(fromEnv)) return { sha: fromEnv, builtAt }
  if (fromEnv !== '') {
    console.warn(
      `[itd-build-meta] BUILD_SHA=${JSON.stringify(fromEnv.slice(0, 64))} — не hex-sha (7..40, нижний регистр), беру git`,
    )
  }
  let sha = 'dev'
  try {
    sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    // не git-чекаут и без BUILD_SHA (архив, собранный вручную) — честный 'dev'
  }
  return { sha, builtAt }
}

const stamp = { ...buildStamp(), version: buildVersion() }

// <meta name="build" content="5026a2d 2026-09-09T…"> в <head> index.html.
function buildMeta(): Plugin {
  return {
    name: 'itd-build-meta',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<title>IT Director</title>',
        `<title>IT Director</title>\n    <meta name="build" content="${stamp.sha} ${stamp.builtAt}" />`,
      )
    },
  }
}

export default defineConfig({
  define: {
    __BUILD_SHA__: JSON.stringify(stamp.sha),
    __BUILD_AT__: JSON.stringify(stamp.builtAt),
    __BUILD_VERSION__: JSON.stringify(stamp.version),
  },
  plugins: [buildMeta()],
  build: {
    // Смоук-скриншоты и прод-дебаг: клиент читает несжатые имена, но
    // наружу карта не светится (нет sourceMappingURL в бандле); сами
    // .map отдаются Go-сервером за ITGAME_SOURCEMAP_TOKEN (ITGAME-28).
    sourcemap: 'hidden',
    // Два входа (ITGAME-161): игра и заглушка мобильного захода, куда уводит гейт
    // index.html; по адресу /mobile.html потом встанет мобильный клиент (ITGAME-227).
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        mobile: fileURLToPath(new URL('./mobile.html', import.meta.url)),
      },
    },
  },
  server: {
    proxy: {
      // dev: WebSocket идёт через Vite на Go-сервер
      '/ws': { target: 'ws://localhost:8080', ws: true },
      '/admin': 'http://localhost:8080',
      // dev: /api/debug/* (ITGAME-26) — на Go-сервер, как в проде same-origin
      '/api': 'http://localhost:8080',
    },
  },
  preview: {
    proxy: {
      '/ws': { target: 'ws://localhost:8080', ws: true },
      '/admin': 'http://localhost:8080',
      '/api': 'http://localhost:8080',
    },
  },
})
