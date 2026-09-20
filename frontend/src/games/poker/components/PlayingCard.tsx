// トランプ 1 枚。サーバーからは "As"（ランク 1 文字 + スート 1 文字）で来る。

const SUIT_MARKS: Record<string, string> = { s: '♠', h: '♥', d: '♦', c: '♣' }
const RED = new Set(['h', 'd'])

interface Props {
  /** "As" の形。裏向きのときは省略する */
  card?: string
  /** 裏向き（AI の手札など） */
  hidden?: boolean
  /** 役に使われていない札を薄く出す */
  dim?: boolean
  size?: 'normal' | 'small'
}

export function PlayingCard({ card, hidden, dim, size = 'normal' }: Props) {
  const cls = `card-face${size === 'small' ? ' small' : ''}${dim ? ' dim' : ''}`
  if (hidden || !card) return <span className={`${cls} back`} aria-label="裏向きのカード" />
  const rank = card.slice(0, 1)
  const suit = card.slice(1, 2)
  const red = RED.has(suit)
  return (
    <span className={`${cls}${red ? ' red' : ''}`} aria-label={`${rank}の${SUIT_MARKS[suit] ?? suit}`}>
      <span className="card-rank">{rank === 'T' ? '10' : rank}</span>
      <span className="card-suit">{SUIT_MARKS[suit] ?? suit}</span>
    </span>
  )
}

/** 空きの枠（まだめくられていないボード） */
export function CardSlot() {
  return <span className="card-face slot" />
}
