// エアホッケーで AI と対戦する画面。マウス（タッチ）で手前のマレットを動かす。

import { useEffect, useMemo, useRef, useState } from 'react'
import { useGameLoop } from '../../../lib/useGameLoop'
import { fetchAgents, fetchPolicy, saveMatch, type AirHockeyAgentDto } from '../api/airhockey'
import { GOAL_HALF, L, MALLET_R, PUCK_R, W, type State } from '../engine/physics'
import { Policy } from '../engine/policy'
import { AirHockeyMatch, WIN_SCORE } from '../game/match'
import { airhockeySounds } from '../sounds'

export const LEVELS: Record<string, { label: string; speed: number }> = {
  easy: { label: 'ゆっくり（AI の速さ 60%）', speed: 0.6 },
  normal: { label: 'ふつう（80%）', speed: 0.8 },
  max: { label: '全力（100%）', speed: 1.0 },
}

const SCALE = 300 // 台の 1 単位 = 300px
const CANVAS_W = W * SCALE
const CANVAS_H = L * SCALE

export function AirHockeyPage() {
  const [agents, setAgents] = useState<AirHockeyAgentDto[]>([])
  const [agent, setAgent] = useState('')
  const [level, setLevel] = useState('max')
  const [policy, setPolicy] = useState<{ policy: Policy | null; episode: number | null } | null>(null)
  const [round, setRound] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [, setTick] = useState(0)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    fetchAgents()
      .then((list) => {
        setAgents(list)
        setAgent((cur) => cur || list[0]?.id || 'heuristic')
      })
      .catch((e: Error) => {
        setError(`${e.message}（学習なしの AI で遊べます）`)
        setAgent('heuristic')
      })
  }, [])

  // AI の方策を読み込む
  useEffect(() => {
    if (!agent) return
    if (agent === 'heuristic') {
      setPolicy({ policy: null, episode: null })
      return
    }
    let cancelled = false // 読み込み中に AI を選び直したら、古い結果は使わない
    setPolicy(null)
    fetchPolicy(agent)
      .then((json) => !cancelled && setPolicy({ policy: new Policy(json), episode: json.meta?.episode ?? null }))
      .catch((e: Error) => {
        if (cancelled) return
        setError(`${e.message}（学習なしの AI で遊べます）`)
        setPolicy({ policy: null, episode: null })
      })
    return () => {
      cancelled = true
    }
  }, [agent])

  const match = useMemo(() => {
    if (!policy) return null
    const startedAt = performance.now()
    const m: AirHockeyMatch = new AirHockeyMatch(policy.policy, LEVELS[level].speed, {
      onStep: (ev, s) => {
        if (ev.hitMallet) airhockeySounds.hit(Math.hypot(s.pvx, s.pvy))
        else if (ev.hitWall) airhockeySounds.wall()
      },
      onGoal: (mine) => airhockeySounds.goal(mine),
      onEnd: (won) => {
        setTimeout(won ? airhockeySounds.win : airhockeySounds.lose, 300)
        saveMatch({
          agent, level, human_score: m.humanScore, ai_score: m.aiScore,
          duration_sec: (performance.now() - startedAt) / 1000,
        }).catch(() => undefined)
      },
    })
    return m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [policy, level, round])

  // サーブ前のカウントダウン音
  const waitSec = match ? Math.ceil(match.waitMs / 400) : 0
  useEffect(() => {
    if (!match || match.over) return
    if (waitSec > 0) airhockeySounds.countdown(false)
  }, [waitSec, match])

  useGameLoop(
    match ? [{ update: (t: number) => { match.update(t); draw(canvasRef.current, match.state) } }] : [],
    [],
    () => (match ? `${match.humanScore}-${match.aiScore}-${match.over}-${waitSec}` : 'none'),
  )
  useEffect(() => setTick((t) => t + 1), [match])

  // マウス・タッチの位置を台の座標にする（画面の下が手前）
  const onPointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!match) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * W
    const y = (1 - (e.clientY - rect.top) / rect.height) * L
    match.setTarget(x, y)
  }

  return (
    <div className="page">
      <h1>エアホッケー</h1>
      <div className="controls-row">
        <label>
          AI
          <select value={agent} onChange={(e) => setAgent(e.target.value)}>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
        </label>
        <label>
          強さ
          <select value={level} onChange={(e) => setLevel(e.target.value)}>
            {Object.entries(LEVELS).map(([id, l]) => <option key={id} value={id}>{l.label}</option>)}
          </select>
        </label>
        <button onClick={() => setRound((r) => r + 1)}>もう一度</button>
      </div>
      {policy?.episode != null && (
        <p className="muted small">使用中の AI: {agent}（{policy.episode.toLocaleString()} 回学習した時点）</p>
      )}
      {error && <p className="error">{error}</p>}

      <div className="airhockey-layout">
        <div className="airhockey-wrap">
          <canvas
            ref={canvasRef}
            width={CANVAS_W}
            height={CANVAS_H}
            className="airhockey-canvas"
            onPointerMove={onPointer}
            onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); onPointer(e) }}
          />
          {match?.over && (
            <div className="othello-result">
              <div className={`big ${match.humanScore > match.aiScore ? 'win' : 'lose'}`}>
                {match.humanScore > match.aiScore ? 'あなたの勝ち！' : 'AI の勝ち'}
              </div>
              <div className="muted">あなた {match.humanScore} − {match.aiScore} AI</div>
              <button style={{ marginTop: 12 }} onClick={() => setRound((r) => r + 1)}>もう一度</button>
            </div>
          )}
          {match && !match.over && match.waitMs > 0 && <div className="overlay">{waitSec || ''}</div>}
          {!match && <div className="overlay">AI を準備しています…</div>}
        </div>
        <aside className="othello-side">
          <div className="airhockey-score">
            <div><span className="muted small">AI</span> {match?.aiScore ?? 0}</div>
            <div><span className="muted small">あなた</span> {match?.humanScore ?? 0}</div>
          </div>
          <p className="muted small">先に {WIN_SCORE} 点取ったほうが勝ち。マウス（スマホは指）で手前の赤いマレットを動かします。</p>
        </aside>
      </div>
    </div>
  )
}

