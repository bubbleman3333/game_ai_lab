// オセロの盤面（SVG）。打てるマスの印・直前の手・AI の評価値を表示できる。
// 石は「マス番号 + 色」を key にしているので、置かれたり裏返ったりした石だけが作り直され、
// そのとき CSS のアニメーション（.disc-anim）が動く。

import { BLACK, EMPTY, type Cells, type Color } from '../engine/board'

interface Props {
  cells: Cells
  /** 打てるマス（印を出してクリックできるようにする） */
  legal: number[]
  lastMove: number | null
  onPlay?: (sq: number) => void
  /** マスごとの評価値（手番側から見た予想石差）。評価値表示のとき */
  hints?: Map<number, number>
  /** 打てるマスにマウスを重ねたとき、薄く表示する石の色 */
  ghostColor?: Color
  size?: number
}

const LETTERS = 'abcdefgh'

export function OthelloBoard({ cells, legal, lastMove, onPlay, hints, ghostColor, size = 480 }: Props) {
  const pad = 22
  const cell = (size - pad) / 8
  const legalSet = new Set(legal)
  const bestHint = hints && hints.size ? Math.max(...hints.values()) : null

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      className="othello-board"
      role="grid"
      aria-label="オセロの盤面"
    >
      <rect x={pad} y={pad} width={cell * 8} height={cell * 8} fill="var(--othello-green)" />
      {Array.from({ length: 9 }, (_, i) => (
        <g key={i} stroke="var(--othello-line)" strokeWidth={1}>
          <line x1={pad + i * cell} y1={pad} x2={pad + i * cell} y2={pad + 8 * cell} />
          <line x1={pad} y1={pad + i * cell} x2={pad + 8 * cell} y2={pad + i * cell} />
        </g>
      ))}
      {[[2, 2], [6, 2], [2, 6], [6, 6]].map(([x, y]) => (
        <circle key={`${x}${y}`} cx={pad + x * cell} cy={pad + y * cell} r={3} fill="var(--othello-line)" />
      ))}
      {Array.from({ length: 8 }, (_, i) => (
        <g key={i} fill="var(--text-muted)" fontSize={12} textAnchor="middle">
          <text x={pad + (i + 0.5) * cell} y={15}>{LETTERS[i]}</text>
          <text x={10} y={pad + (i + 0.5) * cell + 4}>{i + 1}</text>
        </g>
      ))}
      {Array.from({ length: 64 }, (_, sq) => {
        const x = pad + (sq % 8) * cell
        const y = pad + Math.floor(sq / 8) * cell
        const v = cells[sq]
        const canPlay = legalSet.has(sq) && !!onPlay
        const hint = hints?.get(sq)
        return (
          <g
            key={sq}
            onClick={canPlay ? () => onPlay!(sq) : undefined}
            style={{ cursor: canPlay ? 'pointer' : 'default' }}
            role="gridcell"
            aria-label={`${LETTERS[sq % 8]}${Math.floor(sq / 8) + 1}`}
          >
            <rect x={x} y={y} width={cell} height={cell} fill="transparent" />
            {v !== EMPTY && (
              <circle
                key={`disc-${v}`}
                className="disc-anim"
                cx={x + cell / 2} cy={y + cell / 2} r={cell * 0.41}
                fill={v === BLACK ? 'var(--disc-black)' : 'var(--disc-white)'}
                stroke="var(--disc-edge)" strokeWidth={1}
              />
            )}
            {canPlay && ghostColor && (
              <circle
                className="ghost-disc"
                cx={x + cell / 2} cy={y + cell / 2} r={cell * 0.41}
                fill={ghostColor === BLACK ? 'var(--disc-black)' : 'var(--disc-white)'}
              />
            )}
            {lastMove === sq && <circle cx={x + cell / 2} cy={y + cell / 2} r={4} fill="var(--error)" />}
            {canPlay && hint === undefined && (
              <circle cx={x + cell / 2} cy={y + cell / 2} r={cell * 0.1} fill="var(--othello-hint)" />
            )}
            {canPlay && hint !== undefined && (
              <text
                x={x + cell / 2} y={y + cell / 2 + 5} textAnchor="middle" fontSize={14} fontWeight={700}
                fill={hint === bestHint ? 'var(--othello-best)' : 'var(--othello-hint-text)'}
              >
                {hint > 0 ? `+${Math.round(hint)}` : Math.round(hint)}
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}
