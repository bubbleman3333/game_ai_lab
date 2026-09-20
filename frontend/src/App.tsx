// 画面の一覧（ルーティング）。ゲームを足すときは games/<名前>/ を作り、ここと HomePage の GAMES に追加する。
import { lazy, Suspense, useEffect } from 'react'
import { NavLink, Route, Routes, useLocation } from 'react-router-dom'
import { notifyNavigation, startTelemetry } from './lib/telemetry'
import { MonitorPage } from './pages/MonitorPage'
import { SoundControl } from './components/SoundControl'
import { ThemeToggle } from './components/ThemeToggle'
import { useTheme } from './lib/theme'
import { UpdateNotice } from './components/UpdateNotice'
import { AirHockeyPage } from './games/airhockey/pages/AirHockeyPage'
import { AirHockeyStatsPage } from './games/airhockey/pages/AirHockeyStatsPage'
import { ShogiPage } from './games/shogi/pages/ShogiPage'
import { ShogiStatsPage } from './games/shogi/pages/ShogiStatsPage'
import { OthelloPlayPage } from './games/othello/pages/OthelloPlayPage'
import { OthelloStatsPage } from './games/othello/pages/OthelloStatsPage'
import { OnlineLobby } from './components/online/OnlineLobby'
import { BlobOnlineRoomPage } from './games/blob/pages/BlobOnlineRoomPage'
import { BlobSoloPage } from './games/blob/pages/BlobSoloPage'
import { BlobStatsPage } from './games/blob/pages/BlobStatsPage'
import { BlobVsAiPage } from './games/blob/pages/BlobVsAiPage'
import { OnlineRoomPage } from './games/tetris/pages/OnlineRoomPage'
import { PlayPage } from './games/tetris/pages/PlayPage'
import { SettingsPage } from './games/tetris/pages/SettingsPage'
import { TetrisStatsPage } from './games/tetris/pages/TetrisStatsPage'
import { VsAiPage } from './games/tetris/pages/VsAiPage'
import { HomePage } from './pages/HomePage'

// レースは three.js を使うぶんだけ重いので、/racer を開いたときにだけ読み込む
// （ほかのゲームの表示が遅くならないように）
const RacerPage = lazy(() => import('./games/racer/pages/RacerPage').then((m) => ({ default: m.RacerPage })))
const RacerStatsPage = lazy(() => import('./games/racer/pages/RacerStatsPage').then((m) => ({ default: m.RacerStatsPage })))

export default function App() {
  // 利用状況（今誰が遊んでいるか）の合図。ページを移るたびにすぐ送る
  const location = useLocation()
  useTheme() // 切り替えたとき、canvas で描く盤面も描き直す
  useEffect(() => startTelemetry(), [])
  useEffect(() => notifyNavigation(), [location.pathname])
  return (
    <>
      <nav className="nav">
        <NavLink to="/" end className="brand">Game AI Lab</NavLink>
        <span className="nav-group">テトリス</span>
        <NavLink to="/tetris/play">ひとりで</NavLink>
        <NavLink to="/tetris/vs-ai">AI と対戦</NavLink>
        <NavLink to="/tetris/online">オンライン</NavLink>
        <NavLink to="/tetris/stats">強さ</NavLink>
        <NavLink to="/tetris/settings">キー設定</NavLink>
        <span className="nav-group">ブロブチェイン</span>
        <NavLink to="/blob" end>ひとりで</NavLink>
        <NavLink to="/blob/vs-ai">AI と対戦</NavLink>
        <NavLink to="/blob/online">オンライン</NavLink>
        <NavLink to="/blob/stats">強さ</NavLink>
        <span className="nav-group">オセロ</span>
        <NavLink to="/othello" end>対局</NavLink>
        <NavLink to="/othello/stats">強さ</NavLink>
        <span className="nav-group">エアホッケー</span>
        <NavLink to="/airhockey" end>対戦</NavLink>
        <NavLink to="/airhockey/stats">強さ</NavLink>
        <span className="nav-group">レース</span>
        <NavLink to="/racer" end>走る</NavLink>
        <NavLink to="/racer/stats">強さ</NavLink>
        <span className="nav-group">将棋</span>
        <NavLink to="/shogi" end>対局</NavLink>
        <NavLink to="/shogi/stats">強さ</NavLink>
        <SoundControl />
        <ThemeToggle />
      </nav>
      <UpdateNotice />
      <main>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/tetris/play" element={<PlayPage />} />
          <Route path="/tetris/vs-ai" element={<VsAiPage />} />
          <Route path="/tetris/online" element={<OnlineLobby key="tetris" game="tetris" basePath="/tetris/online" title="オンライン対戦" />} />
          <Route path="/tetris/online/:code" element={<OnlineRoomPage />} />
          <Route path="/tetris/stats" element={<TetrisStatsPage />} />
          <Route path="/tetris/settings" element={<SettingsPage />} />
          <Route path="/blob" element={<BlobSoloPage />} />
          <Route path="/blob/vs-ai" element={<BlobVsAiPage />} />
          <Route path="/blob/online" element={<OnlineLobby key="blob" game="blob" basePath="/blob/online" title="ブロブチェイン オンライン対戦" />} />
          <Route path="/blob/online/:code" element={<BlobOnlineRoomPage />} />
          <Route path="/blob/stats" element={<BlobStatsPage />} />
          <Route path="/othello" element={<OthelloPlayPage />} />
          <Route path="/othello/stats" element={<OthelloStatsPage />} />
          <Route path="/airhockey" element={<AirHockeyPage />} />
          <Route path="/airhockey/stats" element={<AirHockeyStatsPage />} />
          <Route path="/racer" element={<Suspense fallback={<p className="page muted">読み込み中…</p>}><RacerPage /></Suspense>} />
          <Route path="/racer/stats" element={<Suspense fallback={<p className="page muted">読み込み中…</p>}><RacerStatsPage /></Suspense>} />
          <Route path="/shogi" element={<ShogiPage />} />
          <Route path="/shogi/stats" element={<ShogiStatsPage />} />
          <Route path="/monitor" element={<MonitorPage />} />
        </Routes>
      </main>
    </>
  )
}
