// オセロで AI と対局する画面。AI の読みはブラウザの Web Worker で行い、評価関数の重みだけサーバーから読む。

import { useCallback, useEffect, useRef, useState } from 'react'
import { AiLoader } from '../ai/aiLoader'
import { fetchAgents, saveGame, type OthelloAgentDto } from '../api/othello'
import { OthelloBoard } from '../components/OthelloBoard'
import { BLACK, OthelloGame, WHITE, sqToStr, type Color } from '../engine/board'
import { LEVELS, type LevelId, type SearchResult } from '../engine/search'
import { othelloSounds } from '../sounds'

const AI_MIN_DELAY_MS = 350 // AI が一瞬で打つと見づらいので少し待つ
const LOAD_TIMEOUT_MS = 20_000

export function OthelloPlayPage() {
  const [agents, setAgents] = useState<OthelloAgentDto[]>([])
  const [agent, setAgent] = useState('')
  const [level, setLevel] = useState<LevelId>('max')
  const [humanColor, setHumanColor] = useState<Color>(BLACK)
  const [showHints, setShowHints] = useState(false)
  const [game, setGame] = useState(() => new OthelloGame())
  const [, setVersion] = useState(0)
  const [thinking, setThinking] = useState(false)
  const [loading, setLoading] = useState(false)
  const [aiInfo, setAiInfo] = useState<SearchResult | null>(null)
  const [hints, setHints] = useState<Map<number, number> | undefined>()
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const loader = useRef<AiLoader | null>(null)
  const generation = useRef(0) // 新しい対局・待ったのとき、古い AI の結果を捨てるため

  const rerender = () => setVersion((v) => v + 1)
  const aiColor: Color = humanColor === BLACK ? WHITE : BLACK
  const over = game.isOver()

  // AI の準備（Web Worker の起動と、評価関数の読み込み）
  useEffect(() => {
    loader.current = new AiLoader()
    fetchAgents()
      .then((list) => {
        setAgents(list)
        setAgent((cur) => cur || list[0]?.id || 'positional')
      })
      .catch((e: Error) => {
        setError(`${e.message}（学習なしの AI で遊べます）`)
        setAgent('positional')
      })
    return () => loader.current?.terminate()
  }, [])

  useEffect(() => {
    if (!agent || !loader.current) return
    const l = loader.current
    let cancelled = false // 読み込み中に AI を選び直したら、古い読み込みの結果は使わない
    setLoading(true)
    // 通信が詰まっても止まったままにならないよう、20 秒で諦めて学習なしの AI に切り替える
    let timer = 0
    const timeout = new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => reject(new Error('AI の読み込みに時間がかかりすぎています')), LOAD_TIMEOUT_MS)
    })
    Promise.race([l.use(agent), timeout])
      .catch(async (e: Error) => {
        if (cancelled) return
        setError(`${e.message}。学習なしの AI（マスの重み表）で続けます。ページを再読み込みすると、もう一度試します。`)
        await l.use('positional').catch(() => undefined)
      })
      .finally(() => {
        window.clearTimeout(timer)
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [agent])

  const newGame = useCallback(() => {
    generation.current++
    setGame(new OthelloGame())
    setAiInfo(null)
    setHints(undefined)
    setSaved(null)
    setThinking(false)
  }, [])

  // AI の番なら考えて打つ
  useEffect(() => {
    if (thinking || over || game.toMove !== aiColor || loading || !loader.current) return
    const gen = generation.current
    const started = performance.now()
    setThinking(true)
    loader.current.ai
      .search(game.cells, aiColor, LEVELS[level].options)
      .then(async (r) => {
        const wait = AI_MIN_DELAY_MS - (performance.now() - started)
        if (wait > 0) await new Promise((res) => setTimeout(res, wait))
        if (gen !== generation.current) return
        game.play(r.move)
        playMoveSounds()
        setAiInfo(r)
        rerender()
      })
      .catch((e: Error) => gen === generation.current && setError(e.message))
      .finally(() => gen === generation.current && setThinking(false))
  })

  // 評価値表示: 自分の番に、各手の点数を AI に計算させる
  useEffect(() => {
    setHints(undefined)
    if (!showHints || over || game.toMove !== humanColor || loading || !loader.current) return
    const gen = generation.current
    const moveCount = game.moves.length
    loader.current.ai
      .search(game.cells, humanColor, { ...LEVELS[level].options, noise: 0 })
      .then((r) => {
        if (gen === generation.current && game.moves.length === moveCount) {
          setHints(new Map(r.scores.map((s) => [s.move, s.score])))
        }
      })
      .catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHints, game, game.moves.length, humanColor, level, loading, over])

  // 終局したら記録を保存
  useEffect(() => {
    if (!over || saved !== null) return
    setSaved('saving')
    saveGame({
      moves: game.moves.join(''), human_color: humanColor === BLACK ? 'black' : 'white', agent, level,
    })
      .then(() => setSaved('保存しました'))
      .catch((e: Error) => setSaved(`保存できませんでした: ${e.message}`))
  }, [over, saved, game, humanColor, agent, level])

  // 置いた音と、相手がパスになったときの音
  const playMoveSounds = () => {
    othelloSounds.place(game.lastFlipped)
    if (game.lastPass !== null && !game.isOver()) setTimeout(othelloSounds.pass, 350)
  }

  // 終局の音
  useEffect(() => {
    if (!over) return
    const { black, white } = game.score()
    const h = humanColor === BLACK ? black : white
    const a = humanColor === BLACK ? white : black
    const t = setTimeout(h > a ? othelloSounds.win : h < a ? othelloSounds.lose : othelloSounds.draw, 400)
    return () => clearTimeout(t)
  }, [over, game, humanColor])

  const onPlay = (sq: number) => {
    if (thinking || game.toMove !== humanColor) return
    if (game.play(sq)) {
      playMoveSounds()
      setHints(undefined)
      rerender()
    }
  }

  const takeBack = () => {
    if (!game.canUndo(humanColor)) return
    generation.current++
    setThinking(false)
    game.undoUntil(humanColor)
    setAiInfo(null)
    setSaved(null) // 終局後に待ったで戻したときも、次の終局を保存する
    rerender()
  }

  const { black, white } = game.score()
  const humanTurn = !over && game.toMove === humanColor
  const human = humanColor === BLACK ? black : white
  const ai = humanColor === BLACK ? white : black

  return (
    <div className="page">
      <h1>オセロ</h1>
      <div className="controls-row">
        <label>
          あなた
          <select value={humanColor} onChange={(e) => { setHumanColor(Number(e.target.value) as Color); newGame() }}>
            <option value={BLACK}>黒（先手）</option>
            <option value={WHITE}>白（後手）</option>
          </select>
        </label>
        <label>
          AI の評価関数
          <select value={agent} onChange={(e) => { setAgent(e.target.value); newGame() }}>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            {!agents.length && <option value="positional">マスの重み表（学習なし）</option>}
          </select>
        </label>
        <label>
          強さ
          <select value={level} onChange={(e) => setLevel(e.target.value as LevelId)}>
            {Object.entries(LEVELS).map(([id, l]) => <option key={id} value={id}>{l.label}</option>)}
          </select>
        </label>
      </div>
      <div className="controls-row">
        <button onClick={newGame}>新しい対局</button>
        <button onClick={takeBack} disabled={!game.canUndo(humanColor)}>待った</button>
        <label>
          <input type="checkbox" checked={showHints} onChange={(e) => setShowHints(e.target.checked)} />
          評価値を表示（各手の予想石差）
        </label>
      </div>
      {error && <p className="error">{error}</p>}

      <div className="othello-layout">
        <div className="othello-board-wrap">
          <OthelloBoard
            cells={game.cells}
            legal={humanTurn && !thinking ? game.legal() : []}
            lastMove={game.lastMove}
            onPlay={onPlay}
            hints={humanTurn ? hints : undefined}
            ghostColor={humanColor}
          />
          {over && (
            <div className="othello-result" role="status">
              <div className={`big ${human > ai ? 'win' : human < ai ? 'lose' : ''}`}>
                {human > ai ? 'あなたの勝ち！' : human < ai ? 'AI の勝ち' : '引き分け'}
              </div>
              <div className="muted">
                あなた {human} − {ai} AI
              </div>
              <button style={{ marginTop: 12 }} onClick={newGame}>もう一局</button>
            </div>
          )}
        </div>
        <aside className="othello-side">
          <div className="othello-score">
            <span><span className="disc black" /> {black}</span>
            <span><span className="disc white" /> {white}</span>
          </div>
          <p className={`othello-status${humanTurn && !thinking ? ' your-turn' : ''}`}>
            {loading ? 'AI を準備しています…'
              : over ? (human > ai ? 'あなたの勝ち！' : human < ai ? 'AI の勝ち' : '引き分け')
                : thinking ? <span className="thinking-dots">AI が考えています</span>
                  : humanTurn ? 'あなたの番です' : ''}
          </p>
          {game.lastPass !== null && !over && (
            <p className="muted">{game.lastPass === humanColor ? 'あなたは打てる場所がないのでパスです' : 'AI はパスしました'}</p>
          )}
          {aiInfo && (
            <dl className="stats">
              <dt>AI の手</dt><dd>{sqToStr(aiInfo.move)}</dd>
              <dt>読み</dt><dd>{aiInfo.exact ? '最後まで読み切り' : `${aiInfo.depth} 手先`}</dd>
              <dt>AI の予想</dt><dd>{aiInfo.score > 0 ? '+' : ''}{Math.round(aiInfo.score)} 石</dd>
              <dt>読んだ局面</dt><dd>{aiInfo.nodes.toLocaleString()}</dd>
              <dt>時間</dt><dd>{(aiInfo.timeMs / 1000).toFixed(1)} 秒</dd>
            </dl>
          )}
          {over && saved && saved !== 'saving' && <p className="muted small">{saved}</p>}
          <p className="muted small">棋譜: {game.moves.join('') || '—'}</p>
        </aside>
      </div>
    </div>
  )
}
