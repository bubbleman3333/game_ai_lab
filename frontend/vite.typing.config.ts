// 灯守を単独のサイトとして書き出す設定（npm run build:typing）。
// 入口は typing.html、出力は dist-typing/。書き出したあと typing.html を index.html に名前を変える
// （scripts/finish-typing-build.mjs）。公開は Cloudflare Workers（typing.wrangler.jsonc）。
//
// 静的ファイル（public/ の画像など）は public-typing/ から入れる（Game AI Lab 本体の public/ は持ち込まない）。

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  publicDir: 'public-typing',
  build: {
    outDir: 'dist-typing',
    emptyOutDir: true,
    rollupOptions: { input: 'typing.html' },
  },
})
