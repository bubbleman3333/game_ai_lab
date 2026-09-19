// 新しい版が公開されたら知らせる。開いたままの古い画面で、直したはずの不具合が残って見えるのを防ぐ。
// 1 分ごとにトップの HTML を読み、読み込んでいるプログラム（/assets/index-xxxx.js）の名前が変わっていたら出す。

import { useEffect, useState } from 'react'

const CHECK_MS = 60_000

function currentBundle(): string | null {
  const s = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index"]')
  return s ? new URL(s.src).pathname : null
}

export function UpdateNotice() {
  const [outdated, setOutdated] = useState(false)
  useEffect(() => {
    const mine = currentBundle()
    if (!mine) return // 開発用の配信（npm run dev）では何もしない
    const check = async () => {
      try {
        const html = await (await fetch('/', { cache: 'no-store' })).text()
        const latest = html.match(/\/assets\/index-[^"]+\.js/)?.[0]
        if (latest && latest !== mine) setOutdated(true)
      } catch {
        /* 通信できないときは次回また調べる */
      }
    }
    const t = window.setInterval(check, CHECK_MS)
    const onFocus = () => void check()
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(t)
      window.removeEventListener('focus', onFocus)
    }
  }, [])
  if (!outdated) return null
  return (
    <div className="update-notice" role="status">
      新しい版があります。
      <button onClick={() => location.reload()}>更新する</button>
    </div>
  )
}
