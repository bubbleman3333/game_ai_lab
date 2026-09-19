// 1 人分の画面（ホールド・盤面・ネクスト・予告・成績・消し方の表示）。

import { useEffect, useState, type ReactNode } from 'react'
import type { GameController } from '../engine'
import { clearLabel } from '../game/versus'
import { BoardCanvas } from './BoardCanvas'
import { PiecePreview } from './PiecePreview'

interface Props {
  controller: GameController
  title?: string
  cell?: number
  /** 盤面の上に重ねる表示（カウントダウン・勝敗など） */
  overlay?: ReactNode
}

export function PlayerView({ controller, title, cell = 28, overlay }: Props) {
  const g = controller.game
  const [label, setLabel] = useState<{ text: string; kind: string; key: number } | null>(null)
  // 演出のきっかけ（値が変わるたびにアニメーションをやり直す）
  const [flashKey, setFlashKey] = useState(0)
  const [shakeKey, setShakeKey] = useState(0)

  useEffect(
    () =>
      controller.onLock((r) => {
        const text = clearLabel(r)
        const kind = r.perfectClear ? 'pc' : r.spin !== 'none' ? 'tspin' : r.lines === 4 ? 'tetris' : 'normal'
        if (text) setLabel({ text, kind, key: performance.now() })
        if (r.lines > 0) setFlashKey((k) => k + 1)
        if (r.garbageReceived > 0) setShakeKey((k) => k + 1)
      }),
    [controller],
  )
  useEffect(() => {
    if (!label) return
    const t = window.setTimeout(() => setLabel(null), 1200)
    return () => window.clearTimeout(t)
  }, [label])

  const pending = g.pending.reduce((a, p) => a + p[0], 0)
  const s = g.stats
  const minutes = controller.playMs / 60000
  const apm = minutes > 0.05 ? s.attack / minutes : 0
  const pps = minutes > 0.05 ? s.pieces / (minutes * 60) : 0

  return (
    <div className="player">
      {title && <div className="player-title">{title}</div>}
      <div className="player-body">
        <div className="side">
          <div className="side-label">HOLD</div>
          <PiecePreview piece={g.hold} dim={!g.canHold} cell={Math.round(cell / 2)} />
          <dl className={`stats${cell < 16 ? ' compact' : ''}`}>
            <dt>ライン</dt><dd>{s.lines}</dd>
            <dt>火力</dt><dd>{s.attack}</dd>
            <dt>ミノ数</dt><dd>{s.pieces}</dd>
            <dt>T-Spin</dt><dd>{s.tspinClears}</dd>
            <dt>テトリス</dt><dd>{s.tetrises}</dd>
            <dt>APM</dt><dd>{apm.toFixed(1)}</dd>
            <dt>PPS</dt><dd>{pps.toFixed(2)}</dd>
          </dl>
        </div>
        <div className="garbage-meter" style={{ height: 20 * cell }} title={`予告 ${pending} 段`}>
          <div className="garbage-fill" style={{ height: Math.min(20, pending) * cell }} />
        </div>
        <div className={`board-wrap${shakeKey ? ' shake' : ''}`} key={`shake-${shakeKey}`}>
          <BoardCanvas
            colors={g.board.colors}
            current={g.current}
            ghostY={g.current ? g.ghostY() : null}
            cell={cell}
            dim={g.over}
          />
          {flashKey > 0 && <div key={`flash-${flashKey}`} className="line-flash" />}
          {label && (
            <div key={label.key} className={`clear-label ${label.kind}`}>
              {label.text}
            </div>
          )}
          {g.over && !overlay && <div className="overlay">GAME OVER</div>}
          {overlay && <div className="overlay">{overlay}</div>}
        </div>
        <div className="side">
          <div className="side-label">NEXT</div>
          {g.nextPieces.map((p, i) => (
            <PiecePreview key={i} piece={p} cell={Math.round(cell / 2)} />
          ))}
        </div>
      </div>
    </div>
  )
}
