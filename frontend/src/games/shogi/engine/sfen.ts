// SFEN（局面の文字列）を画面用に読む。ルールの判定はしない（サーバーがする）。
// マスは USI の座標: 筋 1〜9（先手から見て右から左）、段 a〜i（上から下）。例 "7g" = ７七。

export type Side = 'black' | 'white'
export interface Piece {
  side: Side
  /** 'P' 'L' 'N' 'S' 'G' 'B' 'R' 'K'（成り駒は promoted） */
  kind: string
  promoted: boolean
}

export interface Position {
  /** board[rank][file]。rank 0 = 一段目（a）、file 0 = ９筋（盤の左端） */
  board: (Piece | null)[][]
  hands: Record<Side, Record<string, number>>
  turn: Side
}

export const HAND_ORDER = ['R', 'B', 'G', 'S', 'N', 'L', 'P']

export function parseSfen(sfen: string): Position {
  const [boardPart, turnPart, handPart] = sfen.split(' ')
  const board: (Piece | null)[][] = []
  for (const row of boardPart.split('/')) {
    const cells: (Piece | null)[] = []
    let promoted = false
    for (const ch of row) {
      if (ch === '+') {
        promoted = true
      } else if (/\d/.test(ch)) {
        for (let i = 0; i < Number(ch); i++) cells.push(null)
      } else {
        cells.push({ side: ch === ch.toUpperCase() ? 'black' : 'white', kind: ch.toUpperCase(), promoted })
        promoted = false
      }
    }
    board.push(cells)
  }
  const hands: Record<Side, Record<string, number>> = { black: {}, white: {} }
  if (handPart && handPart !== '-') {
    let count = ''
    for (const ch of handPart) {
      if (/\d/.test(ch)) count += ch
      else {
        const side: Side = ch === ch.toUpperCase() ? 'black' : 'white'
        hands[side][ch.toUpperCase()] = Number(count || '1')
        count = ''
      }
    }
  }
  return { board, hands, turn: turnPart === 'b' ? 'black' : 'white' }
}

/** 画面の (rank 0-8, file 0-8 左から) → USI のマス "7g" */
export const toUsiSquare = (rank: number, fileIdx: number) => `${9 - fileIdx}${'abcdefghi'[rank]}`

/** USI のマス → 画面の (rank, fileIdx) */
export function fromUsiSquare(sq: string): [number, number] {
  return ['abcdefghi'.indexOf(sq[1]), 9 - Number(sq[0])]
}

const NAMES: Record<string, string> = { P: '歩', L: '香', N: '桂', S: '銀', G: '金', B: '角', R: '飛', K: '玉' }
const PROMOTED: Record<string, string> = { P: 'と', L: '杏', N: '圭', S: '全', B: '馬', R: '龍' }

export function pieceName(p: Piece): string {
  if (p.promoted) return PROMOTED[p.kind]
  if (p.kind === 'K') return p.side === 'black' ? '玉' : '王'
  return NAMES[p.kind]
}

export const handName = (kind: string) => NAMES[kind]

/**
 * 指し手（USI）をそのまま盤に反映した局面を返す（画面にすぐ出すため。反則かどうかは調べない。
 * 指せる手はサーバーがくれた一覧から選ぶので、ここでは合法手だけが来る）。
 */
export function applyUsi(pos: Position, usi: string): Position {
  const board = pos.board.map((row) => row.slice())
  const hands = { black: { ...pos.hands.black }, white: { ...pos.hands.white } }
  const side = pos.turn
  const [tr, tf] = fromUsiSquare(usi.slice(2, 4))
  if (usi[1] === '*') {
    const kind = usi[0]
    hands[side][kind] = (hands[side][kind] ?? 1) - 1
    if (hands[side][kind] <= 0) delete hands[side][kind]
    board[tr][tf] = { side, kind, promoted: false }
  } else {
    const [fr, ff] = fromUsiSquare(usi.slice(0, 2))
    const piece = board[fr][ff]!
    const captured = board[tr][tf]
    if (captured) hands[side][captured.kind] = (hands[side][captured.kind] ?? 0) + 1
    board[fr][ff] = null
    board[tr][tf] = { ...piece, promoted: piece.promoted || usi.endsWith('+') }
  }
  return { board, hands, turn: side === 'black' ? 'white' : 'black' }
}
