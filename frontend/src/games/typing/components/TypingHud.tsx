// 戦っているあいだの表示（油・得点・コンボ・波・ボスの残り）。3D の上に重ねる。

import { HEAL_COMBO, MAX_OIL } from '../sim/game'
import type { Snapshot } from './ForestCanvas'

export interface Flash {
  text: string
  kind: 'good' | 'bad' | 'info' | 'big'
  id: number
}

interface Props {
  snap: Snapshot
  chapterLabel: string
  flash: Flash | null
  hurt: number | null
  endless: boolean
}

export function TypingHud({ snap, chapterLabel, flash, hurt, endless }: Props) {
  const toHeal = HEAL_COMBO - (snap.combo % HEAL_COMBO)
  return (
    <div className="typing-hud">
      {hurt !== null && <div key={hurt} className="typing-hurt" />}
      {snap.oil <= 1 && !snap.result && <div className="typing-danger" />}

      <div className="typing-top-left">
        <div className="typing-chapter-label">{chapterLabel}</div>
        <div className="typing-oil" title="ランタンの油。影に近づかれると減り、0 で灯りが消える">
          {Array.from({ length: MAX_OIL }, (_, i) => (
            <span key={i} className={i < snap.oil ? 'drop full' : 'drop'} />
          ))}
        </div>
        <div className="typing-heal-hint">あと {toHeal} 打で油 +1</div>
      </div>

      <div className="typing-top-right">
        <div className="typing-score mono">{snap.score.toLocaleString()}</div>
        <div className="typing-sub mono">
          {Math.round(snap.kpm)} 打/分 ・ 正確さ {(snap.accuracy * 100).toFixed(1)}%
        </div>
        <div className="typing-sub">
          {snap.boss ? 'ボス戦' : endless ? `第 ${snap.wave + 1} の波` : `波 ${Math.min(snap.wave + 1, snap.totalWaves)} / ${snap.totalWaves}`}
        </div>
      </div>

      {snap.boss && (
        <div className="typing-boss">
          <div className="typing-boss-name">{snap.boss.name}</div>
          <div className="typing-boss-bar">
            <div style={{ width: `${(snap.boss.left / snap.boss.total) * 100}%` }} />
          </div>
          <div className="typing-boss-hint">なくした言葉を返す（残り {snap.boss.left}）</div>
        </div>
      )}

      {snap.combo >= 5 && (
        <div className="typing-combo" key={Math.floor(snap.combo / 10)}>
          <span className="mono typing-combo-num">{snap.combo}</span>
          <span className="typing-combo-label">COMBO</span>
          <span className="mono typing-combo-mul">×{snap.multiplier.toFixed(2)}</span>
        </div>
      )}

      {flash && <div key={flash.id} className={`typing-flash ${flash.kind}`}>{flash.text}</div>}
    </div>
  )
}
