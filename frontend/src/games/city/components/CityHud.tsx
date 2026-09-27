// 走っているあいだの表示（ふつうの HTML）。3D の上に重ねる。
//   右上   時刻・所持金・手配度（★）
//   左下   ミニマップと車の傷み
//   右下   速度
//   上     ミッションの内容と残り時間
//   下     無線の字幕（物語の会話）
//   真ん中 WASTED / BUSTED・得点のポップ

import type { Game } from '../sim/game'
import type { Line } from '../sim/story'
import { CAST } from '../sim/story'
import type { Snapshot } from './CityCanvas'
import { Minimap } from './Minimap'

export interface Toast { id: number; text: string; kind: 'score' | 'info' | 'bad' | 'good' }

interface Props {
  game: Game
  snap: Snapshot | null
  line: Line | null
  toasts: Toast[]
  banner: { title: string; sub: string } | null
}

const pad = (n: number) => String(n).padStart(2, '0')

export function CityHud({ game, snap, line, toasts, banner }: Props) {
  if (!snap) return null
  const mission = game.mission
  const hh = Math.floor(snap.clock), mm = Math.floor((snap.clock - hh) * 60)
  const evading = snap.stars > 0 && !snap.seen
  return (
    <div className="city-hud">
      <div className="city-top-right">
        <div className="city-clock">{pad(hh)}:{pad(mm)}</div>
        <div className="city-money">${snap.score.toLocaleString()}</div>
        <div className={`city-stars${evading ? ' evading' : ''}`}>
          {[1, 2, 3, 4, 5].map((k) => <span key={k} className={k <= snap.stars ? 'on' : ''}>★</span>)}
        </div>
      </div>

      <div className="city-bottom-left">
        <Minimap game={game} big={false} />
        <div className="city-health"><div style={{ width: `${snap.health * 100}%` }} /></div>
      </div>

      <div className="city-bottom-right">
        <div className="city-speed">{Math.round(snap.speed)}<small>km/h</small></div>
        <div className="city-car">{snap.car}</div>
      </div>

      {mission && (
        <div className={`city-mission${mission.story ? ' story' : ''}`}>
          <div className="city-mission-title">{mission.def.title}</div>
          <div>{mission.text}</div>
          {mission.timeLeft !== null && (
            <div className={`city-mission-time${mission.timeLeft < 10 ? ' low' : ''}`}>
              {Math.floor(mission.timeLeft / 60)}:{pad(Math.max(0, Math.floor(mission.timeLeft % 60)))}
            </div>
          )}
        </div>
      )}

      {snap.bust > 0.02 && (
        <div className="city-bust">
          <span>逮捕されそう</span>
          <div><div style={{ width: `${snap.bust * 100}%` }} /></div>
        </div>
      )}
      {snap.canCarjack && snap.state === 'play' && <div className="city-hint"><kbd>F</kbd> 車を奪う</div>}

      <div className="city-toasts">
        {toasts.map((t) => <div key={t.id} className={`city-toast ${t.kind}`}>{t.text}</div>)}
      </div>

      {line && (
        <div className="city-subtitle">
          <span style={{ color: CAST[line.who] ?? '#fff' }}>{line.who}</span>
          {line.text}
        </div>
      )}

      {snap.state !== 'play' && (
        <div className={`city-dead ${snap.state}`}>
          <div>{snap.state === 'busted' ? '逮捕' : game.deathReason === 'water' ? '水没' : '大破'}</div>
          <small>{snap.state === 'busted' ? '警察署から出直し' : game.deathReason === 'water' ? '岸で車を乗り換えて続ける' : '車を乗り換えて続ける'}</small>
        </div>
      )}
      {banner && (
        <div className="city-banner">
          <div className="city-banner-title">{banner.title}</div>
          <div>{banner.sub}</div>
        </div>
      )}
    </div>
  )
}
