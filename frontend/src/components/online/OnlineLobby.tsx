// オンライン対戦のロビー（部屋を作る / 部屋に入る）。テトリスとブロブチェインで共通。

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { OnlineGame } from '../../api/online/protocol'
import { createRoom, listOpenRooms } from '../../api/online/rooms'
import type { RoomDto } from '../../api/online/types'
import { usePlayerName } from '../../lib/usePlayerName'

/** game: どのゲームの部屋か。basePath: 部屋の画面の URL（basePath/コード） */
export function OnlineLobby({ game, basePath, title }: { game: OnlineGame; basePath: string; title: string }) {
  const navigate = useNavigate()
  const [name, setName] = usePlayerName()
  const [rooms, setRooms] = useState<RoomDto[]>([])
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)

  const reload = () => listOpenRooms(game).then(setRooms).catch((e: Error) => setError(e.message))
  useEffect(() => {
    reload()
    const t = window.setInterval(reload, 5000)
    return () => window.clearInterval(t)
  }, [game])

  const create = async () => {
    try {
      const room = await createRoom(game)
      navigate(`${basePath}/${room.code}`)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className="page narrow">
      <h1>{title}</h1>
      <label className="field">
        ニックネーム
        <input value={name} maxLength={20} onChange={(e) => setName(e.target.value)} placeholder="ゲスト" />
      </label>

      <section className="card">
        <h2>部屋を作る</h2>
        <p>部屋を作ると 5 文字のコードが出ます。相手にコードか URL を伝えてください。</p>
        <button onClick={create}>部屋を作る</button>
      </section>

      <section className="card">
        <h2>コードで入る</h2>
        <form
          className="controls-row"
          onSubmit={(e) => {
            e.preventDefault()
            if (code.trim()) navigate(`${basePath}/${code.trim().toUpperCase()}`)
          }}
        >
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="ABCDE" maxLength={8} />
          <button type="submit">入る</button>
        </form>
      </section>

      <section className="card">
        <h2>相手を待っている部屋</h2>
        {rooms.length === 0 ? (
          <p className="muted">いまはありません</p>
        ) : (
          <ul className="room-list">
            {rooms.map((r) => (
              <li key={r.code}>
                <span className="mono">{r.code}</span>
                <span>{r.players.map((p) => p.name).join(', ')}</span>
                <button onClick={() => navigate(`${basePath}/${r.code}`)}>入る</button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {error && <p className="error">{error}</p>}
    </div>
  )
}
