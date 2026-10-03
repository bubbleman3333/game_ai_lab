// 灯守を単独のサイトとして動かす入口（typing.html から読み込む）。
// Game AI Lab のメニューや利用状況の送信（/api）は使わない。サーバーは要らない。
// 書き出しは `npm run build:typing`（vite.typing.config.ts）、公開は `npm run deploy:typing`。

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import '../../styles.css'
import { TypingPage } from './pages/TypingPage'
import { runtime } from './runtime'

runtime.standalone = true

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <TypingPage />
    </BrowserRouter>
  </StrictMode>,
)
