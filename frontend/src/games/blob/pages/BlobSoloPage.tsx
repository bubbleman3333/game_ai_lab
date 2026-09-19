// ブロブチェインの一人用。組を置くほど落ちる速さが上がる。ハイスコアはブラウザに保存。

import { useEffect, useMemo, useRef, useState } from 'react'
import { isTouchDevice } from '../../../lib/useViewport'
import { useGameLoop } from '../../../lib/useGameLoop'
import { BlobPlayer } from '../components/BlobPlayer'
import { BlobTouch } from '../components/BlobTouch'
import { BlobController } from '../engine/controller'
import { BlobGame } from '../engine/game'
import { BlobInput, KEY_HELP } from '../game/input'
import { attachBlobSounds } from '../sounds'

const BEST_KEY = 'game-ai-lab:blob:best'

function loadBest(): number {
  try {
    return Number(localStorage.getItem(BEST_KEY) ?? 0)
  } catch {
    return 0
  }
}

export function BlobSoloPage() {
  const [round, setRound] = useState(0)
  const [best, setBest] = useState(loadBest)
  const drawRef = useRef<((now: number) => void) | null>(null)

  const controller = useMemo(() => new BlobController(new BlobGame(Math.floor(Math.random() * 2 ** 31))), [round])
  const input = useMemo(() => new BlobInput(controller), [controller])
  useEffect(() => input.attach(), [input])
  useEffect(() => attachBlobSounds(controller), [controller])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'KeyR') setRound((r) => r + 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // レベル: 30 組ごとに速くなる
  const level = Math.floor(controller.game.stats.pairs / 30) + 1
  controller.gravityMs = Math.max(90, 700 - (level - 1) * 70)

  useGameLoop(
    [input, { update: (t: number) => { controller.update(t); drawRef.current?.(t) } }],
    [],
    () => controller.version,
  )

  const over = controller.phase === 'over'
  useEffect(() => {
    if (!over) return
    const s = controller.game.score
    if (s > best) {
      setBest(s)
      try {
        localStorage.setItem(BEST_KEY, String(s))
      } catch {
        /* 保存できなくてもよい */
      }
    }
  }, [over, controller, best])

  return (
    <div className="page blob-page">
      <h1>ブロブチェイン <span className="muted small">ひとりで</span></h1>
      <div className="controls-row">
        <button onClick={() => setRound((r) => r + 1)}>やり直す（R）</button>
        <span className="muted">レベル {level}</span>
        <span className="muted">ハイスコア {best.toLocaleString()}</span>
      </div>
      <div className="blob-arena">
        <BlobPlayer
          controller={controller}
          drawRef={drawRef}
          overlay={over ? (
            <div className="blob-result">
              <div className="big">GAME OVER</div>
              <div>スコア {controller.game.score.toLocaleString()} / 最大 {controller.game.maxChain} 連鎖</div>
              <button onClick={() => setRound((r) => r + 1)}>もう一度</button>
            </div>
          ) : undefined}
        />
      </div>
      {isTouchDevice() ? <BlobTouch input={input} /> : <p className="key-help">{KEY_HELP} / R やり直す</p>}
      <p className="muted small blob-rule">同じ色を 4 つ以上つなげると消えます。消えたあとに落ちた粒がまたつながると「連鎖」。連鎖が多いほど高得点で、対戦では相手におじゃまを送れます。</p>
    </div>
  )
}
