// タイトル画面。夜の森の上に大きな題名を出し、「はじめる」を打つと始まる（クリック・Enter でもよい）。
// 最初の 1 画面で「これはタイピングゲームで、言葉を打つと光る」が伝わるようにしている。

import { useEffect, useMemo, useState } from 'react'
import { RomajiMatcher } from '../sim/romaji'
import { typingSounds } from '../sounds'

export function TitleScreen({ onStart }: { onStart: () => void }) {
  const matcher = useMemo(() => new RomajiMatcher('はじめる'), [])
  const [typed, setTyped] = useState('')
  const [shake, setShake] = useState(0)
  const [lit, setLit] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (lit || e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key === 'Enter') {
        e.preventDefault()
        setLit(true)
        return
      }
      if (e.key.length !== 1) return
      if (matcher.key(e.key.toLowerCase())) {
        typingSounds.key(matcher.typed.length * 4)
        setTyped(matcher.typed)
        if (matcher.done) setLit(true)
      } else {
        typingSounds.miss()
        setShake((n) => n + 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [matcher, lit])

  // 打ち終えたら、文字が光って少し間を置いてから次へ
  useEffect(() => {
    if (!lit) return
    typingSounds.kill(true)
    const t = setTimeout(onStart, 900)
    return () => clearTimeout(t)
  }, [lit, onStart])

  return (
    <div className={lit ? 'typing-title lit' : 'typing-title'} onClick={() => setLit(true)}>
      <div className="typing-title-logo">
        <ruby>灯守<rt>ひもり</rt></ruby>
      </div>
      <div className="typing-title-sub">― 夜の森を灯せ ―</div>
      <p className="typing-title-tag">夜明けまでに、影にさらわれた妹を連れ戻せ。</p>

      <div key={shake} className={shake ? 'typing-title-prompt typing-label locked shake' : 'typing-title-prompt typing-label locked'}>
        <div className="typing-label-text">はじめる</div>
        <div className="typing-label-roma">
          <span className="typed">{typed}</span>
          <span>{matcher.rest}</span>
        </div>
      </div>
      <p className="typing-title-hint">キーボードで <b>hajimeru</b> と打つ（クリック・Enter でも始まる）</p>
      <p className="typing-title-foot">全 5 章の物語 ・ ボス戦 ・ セーブ 3 つ ・ パソコンのキーボード推奨</p>
    </div>
  )
}
