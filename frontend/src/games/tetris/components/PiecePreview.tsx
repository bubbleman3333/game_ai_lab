// ホールド・ネクストの小さなミノ表示。

import { CELLS, type PieceType } from '../engine'
import { PIECE_COLORS } from './colors'

export function PiecePreview({ piece, cell = 14, dim = false }: { piece: PieceType | null; cell?: number; dim?: boolean }) {
  const size = 4 * cell
  if (!piece) return <svg width={size} height={cell * 2.5} className="piece-preview" />
  const cells = CELLS[piece][0]
  const xs = cells.map((c) => c[0])
  const ys = cells.map((c) => c[1])
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const maxY = Math.max(...ys)
  const minY = Math.min(...ys)
  const offX = (size - (maxX - minX + 1) * cell) / 2
  const offY = (cell * 2.5 - (maxY - minY + 1) * cell) / 2
  return (
    <svg width={size} height={cell * 2.5} className="piece-preview" aria-label={piece}>
      {cells.map(([x, y], i) => (
        <rect
          key={i}
          x={offX + (x - minX) * cell + 1}
          y={offY + (maxY - y) * cell + 1}
          width={cell - 2}
          height={cell - 2}
          fill={PIECE_COLORS[piece]}
          opacity={dim ? 0.35 : 1}
        />
      ))}
    </svg>
  )
}
