// 盤面。1 行を 10bit の整数で持つ（bit x = 列 x）。y=0 が最下段。backend/tetris/board.py と同じ。

import { BOARD_HEIGHT, BOARD_WIDTH, CELLS, type PieceType, type Rotation } from './pieces'

export const FULL_ROW = (1 << BOARD_WIDTH) - 1

/** 表示用の色。'G' はおじゃま、'' は空き。ルール判定には使わない（Python 版にはない） */
export type CellColor = PieceType | 'G' | ''

export class Board {
  rows: number[]
  /** colors[y][x]。rows と同じように消去・せり上がりで動く */
  colors: CellColor[][]

  constructor(rows?: readonly number[], colors?: readonly (readonly CellColor[])[]) {
    this.rows = rows ? rows.slice() : new Array(BOARD_HEIGHT).fill(0)
    this.colors = colors
      ? colors.map((r) => r.slice())
      : this.rows.map((r) => Array.from({ length: BOARD_WIDTH }, (_, x) => ((r >> x) & 1 ? 'G' : '')))
  }

  copy(): Board {
    return new Board(this.rows, this.colors)
  }

  /** 盤外（左右の壁・床）は埋まっているものとして扱う */
  isFilled(x: number, y: number): boolean {
    if (x < 0 || x >= BOARD_WIDTH || y < 0) return true
    if (y >= BOARD_HEIGHT) return false
    return ((this.rows[y] >> x) & 1) === 1
  }

  collides(piece: PieceType, rot: Rotation, x: number, y: number): boolean {
    for (const [dx, dy] of CELLS[piece][rot]) {
      const cx = x + dx
      const cy = y + dy
      if (cx < 0 || cx >= BOARD_WIDTH || cy < 0) return true
      if (cy < BOARD_HEIGHT && (this.rows[cy] >> cx) & 1) return true
    }
    return false
  }

  isEmpty(): boolean {
    return this.rows.every((r) => r === 0)
  }

  place(piece: PieceType, rot: Rotation, x: number, y: number): void {
    for (const [dx, dy] of CELLS[piece][rot]) {
      this.rows[y + dy] |= 1 << (x + dx)
      this.colors[y + dy][x + dx] = piece
    }
  }

  clearLines(): number {
    const keep = this.rows.map((r) => r !== FULL_ROW)
    const kept = this.rows.filter((_, y) => keep[y])
    const cleared = BOARD_HEIGHT - kept.length
    if (cleared) {
      this.rows = kept.concat(new Array(cleared).fill(0))
      this.colors = this.colors
        .filter((_, y) => keep[y])
        .concat(Array.from({ length: cleared }, () => new Array(BOARD_WIDTH).fill('')))
    }
    return cleared
  }

  /** 下から lines 段せり上げる。上から押し出されたら false（top out） */
  addGarbage(lines: number, hole: number): boolean {
    const overflow = this.rows.slice(BOARD_HEIGHT - lines).some((r) => r !== 0)
    const row = FULL_ROW & ~(1 << hole)
    this.rows = new Array(lines).fill(row).concat(this.rows.slice(0, BOARD_HEIGHT - lines))
    const colorRow = (): CellColor[] => Array.from({ length: BOARD_WIDTH }, (_, x) => (x === hole ? '' : 'G'))
    this.colors = Array.from({ length: lines }, colorRow).concat(this.colors.slice(0, BOARD_HEIGHT - lines))
    return !overflow
  }

  /** デバッグ用: 上の行から '#' / '.' の文字列 */
  toStrings(height = 20): string[] {
    const out: string[] = []
    for (let y = height - 1; y >= 0; y--) {
      let s = ''
      for (let x = 0; x < BOARD_WIDTH; x++) s += (this.rows[y] >> x) & 1 ? '#' : '.'
      out.push(s)
    }
    return out
  }
}
