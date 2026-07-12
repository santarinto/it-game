import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    proxy: {
      // dev: WebSocket идёт через Vite на Go-сервер
      '/ws': { target: 'ws://localhost:8080', ws: true },
      '/admin': 'http://localhost:8080',
    },
  },
})
