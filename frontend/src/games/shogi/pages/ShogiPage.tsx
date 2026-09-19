// 将棋で AI と対局する画面。指し手の判定と AI の探索はサーバーで行う（最強だと 1 手 5 秒ほど）。

import { useEffect, useMemo, useState } from 'react'
import { sound } from '../../../lib/sound'
import { fetchAgents, fetchLevels, gameAction, playMove, startGame, type ShogiAgentDto, type ShogiGameDto } from '../api/shogi'
import { ShogiBoard } from '../components/ShogiBoard'
import { applyUsi, parseSfen, type Side } from '../engine/sfen'

const pieceSound = () => {
  sound.noise({ dur: 0.05, gain: 0.3, filter: 2500 })
  sound.tone({ freq: 700, to: 400, dur: 0.05, type: 'triangle', gain: 0.12 })
}

export function ShogiPage() {
  const [agents, setAgents] = useState<ShogiAgentDto[]>([])
  const [levels, setLevels] = useState<{ id: string; label: string }[]>([])
  const [agent, setAgent] = useState('')
  const [level, setLevel] = useState('normal')
  const [color, setColor] = useState<Side>('black')
  const [game, setGame] = useState<ShogiGameDto | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [promotion, setPromotion] = useState<{ plain: string; promoted: string } | null>(null)
  const [thinking, setThinking] = useState(false)
  // 自分が指した手。AI の応手が返ってくるまで、この手を反映した盤を先に見せる
  const [pendingMove, setPendingMove] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchAgents().then((list) => {
      setAgents(list)
      setAgent((cur) => cur || list[0]?.id || 'random')
    }).catch((e: Error) => setError(e.message))
    fetchLevels().then(setLevels).catch(() => undefined)
  }, [])

  const run = async (fn: () => Promise<ShogiGameDto>) => {
    setThinking(true)
    setError(null)
    try {
      const g = await fn()
      setGame(g)
      if (g.last_move) pieceSound()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setThinking(false)
      setSelected(null)
      setPromotion(null)
      setPendingMove(null)
    }
  }

  const newGame = () => run(() => startGame({ human_color: color, agent, level }))
  const pos = useMemo(() => {
    if (!game) return null
    const p = parseSfen(game.sfen)
    return pendingMove ? applyUsi(p, pendingMove) : p
  }, [game, pendingMove])
  const interactive = !!game?.your_turn && !thinking

  // 選んだ駒（または持ち駒）で行けるマス
  const targets = useMemo(() => {
    const t = new Set<string>()
    if (!game || !selected) return t
    for (const m of game.legal_moves) {
      if (m.startsWith(selected)) t.add(m.slice(2, 4))
    }
    return t
  }, [game, selected])

  const send = (move: string) => {
    if (!game) return
    pieceSound()
    setPendingMove(move)
    setSelected(null)
    setPromotion(null)
    run(() => playMove(game.id, move))
  }

  const onSquare = (sq: string) => {
    if (!game || !pos) return
    if (selected && targets.has(sq)) {
      const cands = game.legal_moves.filter((m) => m.startsWith(selected) && m.slice(2, 4) === sq)
      const plain = cands.find((m) => !m.endsWith('+'))
      const promoted = cands.find((m) => m.endsWith('+'))
      if (plain && promoted) setPromotion({ plain, promoted })
      else send((promoted ?? plain)!)
      return
    }
    // 自分の駒を選ぶ（成りの確認が出ていたら閉じる）
    const hasMoves = game.legal_moves.some((m) => m.startsWith(sq))
    setPromotion(null)
    setSelected(hasMoves && selected !== sq ? sq : null)
  }

  const onHand = (kind: string) => {
    setPromotion(null)
    setSelected((cur) => (cur === `${kind}*` ? null : `${kind}*`))
  }

  const winrate = game?.ai?.winrate
  const resultText = game?.result === 'human_win' ? 'あなたの勝ち！' : game?.result === 'ai_win' ? 'AI の勝ち' : game?.result === 'draw' ? '引き分け' : null

  return (
    <div className="page wide">
      <h1>将棋</h1>
      <div className="controls-row">
        <label>
          あなた
          <select value={color} onChange={(e) => setColor(e.target.value as Side)}>
            <option value="black">先手</option>
            <option value="white">後手</option>
          </select>
        </label>
        <label>
          AI
          <select value={agent} onChange={(e) => setAgent(e.target.value)}>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
        </label>
        <label>
          強さ
          <select value={level} onChange={(e) => setLevel(e.target.value)}>
            {levels.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
        </label>
        <button onClick={newGame} disabled={thinking}>対局を始める</button>
      </div>
      {agents.length > 0 && agents[0].id === 'random' && (
        <p className="muted small">まだ学習した AI がありません（学習が終わると選べるようになります）。いまはランダムに指す AI で動作を確認できます。</p>
      )}
      {error && <p className="error">{error}</p>}

      {!game || !pos ? (
        <p className="muted">先手・後手と強さを選んで「対局を始める」を押してください。</p>
      ) : (
        <div className="shogi-layout">
          <div className="shogi-main">
            <ShogiBoard
              pos={pos} bottom={game.human_color} selected={selected} targets={targets}
              lastMove={pendingMove ?? game.last_move} onSquare={onSquare} onHand={onHand} interactive={interactive}
            />
            {promotion && (
              <div className="shogi-promote">
                成りますか？
                <button onClick={() => send(promotion.promoted)}>成る</button>
                <button onClick={() => send(promotion.plain)}>成らない</button>
              </div>
            )}
          </div>
          <aside className="shogi-side">
            <p className={`othello-status${interactive ? ' your-turn' : ''}`}>
              {resultText ? `${resultText}（${game.reason}）`
                : thinking ? <span className="thinking-dots">AI が考えています</span>
                  : game.your_turn ? (game.in_check ? '王手されています！' : 'あなたの番です') : ''}
            </p>
            {game.ai && game.ai.playouts !== undefined && (
              <dl className="stats">
                <dt>AI の勝率予想</dt><dd>{winrate != null ? `${Math.round(winrate * 100)}%` : '—'}</dd>
                <dt>読んだ回数</dt><dd>{game.ai.playouts?.toLocaleString()}</dd>
                <dt>考えた時間</dt><dd>{((game.ai.time_ms ?? 0) / 1000).toFixed(1)} 秒</dd>
                <dt>読み筋</dt><dd className="mono small">{game.ai.pv?.slice(0, 5).join(' ')}</dd>
              </dl>
            )}
            {!game.result && (
              <div className="controls-row" style={{ marginTop: 12 }}>
                <button onClick={() => run(() => gameAction(game.id, 'undo'))} disabled={thinking || game.moves.length < 2}>待った</button>
                <button onClick={() => run(() => gameAction(game.id, 'resign'))} disabled={thinking}>投了</button>
                {game.can_declare && <button onClick={() => run(() => gameAction(game.id, 'declare'))} disabled={thinking}>入玉宣言</button>}
              </div>
            )}
            <h2>棋譜</h2>
            <ol className="kifu">
              {game.kif.map((k, i) => <li key={i}>{k}</li>)}
              {pendingMove && <li className="muted">{pendingMove}（送信中）</li>}
            </ol>
          </aside>
        </div>
      )}
    </div>
  )
}
