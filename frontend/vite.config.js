import process from 'node:process'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const proxyTarget = env.VITE_API_PROXY_TARGET?.trim()
  if (!proxyTarget) {
    throw new Error('Missing required environment variable: VITE_API_PROXY_TARGET')
  }

  return {
    plugins: [react()],
    server: {
      port: 5173,
      // The dev server forwards /api to the API, so the browser sees one origin
      // (no CORS in development). Configure the target with VITE_API_PROXY_TARGET.
      proxy: {
        '/api': { target: proxyTarget, changeOrigin: true },
        // Socket.IO (Sprint 6C): HTTP long-polling plus the WebSocket upgrade.
        '/socket.io': { target: proxyTarget, changeOrigin: true, ws: true },
      },
    },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.js'],
      css: false,
      restoreMocks: true,
    },
  }
})
