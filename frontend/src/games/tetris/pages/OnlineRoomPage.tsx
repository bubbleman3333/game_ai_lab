// オンライン対戦の部屋。準備完了 → カウントダウン → 対戦 → 結果 → もう一度。

import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { CLOSE_ROOM_FULL, CLOSE_ROOM_NOT_FOUND, type BoardRowsText, type PublicStats } from '../../../api/online/protocol'
import { MatchSocket } from '../../../api/online/socket'
import type { RoomDto } from '../api/types'
import { KeyHelp } from '../components/KeyHelp'
import { TouchControls } from '../components/TouchControls'
import { isTouchDevice, useTetrisCell } from '../../../lib/useViewport'
import { MiniBoard } from '../components/MiniBoard'
import { PlayerView } from '../components/PlayerView'
import { KeyboardInput } from '../game/keyboard'
import { loadHandling, loadKeys } from '../game/settings'
import { tetrisSounds, useTetrisSounds } from '../sounds'
import { OnlineMatch } from '../game/onlineMatch'
import { useGameLoop } from '../../../lib/useGameLoop'
import { usePlayerName } from '../../../lib/usePlayerName'

type Phase = 'waiting' | 'countdown' | 'playing' | 'result'

interface Opponent {
  rows: BoardRowsText
  stats: PublicStats
  pending: number
}

export function OnlineRoomPage() {
  const { code = '' } = useParams()
  const [name] = usePlayerName()
  const [socket, setSocket] = useState<MatchSocket | null>(null)
  const [slot, setSlot] = useState<number | null>(null)
  const [room, setRoom] = useState<RoomDto | null>(null)
  const [phase, setPhase] = useState<Phase>('waiting')
  const [match, setMatch] = useState<OnlineMatch | null>(null)
  const [startAt, setStartAt] = useState(0)
  const [opponent, setOpponent] = useState<Opponent | null>(null)
  const [result, setResult] = useState<{ win: boolean; reason: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const slotRef = useRef<number | null>(null)
  const cell = useTetrisCell(2, 26)

  // 接続（部屋コードが変わったらつなぎ直す）
  useEffect(() => {
    const s = new MatchSocket(code, name)
    s.onClose = (c) => {
      if (c === CLOSE_ROOM_NOT_FOUND) setError('部屋が見つかりません')
      else if (c === CLOSE_ROOM_FULL) setError('この部屋は満員です')
      else setError('接続が切れました')
    }
    const off = s.subscribe((msg) => {
      switch (msg.type) {
        case 'welcome':
          slotRef.current = msg.slot
          setSlot(msg.slot)
          break
        case 'room':
          setRoom(msg.room)
          break
        case 'start':
          setMatch((old) => {
            old?.finish()
            return new OnlineMatch(s, msg.seed)
          })
          setOpponent(null)
          setResult(null)
          setStartAt(performance.now() + msg.countdown_ms)
          setPhase('countdown')
          break
        case 'opponent_state':
          setOpponent({ rows: msg.rows, stats: msg.stats, pending: msg.pending })
          break
        case 'end':
          setRoom(msg.room)
          setResult({ win: msg.winner_slot === slotRef.current, reason: msg.reason })
          setPhase('result')
          break
        case 'error':
          setError(msg.message)
          break
      }
    })
    setSocket(s)
    return () => {
      off()
      s.onClose = null
      s.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code])

  useEffect(() => {
    if (phase === 'result') match?.finish()
  }, [phase, match])

  const keyboard = useMemo(() => (match ? new KeyboardInput(match.controller, loadKeys(), loadHandling()) : null), [match])
  useTetrisSounds(match?.controller)
  useEffect(() => keyboard?.attach(), [keyboard])

  const secondsLeft = (t: number) => Math.max(0, Math.ceil((startAt - t) / 1000))
  useGameLoop(
    [
      {
        update: (t: number) => {
          if (phase === 'countdown' && t >= startAt && match) {
            match.start()
            setPhase('playing')
          }
        },
      },
      ...(match ? [match] : []),
      ...(keyboard ? [keyboard] : []),
    ],
    match ? [match.controller] : [],
    () => `${match?.controller.version ?? 0}:${secondsLeft(performance.now())}`,
  )

  const me = room?.players.find((p) => p.slot === slot)
  const other = room?.players.find((p) => p.slot !== slot)
  const left = secondsLeft(performance.now())
  useEffect(() => {
    if (phase === 'countdown' && left > 0) tetrisSounds.countdown(false)
    if (phase === 'playing') tetrisSounds.countdown(true) // 開始の合図
  }, [left, phase])
  useEffect(() => {
    if (phase === 'result' && result?.win) tetrisSounds.win()
  }, [phase, result])
  const overlay =
    phase === 'countdown' ? <span className="countdown">{left || 'GO'}</span>
      : phase === 'result' && result ? (result.win ? 'WIN' : 'LOSE')
        : null

  return (
    <div className="page">
      <h1>
        オンライン対戦 <span className="mono">{code}</span>
      </h1>
      <p className="muted">
        この URL を相手に送ると同じ部屋に入れます。<Link to="/tetris/online">ロビーに戻る</Link>
      </p>
      {error && <p className="error">{error}</p>}

      <div className="controls-row">
        <span>
          {me?.name ?? name ?? 'あなた'}（{me?.wins ?? 0} 勝） vs {other ? `${other.name}（${other.wins} 勝）` : '相手を待っています…'}
        </span>
        {(phase === 'waiting' || phase === 'result') && other && (
          <button onClick={() => socket?.send({ type: 'ready', ready: !me?.ready })}>
            {me?.ready ? '準備完了を取り消す' : '準備完了'}
          </button>
        )}
        {other?.ready && phase !== 'playing' && phase !== 'countdown' && <span className="muted">相手は準備完了</span>}
      </div>
      {result && phase === 'result' && (
        <p className={result.win ? 'win' : 'lose'}>
          {result.win ? '勝ち！' : '負け…'}（{result.reason === 'disconnect' ? '相手の切断' : 'ゲームオーバー'}）
        </p>
      )}

      <div className="arena versus">
        {match ? (
          <PlayerView controller={match.controller} title={me?.name ?? 'あなた'} cell={cell} overlay={overlay} />
        ) : (
          <div className="placeholder">両者が「準備完了」を押すと始まります</div>
        )}
        <div className="opponent">
          <div className="player-title">{other?.name ?? '相手'}</div>
          {opponent ? (
            <>
              <MiniBoard rows={opponent.rows} cell={Math.max(8, Math.round(cell * 0.7))} dim={phase === 'result' && !!result?.win} />
              <dl className="stats">
                <dt>ライン</dt><dd>{opponent.stats.lines}</dd>
                <dt>火力</dt><dd>{opponent.stats.attack}</dd>
                <dt>予告</dt><dd>{opponent.pending}</dd>
              </dl>
            </>
          ) : (
            <div className="placeholder small">—</div>
          )}
        </div>
      </div>
      {isTouchDevice() ? <TouchControls /> : <KeyHelp />}
    </div>
  )
}
