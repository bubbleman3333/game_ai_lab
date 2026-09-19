// エンジンの入口。画面側はここから import する。仕様は docs/RULES.md。
export { Board, type CellColor } from './board'
export {
  GameController, DEFAULT_CONTROLLER_OPTIONS, type ActionListener, type ControllerOptions, type LockListener,
} from './controller'
export { Game, type Action, type ActivePiece, type LockResult, type Stats } from './game'
export {
  BOARD_HEIGHT, BOARD_WIDTH, CELLS, PIECE_TYPES, VISIBLE_HEIGHT, type PieceType, type Rotation,
} from './pieces'
export { type PendingGarbage, type Spin } from './rules'
