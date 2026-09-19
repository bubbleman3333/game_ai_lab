// ミノの形と SRS の壁蹴り表。backend/tetris/pieces.py と同じ内容（docs/RULES.md）。

export type PieceType = 'I' | 'J' | 'L' | 'O' | 'S' | 'T' | 'Z'
export type Rotation = 0 | 1 | 2 | 3
export type Cell = readonly [number, number]

export const PIECE_TYPES: readonly PieceType[] = ['I', 'J', 'L', 'O', 'S', 'T', 'Z']
export const BOARD_WIDTH = 10
export const BOARD_HEIGHT = 40
export const VISIBLE_HEIGHT = 20
export const SPAWN_X = 4
export const SPAWN_Y = 20

const rotateCw = (cells: readonly Cell[]): Cell[] => cells.map(([x, y]) => [y, -x] as const)

function allRotations(spawn: readonly Cell[]): Cell[][] {
  const states: Cell[][] = [spawn.slice()]
  for (let i = 0; i < 3; i++) states.push(rotateCw(states[states.length - 1]))
  return states
}

const O_CELLS: Cell[] = [[0, 0], [1, 0], [0, 1], [1, 1]]

export const CELLS: Record<PieceType, Cell[][]> = {
  T: allRotations([[-1, 0], [0, 0], [1, 0], [0, 1]]),
  J: allRotations([[-1, 1], [-1, 0], [0, 0], [1, 0]]),
  L: allRotations([[1, 1], [-1, 0], [0, 0], [1, 0]]),
  S: allRotations([[0, 1], [1, 1], [-1, 0], [0, 0]]),
  Z: allRotations([[-1, 1], [0, 1], [0, 0], [1, 0]]),
  O: [O_CELLS, O_CELLS, O_CELLS, O_CELLS],
  I: [
    [[-1, 0], [0, 0], [1, 0], [2, 0]],
    [[1, 1], [1, 0], [1, -1], [1, -2]],
    [[-1, -1], [0, -1], [1, -1], [2, -1]],
    [[0, 1], [0, 0], [0, -1], [0, -2]],
  ],
}

type KickTable = Record<string, Cell[]>

const KICKS_JLSTZ: KickTable = {
  '0>1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '1>0': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '1>2': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '2>1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '2>3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  '3>2': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '3>0': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '0>3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
}
const KICKS_I: KickTable = {
  '0>1': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  '1>0': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  '1>2': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
  '2>1': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  '2>3': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  '3>2': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  '3>0': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  '0>3': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
}
const NO_KICK: Cell[] = [[0, 0]]

export function kicks(piece: PieceType, from: Rotation, to: Rotation): Cell[] {
  if (piece === 'O') return NO_KICK
  return (piece === 'I' ? KICKS_I : KICKS_JLSTZ)[`${from}>${to}`]
}

export const T_FRONT_CORNERS: Record<Rotation, [Cell, Cell]> = {
  0: [[-1, 1], [1, 1]],
  1: [[1, 1], [1, -1]],
  2: [[-1, -1], [1, -1]],
  3: [[-1, 1], [-1, -1]],
}
export const T_ALL_CORNERS: Cell[] = [[-1, 1], [1, 1], [-1, -1], [1, -1]]
