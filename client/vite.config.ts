import { defineConfig, type Plugin } from 'vite'
import { execSync } from 'node:child_process'

// Штамп сборки (ITGAME-28): sha коммита и время билда. Пробрасываются в
// бандл (define) и в <meta name="build"> — «доехала ли правка до стенда»
// проверяется без хэша в имени файла. Dev-сервер штампует на старте.
function buildStamp() {
  let sha = 'dev'
  try {
    sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    // не git-чекаут (например, сборка из архива) — честный 'dev'
  }
  const builtAt = new Date().toISOString()
  return { sha, builtAt }
}

const stamp = buildStamp()

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
  },
  plugins: [buildMeta()],
  build: {
    // Смоук-скриншоты и прод-дебаг: клиент читает несжатые имена, но
    // наружу карта не светится (нет sourceMappingURL в бандле); сами
    // .map отдаются Go-сервером за ITGAME_SOURCEMAP_TOKEN (ITGAME-28).
    sourcemap: 'hidden',
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
