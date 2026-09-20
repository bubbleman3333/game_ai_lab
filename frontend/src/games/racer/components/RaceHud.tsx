// レース中の表示（速度・周回・タイム・ブースト・カウントダウン・順位）。
// ふつうの HTML を canvas の上に重ねているだけで、3D とは関係ない。

import { COUNTDOWN, formatTime, type Race } from '../game/race'
import type { Snapshot } from './RaceCanvas'

interface Props {
  snap: Snapshot
  race: Race
  /** 直前に決めたトリック（何回転か）。しばらく出してから消す */
  flash: string | null
}

export function RaceHud({ snap, race, flash }: Props) {
  const counting = snap.time < 0
  const countLabel = counting
    ? (snap.time < -COUNTDOWN + 0.2 ? '3' : Math.ceil(-snap.time).toString())
    : snap.time < 0.9 ? 'GO!' : null

  return (
    <div className="racer-hud">
      <div className="racer-hud-top">
        <div className="racer-hud-box">
          <span className="racer-hud-label">周回</span>
          <span className="racer-hud-value">{snap.lap}<small> / {snap.laps}</small></span>
        </div>
        {race.racers.length > 1 && (
          <div className="racer-hud-box">
            <span className="racer-hud-label">順位</span>
            <span className="racer-hud-value">{snap.place}<small> / {snap.total}</small></span>
          </div>
        )}
        <div className="racer-hud-box">
          <span className="racer-hud-label">タイム</span>
          <span className="racer-hud-value mono">{formatTime(Math.max(snap.time, 0))}</span>
        </div>
        <div className="racer-hud-box">
          <span className="racer-hud-label">ベストラップ</span>
          <span className="racer-hud-value mono">{formatTime(snap.bestLap)}</span>
        </div>
      </div>

      {countLabel && <div className="racer-count">{countLabel}</div>}
      {flash && <div className="racer-flash">{flash}</div>}

      <div className="racer-hud-bottom">
        <div className="racer-speed">
          <span className="racer-speed-value">{Math.round(snap.speed)}</span>
          <span className="racer-speed-unit">km/h</span>
        </div>
        <div className="racer-boost" aria-label="ブーストの残り">
          <div className="racer-boost-fill" style={{ width: `${Math.min(snap.boost / 1.8, 1) * 100}%` }} />
        </div>
      </div>

      {race.racers.length > 1 && (
        <ol className="racer-standings">
          {race.standings().map((r) => (
            <li key={r.name} className={r.kind === 'human' ? 'me' : undefined}>
              <span className="racer-standings-name">{r.name}</span>
              <span className="mono">
                {r.finishedAt !== null ? formatTime(r.finishedAt) : `${(r.state.prog / race.course.length).toFixed(2)} 周`}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
