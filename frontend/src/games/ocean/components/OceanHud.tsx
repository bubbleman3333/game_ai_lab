// 泳いでいるあいだ画面に重ねる表示（距離・体力・息・スタミナ・サメの警告・区間）。
// 3D は canvas の中なので、ここは HTML だけ。

import type { Snapshot } from './OceanCanvas'

interface Props {
  snap: Snapshot
  /** 画面の真ん中に一瞬出す文字 */
  flash: { text: string; kind: 'good' | 'bad' | 'info'; id: number } | null
  /** 噛まれた・刺されたときの画面の縁の赤・紫（id が変わるたびに点滅し直す） */
  hurt: { kind: 'bite' | 'sting'; id: number } | null
}

const DIR_LABEL: Record<string, string> = { front: '前', back: '後ろ', left: '左', right: '右' }
const DIR_ARROW: Record<string, string> = { front: '▲', back: '▼', left: '◀', right: '▶' }

export function OceanHud({ snap, flash, hurt }: Props) {
  const hearts = []
  for (let i = 0; i < snap.maxHp / 2; i++) {
    const v = snap.hp - i * 2
    hearts.push(<span key={i} className={v >= 2 ? 'full' : v === 1 ? 'half' : 'empty'}>♥</span>)
  }
  const threat = snap.threat
  return (
    <div className={`ocean-hud ${snap.cameraUnderwater ? 'under' : ''}`}>
      <div className="ocean-tint" style={{ opacity: snap.cameraUnderwater ? 0.25 + snap.depth * 0.25 : 0 }} />
      {hurt && <div key={hurt.id} className={`ocean-hurt ${hurt.kind}`} />}
      {snap.underwater && snap.air < 0.3 && !snap.dead && <div className="ocean-air-warn" />}

      <div className="ocean-top-left">
        <div className="ocean-hearts">{hearts}</div>
        <div className="ocean-bar-label">息</div>
        <div className={`ocean-bar air ${snap.air < 0.3 ? 'low' : ''}`}><div style={{ width: `${snap.air * 100}%` }} /></div>
        <div className="ocean-bar-label">スタミナ</div>
        <div className="ocean-bar stamina"><div style={{ width: `${snap.stamina * 100}%` }} /></div>
        {snap.underwater && <div className="ocean-depth">水深 {snap.depthM.toFixed(1)}<small>m</small></div>}
      </div>

      <div className="ocean-top-right">
        <div className="ocean-distance">{Math.floor(snap.distance)}<small>m</small></div>
        <div className="ocean-score">{snap.score} <small>点</small></div>
        <div className="ocean-zone">
          {snap.zoneName}
          {snap.nextZoneIn !== null && <small> ・ 次の海まで {Math.ceil(snap.nextZoneIn)}m</small>}
        </div>
      </div>

      {threat && !snap.dead && (
        <div className={`ocean-threat ${threat.state} dir-${threat.dir}`}>
          <span className="ocean-threat-arrow">{DIR_ARROW[threat.dir]}</span>
          <span className="ocean-threat-text">
            {threat.state === 'charge' ? 'サメが来る！ 横へ避けるか、目の前で蹴れ' : `サメ（${DIR_LABEL[threat.dir]}・${Math.round(threat.dist)}m）`}
          </span>
        </div>
      )}

      {flash && <div key={flash.id} className={`ocean-flash ${flash.kind}`}>{flash.text}</div>}
    </div>
  )
}
