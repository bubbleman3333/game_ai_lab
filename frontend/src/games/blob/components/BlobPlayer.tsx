// 1 人分の画面（盤・ネクスト・得点・予告おじゃま）。一人用とオンライン対戦で共通。

import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import type { BlobController } from '../engine/controller'
import { BlobCanvas, Effects, PairPreview, type HintRef } from './BlobCanvas'

/** 予告おじゃまのアイコン（大きい玉 = 6 個、岩 = 30 個） */
function PendingIcons({ n }: { n: number }) {
  const rocks = Math.floor(n / 30)
  const big = Math.floor((n % 30) / 6)
  const small = n % 6
  const icons = [...Array(rocks).fill('rock'), ...Array(big).fill('big'), ...Array(small).fill('small')].slice(0, 6)
  return (
    <div className="blob-pending" title={`予告 ${n} 個`}>
      {icons.map((k, i) => <span key={i} className={`pending-${k}`} />)}
    </div>
  )
}

export function BlobPlayer({ controller, title, overlay, drawRef, hint }: {
  controller: BlobController
  title?: string
  overlay?: ReactNode
  drawRef: { current: ((now: number) => void) | null }
  /** AI のおすすめの置き場所（一人用の「お手本」） */
  hint?: HintRef
}) {
  const effects = useMemo(() => new Effects(), [controller])
  const colorsRef = useRef<string[]>([])

  // 出来事から演出（粒子・連鎖の文字・揺れ）を作る
  useEffect(() => {
    colorsRef.current = ['', '--blob-1', '--blob-2', '--blob-3', '--blob-4', '--blob-garbage'].map((v) =>
      v ? getComputedStyle(document.documentElement).getPropertyValue(v).trim() : '')
    return controller.on((e) => {
      const now = performance.now()
      if (e.type === 'pop') effects.burst(e.step.cells, colorsRef.current, now, e.step.chain)
      if (e.type === 'allClear') effects.allClear(now)
    })
  }, [controller, effects])

  const g = controller.game
  return (
    <div className="blob-player">
      {title && <div className="player-title">{title}</div>}
      <PendingIcons n={g.pending} />
      <div className="blob-body">
        <div className="blob-board">
          <BlobCanvas controller={controller} effects={effects} draw={drawRef} hint={hint} />
          {overlay && <div className="overlay">{overlay}</div>}
        </div>
        <div className="blob-side">
          <div className="side-label">NEXT</div>
          {g.next[0] && <PairPreview pair={g.next[0]} size={30} />}
          {g.next[1] && <PairPreview pair={g.next[1]} size={22} />}
          <dl className="stats blob-stats">
            <dt>スコア</dt><dd>{g.score.toLocaleString()}</dd>
            <dt>最大連鎖</dt><dd>{g.maxChain}</dd>
            <dt>送った</dt><dd>{g.stats.sent}</dd>
          </dl>
        </div>
      </div>
    </div>
  )
}
