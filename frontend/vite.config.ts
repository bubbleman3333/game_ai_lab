import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// 開発時は /api と /ws を Django（localhost:8000）へ転送する
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Cloudflare のクイックトンネル（*.trycloudflare.com）経由のアクセスを許可する
    allowedHosts: ['.trycloudflare.com'],
    proxy: {
      '/api': { target: 'http://localhost:8000', changeOrigin: true },
      '/ws': { target: 'ws://localhost:8000', ws: true },
    },
  },
  // 公開用（npm run build の結果を配信する vite preview）も、同じ転送とホスト許可を使う
  preview: {
    port: 5173,
    allowedHosts: ['.trycloudflare.com'],
    proxy: {
      '/api': { target: 'http://localhost:8000', changeOrigin: true },
      '/ws': { target: 'ws://localhost:8000', ws: true },
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
})
