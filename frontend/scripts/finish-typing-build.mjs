// npm run build:typing の仕上げ: dist-typing/typing.html を index.html に名前を変える
// （Cloudflare Workers はサイトの入口として index.html を返すため）。
import { existsSync, renameSync } from 'node:fs'

const from = 'dist-typing/typing.html'
if (!existsSync(from)) {
  console.error(`${from} がありません。先に vite build -c vite.typing.config.ts を実行してください`)
  process.exit(1)
}
renameSync(from, 'dist-typing/index.html')
console.log('dist-typing/index.html を作りました')
