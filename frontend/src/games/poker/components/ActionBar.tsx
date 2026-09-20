// 人が打つところ。**ノーリミットなので額は自由に決められる**（最低レイズ〜オールインの間）。
// ワンタッチのボタンは AI が学習している倍率とオールイン。

import { useEffect, useState } from 'react'
import type { ActionKind, PokerTableDto } from '../api/poker'

interface Props {
  table: PokerTableDto
  busy: boolean
  onAction: (kind: ActionKind, to?: number) => void
  onNext: () => void
}

export function ActionBar({ table, busy, onAction, onNext }: Props) {
  const a = table.actions
  const [amount, setAmount] = useState(a.min_raise_to)

  // 局面が変わったら、スライダーの初期値を最低レイズに戻す
  useEffect(() => {
    setAmount(a.min_raise_to)
  }, [a.min_raise_to, table.hand_no, table.street, table.street_bet[0], table.street_bet[1]])

  if (table.finished) {
    const busted = table.result?.busted ?? -1
    const gain = table.result?.payoff[table.you] ?? 0
    const folded = table.result?.folded ?? -1
    // なぜ終わったのかを必ず書く。「相手が降りたのか、見せ合って負けたのか」が分からないと何も学べない
    const reason =
      folded === table.ai ? 'AI がフォールドしました。'
      : folded === table.you ? 'あなたがフォールドしました。'
      : 'ショーダウン（手札を見せ合い）。'
    return (
      <div className="poker-actions">
        <span className="poker-reason">{reason}</span>
        <span className={gain > 0 ? 'win' : gain < 0 ? 'lose' : 'muted'}>
          {gain > 0 ? `+${gain} 獲得` : gain < 0 ? `${gain} 失点` : '引き分け'}
        </span>
        {busted < 0 ? (
          <button onClick={onNext} disabled={busy} autoFocus>次の局へ</button>
        ) : (
          <span className="lose">
            {busted === table.you ? 'あなたのスタックが尽きました' : 'AI のスタックが尽きました'}
            （新しいテーブルを作ってください）
          </span>
        )}
      </div>
    )
  }

  if (table.to_act !== table.you) {
    const said = table.last_actions[table.ai]
    return (
      <div className="poker-actions muted">
        {said ? `AI: ${said} → ` : ''}AI が考えています…
      </div>
    )
  }

  const canSlide = a.can_raise && a.max_raise_to > a.min_raise_to
  return (
    <div className="poker-actions">
      {a.can_fold && <button onClick={() => onAction('fold')} disabled={busy}>フォールド</button>}
      {a.can_check && <button onClick={() => onAction('check')} disabled={busy}>チェック</button>}
      {a.can_call && (
        <button onClick={() => onAction('call')} disabled={busy}>コール {a.call_amount}</button>
      )}
      {a.can_raise && (
        <>
          <span className="poker-raise">
            <input
              type="range"
              min={a.min_raise_to}
              max={a.max_raise_to}
              value={Math.min(Math.max(amount, a.min_raise_to), a.max_raise_to)}
              onChange={(e) => setAmount(Number(e.target.value))}
              disabled={busy || !canSlide}
              aria-label="レイズ額"
            />
            <input
              type="number"
              min={a.min_raise_to}
              max={a.max_raise_to}
              value={amount}
              onChange={(e) => setAmount(Number(e.target.value))}
              disabled={busy}
              aria-label="レイズ額（数値）"
            />
          </span>
          <button
            onClick={() => onAction('raise', Math.min(Math.max(amount, a.min_raise_to), a.max_raise_to))}
            disabled={busy}
          >
            {amount >= a.max_raise_to ? 'オールイン' : `レイズ to ${amount}`}
          </button>
          {a.presets.map((p) => (
            <button key={p.label} className="poker-preset" onClick={() => setAmount(p.to)} disabled={busy}>
              {p.label}
            </button>
          ))}
        </>
      )}
    </div>
  )
}
