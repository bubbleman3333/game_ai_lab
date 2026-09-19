// オセロのルール（ブラウザ版）。backend/games/othello/board.py と同じ結果を出す（shared/fixtures/othello で確認）。
// 探索を速くするため、盤面は長さ 64 の配列にし、打つ・戻すを配列の書き換えで行う。
// マス番号 sq = y * 8 + x（x: 列 a〜h、y: 行 1〜8）。

export const EMPTY = 0
export const BLACK = 1
export const WHITE = 2
export type Color = typeof BLACK | typeof WHITE
export type Cells = Int8Array

export const opponent = (c: Color): Color => (c === BLACK ? WHITE : BLACK)

const DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]

/** RAYS[sq] = そのマスから各方向に並ぶマス番号の列 */
export const RAYS: number[][][] = Array.from({ length: 64 }, (_, sq) => {
  const x0 = sq % 8
  const y0 = Math.floor(sq / 8)
  return DIRS.map(([dx, dy]) => {
    const ray: number[] = []
    for (let x = x0 + dx, y = y0 + dy; x >= 0 && x < 8 && y >= 0 && y < 8; x += dx, y += dy) ray.push(y * 8 + x)
    return ray
  }).filter((r) => r.length >= 2)
})

export function initialCells(): Cells {
  const c = new Int8Array(64)
  c[3 * 8 + 3] = WHITE // d4
  c[4 * 8 + 4] = WHITE // e5
  c[4 * 8 + 3] = BLACK // d5
  c[3 * 8 + 4] = BLACK // e4
  return c
}

export function canPlay(cells: Cells, color: Color, sq: number): boolean {
  if (cells[sq] !== EMPTY) return false
  const opp = opponent(color)
  for (const ray of RAYS[sq]) {
    if (cells[ray[0]] !== opp) continue
    for (let i = 1; i < ray.length; i++) {
      const v = cells[ray[i]]
      if (v === color) return true
      if (v !== opp) break
    }
  }
  return false
}

export function legalMoves(cells: Cells, color: Color): number[] {
  const out: number[] = []
  for (let sq = 0; sq < 64; sq++) if (canPlay(cells, color, sq)) out.push(sq)
  return out
}

export function hasMove(cells: Cells, color: Color): boolean {
  for (let sq = 0; sq < 64; sq++) if (canPlay(cells, color, sq)) return true
  return false
}

/** 打って裏返す。戻り値は裏返したマス（undo に渡す）。打てない手なら空配列で盤面は変えない */
export function play(cells: Cells, color: Color, sq: number): number[] {
  const opp = opponent(color)
  const flipped: number[] = []
  for (const ray of RAYS[sq]) {
    if (cells[ray[0]] !== opp) continue
    let i = 1
    while (i < ray.length && cells[ray[i]] === opp) i++
    if (i < ray.length && cells[ray[i]] === color) {
      for (let k = 0; k < i; k++) flipped.push(ray[k])
    }
  }
  if (flipped.length) {
    cells[sq] = color
    for (const f of flipped) cells[f] = color
  }
  return flipped
}

export function undo(cells: Cells, color: Color, sq: number, flipped: number[]): void {
  const opp = opponent(color)
  cells[sq] = EMPTY
  for (const f of flipped) cells[f] = opp
}

export function count(cells: Cells, color: Color): number {
  let n = 0
  for (let i = 0; i < 64; i++) if (cells[i] === color) n++
  return n
}

/** 終局時の石差（color から見て）。空きマスは勝った側に数える */
export function finalScore(cells: Cells, color: Color): number {
  let p = count(cells, color)
  let o = count(cells, opponent(color))
  const e = 64 - p - o
  if (p > o) p += e
  else if (o > p) o += e
  return p - o
}

export const sqToStr = (sq: number) => 'abcdefgh'[sq % 8] + String(Math.floor(sq / 8) + 1)
export const strToSq = (s: string) => (Number(s[1]) - 1) * 8 + 'abcdefgh'.indexOf(s[0].toLowerCase())

/** デバッグ用: 'X' = 黒、'O' = 白、'.' = 空き。上の行から */
export function toStrings(cells: Cells): string[] {
  const rows: string[] = []
  for (let y = 0; y < 8; y++) {
    let s = ''
    for (let x = 0; x < 8; x++) s += cells[y * 8 + x] === BLACK ? 'X' : cells[y * 8 + x] === WHITE ? 'O' : '.'
    rows.push(s)
  }
  return rows
}

export function fromStrings(rows: string[]): Cells {
  const c = new Int8Array(64)
  rows.forEach((r, y) => [...r].forEach((ch, x) => (c[y * 8 + x] = ch === 'X' ? BLACK : ch === 'O' ? WHITE : EMPTY)))
  return c
}

/** 画面用の対局状態。パスは自動で処理する */
export class OthelloGame {
  cells: Cells = initialCells()
  toMove: Color = BLACK
  moves: string[] = []
  /** 1 手ごとの盤面（待ったに使う） */
  private history: { cells: Cells; toMove: Color }[] = []
  lastMove: number | null = null
  /** 直前の手で裏返った石の数（効果音に使う） */
  lastFlipped = 0
  lastPass: Color | null = null

  legal(): number[] {
    return legalMoves(this.cells, this.toMove)
  }

  isOver(): boolean {
    return !hasMove(this.cells, BLACK) && !hasMove(this.cells, WHITE)
  }

  play(sq: number): boolean {
    const before = this.cells.slice()
    const flipped = play(this.cells, this.toMove, sq)
    if (!flipped.length) return false
    this.lastFlipped = flipped.length
    this.history.push({ cells: before, toMove: this.toMove })
    this.moves.push(sqToStr(sq))
    this.lastMove = sq
    this.toMove = opponent(this.toMove)
    this.lastPass = null
    if (!hasMove(this.cells, this.toMove) && hasMove(this.cells, opponent(this.toMove))) {
      this.lastPass = this.toMove
      this.toMove = opponent(this.toMove)
    }
    return true
  }

  /** color の手番まで戻せるか（待ったボタンを押せるか） */
  canUndo(color: Color): boolean {
    return this.history.some((h) => h.toMove === color)
  }

  /** color の手番になるところまで戻す（待った）。戻れないときは何も変えずに false */
  undoUntil(color: Color): boolean {
    if (!this.canUndo(color)) return false
    while (this.history.length) {
      const h = this.history.pop()!
      this.moves.pop()
      this.cells = h.cells
      this.toMove = h.toMove
      if (h.toMove === color) {
        this.lastMove = null
        this.lastPass = null
        return true
      }
    }
    return false
  }

  score(): { black: number; white: number } {
    return { black: count(this.cells, BLACK), white: count(this.cells, WHITE) }
  }
}
