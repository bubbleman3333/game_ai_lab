// 将棋盤（SVG）と持ち駒。自分が後手のときは盤を 180° 回して、自分の駒が手前に来るようにする。

import { handName, HAND_ORDER, pieceName, toUsiSquare, type Position, type Side } from '../engine/sfen'

interface Props {
  pos: Position
  /** 手前に来る側（人の色） */
  bottom: Side
  /** 選んでいる駒のマス（USI）、または打つ駒（'P*' など） */
  selected: string | null
  /** 選んでいる駒で行けるマス（USI） */
  targets: Set<string>
  lastMove: string | null
  onSquare: (usiSquare: string) => void
  onHand: (kind: string) => void
  /** 自分が操作できるときだけ true */
  interactive: boolean
}

const CELL = 48
const PAD = 20

export function ShogiBoard({ pos, bottom, selected, targets, lastMove, onSquare, onHand, interactive }: Props) {
  const flip = bottom === 'white'
  const size = PAD * 2 + CELL * 9
  // 直前の手の行き先（"7g7f" → "7f"、"7c7b+" → "7b"、"P*5e" → "5e"）
  const lastToSq = lastMove ? lastMove.slice(2, 4) : null

  // 画面上の位置（左上から）→ 盤の (rank, fileIdx)
  const at = (row: number, col: number): [number, number] => (flip ? [8 - row, 8 - col] : [row, col])
  const top: Side = bottom === 'black' ? 'white' : 'black'

  return (
    <div className="shogi-board-wrap">
      <Hand side={top} pos={pos} active={false} selected={null} onHand={onHand} />
      <svg viewBox={`0 0 ${size} ${size}`} className="shogi-board" role="grid" aria-label="将棋盤">
        <rect x={PAD} y={PAD} width={CELL * 9} height={CELL * 9} fill="var(--shogi-wood)" />
        {Array.from({ length: 10 }, (_, i) => (
          <g key={i} stroke="var(--shogi-line)" strokeWidth={1}>
            <line x1={PAD + i * CELL} y1={PAD} x2={PAD + i * CELL} y2={PAD + 9 * CELL} />
            <line x1={PAD} y1={PAD + i * CELL} x2={PAD + 9 * CELL} y2={PAD + i * CELL} />
          </g>
        ))}
        {[[3, 3], [6, 3], [3, 6], [6, 6]].map(([x, y]) => (
          <circle key={`${x}${y}`} cx={PAD + x * CELL} cy={PAD + y * CELL} r={3} fill="var(--shogi-line)" />
        ))}
        {Array.from({ length: 9 }, (_, i) => (
          <g key={i} fill="var(--text-muted)" fontSize={12} textAnchor="middle">
            <text x={PAD + (i + 0.5) * CELL} y={14}>{flip ? i + 1 : 9 - i}</text>
            <text x={size - 8} y={PAD + (i + 0.5) * CELL + 4}>{'一二三四五六七八九'[flip ? 8 - i : i]}</text>
          </g>
        ))}
        {Array.from({ length: 81 }, (_, k) => {
          const row = Math.floor(k / 9)
          const col = k % 9
          const [rank, fileIdx] = at(row, col)
          const usi = toUsiSquare(rank, fileIdx)
          const piece = pos.board[rank][fileIdx]
          const x = PAD + col * CELL
          const y = PAD + row * CELL
          const isTarget = targets.has(usi)
          const isSelected = selected === usi
          const isLast = usi === lastToSq
          const upsideDown = piece && piece.side === top
          return (
            <g key={usi} onClick={interactive ? () => onSquare(usi) : undefined}
               style={{ cursor: interactive ? 'pointer' : 'default' }} role="gridcell" aria-label={usi}>
              <rect x={x} y={y} width={CELL} height={CELL}
                    fill={isSelected ? 'var(--shogi-selected)' : isLast ? 'var(--shogi-last)' : 'transparent'} />
              {piece && (
                <text
                  x={x + CELL / 2} y={y + CELL / 2 + 8} textAnchor="middle" fontSize={26}
                  className="shogi-piece"
                  fill={piece.promoted ? 'var(--shogi-promoted)' : 'var(--shogi-ink)'}
                  transform={upsideDown ? `rotate(180 ${x + CELL / 2} ${y + CELL / 2})` : undefined}
                >
                  {pieceName(piece)}
                </text>
              )}
              {isTarget && <circle cx={x + CELL / 2} cy={y + CELL / 2} r={piece ? CELL * 0.45 : 7}
                                   fill={piece ? 'none' : 'var(--shogi-target)'} stroke="var(--shogi-target)" strokeWidth={3} />}
            </g>
          )
        })}
      </svg>
      <Hand side={bottom} pos={pos} active={interactive} selected={selected} onHand={onHand} />
    </div>
  )
}

function Hand({ side, pos, active, selected, onHand }: {
  side: Side; pos: Position; active: boolean; selected: string | null; onHand: (kind: string) => void
}) {
  const hand = pos.hands[side]
  const kinds = HAND_ORDER.filter((k) => hand[k])
  return (
    <div className={`shogi-hand ${side}`}>
      <span className="muted small">{side === 'black' ? '☗先手' : '☖後手'}の持ち駒</span>
      {kinds.length === 0 && <span className="muted small">なし</span>}
      {kinds.map((k) => (
        <button
          key={k}
          className={`hand-piece${selected === `${k}*` ? ' selected' : ''}`}
          disabled={!active}
          onClick={() => onHand(k)}
        >
          {handName(k)}{hand[k] > 1 && <small>{hand[k]}</small>}
        </button>
      ))}
    </div>
  )
}

