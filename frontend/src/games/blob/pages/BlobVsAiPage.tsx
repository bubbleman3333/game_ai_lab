// 自分 vs AI、または AI vs AI（同じ画面で対戦。連鎖でおじゃまを送り合う）。
// テトリスの /tetris/vs-ai と同じ作り。AI の手は backend（/api/blob/move/）が返す。

import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useGameLoop } from '../../../lib/useGameLoop'
import { isTouchDevice } from '../../../lib/useViewport'
import { useBlobAgents } from '../api/ai'
import { BlobAiControls, BlobAiVersion } from '../components/BlobAiControls'
import { BlobPlayer } from '../components/BlobPlayer'
import { BlobTouch } from '../components/BlobTouch'
import { BlobController } from '../engine/controller'
import { BlobGame } from '../engine/game'
import { BLOB_AI_SPEEDS, BlobAiPlayer, DEFAULT_BLOB_AI_SPEED } from '../game/aiPlayer'
import { BlobInput, KEY_HELP } from '../game/input'
import { linkBlobGarbage } from '../game/versus'
import { attachBlobSounds, blobSounds } from '../sounds'

const COUNTDOWN_MS = 3000
const GRAVITY_MS = 700

type Mode = 'human' | 'ai'

export function BlobVsAiPage() {
  const [mode, setMode] = useState<Mode>('human')
  const [round, setRound] = useState(0)
  const [agent, setAgent] = useState('')
  const [speed, setSpeed] = useState(DEFAULT_BLOB_AI_SPEED)
  // AI vs AI のときの左側の AI
  const [agent2, setAgent2] = useState('heuristic')
  const [speed2, setSpeed2] = useState(DEFAULT_BLOB_AI_SPEED)
  // 組ぷよの出る順番を両者で同じにするか
  const [sameQueue, setSameQueue] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [errorLeft, setErrorLeft] = useState<string | null>(null)
  const [startAt, setStartAt] = useState(() => performance.now() + COUNTDOWN_MS)
  const { agents } = useBlobAgents()
  const drawMe = useRef<((now: number) => void) | null>(null)
  const drawCpu = useRef<((now: number) => void) | null>(null)

  const { me, cpu } = useMemo(() => {
    const newSeed = () => Math.floor(Math.random() * 2 ** 31)
    const seed = newSeed()
    const me = new BlobController(new BlobGame(seed))
    const cpu = new BlobController(new BlobGame(sameQueue ? seed : newSeed()))
    // AI は自分で落とすので、自然落下は待たせない
    me.gravityMs = mode === 'ai' ? 60_000 : GRAVITY_MS
    cpu.gravityMs = 60_000
    me.paused = cpu.paused = true
    return { me, cpu }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [round, mode, sameQueue])

  const input = useMemo(() => (mode === 'human' ? new BlobInput(me) : null), [me, mode])
  const leftAi = useMemo(() => {
    if (mode !== 'ai') return null
    const p = new BlobAiPlayer(me, { agent: agent2, ...BLOB_AI_SPEEDS[speed2] })
    p.onError = setErrorLeft
    return p
  }, [me, mode, agent2, speed2])
  const ai = useMemo(() => {
    const p = new BlobAiPlayer(cpu, { agent, ...BLOB_AI_SPEEDS[speed] })
    p.onError = setError
    return p
  }, [cpu, agent, speed])

  useEffect(() => linkBlobGarbage(me, cpu), [me, cpu])
  useEffect(() => attachBlobSounds(me), [me])
  useEffect(() => input?.attach(), [input])
  useEffect(() => {
    ai.start()
    return () => ai.stop()
  }, [ai])
  useEffect(() => {
    leftAi?.start()
    return () => leftAi?.stop()
  }, [leftAi])

  const secondsLeft = (t: number) => Math.max(0, Math.ceil((startAt - t) / 1000))
  useGameLoop(
    [
      {
        update: (t: number) => {
          const over = me.phase === 'over' || cpu.phase === 'over'
          if (t >= startAt && me.paused && !over) me.paused = cpu.paused = false
          if (over) me.paused = cpu.paused = true
          me.update(t)
          cpu.update(t)
          drawMe.current?.(t)
          drawCpu.current?.(t)
        },
      },
      ...(input ? [input] : []),
      ai,
      ...(leftAi ? [leftAi] : []),
    ],
    [],
    () => `${me.version}:${cpu.version}:${secondsLeft(performance.now())}`,
  )

  const left = secondsLeft(performance.now())
  const counting = left > 0
  useEffect(() => {
    if (left > 0) blobSounds.countdown(false)
    else blobSounds.countdown(true)
  }, [left])
  const cpuOver = cpu.phase === 'over'
  useEffect(() => {
    if (cpuOver && me.phase !== 'over' && mode === 'human') blobSounds.win()
  }, [cpuOver, me, mode])

  const restart = () => {
    setError(null)
    setErrorLeft(null)
    setRound((r) => r + 1)
    setStartAt(performance.now() + COUNTDOWN_MS)
  }
  const result = me.phase === 'over' ? 'LOSE' : cpu.phase === 'over' ? 'WIN' : null
  const banner = (text: string | null, win: boolean) =>
    text ? <div className={`blob-result ${win ? 'win' : 'lose'}`}><div className="big">{text}</div></div> : undefined
  const overlay = counting ? <span className="countdown">{left}</span> : banner(result, result === 'WIN')

  return (
    <div className="page blob-page">
      <h1>ブロブチェイン <span className="muted small">AI と対戦</span></h1>
      <div className="controls-row">
        <label>
          対戦
          <select value={mode} onChange={(e) => { setMode(e.target.value as Mode); restart() }}>
            <option value="human">あなた vs AI</option>
            <option value="ai">AI vs AI（観戦）</option>
          </select>
        </label>
        <label>
          組の順番
          <select value={sameQueue ? 'same' : 'diff'} onChange={(e) => { setSameQueue(e.target.value === 'same'); restart() }}>
            <option value="same">両者同じ</option>
            <option value="diff">別々</option>
          </select>
        </label>
        <button onClick={restart}>もう一度</button>
      </div>
      {mode === 'ai' && (
        <>
          <div className="controls-row"><span className="muted small">左の AI</span></div>
          <BlobAiControls agents={agents} agent={agent2} onAgent={setAgent2} speed={speed2} onSpeed={setSpeed2} />
          <BlobAiVersion agent={leftAi?.lastAgent ?? null} />
          <div className="controls-row"><span className="muted small">右の AI</span></div>
        </>
      )}
      <BlobAiControls agents={agents} agent={agent} onAgent={setAgent} speed={speed} onSpeed={setSpeed} />
      <BlobAiVersion agent={ai.lastAgent} />
      {errorLeft && <p className="error">左の AI: {errorLeft}</p>}
      {error && <p className="error">{mode === 'ai' ? '右の AI: ' : ''}{error}</p>}
      <div className="blob-arena versus two-boards">
        <BlobPlayer
          controller={me}
          title={mode === 'human' ? 'あなた' : `AI（${agent2 || '既定'}）`}
          drawRef={drawMe}
          overlay={overlay}
        />
        <BlobPlayer
          controller={cpu}
          title={mode === 'human' ? 'AI' : `AI（${agent || '既定'}）`}
          drawRef={drawCpu}
          overlay={counting ? overlay : banner(result && (result === 'WIN' ? 'LOSE' : 'WIN'), result === 'LOSE')}
        />
      </div>
      {mode === 'human' && (input && isTouchDevice() ? <BlobTouch input={input} /> : <p className="key-help">{KEY_HELP}</p>)}
      <p className="muted small blob-rule">
        AI は 1 手ごとに backend（/api/blob/move/）に置き場所を聞いています。
        強さは <Link to="/blob/stats">AI の強さ</Link> のページで見られます。
      </p>
    </div>
  )
}
