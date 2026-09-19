// オンライン対戦の相手の盤面（WebSocket で届いた文字列の行）を描く。

import type { CellColor } from '../engine'
import type { BoardRowsText } from '../../../api/online/protocol'
import { BoardCanvas } from './BoardCanvas'

export function rowsTextToColors(rows: BoardRowsText): CellColor[][] {
  return rows.map((r) => r.split('').map((ch) => (ch === '.' ? '' : (ch as CellColor))))
}

export function MiniBoard({ rows, cell = 18, dim = false }: { rows: BoardRowsText; cell?: number; dim?: boolean }) {
  return <BoardCanvas colors={rowsTextToColors(rows)} cell={cell} dim={dim} />
}
