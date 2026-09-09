import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    proxy: {
      // dev: WebSocket идёт через Vite на Go-сервер
      '/ws': { target: 'ws://localhost:8080', ws: true },
      '/admin': 'http://localhost:8080',
      // dev: /api/debug/* (ITGAME-26) — на Go-сервер, как в проде same-origin
      '/api': 'http://localhost:8080',
    },
  },
})
