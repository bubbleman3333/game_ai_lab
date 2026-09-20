// ブロブチェインの一人用。組を置くほど落ちる速さが上がる。ハイスコアはブラウザに保存。
// AI の使い方を 3 つから選べる（使わない／お手本を見る／AI に任せる）。

import { useEffect, useMemo, useRef, useState } from 'react'
import { isTouchDevice } from '../../../lib/useViewport'
import { useGameLoop } from '../../../lib/useGameLoop'
import { useBlobAgents } from '../api/ai'
import { BlobAiControls, BlobAiVersion } from '../components/BlobAiControls'
import { BlobPlayer } from '../components/BlobPlayer'
import { BlobTouch } from '../components/BlobTouch'
import type { HintRef } from '../components/BlobCanvas'
import { BlobController } from '../engine/controller'
import { BlobGame } from '../engine/game'
import { BLOB_AI_SPEEDS, BlobAiPlayer, DEFAULT_BLOB_AI_SPEED } from '../game/aiPlayer'
import { BlobInput, KEY_HELP } from '../game/input'
import { attachBlobSounds } from '../sounds'

const BEST_KEY = 'game-ai-lab:blob:best'

/** AI の使い方 */
type AiMode = 'off' | 'hint' | 'auto'

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
  const [aiMode, setAiMode] = useState<AiMode>('off')
  const [agent, setAgent] = useState('')
  const [speed, setSpeed] = useState(DEFAULT_BLOB_AI_SPEED)
  const [aiError, setAiError] = useState<string | null>(null)
  const drawRef = useRef<((now: number) => void) | null>(null)
  const hint: HintRef = useRef<{ x: number; rot: number } | null>(null)
  const { agents } = useBlobAgents()

  const controller = useMemo(() => new BlobController(new BlobGame(Math.floor(Math.random() * 2 ** 31))), [round])
  const input = useMemo(() => new BlobInput(controller), [controller])
  const ai = useMemo(() => {
    if (aiMode === 'off') return null
    const p = new BlobAiPlayer(controller, {
      agent, ...BLOB_AI_SPEEDS[speed], advise: aiMode === 'hint',
    })
    p.onError = setAiError
    return p
  }, [controller, aiMode, agent, speed])

  // AI に任せているときはキー操作をつながない（AI の操作と取り合いになるため）
  useEffect(() => (aiMode === 'auto' ? undefined : input.attach()), [input, aiMode])
  useEffect(() => attachBlobSounds(controller), [controller])
  useEffect(() => {
    if (!ai) {
      hint.current = null
      setAiError(null)
      return
    }
    ai.start()
    return () => {
      ai.stop()
      hint.current = null
    }
  }, [ai])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'KeyR') setRound((r) => r + 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // レベル: 30 組ごとに速くなる。AI に任せているときは AI の速さにまかせる
  const level = Math.floor(controller.game.stats.pairs / 30) + 1
  controller.gravityMs = aiMode === 'auto' ? 60_000 : Math.max(90, 700 - (level - 1) * 70)

  useGameLoop(
    [
      input,
      ...(ai ? [ai] : []),
      {
        update: (t: number) => {
          hint.current = aiMode === 'hint' ? (ai?.hint?.placement ?? null) : null
          controller.update(t)
          drawRef.current?.(t)
        },
      },
    ],
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

  const expected = aiMode === 'hint' ? ai?.hint?.expected : undefined

  return (
    <div className="page blob-page">
      <h1>ブロブチェイン <span className="muted small">ひとりで</span></h1>
      <div className="controls-row">
        <button onClick={() => setRound((r) => r + 1)}>やり直す（R）</button>
        <span className="muted">レベル {level}</span>
        <span className="muted">ハイスコア {best.toLocaleString()}</span>
        <label>
          AI
          <select value={aiMode} onChange={(e) => setAiMode(e.target.value as AiMode)}>
            <option value="off">使わない</option>
            <option value="hint">お手本（置き場所を教わる）</option>
            <option value="auto">AI に任せる（観戦）</option>
          </select>
        </label>
      </div>
      {aiMode !== 'off' && (
        <>
          <BlobAiControls agents={agents} agent={agent} onAgent={setAgent} speed={speed} onSpeed={setSpeed} />
          <BlobAiVersion agent={ai?.lastAgent ?? null} />
        </>
      )}
      {aiError && <p className="error">{aiError}</p>}
      {expected && (
        <p className="muted small">
          AI のおすすめ: {expected.chain > 0 ? `${expected.chain} 連鎖（おじゃま ${expected.sent} 個）` : '連鎖はまだ（形を作る手）'}
        </p>
      )}
      <div className="blob-arena">
        <BlobPlayer
          controller={controller}
          drawRef={drawRef}
          hint={hint}
          overlay={over ? (
            <div className="blob-result">
              <div className="big">GAME OVER</div>
              <div>スコア {controller.game.score.toLocaleString()} / 最大 {controller.game.maxChain} 連鎖</div>
              <button onClick={() => setRound((r) => r + 1)}>もう一度</button>
            </div>
          ) : undefined}
        />
      </div>
      {aiMode === 'auto' ? null
        : isTouchDevice() ? <BlobTouch input={input} /> : <p className="key-help">{KEY_HELP} / R やり直す</p>}
      <p className="muted small blob-rule">同じ色を 4 つ以上つなげると消えます。消えたあとに落ちた粒がまたつながると「連鎖」。連鎖が多いほど高得点で、対戦では相手におじゃまを送れます。</p>
    </div>
  )
}
