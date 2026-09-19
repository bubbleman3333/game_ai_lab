// 今誰が遊んでいるか（管理者用）。/monitor で開く。合言葉は backend/.monitor_token の中身。

import { useCallback, useEffect, useState } from 'react'
import { ApiError, apiUrl } from '../api/client'

interface Live {
  now: string
  online: number
  by_game: { game: string; players: number; mobile: number }[]
  sessions: { nickname: string; path: string; game: string; device: string; since: string; last_seen: string }[]
  today: { visitors: number; games: Record<string, number>; errors: number }
  events: { at: string; kind: string; game: string; message: string; data: Record<string, unknown> }[]
}

const GAME_NAMES: Record<string, string> = {
  tetris: 'テトリス', blob: 'ブロブチェイン', othello: 'オセロ', airhockey: 'エアホッケー', shogi: '将棋', top: 'トップ', other: 'その他',
}
const KIND_NAMES: Record<string, string> = { game: '対局', client_error: '画面のエラー', server_error: 'サーバーのエラー' }
const TOKEN_KEY = 'game-ai-lab:monitor-token'
const REFRESH_MS = 5000

const time = (iso: string) => new Date(iso).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const minutesSince = (iso: string) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000))

function loadToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? ''
  } catch {
    return ''
  }
}

export function MonitorPage() {
  const [token, setToken] = useState(loadToken)
  const [input, setInput] = useState('')
  const [live, setLive] = useState<Live | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!token) return
    try {
      const res = await fetch(apiUrl('/api/monitoring/live/'), { headers: { 'X-Monitor-Token': token } })
      if (res.status === 403) throw new ApiError(403, 'forbidden', '合言葉が違います')
      if (!res.ok) throw new ApiError(res.status, 'error', `HTTP ${res.status}`)
      setLive(await res.json())
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [token])

  useEffect(() => {
    load()
    const t = window.setInterval(load, REFRESH_MS)
    return () => window.clearInterval(t)
  }, [load])

  const saveToken = () => {
    try {
      localStorage.setItem(TOKEN_KEY, input.trim())
    } catch {
      /* 保存できなくてもこの画面では使える */
    }
    setToken(input.trim())
  }

  if (!token || error === '合言葉が違います') {
    return (
      <div className="page narrow">
        <h1>利用状況</h1>
        <p className="muted">合言葉を入れてください（サーバーの <code>backend/.monitor_token</code> の中身）。</p>
        {error && <p className="error">{error}</p>}
        <form className="controls-row" onSubmit={(e) => { e.preventDefault(); saveToken() }}>
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="合言葉" />
          <button type="submit">見る</button>
        </form>
      </div>
    )
  }

  return (
    <div className="page wide">
      <h1>利用状況 <span className="muted small">{live ? `${time(live.now)} 更新（5 秒ごと）` : '読み込み中…'}</span></h1>
      {error && <p className="error">{error}</p>}
      {live && (
        <>
          <section className="tiles">
            <div className="tile"><div className="tile-label">いま開いている人</div><div className="tile-value">{live.online}</div></div>
            <div className="tile"><div className="tile-label">今日来た人（タブ数）</div><div className="tile-value">{live.today.visitors}</div></div>
            <div className="tile">
              <div className="tile-label">今日の対局</div>
              <div className="tile-value">{Object.values(live.today.games).reduce((a, b) => a + b, 0)}</div>
              <div className="tile-sub">
                {Object.entries(live.today.games).map(([g, n]) => `${GAME_NAMES[g] ?? g} ${n}`).join(' / ') || '—'}
              </div>
            </div>
            <div className="tile"><div className="tile-label">今日のエラー</div><div className="tile-value">{live.today.errors}</div></div>
          </section>

          <h2>ゲームごと</h2>
          {live.by_game.length === 0 ? <p className="muted">いま開いている人はいません</p> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>ゲーム</th><th>人数</th><th>うちスマホ</th></tr></thead>
                <tbody>
                  {live.by_game.map((g) => (
                    <tr key={g.game}><td>{GAME_NAMES[g.game] ?? g.game}</td><td>{g.players}</td><td>{g.mobile}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h2>いま開いている人</h2>
          {live.sessions.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead><tr><th>ニックネーム</th><th>ページ</th><th>端末</th><th>開いてから</th></tr></thead>
                <tbody>
                  {live.sessions.map((s, i) => (
                    <tr key={i}>
                      <td>{s.nickname || '（なし）'}</td><td>{s.path}</td><td>{s.device === 'mobile' ? 'スマホ' : 'PC'}</td>
                      <td>{minutesSince(s.since)} 分</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h2>最近の出来事</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>時刻</th><th>種類</th><th>内容</th></tr></thead>
              <tbody>
                {live.events.map((e, i) => (
                  <tr key={i} className={e.kind !== 'game' ? 'error-row' : ''}>
                    <td>{time(e.at)}</td><td>{KIND_NAMES[e.kind] ?? e.kind}</td>
                    <td className="event-message">{e.message}{e.data?.path ? `（${String(e.data.path)}）` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
