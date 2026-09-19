// オンライン対戦の WebSocket メッセージ（テトリス・ブロブチェイン共通）。
// backend/apps/tetris_online/protocol.py と同じ定義。

import type { RoomDto } from './types'

export type OnlineGame = 'tetris' | 'blob'

/** 相手画面に表示するための盤面。下の行から、各行 10 文字（'.' は空き、'G' はおじゃま、他はミノ） */
export type BoardRowsText = string[]

export interface PublicStats {
  pieces: number
  lines: number
  attack: number
}

export type ClientMessage =
  | { type: 'ready'; ready: boolean }
  | { type: 'state'; rows: BoardRowsText; stats: PublicStats; pending: number }
  | { type: 'attack'; lines: number }
  | { type: 'topout'; stats: PublicStats }
  | { type: 'ping' }

export type ServerMessage =
  | { type: 'welcome'; slot: number }
  | { type: 'room'; room: RoomDto }
  | { type: 'start'; seed: number; round: number; countdown_ms: number }
  | { type: 'opponent_state'; slot: number; rows: BoardRowsText; stats: PublicStats; pending: number }
  | { type: 'garbage'; from_slot: number; lines: number }
  | { type: 'end'; winner_slot: number; reason: 'topout' | 'disconnect'; room: RoomDto }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong' }

export const CLOSE_ROOM_NOT_FOUND = 4004
export const CLOSE_ROOM_FULL = 4009
