// 自分 vs AI、または AI vs AI（同じ画面で対戦。おじゃまを送り合う）。

import { useEffect, useMemo, useState } from 'react'
import { AiControls, AiVersion, AI_SPEEDS } from '../components/AiControls'
import { KeyHelp } from '../components/KeyHelp'
import { TouchControls } from '../components/TouchControls'
import { isTouchDevice, useTetrisCell } from '../../../lib/useViewport'
import { PlayerView } from '../components/PlayerView'
import { Game, GameController } from '../engine'
import { AiPlayer } from '../game/aiPlayer'
import { KeyboardInput } from '../game/keyboard'
import { loadHandling, loadKeys } from '../game/settings'
import { tetrisSounds, useTetrisSounds } from '../sounds'
import { useAgents } from '../game/useAgents'
import { exposeForDebug } from '../game/debug'
import { useGameLoop } from '../../../lib/useGameLoop'
import { linkGarbage } from '../game/versus'

const COUNTDOWN_MS = 3000

type Mode = 'human' | 'ai'

export function VsAiPage() {
  const [mode, setMode] = useState<Mode>('human')
  const [round, setRound] = useState(0)
  const [agent, setAgent] = useState('')
  const [speed, setSpeed] = useState(1)
  // AI vs AI のときの左側の AI
  const [agent2, setAgent2] = useState('heuristic')
  const [speed2, setSpeed2] = useState(1)
  const [error, setError] = useState<string | null>(null)
  const [errorLeft, setErrorLeft] = useState<string | null>(null) // AI vs AI の左の AI
  const [startAt, setStartAt] = useState(() => performance.now() + COUNTDOWN_MS)
  const { agents } = useAgents()
  const cell = useTetrisCell(2, 26)

  const { me, cpu } = useMemo(() => {
    const seed = Math.floor(Math.random() * 2 ** 31) // 両者同じツモ順
    const me = new GameController(new Game(seed), mode === 'ai' ? { gravityMs: 0 } : {})
    const cpu = new GameController(new Game(seed), { gravityMs: 0 })
    me.paused = cpu.paused = true
    return { me, cpu }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [round, mode])
  const keyboard = useMemo(() => new KeyboardInput(me, loadKeys(), loadHandling()), [me])
  const leftAi = useMemo(() => {
    if (mode !== 'ai') return null
    const p = new AiPlayer(me, { agent: agent2, ...AI_SPEEDS[speed2] })
    p.onError = setErrorLeft
    return p
  }, [me, mode, agent2, speed2])
  useTetrisSounds(me)
  const ai = useMemo(() => {
    const p = new AiPlayer(cpu, { agent, ...AI_SPEEDS[speed] })
    p.onError = setError
    return p
  }, [cpu, agent, speed])

  useEffect(() => linkGarbage(me, cpu), [me, cpu])
  useEffect(() => (mode === 'human' ? keyboard.attach() : undefined), [keyboard, mode])
  useEffect(() => {
    ai.start()
    return () => ai.stop()
  }, [ai])
  useEffect(() => {
    leftAi?.start()
    return () => leftAi?.stop()
  }, [leftAi])
  useEffect(() => exposeForDebug({ me, cpu, keyboard, ai }), [me, cpu, keyboard, ai])

  const secondsLeft = (t: number) => Math.max(0, Math.ceil((startAt - t) / 1000))
  useGameLoop(
    [
      {
        update: (t: number) => {
          if (t >= startAt && me.paused && !me.game.over && !cpu.game.over) me.paused = cpu.paused = false
          // どちらかが負けたら両方止める
          if (me.game.over || cpu.game.over) me.paused = cpu.paused = true
        },
      },
      ...(mode === 'human' ? [keyboard] : []),
      ai,
      ...(leftAi ? [leftAi] : []),
    ],
    [me, cpu],
    // カウントダウンの秒数が変わったときも再描画する
    () => `${me.version}:${cpu.version}:${secondsLeft(performance.now())}`,
  )
  const left = secondsLeft(performance.now())
  const counting = left > 0
  // カウントダウンと勝敗の音
  useEffect(() => {
    if (left > 0) tetrisSounds.countdown(false)
    else if (!me.game.over && !cpu.game.over) tetrisSounds.countdown(true)
  }, [left, me, cpu])
  const cpuOver = cpu.game.over
  useEffect(() => {
    if (cpuOver && !me.game.over && mode === 'human') tetrisSounds.win()
  }, [cpuOver, me, mode])

  const restart = () => {
    setError(null)
    setErrorLeft(null)
    setRound((r) => r + 1)
    setStartAt(performance.now() + COUNTDOWN_MS)
  }
  const result = me.game.over ? 'LOSE' : cpu.game.over ? 'WIN' : null
  const overlay = counting ? <span className="countdown">{left}</span> : result

  return (
    <div className="page">
      <h1>AI と対戦</h1>
      <div className="controls-row">
        <label>
          対戦
          <select value={mode} onChange={(e) => { setMode(e.target.value as Mode); restart() }}>
            <option value="human">あなた vs AI</option>
            <option value="ai">AI vs AI（観戦）</option>
          </select>
        </label>
        <button onClick={restart}>もう一度</button>
      </div>
      {mode === 'ai' && (
        <div className="controls-row"><span className="muted small">左の AI</span></div>
      )}
      {mode === 'ai' && <AiControls agents={agents} agent={agent2} onAgent={setAgent2} speed={speed2} onSpeed={setSpeed2} />}
      {mode === 'ai' && <AiVersion agent={leftAi?.lastAgent ?? null} />}
      {mode === 'ai' && <div className="controls-row"><span className="muted small">右の AI</span></div>}
      <AiControls agents={agents} agent={agent} onAgent={setAgent} speed={speed} onSpeed={setSpeed} />
      <AiVersion agent={ai.lastAgent} />
      {errorLeft && <p className="error">左の AI: {errorLeft}</p>}
      {error && <p className="error">{mode === 'ai' ? '右の AI: ' : ''}{error}</p>}
      <div className="arena versus">
        <PlayerView controller={me} title={mode === 'human' ? 'あなた' : `AI（${agent2 || '既定'}）`} cell={cell} overlay={overlay} />
        <PlayerView controller={cpu} title={mode === 'human' ? 'AI' : `AI（${agent || '既定'}）`} cell={cell} overlay={counting ? overlay : result && (result === 'WIN' ? 'LOSE' : 'WIN')} />
      </div>
      {mode === 'human' && isTouchDevice() && <TouchControls />}
      {mode === 'human' && !isTouchDevice() && <KeyHelp />}
    </div>
  )
}