/** 台・パック・マレットを描く（y は画面の下が 0） */
function draw(canvas: HTMLCanvasElement | null, s: State): void {
  const ctx = canvas?.getContext('2d')
  if (!ctx) return
  const css = getComputedStyle(document.documentElement)
  const color = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback
  const X = (x: number) => x * SCALE
  const Y = (y: number) => CANVAS_H - y * SCALE

  ctx.fillStyle = color('--ah-table', '#0f2a3a')
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)
  ctx.strokeStyle = color('--ah-line', '#2f6f8f')
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(0, Y(L / 2))
  ctx.lineTo(CANVAS_W, Y(L / 2))
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(X(W / 2), Y(L / 2), 0.15 * SCALE, 0, Math.PI * 2)
  ctx.stroke()
  // ゴール
  ctx.fillStyle = color('--ah-goal', '#000')
  ctx.fillRect(X(W / 2 - GOAL_HALF), 0, GOAL_HALF * 2 * SCALE, 6)
  ctx.fillRect(X(W / 2 - GOAL_HALF), CANVAS_H - 6, GOAL_HALF * 2 * SCALE, 6)

  const circle = (x: number, y: number, r: number, fill: string) => {
    ctx.beginPath()
    ctx.arc(X(x), Y(y), r * SCALE, 0, Math.PI * 2)
    ctx.fillStyle = fill
    ctx.fill()
  }
  circle(s.m1x, s.m1y, MALLET_R, color('--ah-ai', '#3987e5'))
  circle(s.m0x, s.m0y, MALLET_R, color('--ah-human', '#e66767'))
  circle(s.px, s.py, PUCK_R, color('--ah-puck', '#f5f5f5'))
}
