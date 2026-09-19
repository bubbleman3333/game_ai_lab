// ひとりで遊ぶ / AI が遊ぶのを見る。

import { useEffect, useMemo, useState } from 'react'
import { AiControls, AiVersion, AI_SPEEDS, DEFAULT_AI_SPEED } from '../components/AiControls'
import { KeyHelp } from '../components/KeyHelp'
import { TouchControls } from '../components/TouchControls'
import { isTouchDevice, useTetrisCell } from '../../../lib/useViewport'
import { PlayerView } from '../components/PlayerView'
import { Game, GameController } from '../engine'
import { AiPlayer } from '../game/aiPlayer'
import { KeyboardInput } from '../game/keyboard'
import { loadHandling, loadKeys } from '../game/settings'
import { useTetrisSounds } from '../sounds'
import { useAgents } from '../game/useAgents'
import { exposeForDebug } from '../game/debug'
import { useGameLoop } from '../../../lib/useGameLoop'

type Mode = 'human' | 'ai'

export function PlayPage() {
  const [mode, setMode] = useState<Mode>('human')
  const [round, setRound] = useState(0)
  const [agent, setAgent] = useState('')
  const [speed, setSpeed] = useState(DEFAULT_AI_SPEED)
  const [error, setError] = useState<string | null>(null)
  const { agents, error: agentError } = useAgents()
  const cell = useTetrisCell(1, 28)

  const controller = useMemo(
    () => new GameController(new Game(Math.floor(Math.random() * 2 ** 31)), { gravityMs: mode === 'ai' ? 0 : 1000 }),
    // round が変わったら新しいゲーム
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, round],
  )
  const keyboard = useMemo(() => (mode === 'human' ? new KeyboardInput(controller, loadKeys(), loadHandling()) : null), [controller, mode])
  useTetrisSounds(controller)
  const ai = useMemo(() => {
    if (mode !== 'ai') return null
    const p = new AiPlayer(controller, { agent, ...AI_SPEEDS[speed] })
    p.onError = setError
    return p
  }, [controller, mode, agent, speed])

  useEffect(() => keyboard?.attach(), [keyboard])
  // 開発中はブラウザのコンソールから window.__tetris で中身を見られるようにする
  useEffect(() => exposeForDebug({ controller, keyboard, ai }), [controller, keyboard, ai])
  useEffect(() => {
    ai?.start()
    return () => ai?.stop()
  }, [ai])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'KeyR' || e.code === 'F4') {
        e.preventDefault()
        setError(null)
        setRound((r) => r + 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useGameLoop([keyboard, ai].filter((x) => x !== null), [controller], () => controller.version)

  return (
    <div className="page">
      <h1>ひとりで遊ぶ</h1>
      <div className="controls-row">
        <label>
          プレイヤー
          <select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
            <option value="human">自分</option>
            <option value="ai">AI（観戦）</option>
          </select>
        </label>
        <button onClick={() => { setError(null); setRound((r) => r + 1) }}>やり直す（R）</button>
      </div>
      {mode === 'ai' && <AiControls agents={agents} agent={agent} onAgent={setAgent} speed={speed} onSpeed={setSpeed} />}
      {mode === 'ai' && <AiVersion agent={ai?.lastAgent ?? null} />}
      {(error || (mode === 'ai' && agentError)) && <p className="error">{error ?? agentError}</p>}
      <div className="arena">
        <PlayerView controller={controller} cell={cell} />
      </div>
      {mode === 'human' && isTouchDevice() && <TouchControls />}
      {mode === 'human' && !isTouchDevice() && <KeyHelp extra="R やり直し" />}
    </div>
  )
}
